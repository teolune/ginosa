"""Detect's bass ear (W4.4), run by ginosa on this Mac in .stems/venv:

    bass.py <bass stem .wav> <output .json>

Two ears on the bass stem, each catching what the other misses:
1. Level: librosa's onsets (spectral flux under 1 kHz, 11.6 ms frames, peak-picking delta 0.12,
   moved back to where each attack begins), each with its strength.
2. Notes: Basic Pitch (Spotify, Apache-2.0; ONNX) transcribes the stem's notes, 27.5–600 Hz,
   onsets above 0.5, notes of at least 128 ms; at each start the lowest note counts (the rest are
   harmonics), with its loudness.
A start both hear (within 50 ms) counts, at the level onset's time; one heard only by level counts
when its strength is at least half the song's loud onsets' (the 90th percentile); one heard only
by Basic Pitch, when it's at least three quarters as loud as the song's loud notes. Chosen on 8
BabySlakh songs (2,964 bass notes): F 0.907 within ±50 ms (0.809 within ±30 ms), each song scored
with thresholds picked on the other seven, against 0.747 (±30) for level onsets alone.

Writes {"bass": [s…], "one_check": [s…]} (one_check: the starts only one ear heard, to mark as
doubtful). The stem is only read.
"""
import bisect
import json
import sys
from pathlib import Path

LEVEL_ALONE = 0.5
NOTES_ALONE = 0.75
TOGETHER = 0.05
SAME_START = 0.03


def level_onsets(path: str):
    import librosa
    import numpy as np

    y, sr = librosa.load(path, sr=22050, mono=True)
    hop = 256
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmax=1000)
    starts = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=True, delta=0.12)
    peaks = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=False, delta=0.12)
    if not len(peaks):
        return []
    strength = env[peaks]
    ref = float(np.percentile(strength, 90)) or 1.0
    return [(float(t), float(s) / ref) for t, s in zip(librosa.frames_to_time(starts, sr=sr, hop_length=hop), strength)]


def note_starts(path: str):
    import numpy as np
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    _, _, notes = predict(path, ICASSP_2022_MODEL_PATH, onset_threshold=0.5, minimum_note_length=128, minimum_frequency=27.5, maximum_frequency=600.0)
    merged = []
    for t, p, a in sorted((float(n[0]), int(n[2]), float(n[3])) for n in notes):
        if merged and t - merged[-1][0] <= SAME_START:
            if p < merged[-1][1]:
                merged[-1] = (merged[-1][0], p, max(a, merged[-1][2]))
            continue
        merged.append((t, p, a))
    if not merged:
        return []
    ref = float(np.percentile([a for _, _, a in merged], 90)) or 1.0
    return [(t, a / ref) for t, _, a in merged]


def near(t: float, times: list, within: float) -> bool:
    i = bisect.bisect_left(times, t - within)
    return i < len(times) and times[i] <= t + within


def main(stem: str, out: str) -> None:
    level = level_onsets(stem)
    notes = note_starts(stem)
    level_t = [t for t, _ in level]
    note_t = [t for t, _ in notes]
    starts, alone = [], []
    for t, s in level:
        if near(t, note_t, TOGETHER):
            starts.append(t)
        elif s >= LEVEL_ALONE:
            starts.append(t)
            alone.append(t)
    for t, a in notes:
        if not near(t, level_t, TOGETHER) and a >= NOTES_ALONE:
            starts.append(t)
            alone.append(t)
    result = {"bass": [round(t, 4) for t in sorted(starts)], "one_check": [round(t, 4) for t in sorted(alone)]}
    Path(out + ".partial").write_text(json.dumps(result))
    Path(out + ".partial").replace(out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: bass.py <bass stem .wav> <output .json>")
    main(sys.argv[1], sys.argv[2])
