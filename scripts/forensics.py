# -*- coding: utf-8 -*-
"""Silent forensics on a synthesized wav.

Distinguishes "the clone is imperfect" from "the signal is broken". A piercing
whistle / electronic crunch shows up as an absurd spectral centroid, an almost
binary zero-crossing rate, or non-finite samples — all measurable without
playing anything.

Usage: python forensics.py <wav> [wav2 ...]
"""
from __future__ import annotations

import json
import sys

import numpy as np
import soundfile as sf


def analyze(path: str) -> dict:
    data, sr = sf.read(path, dtype="float32", always_2d=False)
    mono = np.asarray(data, dtype="float64")
    if mono.ndim > 1:
        mono = mono.mean(axis=1)

    finite = np.isfinite(mono)
    report: dict = {
        "file": path,
        "sampleRate": int(sr),
        "frames": int(mono.size),
        "durationSec": round(mono.size / float(sr), 3),
        "nonFinite": int(mono.size - int(finite.sum())),
    }
    if not finite.all():
        report["verdict"] = "❌ 含 NaN/Inf 样本 —— 信号已损坏"
        return report

    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    rms = float(np.sqrt(np.mean(mono ** 2))) if mono.size else 0.0
    report["peak"] = round(peak, 4)
    report["rms"] = round(rms, 5)
    report["crestDb"] = round(20 * np.log10(peak / rms), 2) if rms > 0 else None

    # Spectral centroid over voiced frames — speech sits around 0.5-3 kHz.
    frame = 1024
    hop = 512
    centroids = []
    zcrs = []
    window = np.hanning(frame)
    for start in range(0, max(1, mono.size - frame), hop):
        seg = mono[start:start + frame]
        if seg.size < frame:
            break
        if float(np.sqrt(np.mean(seg ** 2))) < rms * 0.2:
            continue
        spec = np.abs(np.fft.rfft(seg * window))
        freqs = np.fft.rfftfreq(frame, 1.0 / sr)
        total = float(spec.sum())
        if total <= 0:
            continue
        centroids.append(float((spec * freqs).sum() / total))
        zcrs.append(float(np.mean(np.abs(np.diff(np.signbit(seg).astype(np.int8))))))

    report["spectralCentroidHz"] = round(float(np.mean(centroids)), 1) if centroids else None
    report["spectralCentroidP95Hz"] = round(float(np.percentile(centroids, 95)), 1) if centroids else None
    report["zeroCrossingRate"] = round(float(np.mean(zcrs)), 4) if zcrs else None

    # Energy above 8 kHz: speech has very little, a whistle/crunch has a lot.
    spec = np.abs(np.fft.rfft(mono * np.hanning(mono.size))) if mono.size else np.zeros(1)
    freqs = np.fft.rfftfreq(mono.size, 1.0 / sr) if mono.size else np.zeros(1)
    total = float(spec.sum()) or 1.0
    report["hfEnergyRatioAbove8k"] = round(float(spec[freqs > 8000].sum() / total), 5)
    report["hfEnergyRatioAbove12k"] = round(float(spec[freqs > 12000].sum() / total), 5)

    verdicts = []
    centroid = report["spectralCentroidHz"]
    if centroid is not None and centroid > 5000:
        verdicts.append("⚠️ 频谱质心异常偏高（>5kHz），听起来会发尖/发啸")
    if report["zeroCrossingRate"] is not None and report["zeroCrossingRate"] > 0.35:
        verdicts.append("⚠️ 过零率异常高，接近噪声而非语音")
    if report["hfEnergyRatioAbove8k"] > 0.08:
        verdicts.append("⚠️ 8kHz 以上能量过高，典型的电子崩坏/嘶声")
    if report["crestDb"] is not None and report["crestDb"] < 6:
        verdicts.append("⚠️ 波峰因数过低，像被压限的噪声")
    if peak >= 0.999:
        verdicts.append("⚠️ 达到满刻度，可能削波")
    report["verdict"] = verdicts or ["未见明显损坏特征"]
    return report


def main() -> int:
    for path in sys.argv[1:]:
        print(json.dumps(analyze(path), ensure_ascii=False, indent=1))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
