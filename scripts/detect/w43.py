"""W4.3 experiments: drum pieces (DrumSep), a drum transcriber (ADTOF) and their agreement.

For each bench song: BS-RoFormer-SW's drums stem (lab/sep/BS-Roformer-SW/<slug>), split by DrumSep
into kick, snare, toms, hi-hat, ride and crash (lab/sep/drumsep/<slug>), transcribed by ADTOF
(lab/hits/<slug>.adtof.json), and onsets found in each piece (lab/hits/<slug>.pieces.json).
`score` compares ways of combining them against the answer keys.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / "media" / "bench" / "lab"
KEYS = ROOT / "media" / "bench" / "keys"
MODELS = ROOT / ".stems" / "models"
BIN = Path(sys.executable).parent
DRUMSEP = "MDX23C-DrumSep-aufr33-jarredou.ckpt"
KINDS = ["kick", "clap", "hihat"]
PIECE_OF = {"kick": ["kick"], "clap": ["snare"], "hihat": ["hh"]}


def stem(dir_: Path, name: str) -> Path | None:
    for p in dir_.glob("*.wav"):
        # The last name in brackets: "song_(drums)_BS-Roformer-SW_(kick)_MDX23C….wav" is the kick.
        found = re.findall(r"_\((\w+)\)_", p.name)
        if found and found[-1] == name:
            return p
    return None


def run_separator(audio: Path, model: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    done = subprocess.run([str(BIN / "mlx-audio-separator"), str(audio), "-m", model, "--model_file_dir", str(MODELS), "--output_dir", str(out), "--output_format", "WAV", "--save_converted_safetensors"], capture_output=True, text=True, env={**__import__("os").environ, "HF_HOME": str(ROOT / ".stems" / "hf")})
    (out / "log.txt").write_text(done.stdout + done.stderr)
    if done.returncode != 0:
        raise RuntimeError(f"{model} failed: {(done.stdout + done.stderr).strip().splitlines()[-1:]}")


def key_of(slug: str) -> dict:
    """A bench key, or the generated drums' (media/test/beat_128bpm.wav: 128 BPM from 0.4 s, the snare white noise on a kick)."""
    if slug == "generated-128":
        beat = 60 / 128
        beats = [0.4 + i * beat for i in range(64)]
        return {"audio": "media/test/beat_128bpm.wav", "hits": {"kick": beats, "clap": beats[1::2], "hihat": [0.4 + i * beat / 2 for i in range(127)]}}
    return json.loads((KEYS / f"{slug}.json").read_text())


def drums_stem(slug: str) -> Path:
    key = key_of(slug)
    out = LAB / "sep" / "BS-Roformer-SW" / slug
    found = stem(out, "drums") if out.exists() else None
    if not found:
        audio = (ROOT / key["audio"]).resolve()
        if slug == "generated-128":
            # BS-RoFormer-SW only takes stereo; the generated drums are mono (ginosa hands it stereo too).
            stereo = LAB / "input" / f"{slug}.wav"
            stereo.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(audio), "-ac", "2", "-ar", "44100", str(stereo)], check=True)
            audio = stereo
        run_separator(audio, "BS-Roformer-SW.ckpt", out)
        found = stem(out, "drums")
    return found


def pieces(slug: str) -> dict:
    out = LAB / "sep" / "drumsep" / slug
    if not (out.exists() and stem(out, "kick")):
        run_separator(drums_stem(slug), DRUMSEP, out)
    return {name: stem(out, name) for name in ["kick", "snare", "toms", "hh", "ride", "crash"]}


def adtof(slug: str) -> dict:
    """ADTOF on the drums stem: hit times (s) by kind, from its MIDI notes."""
    import pretty_midi
    from adtof_pytorch import transcribe_to_midi

    path = LAB / "hits" / f"{slug}.adtof.json"
    if path.exists():
        return json.loads(path.read_text())
    path.parent.mkdir(parents=True, exist_ok=True)
    mid = path.with_suffix(".mid")
    transcribe_to_midi(str(drums_stem(slug)), str(mid))
    notes = [(n.start, n.pitch, n.velocity) for inst in pretty_midi.PrettyMIDI(str(mid)).instruments for n in inst.notes]
    kind_of = {35: "kick", 36: "kick", 38: "clap", 40: "clap", 42: "hihat", 44: "hihat", 46: "hihat", 47: "toms", 49: "cymbals"}
    out = {"pitches": {}}
    for start, pitch, _v in notes:
        out["pitches"][str(pitch)] = out["pitches"].get(str(pitch), 0) + 1
        out.setdefault(kind_of.get(pitch, f"pitch{pitch}"), []).append(round(start, 4))
    for k in out:
        if k != "pitches":
            out[k].sort()
    path.write_text(json.dumps(out))
    return out


