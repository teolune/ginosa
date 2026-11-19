"""W4.4 lab: bass note starts. Answer keys from BabySlakh (Manilow et al. 2019, CC BY 4.0: mixes
rendered from MIDI, so every bass note's start is known), and ways of finding the starts in a bass
stem: level onsets, pitch changes (pYIN), both, and a note transcriber (Basic Pitch) if installed.

Run through lab.py:  npm run detect-lab -- w44-prepare · w44-score [song…]
"""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import w43  # noqa: E402

ROOT, LAB = w43.ROOT, w43.LAB
SLAKH = ROOT / "media" / "bench" / "babyslakh"
TOL = 0.03
SONGS_WANTED = 8


def tracks() -> list:
    import yaml

    out = []
    for meta in sorted(SLAKH.rglob("metadata.yaml")):
        d = yaml.safe_load(meta.read_text())
        # BabySlakh's metadata says nothing was saved; the files say otherwise, so go by them.
        bass = [k for k, s in (d.get("stems") or {}).items() if s.get("inst_class") == "Bass" and (meta.parent / "MIDI" / f"{k}.mid").exists() and (meta.parent / "stems" / f"{k}.wav").exists()]
        if bass:
            out.append({"dir": meta.parent, "name": meta.parent.name, "bass": bass})
    return out


def bass_starts(track: dict) -> list:
    """Every bass note's start in the track's MIDI (notes starting within 30 ms of each other count once)."""
    import pretty_midi

    starts = []
    for stem in track["bass"]:
        f = track["dir"] / "MIDI" / f"{stem}.mid"
        if f.exists():
            for inst in pretty_midi.PrettyMIDI(str(f)).instruments:
                starts += [float(n.start) for n in inst.notes]
    starts.sort()
    merged = []
    for t in starts:
        if not merged or t - merged[-1] > TOL:
            merged.append(round(t, 4))
    return merged


def prepare(*_: str) -> dict:
    """The first songs with a bass part: their answer keys and BS-RoFormer-SW's bass stem from the mix."""
    out = {}
    for track in tracks()[:SONGS_WANTED]:
        slug = f"slakh-{track['name'].lower()}"
        starts = bass_starts(track)
        stereo = LAB / "input" / f"{slug}.wav"
        stereo.parent.mkdir(parents=True, exist_ok=True)
        if not stereo.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(track["dir"] / "mix.wav"), "-ac", "2", "-ar", "44100", str(stereo)], check=True)
        sep = LAB / "sep" / "BS-Roformer-SW" / slug
        if not (sep.exists() and w43.stem(sep, "bass")):
            w43.run_separator(stereo, "BS-Roformer-SW.ckpt", sep)
        key = {"name": f"BabySlakh {track['name']}", "audio": str(stereo.relative_to(ROOT)), "bass": starts, "clean": str((track["dir"] / "stems" / f"{track['bass'][0]}.wav").relative_to(ROOT))}
        (LAB / "keys").mkdir(parents=True, exist_ok=True)
        (LAB / "keys" / f"{slug}.json").write_text(json.dumps(key))
        out[slug] = {"bass notes": len(starts), "stem": str(w43.stem(sep, "bass").name)}
    return out


# ---- Ways of finding note starts in a bass recording (times in seconds).

def load(path: Path, sr: int = 22050):
    import librosa

    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return y, sr


def level_onsets(y, sr, gate_db: float = -24.0) -> list:
    """librosa's onsets (spectral flux, hop 256), kept when within `gate_db` of the loud ones."""
    import librosa
    import numpy as np

    hop = 256
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmax=1000)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=True)
    if not len(frames):
        return []
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    level = np.array([20 * np.log10(max(float(rms[f:f + 12].max()) if f < len(rms) else 1e-9, 1e-9)) for f in frames])
    ref = np.percentile(level, 90)
    return [round(float(t), 4) for t, l in zip(librosa.frames_to_time(frames, sr=sr, hop_length=hop), level) if l >= ref + gate_db]


