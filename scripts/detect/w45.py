"""W4.5 lab: the beat grid. Beat This! (Foscarin, Schlüter and Widmer, ISMIR 2024; MIT) on the bench
songs and yours, a constant grid fitted to its beats, and how well each grid holds the drum hits.

Run through lab.py:  npm run detect-lab -- w45-beats [song…]   ·   w45-grids [song…]
"""
import json
import math
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import w43  # noqa: E402

ROOT = w43.ROOT
LAB = w43.LAB
# Beat This! downloads its checkpoint through torch.hub: into .stems/torch, never ~/.cache.
os.environ.setdefault("TORCH_HOME", str(ROOT / ".stems" / "torch"))
SONGS = ("generated-128", "dpackdist", "entrust", "star-1327741", "star-ismir-0443", "star-ismir-0445", "star-music-delta-rock")


def load_mono(path: Path):
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(y.mean(axis=1)), sr


def beats(*slugs: str) -> dict:
    """Beat This! (final0, no DBN) on each song's full mix: its beats and downbeats, timed."""
    from beat_this.inference import Audio2Beats

    import torch

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    out = {}
    tracker = None
    for slug in slugs or SONGS:
        key = w43.key_of(slug)
        y, sr = load_mono((ROOT / key["audio"]).resolve())
        if tracker is None:
            started = time.time()
            tracker = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)
            out["load seconds"] = round(time.time() - started, 1)
        started = time.time()
        b, d = tracker(y, sr)
        seconds = time.time() - started
        record = {"beats": [round(float(x), 4) for x in b], "downbeats": [round(float(x), 4) for x in d], "seconds": round(seconds, 2), "device": device, "songSeconds": round(len(y) / sr, 1)}
        (LAB / "beats").mkdir(parents=True, exist_ok=True)
        (LAB / "beats" / f"{slug}.json").write_text(json.dumps(record))
        out[slug] = {"beats": len(b), "downbeats": len(d), "seconds": record["seconds"], "device": device}
    return out


def fit_grid(b: list, d: list) -> dict:
    """A constant grid through Beat This!'s beats: the beat length within 5% of their median spacing
    on which they line up best (their phases' mean vector is longest; gaps and the 20 ms frames
    don't matter), the phase where they pile up, and bar 1 where most downbeats fall."""
    import numpy as np

    b = np.array(b)
    if len(b) < 8:
        return {}
    ibi = float(np.median(np.diff(b)))
    candidates = np.linspace(ibi * 0.95, ibi * 1.05, 4001)
    strength = np.abs(np.exp(2j * np.pi * b[:, None] / candidates[None, :]).mean(axis=0))
    period = float(candidates[int(np.argmax(strength))])
    t0 = (float(np.angle(np.exp(2j * np.pi * b / period).mean())) / (2 * np.pi) * period) % period
    resid = ((b - t0) / period - np.round((b - t0) / period)) * period
    votes = [0, 0, 0, 0]
    for x in d:
        k = int(round((x - t0) / period)) % 4
        votes[k] += 1
    k = int(np.argmax(votes))
    downbeat = t0 + k * period
    downbeat -= math.floor(downbeat / (4 * period)) * 4 * period  # the first bar at or after 0
    return {"bpm": round(60 / period, 3), "downbeat": round(float(downbeat), 4), "drift ms (90th pct)": round(float(np.percentile(np.abs(resid), 90)) * 1000, 1), "lined up": round(float(strength.max()), 3), "downbeat votes": votes}


def on_grid(times: list, bpm: float, downbeat: float, tol: float = 0.03) -> float:
    """The share of hits within `tol` of a 16th of the grid."""
    step = 60 / bpm / 4
    if not times:
        return 0.0
    return sum(1 for t in times if abs(((t - downbeat) / step - round((t - downbeat) / step)) * step) <= tol) / len(times)


def on_beats(times: list, b: list, tol: float = 0.03) -> float:
    """The share of hits within `tol` of a 16th of Beat This!'s own beats (each beat in four), which follow tempo changes."""
    import numpy as np

    b = np.array(b)
    if len(b) < 2 or not times:
        return 0.0
    grid = np.concatenate([np.linspace(b[i], b[i + 1], 4, endpoint=False) for i in range(len(b) - 1)])
    grid = np.sort(grid)
    t = np.array(times)
    i = np.clip(np.searchsorted(grid, t), 1, len(grid) - 1)
    near = np.minimum(np.abs(grid[i] - t), np.abs(grid[i - 1] - t))
    return float(np.mean(near <= tol))