def piece_onsets(slug: str) -> dict:
    """Onsets in each DrumSep piece, with each onset's level (dB of its loudest 50 ms after it)."""
    import librosa
    import numpy as np

    path = LAB / "hits" / f"{slug}.pieces.json"
    if path.exists() and json.loads(path.read_text()):
        return json.loads(path.read_text())
    out = {}
    for name, file in pieces(slug).items():
        if not file:
            continue
        y, sr = librosa.load(str(file), sr=44100, mono=True)
        times = librosa.onset.onset_detect(y=y, sr=sr, units="time", hop_length=256, backtrack=False)
        hop = 256
        rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
        levels = []
        for t in times:
            i = int(t * sr / hop)
            levels.append(float(20 * np.log10(max(rms[i:i + 9].max() if i < len(rms) else 1e-9, 1e-9))))
        out[name] = [[round(float(t), 4), round(l, 1)] for t, l in zip(times, levels)]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out))
    return out


def prepare(*slugs: str) -> dict:
    """Separation, drum pieces, ADTOF and piece onsets for these bench songs (cached)."""
    import time

    report = {}
    for slug in slugs:
        t0 = time.time()
        drums_stem(slug)
        t1 = time.time()
        pieces(slug)
        t2 = time.time()
        a = adtof(slug)
        t3 = time.time()
        p = piece_onsets(slug)
        report[slug] = {"separateS": round(t1 - t0, 1), "drumsepS": round(t2 - t1, 1), "adtofS": round(t3 - t2, 1), "adtof": {k: len(v) for k, v in a.items() if k != "pitches"}, "pitches": a.get("pitches"), "pieces": {k: len(v) for k, v in p.items()}}
    return report


def match(found, truth, tol=0.03):
    f = sorted(found)
    t = sorted(truth)
    j = m = 0
    for x in t:
        while j < len(f) and f[j] < x - tol - 1e-9:
            j += 1
        if j < len(f) and f[j] <= x + tol + 1e-9:
            m += 1
            j += 1
    return m, len(f), len(t)


def near(t, times, tol=0.03):
    import bisect

    i = bisect.bisect_left(times, t - tol)
    return i < len(times) and times[i] <= t + tol


def methods_for(slug: str, gate_db: float) -> dict:
    a = adtof(slug)
    p = piece_onsets(slug)
    out = {}
    for kind in KINDS:
        ad = a.get(kind, [])
        onsets = []
        for piece in PIECE_OF[kind]:
            ons = p.get(piece, [])
            if ons:
                loud = sorted(l for _, l in ons)
                ref = loud[int(len(loud) * 0.9)] if loud else 0
                onsets += [t for t, l in ons if l >= ref + gate_db]
        onsets.sort()
        out[kind] = {
            "adtof": ad,
            "pieces": onsets,
            "agree": [t for t in ad if near(t, onsets)],
            "either": sorted(ad + [t for t in onsets if not near(t, ad)]),
        }
    return out


def score(gate_db: str = "-18", *slugs: str) -> dict:
    """F-measure per kind for each way of finding hits, over the STAR songs (or the slugs given)."""
    gate = float(gate_db)
    slugs = slugs or tuple(sorted(p.stem for p in KEYS.glob("star-*.json")))
    totals = {}
    per_song = {}
    for slug in slugs:
        key = json.loads((KEYS / f"{slug}.json").read_text())
        ms = methods_for(slug, gate)
        per_song[slug] = {}
        for kind in KINDS:
            truth = (key.get("hits") or {}).get(kind)
            if truth is None:
                continue
            for method, found in ms[kind].items():
                m, f, t = match(found, truth)
                agg = totals.setdefault(method, {}).setdefault(kind, [0, 0, 0])
                agg[0] += m; agg[1] += f; agg[2] += t
                per_song[slug].setdefault(method, {})[kind] = round(2 * m / (f + t), 3) if f + t else 1.0
    table = {}
    for method, kinds in totals.items():
        table[method] = {}
        for kind, (m, f, t) in kinds.items():
            p = m / f if f else 1.0
            r = m / t if t else 1.0
            table[method][kind] = {"f": round(2 * p * r / (p + r), 3) if p + r else 0.0, "p": round(p, 2), "r": round(r, 2), "extra": f - m, "missed": t - m}
    return {"gateDb": gate, "songs": list(slugs), "totals": table, "perSong": per_song}