def pitch_starts(y, sr, jump: float = 0.7, hold: int = 4):
    """pYIN's pitch (27–500 Hz, 11.6 ms frames): a note starts where the pitch appears after silence or
    moves by at least `jump` semitones and stays there `hold` frames. Also returns the pitch track."""
    import librosa
    import numpy as np

    hop = 256
    f0, voiced, _ = librosa.pyin(y, fmin=27.5, fmax=500.0, sr=sr, frame_length=4096, hop_length=hop)
    midi = librosa.hz_to_midi(np.where(voiced, f0, np.nan))
    times = librosa.times_like(f0, sr=sr, hop_length=hop)
    starts, current = [], None
    i = 0
    n = len(midi)
    while i < n:
        m = midi[i]
        if np.isnan(m):
            current = None
            i += 1
            continue
        if current is None or abs(m - current) >= jump:
            window = midi[i:i + hold]
            if len(window) == hold and not np.isnan(window).any() and np.all(np.abs(window - np.median(window)) < jump / 2):
                starts.append(round(float(times[i]), 4))
                current = float(np.median(window))
                i += hold
                continue
        i += 1
    return starts, (times, midi)


def combine(level: list, pitch: list, near: float = 0.06) -> list:
    """Both: each pitch start, moved to a level onset within `near` before or after it (attacks are sharper
    in level), plus level onsets with no pitch start near them (the same note played again)."""
    import bisect

    out = []
    for t in pitch:
        i = bisect.bisect_left(level, t - near)
        cands = [x for x in level[i:i + 4] if abs(x - t) <= near]
        out.append(min(cands, key=lambda x: abs(x - t)) if cands else t)
    for x in level:
        i = bisect.bisect_left(pitch, x - near)
        if not (i < len(pitch) and pitch[i] <= x + near):
            out.append(x)
    out.sort()
    merged = []
    for t in out:
        if not merged or t - merged[-1] > TOL:
            merged.append(t)
    return merged


def basic_pitch_starts(path: Path):
    try:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import predict
    except Exception as e:  # not installed
        return None, str(e).splitlines()[0][:120]
    _, _, notes = predict(str(path), ICASSP_2022_MODEL_PATH, minimum_frequency=27.5, maximum_frequency=500.0)
    starts = sorted(float(n[0]) for n in notes)
    merged = []
    for t in starts:
        if not merged or t - merged[-1] > TOL:
            merged.append(round(t, 4))
    return merged, None


def score(*slugs: str) -> dict:
    """F within ±30 ms per way, on BS-RoFormer-SW's bass stem and on the song's own clean bass (the ceiling)."""
    keys = sorted((LAB / "keys").glob("slakh-*.json"))
    if slugs:
        keys = [k for k in keys if k.stem in slugs]
    totals, songs = {}, {}
    for kf in keys:
        key = json.loads(kf.read_text())
        truth = key["bass"]
        sep = w43.stem(LAB / "sep" / "BS-Roformer-SW" / kf.stem, "bass")
        songs[kf.stem] = {"notes": len(truth)}
        for source, path in (("separated", sep), ("clean", ROOT / key["clean"])):
            y, sr = load(path)
            level = level_onsets(y, sr)
            pitch, _ = pitch_starts(y, sr)
            ways = {"level": level, "pitch": pitch, "both": combine(level, pitch)}
            bp, why = basic_pitch_starts(path)
            if bp is not None:
                ways["basic-pitch"] = bp
            elif why:
                songs[kf.stem]["basic-pitch"] = why
            for way, found in ways.items():
                m, f, t = w43.match(found, truth)
                agg = totals.setdefault(source, {}).setdefault(way, [0, 0, 0])
                agg[0] += m; agg[1] += f; agg[2] += t
                songs[kf.stem][f"{source} {way}"] = round(2 * m / (f + t), 3) if f + t else 1.0
    table = {s: {w: {"F": round(2 * m / (f + t), 3), "P": round(m / f, 3) if f else 0, "R": round(m / t, 3) if t else 0} for w, (m, f, t) in ws.items()} for s, ws in totals.items()}
    return {"totals": table, "songs": songs}


