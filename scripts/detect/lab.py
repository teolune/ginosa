"""The detection lab (W4): experiments with separation and transcription models on this Mac.

Run through `npm run detect-lab -- <command>`; it uses the Python in .stems/venv. Nothing here
touches your files: songs are only read, and everything it makes goes to media/bench/lab/.
"""
import importlib.metadata as metadata
import json
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LAB = ROOT / "media" / "bench" / "lab"


def env() -> dict:
    """What's installed in .stems/venv, and the Mac it runs on."""
    packages = {d.metadata["Name"].lower(): d.version for d in metadata.distributions()}
    wanted = ["demucs-mlx", "mlx", "mlx-metal", "mlx-audio-separator", "torch", "numpy", "soundfile", "librosa", "huggingface-hub"]
    chip = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
    memory = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() or 0)
    info = {
        "python": platform.python_version(),
        "machine": platform.machine(),
        "chip": chip,
        "memoryGB": round(memory / 1024**3, 1),
        "packages": {name: packages.get(name) for name in wanted},
    }
    try:
        import mlx.core as mx

        info["mlx"] = {"device": str(mx.default_device()), "metal": bool(mx.metal.is_available())}
    except Exception as error:  # noqa: BLE001 - reported, not raised
        info["mlx"] = {"error": str(error)}
    return info


# Packages the lab may add to .stems/venv (nothing else): separation, transcription, and audio files.
INSTALLABLE = {"mlx-audio-separator", "soundfile", "huggingface-hub", "safetensors", "torch", "librosa", "mir-eval", "pretty-midi", "beat-this", "einops", "rotary-embedding-torch", "basic-pitch", "onnxruntime", "resampy", "mir-eval", "scikit-learn"}
# ADTOF's PyTorch port isn't on PyPI: it installs from its GitHub repository (weights included).
INSTALLABLE_URLS = {"git+https://github.com/xavriley/ADTOF-pytorch"}


def pip_install(*specs: str) -> dict:
    """Adds packages to .stems/venv: only those in INSTALLABLE, pinned like name==1.2.3 or with extras like name[extra]."""
    flags = [s for s in specs if s == "--no-deps"]
    specs = tuple(s for s in specs if s != "--no-deps")
    names = [s if s in INSTALLABLE_URLS else s.split("[")[0].split("=")[0].split("<")[0].split(">")[0].lower() for s in specs]
    refused = [n for n in names if n not in INSTALLABLE and n not in INSTALLABLE_URLS]
    if refused or not specs:
        return {"refused": refused or ["nothing to install"]}
    done = subprocess.run([sys.executable, "-m", "pip", "install", "--prefer-binary", *flags, *specs], capture_output=True, text=True)
    return {"exit": done.returncode, "tail": (done.stdout + done.stderr).strip().splitlines()[-25:]}


def tool(name: str, *args: str) -> dict:
    """Runs a command-line tool from .stems/venv/bin (separators' own CLIs), for exploring them."""
    allowed = {"mlx-audio-separator", "demucs-mlx"}
    if name not in allowed:
        return {"refused": name}
    exe = Path(sys.executable).parent / name
    done = subprocess.run([str(exe), *args], capture_output=True, text=True, cwd=LAB)
    (LAB / f"tool-{name}.out").write_text(done.stdout + done.stderr)
    return {"exit": done.returncode, "out": (done.stdout + done.stderr).strip().splitlines()[-40:], "full": f"media/bench/lab/tool-{name}.out"}


MODELS = ROOT / ".stems" / "models"


def key_audio(slug: str) -> Path:
    """A bench song's file, from its answer key (media/bench/keys/<slug>.json; your songs are only read)."""
    key = json.loads((ROOT / "media" / "bench" / "keys" / f"{slug}.json").read_text())
    return (ROOT / key["audio"]).resolve()