def grids(*slugs: str) -> dict:
    """Each song's grid from Beat This!, and how many drum hits sit on its 16ths: the answer key's hits
    where there is one, else the drum transcriber's (listen.py's, made by `listen <song>`)."""
    out = {}
    for slug in slugs or SONGS:
        f = LAB / "beats" / f"{slug}.json"
        if not f.exists():
            beats(slug)
        rec = json.loads(f.read_text())
        g = fit_grid(rec["beats"], rec["downbeats"])
        key = w43.key_of(slug)
        hits = key.get("hits")
        source = "answer key"
        if not hits:
            listened = LAB / "listen" / slug / "drum-hits.json"
            hits = json.loads(listened.read_text()) if listened.exists() else {}
            source = "drum transcriber"
        times = sorted(t for k in ("kick", "clap", "hihat") for t in (hits.get(k) or []))
        row = {"grid": g, "hits from": source, "hits": len(times)}
        if g:
            row["by chance"] = round(min(1.0, 2 * 0.03 / (60 / g["bpm"] / 4)), 3)
            row["on the grid's 16ths"] = round(on_grid(times, g["bpm"], g["downbeat"]), 3)
            row["on its beats' 16ths"] = round(on_beats(times, rec["beats"]), 3)
            for name, bpm in (("half", g["bpm"] / 2), ("double", g["bpm"] * 2)):
                row[f"on the {name} grid's 16ths"] = round(on_grid(times, bpm, g["downbeat"]), 3)
        out[slug] = row
    return out


# ---- Bar 1 from context (your answer, 18 Nov: "the looped parts / chorus, the first kick, complete
# silence at the start"). Test songs with a known bar 1: your songs start on bar 1 (your DAW's
# export), the generated drums at 0.4 s; copies of them cut or delayed by known amounts.
TRUTH = {"dpackdist": (167.0, 0.0147), "entrust": (162.0, 0.0088), "generated-128": (128.0, 0.4)}
VARIANTS = [(s, op, amount) for s in ("dpackdist", "entrust", "generated-128") for op, amount in (("as is", 0), ("cut", 1), ("cut", 2), ("cut", 3), ("cut", 6), ("silence", 1.3))]


def variant_audio(slug: str, op: str, amount: float) -> tuple:
    """The song, or a copy with its first `amount` beats cut off or `amount` seconds of silence before it (in the lab)."""
    import subprocess

    src = (ROOT / w43.key_of(slug)["audio"]).resolve()
    bpm = TRUTH[slug][0]
    if op == "as is":
        return src, 0.0
    shift = -amount * 60 / bpm if op == "cut" else amount
    out = LAB / "input" / f"{slug}-{op}-{amount}.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    if not out.exists():
        filt = ["-ss", f"{-shift:.5f}"] if op == "cut" else ["-af", f"adelay={int(amount * 1000)}:all=1"]
        cmd = ["ffmpeg", "-v", "error", "-y", *(filt if op == "cut" else []), "-i", str(src), *(filt if op != "cut" else []), "-ac", "2", "-ar", "44100", str(out)]
        subprocess.run(cmd, check=True)
    return out, shift


def leading_silence(y, sr) -> float:
    """Seconds of near-silence (50 dB under the song's loudest 50 ms) before the first sound."""
    import numpy as np

    hop = int(sr * 0.01)
    frames = len(y) // hop
    rms = np.sqrt(np.mean(y[: frames * hop].reshape(frames, hop) ** 2, axis=1) + 1e-12)
    loud = np.percentile(20 * np.log10(rms), 99.5)
    first = int(np.argmax(20 * np.log10(rms) > loud - 50))
    return first * 0.01


def drum_hits_shifted(slug: str, shift: float) -> dict:
    key = w43.key_of(slug)
    hits = key.get("hits") or json.loads((LAB / "listen" / slug / "drum-hits.json").read_text())
    return {k: [t + shift for t in hits.get(k, []) if t + shift >= 0] for k in ("kick", "clap", "hihat")}