def offsets(found: list, truth: list, tol: float = 0.08) -> list:
    """Found minus true, for each true start with a found one within `tol` (nearest)."""
    import bisect

    out = []
    for t in truth:
        i = bisect.bisect_left(found, t - tol)
        cands = [x for x in found[i:i + 6] if abs(x - t) <= tol]
        if cands:
            out.append(min(cands, key=lambda x: abs(x - t)) - t)
    return out


def diagnose(*slugs: str) -> dict:
    """Per song on the separated stem: counts, timing offsets, F at ±30 and ±50 ms, and variants of
    level onsets (gate, peak-picking delta) and Basic Pitch (onset threshold, shortest note)."""
    import numpy as np
    import librosa

    keys = sorted((LAB / "keys").glob("slakh-*.json"))
    if slugs:
        keys = [k for k in keys if k.stem in slugs]
    totals = {}
    songs = {}
    for kf in keys:
        key = json.loads(kf.read_text())
        truth = key["bass"]
        sep = w43.stem(LAB / "sep" / "BS-Roformer-SW" / kf.stem, "bass")
        y, sr = load(sep)
        hop = 256
        env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmax=1000)
        rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
        ways = {}
        for delta in (0.03, 0.07, 0.12):
            frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=True, delta=delta)
            lv = np.array([20 * np.log10(max(float(rms[f:f + 12].max()) if f < len(rms) else 1e-9, 1e-9)) for f in frames]) if len(frames) else np.array([])
            ref = np.percentile(lv, 90) if len(lv) else 0
            times = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
            for gate in (-12, -18, -24, -36):
                ways[f"level d{delta} g{gate}"] = [float(t) for t, l in zip(times, lv) if l >= ref + gate]
        try:
            from basic_pitch import ICASSP_2022_MODEL_PATH
            from basic_pitch.inference import predict

            for onset_t in (0.3, 0.5):
                for min_len in (58, 128):
                    _, _, notes = predict(str(sep), ICASSP_2022_MODEL_PATH, onset_threshold=onset_t, minimum_note_length=min_len, minimum_frequency=27.5, maximum_frequency=600.0)
                    st = sorted(float(n[0]) for n in notes)
                    merged = []
                    for t in st:
                        if not merged or t - merged[-1] > TOL:
                            merged.append(t)
                    ways[f"basic-pitch on{onset_t} min{min_len}"] = merged
        except Exception as e:
            songs.setdefault(kf.stem, {})["basic-pitch error"] = str(e)[:200]
        row = {"notes": len(truth)}
        for way, found in ways.items():
            for tol in (0.03, 0.05):
                m, f, t = w43.match(found, truth, tol)
                agg = totals.setdefault(way, {}).setdefault(tol, [0, 0, 0])
                agg[0] += m; agg[1] += f; agg[2] += t
            off = offsets(found, truth)
            row[way] = {"found": len(found), "F30": round(2 * w43.match(found, truth)[0] / (len(found) + len(truth)), 3), "median offset ms": round(float(np.median(off)) * 1000, 1) if off else None}
        songs[kf.stem] = {**songs.get(kf.stem, {}), **row}
    table = {w: {f"F±{int(tol*1000)}": round(2 * m / (f + t), 3) for tol, (m, f, t) in v.items()} for w, v in totals.items()}
    return {"totals": dict(sorted(table.items(), key=lambda kv: -kv[1].get("F±30", 0))), "songs": songs}


def level_best(y, sr) -> list:
    """Level onsets as chosen in the lab: librosa's peak picking with delta 0.12, backtracked, no level gate needed."""
    import librosa

    hop = 256
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmax=1000)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=True, delta=0.12)
    return [float(t) for t in librosa.frames_to_time(frames, sr=sr, hop_length=hop)]


def bp_notes(path: Path) -> list:
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    _, _, notes = predict(str(path), ICASSP_2022_MODEL_PATH, onset_threshold=0.5, minimum_note_length=128, minimum_frequency=27.5, maximum_frequency=600.0)
    # The lowest note at each start (a bass plays one note at a time; higher ones are its harmonics).
    notes = sorted((float(n[0]), int(n[2])) for n in notes)
    out = []
    for t, p in notes:
        if out and t - out[-1][0] <= TOL:
            if p < out[-1][1]:
                out[-1] = (out[-1][0], p)
            continue
        out.append((t, p))
    return out


