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


COMMANDS = {"env": env}


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
