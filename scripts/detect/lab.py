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
INSTALLABLE = {"mlx-audio-separator", "soundfile", "huggingface-hub", "safetensors", "torch", "librosa", "mir-eval"}


def pip_install(*specs: str) -> dict:
    """Adds packages to .stems/venv: only those in INSTALLABLE, pinned like name==1.2.3 or with extras like name[extra]."""
    names = [s.split("[")[0].split("=")[0].split("<")[0].split(">")[0].lower() for s in specs]
    refused = [n for n in names if n not in INSTALLABLE]
    if refused or not specs:
        return {"refused": refused or ["nothing to install"]}
    done = subprocess.run([sys.executable, "-m", "pip", "install", "--prefer-binary", *specs], capture_output=True, text=True)
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


COMMANDS = {"env": env, "pip-install": pip_install, "tool": tool, "separate": separate, "compare": compare}


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