def combos(*slugs: str) -> dict:
    import bisect

    def near(t, xs, w):
        i = bisect.bisect_left(xs, t - w)
        return i < len(xs) and xs[i] <= t + w

    keys = sorted((LAB / "keys").glob("slakh-*.json"))
    if slugs:
        keys = [k for k in keys if k.stem in slugs]
    totals = {}
    for kf in keys:
        truth = json.loads(kf.read_text())["bass"]
        sep = w43.stem(LAB / "sep" / "BS-Roformer-SW" / kf.stem, "bass")
        y, sr = load(sep)
        L = sorted(level_best(y, sr))
        notes = bp_notes(sep)
        B = [t for t, _ in notes]
        changes = [t for i, (t, p) in enumerate(notes) if i == 0 or p != notes[i - 1][1]]
        ways = {
            "level": L,
            "basic-pitch": B,
            "level + basic-pitch's new pitches": sorted(L + [t for t in changes if not near(t, L, 0.05)]),
            "level + all basic-pitch": sorted(L + [t for t in B if not near(t, L, 0.05)]),
            "level confirmed by basic-pitch": [t for t in L if near(t, B, 0.05)],
            "basic-pitch, at level's time": sorted({min((x for x in L if abs(x - t) <= 0.05), key=lambda x: abs(x - t), default=t) for t in B}),
        }
        for way, found in ways.items():
            for tol in (0.03, 0.05):
                m, f, t = w43.match(found, truth, tol)
                agg = totals.setdefault(way, {}).setdefault(tol, [0, 0, 0])
                agg[0] += m; agg[1] += f; agg[2] += t
    return {w: {f"±{int(tol*1000)}": {"F": round(2 * m / (f + t), 3), "P": round(m / f, 3), "R": round(m / t, 3)} for tol, (m, f, t) in v.items()} for w, v in totals.items()}


def candidates(path: Path) -> dict:
    """Level onsets with their strength, Basic Pitch's note starts with their loudness and whether the
    pitch is new (each against the song's own 90th percentile), for the scored combination."""
    import librosa
    import numpy as np
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    y, sr = load(path)
    hop = 256
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmax=1000)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=True, delta=0.12)
    peaks = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, backtrack=False, delta=0.12)
    strength = env[peaks] if len(peaks) else np.array([])
    ref = float(np.percentile(strength, 90)) if len(strength) else 1.0
    L = [(float(t), float(s) / ref) for t, s in zip(librosa.frames_to_time(frames, sr=sr, hop_length=hop), strength)]
    _, _, notes = predict(str(path), ICASSP_2022_MODEL_PATH, onset_threshold=0.5, minimum_note_length=128, minimum_frequency=27.5, maximum_frequency=600.0)
    notes = sorted((float(n[0]), int(n[2]), float(n[3])) for n in notes)
    merged = []
    for t, p, a in notes:
        if merged and t - merged[-1][0] <= TOL:
            if p < merged[-1][1]:
                merged[-1] = (merged[-1][0], p, max(a, merged[-1][2]))
            continue
        merged.append((t, p, a))
    aref = float(np.percentile([a for _, _, a in merged], 90)) if merged else 1.0
    B = [(t, a / aref, i == 0 or p != merged[i - 1][1]) for i, (t, p, a) in enumerate(merged)]
    return {"L": L, "B": B}


def scored(c: dict, s_level: float, s_bp: float, new_pitch_only: bool) -> list:
    import bisect

    L = c["L"]
    Lt = [t for t, _ in L]
    Bt = [t for t, _, _ in c["B"]]
    out = []
    for t, s in L:
        i = bisect.bisect_left(Bt, t - 0.05)
        both = i < len(Bt) and Bt[i] <= t + 0.05
        if both or s >= s_level:
            out.append(t)
    for t, a, new in c["B"]:
        i = bisect.bisect_left(Lt, t - 0.05)
        if i < len(Lt) and Lt[i] <= t + 0.05:
            continue
        if a >= s_bp and (new or not new_pitch_only):
            out.append(t)
    return sorted(out)


