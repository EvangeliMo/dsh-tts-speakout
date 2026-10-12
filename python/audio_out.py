# -*- coding: utf-8 -*-
"""Targeted audio output for the dsh-tts-speakout plugin.

Renders float32 PCM to ONE explicit output endpoint, so the agent can make the
machine talk through the loudspeakers even when the default device is a headset.

Device selection is by friendly-name substring, with a deterministic preference
order (WASAPI, then DirectSound, then MME, then WDM-KS). Virtual loopback cables
(VoiceMeeter, Steam Streaming, ToDesk, NVIDIA) are deprioritised: talking into a
recording device is never what "shout at the user" should do.

This module is imported by tts_worker.py inside the plugin's own interpreter.
"""

from __future__ import annotations

import sys
import time
from typing import Any, Iterable

# Host API names in decreasing order of quality/preference on Windows.
_HOSTAPI_RANK = {
    "Windows WASAPI": 0,
    "Windows DirectSound": 1,
    "MME": 2,
    "Windows WDM-KS": 3,
}

# Substrings that mark a device as a virtual cable / capture sink rather than a
# speaker the human can hear.
_VIRTUAL_MARKERS = (
    "voicemeeter",
    "steam streaming",
    "todesk",
    "nvidia",
    "vb-audio",
    "virtual",
    "sound mapper",
    "声音映射器",
    "主声音驱动程序",
    "primary sound driver",
)

# Windows reports the loudspeaker endpoint as "扬声器" (zh) or "Speakers" (en),
# and the headset endpoint as "耳机" / "Headphones".
_SPEAKER_MARKERS = ("扬声器", "speakers", "speaker")
_HEADPHONE_MARKERS = ("耳机", "headphone", "headphones")


class AudioError(RuntimeError):
    """Raised when no usable output device can be resolved."""


def _import_sounddevice():
    try:
        import sounddevice as sd  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        raise AudioError(
            "sounddevice/PortAudio is unavailable: %s" % exc
        ) from exc
    return sd


def list_output_devices(prefer_windows: bool = True) -> list[dict[str, Any]]:
    """Enumerate render endpoints as JSON-ready dicts.

    `suggested` marks the endpoint the plugin would pick by default, so the
    settings UI can show the user what "auto" currently resolves to.
    """
    sd = _import_sounddevice()
    hostapis = sd.query_hostapis()
    raw = sd.query_devices()

    rows: list[dict[str, Any]] = []
    for index, dev in enumerate(raw):
        try:
            out_channels = int(dev["max_output_channels"])
        except Exception:  # noqa: BLE001
            continue
        if out_channels <= 0:
            continue
        api_name = str(hostapis[int(dev["hostapi"])]["name"])
        if prefer_windows and not api_name.startswith("Windows"):
            continue
        rows.append(
            {
                "index": int(index),
                "name": str(dev["name"]),
                "hostapi": api_name,
                "outChannels": out_channels,
                "defaultSamplerate": float(dev["default_samplerate"]),
            }
        )

    suggested = score_devices(rows)[0] if rows else None
    for row in rows:
        row["suggested"] = bool(suggested and row["index"] == suggested["index"])
        row["virtual"] = any(m in row["name"].lower() for m in _VIRTUAL_MARKERS)
    return rows