def separate(model: str, slug: str, *extra: str) -> dict:
    """Separates a bench song with mlx-audio-separator's `model` (weights in .stems/models), timed."""
    import time

    import os

    audio = key_audio(slug)
    env = dict(os.environ)
    # --tf32-off: full float32 matrix maths on the M5's GPU (MLX may use TF32 there), to measure the difference.
    variant = ""
    if "--tf32-off" in extra:
        env["MLX_ENABLE_TF32"] = "0"
        variant = "-fp32"
        extra = tuple(e for e in extra if e != "--tf32-off")
    out = LAB / "sep" / (Path(model).stem + variant) / slug
    out.mkdir(parents=True, exist_ok=True)
    exe = Path(sys.executable).parent / "mlx-audio-separator"
    started = time.time()
    done = subprocess.run([str(exe), str(audio), "-m", model, "--model_file_dir", str(MODELS), "--output_dir", str(out), "--output_format", "WAV", *extra], capture_output=True, text=True, env=env)
    seconds = time.time() - started
    (out / "log.txt").write_text(done.stdout + done.stderr)
    info = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(audio)], capture_output=True, text=True)
    length = float(info.stdout.strip() or 0)
    return {"exit": done.returncode, "seconds": round(seconds, 1), "songSeconds": round(length, 1), "realtime": round(length / seconds, 1) if seconds else None, "files": sorted(p.name for p in out.iterdir()), "tail": (done.stdout + done.stderr).strip().splitlines()[-12:]}


def compare(dir_a: str, dir_b: str) -> dict:
    """How far apart two separations of the same song are, stem by stem (SNR in dB; higher is closer)."""
    import numpy as np
    import soundfile as sf
    import re

    def stems(d):
        return {re.search(r"_\((\w+)\)_", p.name).group(1): p for p in (LAB / "sep" / d).rglob("*.wav") if re.search(r"_\((\w+)\)_", p.name)}

    a, b = stems(dir_a), stems(dir_b)
    out = {}
    for name in sorted(set(a) & set(b)):
        x, _ = sf.read(a[name], dtype="float64")
        y, _ = sf.read(b[name], dtype="float64")
        n = min(len(x), len(y))
        x, y = x[:n], y[:n]
        err = np.sum((x - y) ** 2)
        out[name] = round(float(10 * np.log10(np.sum(x**2) / err)) if err > 0 else float("inf"), 1)
    return out