def tune(*slugs: str) -> dict:
    """Level onsets and Basic Pitch together, each kept alone only when strong: thresholds chosen on
    seven songs and scored on the eighth (leave one out), at ±30 and ±50 ms."""
    import itertools

    keys = sorted((LAB / "keys").glob("slakh-*.json"))
    data = {}
    for kf in keys:
        truth = json.loads(kf.read_text())["bass"]
        sep = w43.stem(LAB / "sep" / "BS-Roformer-SW" / kf.stem, "bass")
        data[kf.stem] = (candidates(sep), truth)
    grid = list(itertools.product((0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 99.0), (0.25, 0.5, 0.75, 1.0, 1.5, 99.0), (False, True)))
    out = {}
    for tol in (0.03, 0.05):
        def total(names, params):
            m = f = t = 0
            for n in names:
                c, truth = data[n]
                mm, ff, tt = w43.match(scored(c, *params), truth, tol)
                m += mm; f += ff; t += tt
            return m, f, t
        loo = [0, 0, 0]
        picks = {}
        for held in data:
            rest = [n for n in data if n != held]
            best = max(grid, key=lambda g: (lambda r: 2 * r[0] / (r[1] + r[2]))(total(rest, g)))
            picks[held] = best
            m, f, t = total([held], best)
            loo[0] += m; loo[1] += f; loo[2] += t
        allbest = max(grid, key=lambda g: (lambda r: 2 * r[0] / (r[1] + r[2]))(total(list(data), g)))
        m, f, t = total(list(data), allbest)
        out[f"±{int(tol * 1000)}"] = {"leave-one-out F": round(2 * loo[0] / (loo[1] + loo[2]), 3), "P": round(loo[0] / loo[1], 3), "R": round(loo[0] / loo[2], 3), "best on all": allbest, "its F": round(2 * m / (f + t), 3), "picks": {k: list(v) for k, v in picks.items()}}
    return out


DRUM_KIND = {35: "kick", 36: "kick", 37: "clap", 38: "clap", 39: "clap", 40: "clap", 42: "hihat", 44: "hihat", 46: "hihat"}


def bench_keys(*names: str) -> dict:
    """Answer keys for the detection bench (media/bench/keys) from a few BabySlakh songs: their bass
    note starts and their drums (kick; snare, clap and side stick as Clap; closed, pedal and open
    hi-hats), from the songs' MIDI. The mix is only read."""
    import pretty_midi

    wanted = set(names or ("Track00001", "Track00005", "Track00007"))
    out = {}
    for track in tracks():
        if track["name"] not in wanted:
            continue
        hits = {"kick": [], "clap": [], "hihat": [], "bass": bass_starts(track)}
        import yaml

        meta = yaml.safe_load((track["dir"] / "metadata.yaml").read_text())
        for k, s in (meta.get("stems") or {}).items():
            f = track["dir"] / "MIDI" / f"{k}.mid"
            if s.get("is_drum") and f.exists():
                for inst in pretty_midi.PrettyMIDI(str(f)).instruments:
                    for n in inst.notes:
                        kind = DRUM_KIND.get(n.pitch)
                        if kind:
                            hits[kind].append(float(n.start))
        for kind in ("kick", "clap", "hihat"):
            merged = []
            for t in sorted(hits[kind]):
                if not merged or t - merged[-1] > 0.005:
                    merged.append(round(t, 4))
            hits[kind] = merged
        key = {"name": f"BabySlakh {track['name']}", "source": "BabySlakh (Manilow et al. 2019, CC BY 4.0), from its MIDI", "audio": str((track["dir"] / "mix.wav").relative_to(ROOT)), "bpm": None, "downbeat": None, "hits": hits}
        (ROOT / "media" / "bench" / "keys" / f"slakh-{track['name'].lower()}.json").write_text(json.dumps(key))
        out[track["name"]] = {k: len(v) for k, v in hits.items()}
    return out
