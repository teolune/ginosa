"""The beat grid's ear (W4.5), run by ginosa on this Mac in .stems/venv:

    beats.py <song .wav> <output .json>

Beat This! (Foscarin, Schlüter and Widmer, ISMIR 2024; code and weights MIT), its final0 model
without the DBN, on the GPU (MPS) when there is one: the beats and downbeats of the song, in
20 ms frames. Also where the music starts (the end of any silence at the start: 50 dB under its
loudest moments). Writes {"beats": [s…], "downbeats": [s…], "firstSound": s, "seconds": s}.
ginosa lays the grid over them (src/engine/audio/song-beats.ts). The song is only read.
"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Beat This!'s checkpoint, downloaded by npm run stems-setup through torch.hub into .stems/torch.
os.environ.setdefault("TORCH_HOME", str(ROOT / ".stems" / "torch"))
CHECKPOINT = ROOT / ".stems" / "torch" / "hub" / "checkpoints" / "beat_this-final0.ckpt"


def first_sound(y, sr) -> float:
    import numpy as np

    hop = max(1, int(sr * 0.01))
    frames = len(y) // hop
    if frames == 0:
        return 0.0
    level = 20 * np.log10(np.sqrt(np.mean(y[: frames * hop].reshape(frames, hop) ** 2, axis=1) + 1e-12))
    loud = np.percentile(level, 99.5)
    return float(np.argmax(level > loud - 50)) * hop / sr


def main(song: str, out: str) -> None:
    import numpy as np
    import soundfile as sf
    import torch
    from beat_this.inference import Audio2Beats

    y, sr = sf.read(song, dtype="float32", always_2d=True)
    y = np.ascontiguousarray(y.mean(axis=1))
    started = time.time()
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tracker = Audio2Beats(checkpoint_path=str(CHECKPOINT) if CHECKPOINT.exists() else "final0", device=device, dbn=False)
    beats, downbeats = tracker(y, sr)
    result = {
        "beats": [round(float(b), 4) for b in beats],
        "downbeats": [round(float(d), 4) for d in downbeats],
        "firstSound": round(first_sound(y, sr), 3),
        "seconds": round(time.time() - started, 2),
    }
    Path(out + ".partial").write_text(json.dumps(result))
    Path(out + ".partial").replace(out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: beats.py <song .wav> <output .json>")
    main(sys.argv[1], sys.argv[2])