def clap_features(slug: str, ann: str) -> dict:
    """At each annotated hit (STAR classes), the drums stem's mid (1–4 kHz) to high (6–16 kHz) energy
    ratio and its 60 ms decay, to see whether claps stand apart from hi-hats and snares."""
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(str(drums_stem(slug)), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    rows = [line.split("\t") for line in (ROOT / "media" / "bench" / "star-preview" / "star_drums_preview" / "data" / ann).read_text().splitlines()]
    hits = {}
    for t, c, _v in rows:
        hits.setdefault(c, []).append(float(t))
    times_all = sorted(float(t) for t, _c, _v in rows)

    def alone(t):
        return sum(1 for u in times_all if abs(u - t) < 0.02) == 1

    def feats(t):
        i = int(t * sr)
        seg = y[i:i + int(0.06 * sr)]
        if len(seg) < 256:
            return None
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
        f = np.fft.rfftfreq(len(seg), 1 / sr)
        band = lambda a, b: spec[(f >= a) & (f < b)].sum() + 1e-12
        tail = y[i + int(0.06 * sr):i + int(0.12 * sr)]
        decay = 10 * np.log10((np.mean(tail ** 2) + 1e-12) / (np.mean(seg ** 2) + 1e-12))
        return 10 * np.log10(band(1000, 4000) / band(6000, 16000)), 10 * np.log10(band(150, 400) / band(1000, 4000)), decay

    out = {}
    for c in ["CL", "SD", "CHH", "OHH", "BD"]:
        fs = [feats(t) for t in hits.get(c, []) if alone(t)]
        fs = [x for x in fs if x]
        if fs:
            a = np.array(fs)
            out[c] = {"n": len(fs), "mid/high dB": [round(float(np.percentile(a[:, 0], q)), 1) for q in (10, 50, 90)], "low/mid dB": [round(float(np.percentile(a[:, 1], q)), 1) for q in (10, 50, 90)], "decay dB": [round(float(np.percentile(a[:, 2], q)), 1) for q in (10, 50, 90)]}
    return out


def dominance(margin_db: str = "6", *slugs: str) -> dict:
    """The extra onsets ("either" minus ADTOF) kept only when their own piece hears them at least as
    loud, against its loud hits, as any other piece does (within `margin_db`): a hit that leaked into
    the snare piece is louder in the hi-hat's. Scored where there are answers; kept hits saved."""
    margin = float(margin_db)
    slugs = slugs or ("star-1327741", "star-ismir-0443", "star-ismir-0445", "star-music-delta-rock", "generated-128", "dpackdist", "entrust")
    totals, out = {}, {}
    for slug in slugs:
        key = key_of(slug)
        a = adtof(slug)
        p = piece_onsets(slug)
        refs = {}
        for piece, ons in p.items():
            loud = sorted(l for _, l in ons)
            refs[piece] = loud[int(len(loud) * 0.9)] if loud else 0
        def rel(piece, t):
            best = None
            for u, l in p.get(piece, []):
                if abs(u - t) <= 0.03 and (best is None or l > best):
                    best = l
            return None if best is None else best - refs[piece]
        kept_all = {}
        for kind in KINDS:
            own_piece = PIECE_OF[kind][0]
            ad = a.get(kind, [])
            extra = [t for t, l in p.get(own_piece, []) if l >= refs[own_piece] - 18 and not near(t, ad)]
            kept = []
            for t in extra:
                mine = rel(own_piece, t)
                others = [r for q in p if q != own_piece for r in [rel(q, t)] if r is not None]
                if mine is not None and (not others or mine >= max(others) - margin):
                    kept.append(t)
            kept_all[kind] = kept
            truth = (key.get("hits") or {}).get(kind)
            if truth is None:
                continue
            for method, found in {"adtof": ad, "either": sorted(ad + extra), "dominant": sorted(ad + kept)}.items():
                m, f, tt = match(found, truth)
                group = "generated" if slug == "generated-128" else "star"
                agg = totals.setdefault(group, {}).setdefault(method, {}).setdefault(kind, [0, 0, 0])
                agg[0] += m; agg[1] += f; agg[2] += tt
        (LAB / "hits" / f"{slug}.dominant.json").write_text(json.dumps(kept_all))
        out[slug] = {k: len(v) for k, v in kept_all.items()}
    table = {g: {meth: {k: round(2 * m / (f + t), 3) for k, (m, f, t) in kinds.items()} for meth, kinds in ms.items()} for g, ms in totals.items()}
    return {"margin": margin, "scores": table, "kept extras": out}