def score_devices(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank render endpoints best-first.

    Preference: real speaker over headset, physical over virtual cable, then the
    host-API rank. Sorting is total and stable so the same machine always picks
    the same endpoint.
    """
    def key(row: dict[str, Any]) -> tuple:
        name = str(row.get("name", "")).lower()
        is_virtual = any(m in name for m in _VIRTUAL_MARKERS)
        is_speaker = any(m in name for m in _SPEAKER_MARKERS)
        is_headphone = any(m in name for m in _HEADPHONE_MARKERS)
        return (
            1 if is_virtual else 0,
            0 if (is_speaker and not is_headphone) else (2 if is_headphone else 1),
            _HOSTAPI_RANK.get(str(row.get("hostapi", "")), 9),
            str(row.get("name", "")),
            int(row.get("index", 0)),
        )

    return sorted(rows, key=key)


def resolve_device(devices: list[dict[str, Any]], wanted: str | None) -> dict[str, Any] | None:
    """Resolve a device spec to one endpoint.

    `wanted` may be a friendly-name substring (case-insensitive) or a plain
    device index. An empty/None spec means "pick automatically".
    """
    if not devices:
        return None
    spec = (wanted or "").strip()
    if not spec:
        return score_devices(devices)[0]

    if spec.isdigit():
        for row in devices:
            if int(row["index"]) == int(spec):
                return row

    needle = spec.lower()
    hits = [row for row in devices if needle in str(row["name"]).lower()]
    if not hits:
        return None
    return score_devices(hits)[0]


def resample(mono, source_rate: int, target_rate: int):
    """Resample 1-D float32 audio between rates.

    WASAPI endpoints reject audio whose rate differs from the engine mix format
    (the Realtek speakers here run at 48 kHz while Qwen3-TTS emits 24 kHz), so
    playback must convert rather than hope PortAudio copes.
    """
    import numpy as np  # noqa: PLC0415

    if int(source_rate) == int(target_rate) or mono.size == 0:
        return mono
    try:
        from math import gcd  # noqa: PLC0415

        from scipy.signal import resample_poly  # noqa: PLC0415

        divisor = gcd(int(source_rate), int(target_rate))
        return resample_poly(
            mono, int(target_rate) // divisor, int(source_rate) // divisor
        ).astype("float32")
    except Exception:  # noqa: BLE001
        # Linear interpolation fallback: no dependency, still musically fine for
        # a 2x upsample of speech.
        length = int(round(mono.size * float(target_rate) / float(source_rate)))
        source_positions = np.linspace(0.0, 1.0, mono.size, endpoint=False)
        target_positions = np.linspace(0.0, 1.0, length, endpoint=False)
        return np.interp(target_positions, source_positions, mono).astype("float32")


def device_samplerate(device_index: int, fallback: int) -> int:
    """Preferred output rate for one device, as PortAudio reports it."""
    sd = _import_sounddevice()
    try:
        info = sd.query_devices(device_index)
        rate = float(info.get("default_samplerate") or 0)
        if rate >= 8000:
            return int(round(rate))
    except Exception:  # noqa: BLE001
        pass
    return int(fallback)


class Speaker:
    """Owns one short-lived output stream per playback."""

    def __init__(self) -> None:
        self._stream = None
        self._closed = False

    def play(self, samples, samplerate: int, device_index: int, volume: float = 1.0,
             blocking: bool = True, channels: int | None = None) -> float:
        """Write `samples` (1-D float32, mono) to `device_index`.

        The mono signal is duplicated across EVERY output channel the endpoint
        offers, and the endpoint's own rate is used.

        Both details are load-bearing on this machine's Realtek loudspeakers:
        every attempt that wrote a single channel (the other channel left at 0)
        produced a piercing, buzzing rendition, and every attempt with the full
        channel count filled from a signal written to both channels rendered
        correctly. Opening the device with fewer channels than the endpoint
        advertises is the failure mode, not the samples.
        """
        sd = _import_sounddevice()
        try:
            import numpy as np  # noqa: PLC0415
        except Exception as exc:  # noqa: BLE001
            raise AudioError("numpy is unavailable: %s" % exc) from exc

        gain = max(0.0, min(1.0, float(volume)))
        mono = np.asarray(samples, dtype="float32").reshape(-1)
        if mono.size == 0:
            return 0.0

        target_rate = device_samplerate(device_index, int(samplerate))
        mono = resample(mono, int(samplerate), target_rate) * gain
        duration = mono.size / float(target_rate)

        if channels is None:
            # Fill every channel the endpoint advertises (2 for a normal stereo
            # pair). Asking for less is what corrupted playback here.
            try:
                info = sd.query_devices(device_index)
                channels = int(info.get("max_output_channels") or 2)
            except Exception:  # noqa: BLE001
                channels = 2
        channels = max(1, int(channels))
        data = np.repeat(mono.reshape(-1, 1), channels, axis=1).astype("float32")

        # Clear any module-level stream sounddevice is still holding before we
        # open ours; mixing the two is what corrupted repeat playback.
        self.flush_module_state()

        stream = sd.OutputStream(
            device=device_index,
            samplerate=target_rate,
            channels=channels,
            dtype="float32",
            latency="high",
            blocksize=0,
        )
        self._stream = stream

        # Tail padding. `stream.stop()` is not guaranteed to have drained the
        # device buffer, so the last few blocks of audio were being dropped and
        # the final syllable got clipped. Appending real silence (and letting it
        # play out) gives the buffered speech a chance to reach the speaker.
        try:
            pad_frames = int(stream.blocksize or target_rate * 0.25)
        except Exception:  # noqa: BLE001
            pad_frames = int(target_rate * 0.25)
        pad_frames = max(int(target_rate * 0.2), int(pad_frames))
        padded = np.concatenate([
            data,
            np.zeros((pad_frames, channels), dtype="float32"),
        ])

        try:
            stream.start()
            stream.write(padded)
            # `write()` returns once the data is queued, not once it is audible;
            # sleep out the padding so the buffered tail actually plays.
            time.sleep(pad_frames / float(target_rate))
            stream.stop()
        finally:
            try:
                stream.close()
            except Exception:  # noqa: BLE001
                pass
            self._stream = None
        return duration

    def stop(self) -> None:
        """Abort any in-flight playback as quickly as PortAudio allows."""
        stream = self._stream
        if stream is None:
            return
        try:
            stream.abort()
        except Exception:  # noqa: BLE001
            pass
        try:
            stream.close()
        except Exception:  # noqa: BLE001
            pass
        self._stream = None

    def flush_module_state(self) -> None:
        """Drop any stream PortAudio is still holding module-wide.

        sounddevice keeps a module-level stream from `sd.play()`; leaving it
        around while opening our own stream is exactly the kind of cross-state
        that produced the repeat-playback defect.
        """
        sd = _import_sounddevice()
        try:
            sd.stop()
        except Exception:  # noqa: BLE001
            pass
        try:
            # Give the WASAPI endpoint a moment to settle after a close.
            import time as _time  # noqa: PLC0415

            _time.sleep(0.05)
        except Exception:  # noqa: BLE001
            pass

    def warm_up(self, device_index: int, samplerate: int, channels: int | None = None,
                seconds: float = 0.20) -> bool:
        """Open the endpoint once with silence, then close it.

        Measured behaviour on this machine's Realtek loudspeaker endpoint: the
        FIRST stream open after the endpoint has been idle renders garbage, while
        an open that immediately follows another one is clean. Burning one silent
        stream turns the user's actual utterance into that second open.
        """
        sd = _import_sounddevice()
        try:
            import numpy as np  # noqa: PLC0415
        except Exception:  # noqa: BLE001
            return False

        if channels is None:
            try:
                info = sd.query_devices(device_index)
                channels = int(info.get("max_output_channels") or 2)
            except Exception:  # noqa: BLE001
                channels = 2

        self.flush_module_state()
        frames = max(1, int(samplerate * seconds))
        silence = np.zeros((frames, max(1, int(channels))), dtype="float32")
        try:
            stream = sd.OutputStream(
                device=device_index,
                samplerate=samplerate,
                channels=max(1, int(channels)),
                dtype="float32",
                latency="high",
                blocksize=0,
            )
            with stream:
                stream.write(silence)
            return True
        except Exception as exc:  # noqa: BLE001
            # Warm-up must never become a hard failure; playback reports its own.
            import sys as _sys  # noqa: PLC0415

            print("warm-up skipped: %s" % exc, file=_sys.stderr)
            return False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.stop()


def play_file_standalone(path: str, device: str = "", volume: float = 0.5) -> dict:
    """Play one wav to a concrete endpoint and exit.

    This is the playback fallback. A long-lived process that keeps opening and
    closing streams on these Realtek endpoints eventually renders silence even
    though every call returns success — while a freshly started process playing
    the same file to the same endpoint is audible every time. Running playback
    in its own short-lived process therefore trades a little latency for
    determinism.

    Returning a dict (rather than raising) keeps the caller's error handling in
    one place.
    """
    try:
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415

        devices = list_output_devices()
        chosen = resolve_device(devices, device)
        if chosen is None:
            return {"ok": False, "message": "找不到输出设备: %s" % (device or "自动")}
        index = int(chosen["index"])
        samples, sr = sf.read(path, dtype="float32", always_2d=False)
        mono = np.asarray(samples, dtype="float32").reshape(-1)
        speaker = Speaker()
        try:
            speaker.flush_module_state()
            duration = speaker.play(mono, int(sr), index, volume=volume)
        finally:
            speaker.close()
        return {
            "ok": True,
            "duration": round(float(duration), 3),
            "device": chosen["name"],
            "deviceIndex": index,
            "volume": float(volume),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": "%s: %s" % (type(exc).__name__, exc)}


def main() -> int:
    """CLI: play a wav to an endpoint, or list devices when given a flag."""
    import argparse
    import json

    parser = argparse.ArgumentParser(description="targeted audio output")
    parser.add_argument("--play", metavar="WAV", help="wav file to play")
    parser.add_argument("--device", default="", help="friendly-name substring (empty = auto)")
    parser.add_argument("--volume", type=float, default=0.5)
    parser.add_argument("--list", action="store_true", help="list output devices")
    args = parser.parse_args()

    if args.play:
        print(json.dumps(play_file_standalone(args.play, args.device, args.volume),
                         ensure_ascii=False))
        return 0

    want = args.device
    try:
        devices = list_output_devices()
    except AudioError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 1
    chosen = resolve_device(devices, want)
    print(json.dumps({"ok": True, "devices": devices, "chosen": chosen},
                     ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