def w43_prepare(*slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w43

    return w43.prepare(*slugs)


def w43_score(*args: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w43

    return w43.score(*args)


def w43_claps() -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w43

    return {
        "star-1327741": w43.clap_features("star-1327741", "training/mtg-jamendo/annotation/1327741_mix_ar_80s_chrome_kit_full.txt"),
        "star-ismir-0445": w43.clap_features("star-ismir-0445", "training/ismir04/annotation/ismir_0445_mix_ar_60s_late_kit_full.txt"),
    }


def listen(slug: str) -> dict:
    """Detect's own transcriber (listen.py) on a STAR song's BS-RoFormer-SW drums stem, timed, and scored like w43-score."""
    import time

    sys.path.insert(0, str(Path(__file__).parent))
    import listen as app
    import w43

    out = LAB / "listen" / slug
    start = time.time()
    app.main(str(w43.drums_stem(slug)), str(out), keep_pieces=False)
    hits = json.loads((out / "drum-hits.json").read_text())
    return {"seconds": round(time.time() - start, 1), "found": {k: len(v) for k, v in hits.items()}, "pieces left": (out / "pieces").exists()}


def w43_dominance(margin: str = "6", *slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w43

    return w43.dominance(margin, *slugs)


def midi_info() -> dict:
    """The STAR preview's MIDI files: tempo changes, time signatures and the first note, to see whether they hold a beat grid."""
    import pretty_midi

    out = {}
    for f in sorted((ROOT / "media" / "bench" / "star-preview").rglob("*.mid")):
        m = pretty_midi.PrettyMIDI(str(f))
        times, tempi = m.get_tempo_changes()
        notes = sorted(n.start for i in m.instruments for n in i.notes)
        out[f.name] = {
            "tempo changes": len(tempi),
            "tempi (first 5)": [round(float(t), 3) for t in tempi[:5]],
            "at": [round(float(t), 3) for t in times[:5]],
            "time signatures": [(ts.numerator, ts.denominator, round(ts.time, 3)) for ts in m.time_signature_changes[:3]],
            "resolution": m.resolution,
            "first note": round(notes[0], 3) if notes else None,
            "beats (first 6)": [round(float(b), 3) for b in m.get_beats()[:6]],
            "downbeats (first 3)": [round(float(b), 3) for b in m.get_downbeats()[:3]],
        }
    return out


def w45_beats(*slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w45

    return w45.beats(*slugs)


def w45_grids(*slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w45

    return w45.grids(*slugs)


def w45_bar_one() -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w45

    return w45.bar_one()


def w45_phases(*slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w45

    return w45.phases(*slugs)


def w44_prepare(*args: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w44

    return w44.prepare(*args)


def w44_score(*slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w44

    return w44.score(*slugs)


def w44_diagnose(*slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w44

    return w44.diagnose(*slugs)


def w44_combos(*slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w44

    return w44.combos(*slugs)


def w44_tune(*slugs: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w44

    return w44.tune(*slugs)


def bass_app(*slugs: str) -> dict:
    """Detect's own bass ear (bass.py) on the BabySlakh songs' separated bass, scored, timed."""
    import time

    sys.path.insert(0, str(Path(__file__).parent))
    import bass as app
    import w43
    import w44

    totals = {0.03: [0, 0, 0], 0.05: [0, 0, 0]}
    out = {}
    for kf in sorted((LAB / "keys").glob("slakh-*.json")):
        if slugs and kf.stem not in slugs:
            continue
        truth = json.loads(kf.read_text())["bass"]
        stem = w43.stem(LAB / "sep" / "BS-Roformer-SW" / kf.stem, "bass")
        target = LAB / "bass" / f"{kf.stem}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        started = time.time()
        app.main(str(stem), str(target))
        found = json.loads(target.read_text())["bass"]
        out[kf.stem] = {"seconds": round(time.time() - started, 1)}
        for tol, agg in totals.items():
            m, f, t = w43.match(found, truth, tol)
            agg[0] += m; agg[1] += f; agg[2] += t
            out[kf.stem][f"F±{int(tol * 1000)}"] = round(2 * m / (f + t), 3)
    out["total"] = {f"F±{int(tol * 1000)}": round(2 * m / (f + t), 3) for tol, (m, f, t) in totals.items()}
    return out


def w44_bench_keys(*names: str) -> dict:
    sys.path.insert(0, str(Path(__file__).parent))
    import w44

    return w44.bench_keys(*names)


COMMANDS = {"w44-bench-keys": w44_bench_keys, "bass-app": bass_app, "w44-tune": w44_tune, "w44-combos": w44_combos, "w44-diagnose": w44_diagnose, "w44-prepare": w44_prepare, "w44-score": w44_score, "w45-phases": w45_phases, "w45-bar-one": w45_bar_one, "w45-beats": w45_beats, "w45-grids": w45_grids, "midi-info": midi_info, "w43-dominance": w43_dominance, "listen": listen, "env": env, "pip-install": pip_install, "tool": tool, "separate": separate, "compare": compare, "w43-prepare": w43_prepare, "w43-score": w43_score, "w43-claps": w43_claps}


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in COMMANDS:
        print(f"usage: npm run detect-lab -- <{'|'.join(COMMANDS)}> …")
        return 2
    LAB.mkdir(parents=True, exist_ok=True)
    result = COMMANDS[argv[0]](*argv[1:])
    print(json.dumps(result, indent=1))
    (LAB / f"{argv[0]}.json").write_text(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
