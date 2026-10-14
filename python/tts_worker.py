# -*- coding: utf-8 -*-
"""dsh-tts-speakout inference worker.

Long-lived NDJSON worker on stdin/stdout. It loads the Qwen3-TTS voice-clone
model once, serves synthesis requests serially, and renders the result to one
explicitly chosen output endpoint.

Protocol (one JSON object per line, UTF-8):

  in : {"id":1,"op":"speak","text_b64":"...","voice_id":"...","volume":0.8}
  out: {"type":"result","id":1,"ok":true,"duration":2.51,...}
       {"type":"error","id":1,"ok":false,"message":"..."}
       {"type":"status",...}          # on startup and on demand
       {"type":"log","level":"info","message":"..."}

Design notes
------------
* **stdout carries only protocol JSON.** Model libraries print banners, so fd 1
  is duplicated, then replaced by fd 2 while the libraries load; replies are
  written to the saved descriptor. Without this the NDJSON stream corrupts and
  the host reports "worker sent malformed JSON".
* **Model loading is lazy** (~4.5 s, 2.4 GB VRAM) and happens on the first
  synthesis, so plugin activation stays free.
* `attn_implementation` is never passed explicitly: on this Windows build,
  passing "sdpa" with bf16 segfaults the process.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any

# --------------------------------------------------------------- stdout guard

_PROTOCOL_FD = os.dup(1)


def _protect_stdout() -> None:
    """Point native fd 1 at stderr so library output cannot corrupt the stream."""
    try:
        os.dup2(2, 1)
    except Exception:  # noqa: BLE001
        pass


def _emit(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    data = (line + "\n").encode("utf-8")
    try:
        os.write(_PROTOCOL_FD, data)
    except OSError:
        try:
            sys.__stdout__.write(line + "\n")
            sys.__stdout__.flush()
        except Exception:  # noqa: BLE001
            pass


def log(level: str, message: str, data: dict[str, Any] | None = None) -> None:
    payload: dict[str, Any] = {"type": "log", "level": level, "message": message}
    if data:
        payload["data"] = data
    _emit(payload)


def b64(text: str | None) -> str:
    return base64.b64encode((text or "").encode("utf-8")).decode("ascii")


def unb64(value: str | None) -> str:
    if not value:
        return ""
    try:
        return base64.b64decode(value.encode("ascii")).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return ""


# --------------------------------------------------------------- environment

sys.path.insert(0, str(Path(__file__).resolve().parent))

import audio_out  # noqa: E402
import env_bootstrap  # noqa: E402

DEFAULT_SAMPLERATE = 24000


class Worker:
    def __init__(self, model_path: str, voices_dir: str | None, data_dir: str | None,
                 device: str = "", volume: float = 0.8, language: str = "Chinese",
                 max_new_tokens: int = 0, auto_pick_speaker: bool = True,
                 python_path: str | None = None, model_source: str = "auto",
                 bindings: dict[str, str] | None = None) -> None:
        self.model_path = model_path
        self.voices_dir = Path(voices_dir) if voices_dir else None
        self.data_dir = Path(data_dir) if data_dir else Path(tempfile.gettempdir()) / "dsh-tts-speakout"
        self.device_spec = device or ""
        # The user's binding for each of the four slots. Each one names a real
        # endpoint (or the kind alias); they are independent, so the user decides
        # what `primary` / `backup` / `speakers` / `headphones` point at.
        self.bindings = {
            slot: str((bindings or {}).get(slot, "") or "").strip()
            for slot in audio_out.SLOT_NAMES
        }
        # Which slot actually won the last resolution (shown in status/settings).
        self.active_source = ""
        self.volume = max(0.0, min(1.0, float(volume)))
        self.language = language or "Chinese"
        self.max_new_tokens = int(max_new_tokens or 0)
        self.auto_pick_speaker = auto_pick_speaker
        self.python_path = python_path
        self.model_source = model_source

        self.model = None
        self.loading = False
        self.load_error: str | None = None
        self.samplerate = DEFAULT_SAMPLERATE
        self._prompt_cache: dict[tuple, Any] = {}
        self._speaker = audio_out.Speaker()
        self._play_lock = threading.Lock()
        self._warmed: set[tuple[int, int]] = set()
        self._stop_flag = threading.Event()

        self.devices: list[dict[str, Any]] = []
        self.active_device: dict[str, Any] | None = None
        self._out_dir = self.data_dir / "out"
        self._out_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------ endpoint gain

    def endpoint_gain(self) -> dict[str, Any] | None:
        """Read the chosen endpoint's Windows volume/mute.

        A render stream can complete perfectly while the endpoint itself is
        muted or at 0 %, which is exactly the "the agent said it spoke but I
        heard nothing" failure. Surfacing this in `status` — and warning about it
        before playback — turns an invisible problem into a named one.
        """
        if not self.active_device:
            return None
        try:
            import volume_ctl  # noqa: PLC0415
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)}
        needle = str(self.active_device.get("name") or "")
        try:
            volume_ctl.ole32.CoInitialize(None)
            try:
                for _index, dev, name in volume_ctl.render_devices():
                    if name != needle:
                        continue
                    volume = volume_ctl.EndpointVolume(dev)
                    try:
                        return {
                            "name": name,
                            "volume": round(volume.scalar(), 4),
                            "muted": volume.muted(),
                        }
                    finally:
                        volume.close()
            finally:
                volume_ctl.ole32.CoUninitialize()
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)}
        return None

    def silent_warning(self) -> str | None:
        """A human-readable warning when the endpoint cannot be heard."""
        info = self.endpoint_gain()
        if not info or info.get("error"):
            return None
        if info.get("muted"):
            return ("输出通道「%s」当前被**静音**，喊话不会有声音。"
                    "请取消静音或调高音量。" % info.get("name"))
        if float(info.get("volume") or 0) <= 0.001:
            return ("输出通道「%s」的系统音量为 **0%%**，喊话不会有声音。"
                    "请调高音量。" % info.get("name"))
        if float(info.get("volume") or 1) < 0.15:
            return ("输出通道「%s」的系统音量仅 %.0f%%，可能听不清。"
                    % (info.get("name"), float(info["volume"]) * 100))
        return None

    # ------------------------------------------------------------ devices

    def refresh_devices(self) -> list[dict[str, Any]]:
        try:
            rows = audio_out.list_output_devices()
        except audio_out.AudioError as exc:
            log("warn", "输出设备枚举失败: %s" % exc)
            self.devices = []
            self.active_device = None
            return []
        if not self.auto_pick_speaker:
            for row in rows:
                row["suggested"] = False
        self.devices = rows
        chosen = self.select_device()
        self.active_device = chosen["device"] if chosen else None
        self.active_source = str(chosen.get("used", "")) if chosen else ""
        if self.active_device:
            log("info", "输出通道: %s (%s)%s"
                % (self.active_device["name"], self.active_device["hostapi"],
                   (" [来自偏好: %s]" % self.active_source) if self.active_source else ""),
                {"deviceIndex": self.active_device["index"]})
        else:
            log("warn", "未找到可用的输出设备，将无法发声")
        return rows

    def route_chain(self) -> list[str]:
        """The ordered slots this worker walks when nothing is pinned.

        Always all four, `primary` first: an unbound slot still resolves through
        its default, so the chain never stalls and a bound slot is never dead
        weight.
        """
        return audio_out.expand_chain(self.bindings)

    def select_device(self) -> dict[str, Any] | None:
        """Which endpoint this worker should speak through, by user precedence.

        Order (highest first):
          1. `device` — an explicit pin the user set, or the channel the host
             pushed for this session.
          2. the slot chain: `primary` -> `backup` -> `speakers` -> `headphones`.
             The first *reachable* slot wins, which is exactly what the fallback
             slots are for.
          3. the automatic heuristic (speakers preferred over headsets, virtual
             cables deprioritised), used when the chain yields nothing.
        """
        pin = str(self.device_spec or "").strip()
        if pin:
            resolved = audio_out.resolve_device(self.devices, pin, self.bindings)
            if resolved is not None:
                return {"device": resolved, "used": pin, "slot": audio_out.slot_of(pin), "index": -1}
            # A pin outranks the chain, but a pin that cannot be opened must not
            # silence the plugin entirely; fall through and say so.
            log("warn", "指定通道当前不可用（%s），改走槽位链或自动选择" % pin)

        chain = self.route_chain()
        if chain:
            picked = audio_out.resolve_chain(self.devices, chain, self.bindings)
            if picked is not None:
                return picked
            log("warn", "槽位链里没有任何可用端口，回退到自动选择")

        resolved = audio_out.resolve_device(self.devices, None, self.bindings)
        if resolved is None:
            return None
        return {"device": resolved, "used": "", "slot": "", "index": -1}

    def resolve_device_index(self) -> int:
        if not self.devices:
            self.refresh_devices()
        # Probe-based: an endpoint that cannot be opened must never be selected,
        # or a speak-out would "succeed" while producing no sound.
        chosen = self.select_device()
        if chosen is None:
            raise audio_out.AudioError(
                "找不到任何可用的输出通道。请检查系统音频设备是否正常。"
            )
        self.active_device = chosen["device"]
        self.active_source = str(chosen.get("used", ""))
        return int(self.active_device["index"])

    def device_names(self, limit: int = 12, reachable_only: bool = True) -> str:
        """Friendly names of endpoints, for error text.

        Defaults to endpoints Windows reports as ACTIVE: telling a caller that
        "耳机" is available when the jack is empty would be worse than saying
        nothing. Included so a caller that asked for a wrong channel learns the
        valid names from the same reply instead of guessing repeatedly.
        """
        rows = self.devices
        if reachable_only:
            live = [d for d in rows if d.get("reachable") is not False]
            if live:
                rows = live
        # De-duplicate: DirectSound/WASAPI/WDM-KS expose the same endpoint under
        # the same name, and a 25-item list buries the useful part.
        names: list[str] = []
        for d in rows:
            name = str(d.get("name") or "")
            if name and name not in names:
                names.append(name)
        if not names:
            return ""
        if len(names) > limit:
            return ", ".join(names[:limit]) + " 等 %d 个" % len(names)
        return ", ".join(names)

    def resolve_explicit_device(self, device: str) -> int:
        """Validate an explicitly requested output and return its index.

        `device` is normally one of the four slot names (`primary` / `backup` /
        `speakers` / `headphones`); a raw device name is still accepted so a user
        can point at one exact endpoint. Re-enumerates the OS first: this runs as a
        pre-flight check before synthesis, and the point is to fail fast when the
        request cannot be honoured.

        STRICT BY DESIGN: a slot that cannot resolve raises instead of falling back
        to another output. Silently speaking through a different port would make
        the user believe they heard the one they asked for. Availability is decided
        by actually opening the endpoint, not by its name, because the Realtek
        headphone jack is enumerated even with nothing plugged in.
        """
        spec = str(device or "").strip()
        self.refresh_devices()
        if not self.devices:
            raise audio_out.AudioError(
                "当前枚举不到任何音频输出设备，无法确定输出通道「%s」是否可用。" % spec
            )

        slot = audio_out.slot_of(spec)
        if slot:
            working = audio_out.port_candidates(self.devices, slot, self.bindings)
            if not working:
                bound = str(self.bindings.get(slot, "") or "")
                detail = ("（槽位绑定为「%s」）" % bound) if bound else "（未绑定，按类型自动判断）"
                raise audio_out.AudioError(
                    "输出槽位 %s 当前没有可用端点%s。"
                    "可用通道: %s"
                    % (slot, detail, self.device_names())
                )
            self.active_device = working[0]
            log("info", "按调用方要求使用槽位 %s -> %s (%s)"
                % (slot, self.active_device["name"], self.active_device["hostapi"]))
            return int(self.active_device["index"])

        matches = audio_out.name_matches_candidates(self.devices, spec)
        if not matches:
            raise audio_out.AudioError(
                "指定的输出通道不存在（%s）。可用槽位: %s。可用通道: %s"
                % (spec, ", ".join(audio_out.SLOT_NAMES), self.device_names())
            )

        working = audio_out.devices_for_spec(self.devices, spec)
        if not working:
            # The name matched, but no endpoint behind it can be opened: a jack
            # with nothing plugged in, or a disabled device. Saying so beats a
            # generic failure, because the fix ("plug it in") differs from
            # "pick another channel".
            found = " / ".join(sorted({str(r.get("name", "")) for r in matches})[:3])
            raise audio_out.AudioError(
                "指定的输出通道当前不可用（%s，匹配到 %s）。"
                "它可能没有插入或已被禁用；当前可用的通道: %s"
                % (spec, found, self.device_names())
            )

        self.active_device = working[0]
        log("info", "按调用方要求使用输出通道: %s (%s)"
            % (self.active_device["name"], self.active_device["hostapi"]))
        return int(self.active_device["index"])

    # ------------------------------------------------------------ voices

    def list_voices(self) -> list[dict[str, Any]]:
        if not self.voices_dir or not self.voices_dir.is_dir():
            return []
        out: list[dict[str, Any]] = []
        for entry in sorted(self.voices_dir.iterdir()):
            meta = entry / "voice.json"
            if not meta.is_file():
                continue
            try:
                payload = json.loads(meta.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            ref = entry / (payload.get("refFile") or "ref.wav")
            out.append({
                "id": str(payload.get("id") or entry.name),
                "title": str(payload.get("title") or entry.name),
                "title_b64": b64(str(payload.get("title") or entry.name)),
                "mode": str(payload.get("mode") or "xvec"),
                "language": str(payload.get("language") or self.language),
                "hasRefText": bool((payload.get("refText") or "").strip()),
                "refAudio": str(ref) if ref.is_file() else "",
                "refText": str(payload.get("refText") or ""),
            })
        return out

    def default_voice_id(self) -> str:
        """The voice the host marked as default, read from the shared config.

        The host owns which preset is default (the settings panel can change it
        at any time), so this is re-read per call rather than cached at startup.
        """
        if not self.data_dir:
            return ""
        try:
            payload = json.loads((self.data_dir / "config.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return ""
        return str(payload.get("defaultVoice") or "")

    def find_voice(self, voice_id: str | None) -> dict[str, Any] | None:
        voices = self.list_voices()
        if not voices:
            return None
        wanted = voice_id or self.default_voice_id()
        if not wanted:
            return voices[0]
        for voice in voices:
            if voice["id"] == wanted:
                return voice
        if voice_id:
            raise ValueError("音色不存在: %s（可用: %s）"
                             % (voice_id, ", ".join(v["id"] for v in voices)))
        log("warn", "默认音色 %s 已不存在，改用 %s" % (wanted, voices[0]["id"]))
        return voices[0]

    def prompt_for(self, voice: dict[str, Any]):
        """Build (and cache) the reusable voice-clone prompt for one preset."""
        ref_audio = voice.get("refAudio")
        if not ref_audio or not Path(ref_audio).is_file():
            raise ValueError("音色 %s 的参考音频缺失: %s" % (voice["id"], ref_audio))
        xvec = (voice.get("mode") or "xvec").lower() == "xvec"
        ref_text = "" if xvec else (voice.get("refText") or "").strip()
        if not xvec and not ref_text:
            # ICL without a transcript makes the model run to max_new_tokens;
            # fall back to the speaker-vector path instead of hanging.
            log("warn", "音色 %s 未填写参考文本，自动使用 xvec 模式（仅音色，韵律弱一些）" % voice["id"])
            xvec = True
        key = (ref_audio, ref_text, xvec)
        if key not in self._prompt_cache:
            self._ensure_model()
            self._prompt_cache[key] = self.model.create_voice_clone_prompt(
                ref_audio=ref_audio, ref_text=ref_text or None, x_vector_only_mode=xvec,
            )
            log("info", "已建立音色特征: %s" % voice["title"])
        return self._prompt_cache[key]

    # ------------------------------------------------------------ model

    def _ensure_model(self) -> None:
        if self.model is not None:
            return
        if self.load_error:
            raise RuntimeError("模型加载此前失败: %s" % self.load_error)
        self.loading = True
        started = time.time()
        log("info", "首次调用：正在加载 Qwen3-TTS 模型（约 5 秒）…")
        try:
            _protect_stdout()
            import torch  # noqa: PLC0415
            from qwen_tts import Qwen3TTSModel  # noqa: PLC0415

            device_map = "cuda:0" if torch.cuda.is_available() else "cpu"
            dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
            self.model = Qwen3TTSModel.from_pretrained(
                self.model_path,
                device_map=device_map,
                dtype=dtype,
                # Never pass "sdpa" explicitly: bf16 + explicit sdpa segfaults here.
                attn_implementation=None,
            )
            self.loading = False
            log("info", "模型加载完成（%.1fs，%s）" % (time.time() - started, device_map))
        except Exception as exc:  # noqa: BLE001
            self.loading = False
            self.load_error = str(exc)
            log("error", "模型加载失败: %s" % exc)
            raise

    def preload(self) -> dict[str, Any]:
        self._ensure_model()
        return {"ready": True, "loadSeconds": None}

    # ------------------------------------------------------------ synthesis

    def synthesize(self, text: str, voice: dict[str, Any], language: str | None,
                   max_new_tokens: int | None) -> tuple[str, dict[str, Any]]:
        if not text.strip():
            raise ValueError("要说的文本为空")
        self._ensure_model()
        prompt = self.prompt_for(voice)
        lang = language or voice.get("language") or self.language
        cap = int(max_new_tokens or self.max_new_tokens or min(4096, max(1024, len(text) * 8)))

        voice_lang = (voice.get("language") or "").strip().lower()
        if voice_lang and voice_lang != str(lang).strip().lower():
            # A reference clip in one language driving synthesis in another is
            # the classic source of "why does it sound so wrong": the clone
            # carries the reference's phonetics and prosody across languages.
            log("warn",
                "音色「%s」的母本是 %s，而这次要用 %s 合成；跨语言会让音色与语调都不自然。"
                "建议导入一段 %s 母本，或把合成语言改成 %s。"
                % (voice["title"], voice.get("language"), lang, lang, voice.get("language")))

        _protect_stdout()
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415

        started = time.time()
        wavs, sr = self.model.generate_voice_clone(
            text=text,
            language=lang,
            voice_clone_prompt=prompt,
            max_new_tokens=cap,
        )
        gen_seconds = time.time() - started
        audio = np.asarray(wavs[0]).reshape(-1)
        duration = float(audio.size) / float(sr) if audio.size else 0.0

        target = self._out_dir / ("speak-%d.wav" % int(time.time() * 1000))
        sf.write(str(target), audio, int(sr))
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        return str(target), {
            "duration": round(duration, 3),
            "sampleRate": int(sr),
            "genSeconds": round(gen_seconds, 2),
            "rtf": round(gen_seconds / duration, 2) if duration else None,
            "peak": round(peak, 4),
            "voiceId": voice["id"],
            "language": lang,
        }

    # ------------------------------------------------------------ playback

    def ensure_warm(self, index: int, samplerate: int) -> bool:
        """Burn one silent stream so the user's utterance is the second open.

        The first stream open on an idle Realtek loudspeaker endpoint renders
        garbage here, while every immediate re-open is clean. Warming once per
        (device, rate) makes the very first thing the user hears the good one.
        """
        key = (int(index), int(samplerate))
        if key in self._warmed:
            return True
        ok = self._speaker.warm_up(int(index), int(samplerate))
        if ok:
            self._warmed.add(key)
            log("debug", "端点已预热: %s" % (self.active_device["name"]
                                        if self.active_device else index))
        return ok

    def play_file(self, path: str, volume: float | None = None,
                  device: str | None = None,
                  validate_only: bool = False) -> dict[str, Any]:
        """Play a wav, or (with `validate_only`) merely validate the endpoint.

        `device` is an optional caller-requested channel; when given it is
        pre-flight checked here. `validate_only` exists so a caller can confirm
        the channel is usable BEFORE paying for synthesis: the check must be
        cheap so an unavailable channel fails fast.
        """
        spec = str(device or "").strip()
        index = (self.resolve_explicit_device(spec) if spec
                 else self.resolve_device_index())
        if validate_only:
            return {
                "validated": True,
                "device": self.active_device["name"] if self.active_device else None,
                "deviceIndex": index,
            }

        _protect_stdout()
        import soundfile as sf  # noqa: PLC0415

        if not Path(path).is_file():
            raise ValueError("音频文件不存在: %s" % path)
        samples, sr = sf.read(path, dtype="float32", always_2d=False)
        gain = self.volume if volume is None else max(0.0, min(1.0, float(volume)))
        started = time.time()
        with self._play_lock:
            rate = audio_out.device_samplerate(index, int(sr))
            info = audio_out._import_sounddevice().query_devices(index)
            log("debug",
                "播放开始: file=%s device=%s[%s] %sHz->%dHz ch=%s vol=%.2f"
                % (Path(path).name,
                   self.active_device["name"] if self.active_device else "?",
                   index, sr, rate, info.get("max_output_channels"), gain))
            self.ensure_warm(index, rate)
            try:
                duration = self._speaker.play(samples, int(sr), index, volume=gain)
            except Exception as exc:  # noqa: BLE001
                log("error", "播放失败: %s" % exc)
                raise
            log("debug", "播放结束: %.3fs（墙钟 %.2fs）"
                % (duration, time.time() - started))
        return {
            "duration": round(duration, 3),
            "sampleRate": int(sr),
            "device": self.active_device["name"] if self.active_device else None,
            "volume": gain,
            "playedMs": int((time.time() - started) * 1000),
        }

    def stop(self) -> dict[str, Any]:
        self._stop_flag.set()
        self._speaker.stop()
        return {"stopped": True}

    # ------------------------------------------------------------ status

    def status(self, include_devices: bool = True) -> dict[str, Any]:
        voices = self.list_voices()
        payload: dict[str, Any] = {
            # NOTE: this dict is nested under `status` in the reply frame, never
            # spread at frame top level — a "type" key here would clobber the
            # envelope's own type and break request/response correlation.
            "ready": self.model is not None,
            "loading": self.loading,
            "error": self.load_error,
            "model": self.model_path,
            "model_b64": b64(self.model_path),
            "samplerate": self.samplerate,
            "device": self.active_device["name"] if self.active_device else "",
            "device_b64": b64(self.active_device["name"] if self.active_device else ""),
            "deviceIndex": self.active_device["index"] if self.active_device else None,
            "deviceSpec": self.device_spec,
            "deviceSource": self.active_source,
            "deviceSource_b64": b64(self.active_source),
            "slotBindings": dict(self.bindings),
            "routeChain": self.route_chain(),
            "volume": self.volume,
            "language": self.language,
            "autoPickSpeaker": self.auto_pick_speaker,
            "voices": [
                {"id": v["id"], "title_b64": v["title_b64"], "mode": v["mode"],
                 "language": v["language"], "hasRefText": v["hasRefText"]}
                for v in voices
            ],
            "voiceCount": len(voices),
            "defaultVoiceId": self.default_voice_id(),
        }
        gain = self.endpoint_gain()
        if gain is not None:
            payload["endpoint"] = gain
        warning = self.silent_warning()
        if warning:
            payload["audibleWarning"] = warning
            payload["audibleWarning_b64"] = b64(warning)
        if include_devices:
            payload["devices"] = [
                {"index": d["index"], "name_b64": b64(d["name"]), "hostapi": d["hostapi"],
                 "suggested": d.get("suggested", False), "virtual": d.get("virtual", False),
                 # Reachability is what the settings page needs to grey out a
                 # jack with nothing plugged in.
                 "reachable": d.get("reachable")}
                for d in self.devices
            ]
        return payload


# --------------------------------------------------------------- request loop

def handle(worker: Worker, request: dict[str, Any]) -> dict[str, Any]:
    op = str(request.get("op") or "").strip()

    if op == "status":
        return {"status": worker.status()}
    if op == "list_devices":
        if request.get("refresh"):
            worker.refresh_devices()
        return {"status": worker.status()}

    if op == "set_device" or op == "set_config":
        if "device" in request:
            worker.device_spec = str(request.get("device") or "")
        if "slotBindings" in request:
            raw = request.get("slotBindings") or {}
            worker.bindings = {
                slot: str((raw or {}).get(slot, "") or "").strip()
                for slot in audio_out.SLOT_NAMES
            }
        if request.get("volume") is not None:
            worker.volume = max(0.0, min(1.0, float(request["volume"])))
        if request.get("language"):
            worker.language = str(request["language"])
        if request.get("maxNewTokens") is not None:
            worker.max_new_tokens = int(request["maxNewTokens"] or 0)
        if request.get("autoPickSpeaker") is not None:
            worker.auto_pick_speaker = bool(request["autoPickSpeaker"])
        worker.refresh_devices()
        return worker.status()

    if op == "preload":
        worker.preload()
        return worker.status()

    if op == "stop":
        return worker.stop()

    if op == "synthesize":
        text = unb64(request.get("text_b64")) or str(request.get("text") or "")
        voice = worker.find_voice(request.get("voice_id"))
        if voice is None:
            raise ValueError("还没有任何音色。请先在插件设置里导入一段母本音频。")
        path, info = worker.synthesize(text, voice, request.get("language"),
                                       request.get("max_new_tokens"))
        payload = {"file": path, "file_b64": b64(path), "path_b64": b64(path)}
        payload.update(info)
        return payload

    if op == "play":
        path = unb64(request.get("file_b64")) or str(request.get("file") or "")
        return worker.play_file(path, request.get("volume"))

    if op == "speak":
        text = unb64(request.get("text_b64")) or str(request.get("text") or "")
        voice = worker.find_voice(request.get("voice_id"))
        if voice is None:
            raise ValueError("还没有任何音色。请先在插件设置里导入一段母本音频。")

        # Pre-flight the output channel BEFORE synthesizing. Synthesis costs
        # seconds (and a cold model load costs ~10s), so discovering only
        # afterwards that the requested channel does not exist wastes the
        # caller's time and returns a confusing "rendered fine but unusable"
        # result. `validate_only` makes the check cheap and immediate.
        requested_device = unb64(request.get("device_b64")) or str(request.get("device") or "")
        try:
            worker.play_file("", None, requested_device or None, validate_only=True)
        except audio_out.AudioError as exc:
            raise ValueError(str(exc)) from exc

        path, info = worker.synthesize(text, voice, request.get("language"),
                                       request.get("max_new_tokens"))
        payload = {"file": path, "file_b64": b64(path), "path_b64": b64(path)}
        payload.update(info)
        # `no_play` synthesizes only. The host uses it for the preview, where
        # playback runs in a short-lived process instead: a long-lived process
        # eventually renders silence on these Realtek endpoints even though each
        # call reports success, while a fresh process is audible every time.
        if request.get("no_play") is True:
            payload["playedMs"] = 0
            payload["device"] = (worker.active_device["name"]
                                 if worker.active_device else None)
            payload["deviceIndex"] = (worker.active_device["index"]
                                      if worker.active_device else None)
            payload["volume"] = worker.volume
            return payload

        # The channel was already resolved by the pre-flight above, and
        # play_file re-resolves the same spec, so the announced device is the
        # one actually opened.
        _emit({"type": "playing", "started": True, "file": path,
               "duration": info["duration"], "device": worker.active_device["name"]
               if worker.active_device else None})
        played = worker.play_file(path, request.get("volume"),
                                  requested_device or None)
        _emit({"type": "played", "started": False, "file": path, **played})
        payload.update({k: v for k, v in played.items() if k in ("device", "volume", "playedMs")})
        return payload

    if op == "shutdown":
        return {"bye": True}

    raise ValueError("未知操作: %s" % op)


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    _protect_stdout()

    model_path = args.get("model") or os.environ.get("DSH_TTS_MODEL") or ""
    if not model_path:
        _emit({"type": "error", "ok": False, "message": "缺少 --model 参数"})
        return 2

    worker = Worker(
        model_path=model_path,
        voices_dir=args.get("voices-dir"),
        data_dir=args.get("data-dir"),
        device=args.get("device") or "",
        volume=float(args.get("volume") or 0.8),
        language=args.get("language") or "Chinese",
        max_new_tokens=int(args.get("max-new-tokens") or 0),
        auto_pick_speaker=str(args.get("auto-pick-speaker", "true")).lower() != "false",
        python_path=args.get("python"),
        model_source=args.get("model-source") or "auto",
        bindings=_parse_bindings(args.get("slot-bindings")),
    )

    try:
        worker.refresh_devices()
    except Exception as exc:  # noqa: BLE001
        log("error", "设备初始化失败: %s" % exc)

    # Startup frame uses the same envelope as every other reply so the host can
    # parse it with one code path: {"type":"result","ok":true,"status":{...}}.
    _emit({"type": "result", "ok": True, "status": worker.status()})
    log("info", "worker 就绪，等待请求")

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(raw)
        except Exception as exc:  # noqa: BLE001
            _emit({"type": "error", "ok": False, "message": "请求 JSON 解析失败: %s" % exc})
            continue

        rid = request.get("id")
        try:
            payload = handle(worker, request)
            _emit({"type": "result", "id": rid, "ok": True, **payload})
            if str(request.get("op")) == "shutdown":
                break
        except Exception as exc:  # noqa: BLE001
            _emit({
                "type": "error", "id": rid, "ok": False,
                "message": str(exc),
                "detail": traceback.format_exc()[-2000:],
            })

    worker._speaker.close()
    return 0


def _parse_bindings(raw: str | None) -> dict[str, str]:
    """Decode the `--slot-bindings` argument.

    Format: `slot=device` pairs joined by '\\x1f' (unit separator, which cannot
    occur in a device name), so the four bindings travel as one argv entry and
    no escaping scheme is needed for spaces or non-ASCII names.
    """
    out: dict[str, str] = {}
    for chunk in str(raw or "").split("\x1f"):
        if not chunk:
            continue
        slot, _, value = chunk.partition("=")
        key = audio_out.slot_of(slot)
        if key and value:
            out[key] = value
    return out


def _parse_args(argv: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    index = 0
    while index < len(argv):
        token = argv[index]
        if token.startswith("--"):
            key = token[2:]
            if index + 1 < len(argv) and not argv[index + 1].startswith("--"):
                out[key] = argv[index + 1]
                index += 2
            else:
                out[key] = "true"
                index += 1
        else:
            index += 1
    return out


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
