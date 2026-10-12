# -*- coding: utf-8 -*-
"""Quality check for a voice-clone reference clip.

Reports the measurements that actually matter for zero-shot cloning: duration
(the model wants 5-15 s), clipping, silence ratio, DC offset and peak/RMS.
"""
import json
import sys

import numpy as np
import soundfile as sf


def main() -> int:
    path = sys.argv[1]
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    duration = len(mono) / float(sr)

    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    rms = float(np.sqrt(np.mean(mono ** 2))) if mono.size else 0.0
    dc = float(np.mean(mono)) if mono.size else 0.0
    clipped = int(np.sum(np.abs(mono) > 0.99))
    clip_ratio = clipped / len(mono) if len(mono) else 0.0

    # Frame energy -> silence ratio (20 ms frames, threshold 1% of peak RMS).
    frame = max(1, int(sr * 0.02))
    count = len(mono) // frame
    energy = np.array([float(np.sqrt(np.mean(mono[i * frame:(i + 1) * frame] ** 2)))
                       for i in range(count)]) if count else np.array([0.0])
    threshold = max(1e-4, float(np.percentile(energy, 90)) * 0.02)
    silence_ratio = float(np.mean(energy < threshold))

    # Simple SNR proxy: loud frames vs quiet frames.
    loud = energy[energy >= np.percentile(energy, 70)]
    quiet = energy[energy <= np.percentile(energy, 20)]
    snr_db = None
    if loud.size and quiet.size and float(np.mean(quiet)) > 0:
        snr_db = 20 * np.log10(float(np.mean(loud)) / float(np.mean(quiet)))

    head = float(np.max(np.abs(mono[: int(sr * 0.05)]))) if len(mono) > int(sr * 0.05) else 0.0
    tail = float(np.max(np.abs(mono[-int(sr * 0.05):]))) if len(mono) > int(sr * 0.05) else 0.0

    report = {
        "path": path,
        "durationSec": round(duration, 2),
        "sampleRate": int(sr),
        "channels": int(data.shape[1]),
        "peak": round(peak, 4),
        "rms": round(rms, 4),
        "dcOffset": round(dc, 5),
        "clippedSamples": clipped,
        "clipRatio": round(clip_ratio, 6),
        "silenceRatio": round(silence_ratio, 4),
        "snrDb": round(snr_db, 1) if snr_db is not None else None,
        "headTransient": round(head, 4),
        "tailTransient": round(tail, 4),
    }

    verdict = []
    if duration < 3:
        verdict.append("时长 <3s：信息不足，克隆会不稳")
    elif duration < 5:
        verdict.append("时长 3~5s：可用，但 5~15s 更好")
    elif duration <= 15:
        verdict.append("时长 5~15s：★ 最佳区间")
    elif duration <= 30:
        verdict.append("时长 15~30s：收益递减")
    else:
        verdict.append("⚠️ 时长 >30s：可能触发生成挂起，建议剪短")
    if clip_ratio > 0.001:
        verdict.append("⚠️ 存在削波（>0.1%% 样本），会引入失真")
    if silence_ratio > 0.5:
        verdict.append("静音占比偏高，有效语音可能不足")
    if abs(dc) > 0.01:
        verdict.append("存在直流偏移，建议高通滤波")
    if peak < 0.05:
        verdict.append("⚠️ 音量过低，信噪比差")
    if not verdict:
        verdict.append("无可疑项")
    report["verdict"] = verdict
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
