# -*- coding: utf-8 -*-
"""One-off audible check: speak a short line through the HEADPHONES at volume 0.3.

Bypasses the tool layer on purpose: the host-side `device` argument only takes
effect after a DSH restart, while this drives the same synthesis + playback code
paths directly, so it tests the audio chain itself.

The endpoint volume is set to 0.3 and RESTORED afterwards: 0.3 is a level the
user asked for in this one request, not a setting change.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "python"))

import audio_out  # noqa: E402
import volume_ctl  # noqa: E402

TARGET = "耳机"
WANT_VOLUME = 0.3
TEXT = "耳机通道测试，音量零点三。如果你能听清这句话，说明从耳机喊话已经正常工作了。"


def endpoint_volume(name: str):
    data = volume_ctl.list_endpoints()
    for row in data.get("devices", []):
        if row.get("name") == name:
            return row
    return None


def set_volume(name: str, volume: float) -> bool:
    try:
        out = subprocess.run(
            [sys.executable, str(ROOT / "python" / "volume_ctl.py"), "--set", name,
             "--volume", str(volume)],
            capture_output=True, text=True, timeout=60,
            env={**__import__("os").environ, "PYTHONIOENCODING": "utf-8"},
        )
        return out.returncode == 0
    except Exception as exc:  # noqa: BLE001
        print("   设置音量失败:", exc)
        return False


def main() -> int:
    audio_out.clear_probe_cache()

    # 1) Resolve the headphones for real (probe-based).
    rows = audio_out.list_output_devices()
    candidates = audio_out.devices_for_spec(rows, TARGET)
    if not candidates:
        print("无法解析耳机通道，已中止（不会发出任何声音）")
        return 1
    device = candidates[0]
    print(f"目标通道: {device['name']} (idx={device['index']}, {device['hostapi']})")

    before = endpoint_volume(device["name"])
    print(f"播放前端点音量: {before}")
    if before and before.get("muted"):
        print("端点当前是静音的，正在解除静音…")
        subprocess.run([sys.executable, str(ROOT / "python" / "volume_ctl.py"),
                        "--set", device["name"], "--mute", "false"],
                       capture_output=True, text=True, timeout=60)

    # 2) Synthesize (model loads here).
    from tts_worker import Worker  # noqa: PLC0415
    data_dir = Path.home() / ".dsh" / "tts-speakout"
    voices = data_dir / "voices"
    cfg_file = data_dir / "config.json"
    default_voice = ""
    if cfg_file.is_file():
        try:
            default_voice = str(json.loads(cfg_file.read_text(encoding="utf-8")).get("defaultVoice") or "")
        except Exception:  # noqa: BLE001
            default_voice = ""

    model_path = r"D:\qwen3tts\models\Qwen3-TTS-12Hz-0.6B-Base"
    w = Worker(model_path=model_path, voices_dir=str(voices), data_dir=str(data_dir),
               volume=WANT_VOLUME, language="Chinese")
    voice = w.find_voice(default_voice or None)
    if voice is None:
        print("没有找到可用音色，已中止")
        return 1
    print(f"使用音色: {voice.get('title') or voice.get('id')}")

    t0 = time.time()
    path, info = w.synthesize(TEXT, voice, "Chinese", None)
    print(f"合成完成: {info['duration']:.2f}s 音频, 用时 {time.time()-t0:.1f}s")

    # 3) Play through the headphones at 0.3.
    try:
        set_volume(device["name"], WANT_VOLUME)
        print(f"端点音量已设为 {WANT_VOLUME}，开始播放…")
        result = w.play_file(path, WANT_VOLUME, TARGET)
        print("播放结果:", json.dumps({k: v for k, v in result.items()}, ensure_ascii=False))
    finally:
        if before is not None:
            set_volume(device["name"], float(before["volume"]))
            if before.get("muted"):
                subprocess.run([sys.executable, str(ROOT / "python" / "volume_ctl.py"),
                                "--set", device["name"], "--mute", "true"],
                               capture_output=True, text=True, timeout=60)
            print(f"端点音量已恢复为 {before['volume']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
