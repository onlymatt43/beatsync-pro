#!/usr/bin/env python3
"""
analyze.py <audio_path>

Stdout: JSON with both onset and beat markers.
Stderr: progress info
"""

import sys
import json
import librosa
import numpy as np
from scipy.signal import find_peaks


def _detect_moments(y, sr):
    """Détecte les drops et build-ups via RMS + gradient."""
    rms = librosa.feature.rms(y=y)[0]
    rms_norm = rms / np.max(rms) if np.max(rms) > 0 else rms

    hop_length = 512
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr)

    # Gradient de l'énergie
    rms_grad = np.gradient(rms_norm)

    # Détection des build-ups (montées d'énergie)
    min_bu_frames = int(2.0 * sr / hop_length)
    bu_start = None
    buildups = []
    in_bu = False
    for i in range(len(rms_grad)):
        if rms_grad[i] > 0.01 and not in_bu:
            bu_start = i
            in_bu = True
        elif rms_grad[i] < -0.01 and in_bu:
            if len(rms_grad) - bu_start >= min_bu_frames:
                t0 = rms_times[bu_start]
                t1 = rms_times[min(i, len(rms_times) - 1)]
                buildups.append((t0, t1))
            in_bu = False
    if in_bu and len(rms_grad) - bu_start >= min_bu_frames:
        buildups.append((rms_times[bu_start], rms_times[-1]))

    def in_any_buildup(t):
        for s, e in buildups:
            if s - 0.5 <= t <= e + 0.5:
                return True
        return False

    return rms_times, rms_norm, buildups, in_any_buildup


def _detect_cuts(y, sr, intensity=1.0):
    # Simplified: just return onset times
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, backtrack=True)
    onset_times = [round(float(value), 6) for value in librosa.frames_to_time(onset_frames, sr=sr)]
    return onset_times, []


def main():
    if len(sys.argv) < 2:
        print("Usage: analyze.py <audio_path>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    print(f"Loading audio: {audio_path}", file=sys.stderr)
    y, sr = librosa.load(audio_path)
    duration_sec = librosa.get_duration(y=y, sr=sr)

    print("Detecting onsets...", file=sys.stderr)
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, backtrack=True)
    onset_times = [round(float(value), 6) for value in librosa.frames_to_time(onset_frames, sr=sr)]

    print("Detecting beats...", file=sys.stderr)
    beat_frames = librosa.onset.onset_detect(y=y, sr=sr, backtrack=False)
    beat_times = [round(float(value), 6) for value in librosa.frames_to_time(beat_frames, sr=sr)]

    rms = librosa.feature.rms(y=y)[0]
    if len(rms) > 160:
        bucket_size = len(rms) / 160
        waveform = []
        for index in range(160):
            start = int(index * bucket_size)
            end = int((index + 1) * bucket_size)
            bucket = rms[start:max(end, start + 1)]
            waveform.append(float(np.mean(bucket)) if len(bucket) else 0.0)
    else:
        waveform = [float(value) for value in rms]

    max_wave = max(waveform) if waveform else 0.0
    if max_wave > 0:
        waveform = [round(value / max_wave, 6) for value in waveform]
    else:
        waveform = [0.0 for _ in waveform]

    print(f"Found {len(onset_times)} onsets and {len(beat_times)} beats", file=sys.stderr)

    result = {
        "onsetNotes": onset_times,
        "beatNotes": beat_times,
        "onsetCount": len(onset_times),
        "beatCount": len(beat_times),
        "durationSec": round(float(duration_sec), 6),
        "waveform": waveform,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