def rotation_evidence(bpm: float, t0: float, downbeats: list, hits: dict, silence: float, end: float) -> dict:
    """For each of the bar's 4 beats as bar 1 (at `bpm`, beats at t0 + n·beat): the evidence for it."""
    import numpy as np

    beat = 60 / bpm
    def pos(t):  # beat number and how far from it
        n = (t - t0) / beat
        return int(round(n)), abs(n - round(n)) * beat
    ev = {k: [0.0] * 4 for k in ("downbeats", "drums", "start", "changes")}
    for x in downbeats:
        n, off = pos(x)
        if off < 0.07:
            ev["downbeats"][n % 4] += 1
    count = {k: np.zeros(4) for k in ("kick", "clap")}
    for k in count:
        for x in hits.get(k, []):
            n, off = pos(x)
            if off < 0.05:
                count[k][n % 4] += 1
    for r in range(4):
        kick = np.roll(count["kick"], -r)
        snare = np.roll(count["clap"], -r)
        ev["drums"][r] = float(kick[0] + snare[1] + snare[3] - snare[0] - snare[2])
    # The first sound after silence, else the first kick: bar 1 is usually there.
    first = None
    if silence >= 0.1:
        first = silence
    elif hits.get("kick"):
        first = min(hits["kick"])
    if first is not None:
        n, off = pos(first)
        if off < 0.07:
            ev["start"][n % 4] = 1.0
    # Where the drum pattern changes: each beat, the pattern of the bar before against the bar after.
    steps = int(end / (beat / 4)) + 1
    grid = np.zeros((3, steps))
    for i, k in enumerate(("kick", "clap", "hihat")):
        for x in hits.get(k, []):
            s = int(round((x - t0) / (beat / 4)))
            if 0 <= s < steps:
                grid[i, s] = 1
    for b in range(4, steps // 4 - 4):
        before = grid[:, (b - 4) * 4 : b * 4]
        after = grid[:, b * 4 : (b + 4) * 4]
        ev["changes"][b % 4] += float(np.abs(before - after).sum())
    return ev


def bar_one(*names: str) -> dict:
    """Bar 1 for each test copy: Beat This!'s count and downbeats, then each piece of evidence's choice."""
    import numpy as np
    from beat_this.inference import Audio2Beats
    import torch

    tracker = Audio2Beats(checkpoint_path="final0", device="mps" if torch.backends.mps.is_available() else "cpu", dbn=False)
    out = {}
    for slug, op, amount in VARIANTS:
        name = f"{slug} {op} {amount}".strip()
        audio, shift = variant_audio(slug, op, amount)
        y, sr = load_mono(audio)
        b, d = tracker(y, sr)
        g = fit_grid([float(x) for x in b], [float(x) for x in d])
        bpm = g["bpm"] * (2 if g["bpm"] < 90 else 1)
        beat = 60 / bpm
        t0 = g["downbeat"] % beat
        hits = drum_hits_shifted(slug, shift)
        ev = rotation_evidence(bpm, t0, [float(x) for x in d], hits, leading_silence(y, sr), len(y) / sr)
        true_bpm, true_bar = TRUTH[slug]
        true_bar = (true_bar + shift) % (4 * 60 / true_bpm)
        truth = int(round((true_bar - t0) / beat)) % 4 if abs(bpm - true_bpm) < 1 else None
        out[name] = {"bpm": round(bpm, 3), "Beat This! bar 1": int(round((g["downbeat"] - t0) / beat)) % 4, "truth": truth, **{k: [round(x, 1) for x in v] for k, v in ev.items()}}
    return out


def refine_phase(y, sr, bpm: float, t0: float, reach: float = 0.04) -> float:
    """Moves the grid (beats at t0 + n·beat) by up to `reach` seconds, in 1 ms steps, to where the mix's
    onsets (librosa's onset strength, 5 ms frames) are strongest on its 16ths. Beat This!'s beats come in
    20 ms frames, and the hits on your songs sat 7–25 ms before them."""
    import librosa
    import numpy as np

    hop = int(sr * 0.005)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    frame_t = librosa.frames_to_time(np.arange(len(env)), sr=sr, hop_length=hop)
    step = 60 / bpm / 4
    grid = t0 % step + np.arange(0, len(y) / sr, step)
    best, best_score = 0.0, -1.0
    for shift in np.arange(-reach, reach + 1e-9, 0.001):
        score = float(np.interp(grid + shift, frame_t, env).sum())
        if score > best_score:
            best, best_score = float(shift), score
    return best


def phases(*slugs: str) -> dict:
    """The hits' offsets from the grid's 16ths (as a share of a 16th, median, even and odd 16ths) before
    and after moving Beat This!'s grid onto the mix's onsets."""
    import numpy as np

    out = {}
    for slug in slugs or SONGS:
        rec = json.loads((LAB / "beats" / f"{slug}.json").read_text())
        g = fit_grid(rec["beats"], rec["downbeats"])
        bpm = g["bpm"] * (2 if g["bpm"] < 90 else 1)
        key = w43.key_of(slug)
        y, sr = load_mono((ROOT / key["audio"]).resolve())
        shift = refine_phase(y, sr, bpm, g["downbeat"])
        hits = key.get("hits") or json.loads((LAB / "listen" / slug / "drum-hits.json").read_text())
        one = (hits.get("one_check") or {}) if isinstance(hits.get("one_check"), dict) else {}
        row = {"bpm": round(bpm, 3), "shift ms": round(shift * 1000, 1)}
        step = 60 / bpm / 4
        for label, t0 in (("before", g["downbeat"]), ("after", g["downbeat"] + shift)):
            parts = {}
            for k in ("kick", "clap", "hihat"):
                t = np.array(sorted(set(hits.get(k, [])) - set(one.get(k, []))))
                if not len(t):
                    continue
                n = (t - t0) / step
                s = np.round(n)
                off = n - s
                ok = np.abs(off) < 0.45
                even, odd = off[ok & (s % 2 == 0)], off[ok & (s % 2 == 1)]
                parts[k] = [round(float(np.median(even)) * 100, 1) if len(even) else None, round(float(np.median(odd)) * 100, 1) if len(odd) else None, int(len(odd))]
            row[label] = parts
        out[slug] = row
    return out
