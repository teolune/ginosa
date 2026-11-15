"""Detect's drum transcriber (W4.3), run by ginosa on this Mac in .stems/venv:

    listen.py <drums stem .wav> <output folder>

1. DrumSep (MDX23C, aufr33 and jarredou) splits the drums stem into kick, snare, toms, hi-hat,
   ride and crash (mlx-audio-separator; weights in .stems/models).
2. ADTOF (Zehren et al., PyTorch port by Xavier Riley) transcribes the drums stem: kick, snare,
   toms, hi-hat and cymbal hits.
3. In each DrumSep piece, onsets within 18 dB of its loud hits (the 90th percentile).
4. Each channel's hits: ADTOF's, plus any strong onset in its piece ADTOF didn't have within 30 ms,
   when the piece is trusted: of its strong onsets at the moment of an ADTOF hit, at least 40% are
   at one of its own kind (a piece that mostly hears other drums, as DrumSep's snare does with
   the generated test drums' white-noise hats, adds nothing).
   On the STAR Drums preview (F within ±30 ms): kick 0.980, snare and clap 0.839 (snares alone
   0.963), hi-hat 0.916; handclaps aren't known to either model (decision 122).

Writes <output folder>/drum-hits.json: {"kick": [s…], "clap": [s…], "hihat": [s…], "toms": […],
"cymbals": […], "one_check": {"kick": [s…], …}, "agreement": {"kick": 0.97, …}} in seconds of the
stem (one_check: the hits only DrumSep's onsets found, not ADTOF, for marking as doubtful;
agreement: each piece's share described in 4), then lets go of DrumSep's pieces (about 30 MB a minute;
--keep-pieces keeps them). Prints "progress <n>%" lines as it goes. The stem is only read.
"""
import bisect
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / ".stems" / "models"
BIN = Path(sys.executable).parent
DRUMSEP = "MDX23C-DrumSep-aufr33-jarredou.ckpt"
GATE_DB = -18.0
TOLERANCE = 0.03
TRUST = 0.4
# ADTOF's MIDI notes (its five classes) as ginosa's channels.
KIND_OF_PITCH = {35: "kick", 38: "clap", 47: "toms", 42: "hihat", 49: "cymbals"}
PIECE_OF = {"kick": "kick", "clap": "snare", "hihat": "hh"}


def progress(n: int) -> None:
    print(f"progress {n}%", flush=True)


def piece_files(folder: Path) -> dict:
    out = {}
    for p in folder.glob("*.wav"):
        names = re.findall(r"_\((\w+)\)_", p.name)
        if names:
            out[names[-1]] = p
    return out


def drumsep(drums: Path, folder: Path) -> dict:
    pieces = piece_files(folder)
    if all(k in pieces for k in ("kick", "snare", "hh")):
        return pieces
    folder.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "HF_HOME": str(ROOT / ".stems" / "hf")}
    done = subprocess.run([str(BIN / "mlx-audio-separator"), str(drums), "-m", DRUMSEP, "--model_file_dir", str(MODELS), "--output_dir", str(folder), "--output_format", "WAV", "--save_converted_safetensors"], capture_output=True, text=True, env=env)
    if done.returncode != 0:
        raise SystemExit(f"DrumSep failed: {(done.stdout + done.stderr).strip().splitlines()[-1:]}")
    return piece_files(folder)


def adtof(drums: Path, folder: Path) -> dict:
    import pretty_midi
    from adtof_pytorch import transcribe_to_midi

    mid = folder / "adtof.mid"
    transcribe_to_midi(str(drums), str(mid), device="cpu")
    out: dict = {}
    for inst in pretty_midi.PrettyMIDI(str(mid)).instruments:
        for n in inst.notes:
            kind = KIND_OF_PITCH.get(n.pitch)
            if kind:
                out.setdefault(kind, []).append(round(float(n.start), 4))
    return {k: sorted(v) for k, v in out.items()}


def strong_onsets(file: Path) -> list:
    import librosa
    import numpy as np

    y, sr = librosa.load(str(file), sr=44100, mono=True)
    hop = 256
    times = librosa.onset.onset_detect(y=y, sr=sr, units="time", hop_length=hop, backtrack=False)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
    levels = [20 * np.log10(max(float(rms[int(t * sr / hop):int(t * sr / hop) + 9].max()) if int(t * sr / hop) < len(rms) else 1e-9, 1e-9)) for t in times]
    if not levels:
        return []
    ref = sorted(levels)[int(len(levels) * 0.9)]
    return sorted(round(float(t), 4) for t, l in zip(times, levels) if l >= ref + GATE_DB)


def near(t: float, times: list) -> bool:
    i = bisect.bisect_left(times, t - TOLERANCE)
    return i < len(times) and times[i] <= t + TOLERANCE


def main(drums: str, out: str, keep_pieces: bool = False) -> None:
    drums_path, folder = Path(drums), Path(out)
    folder.mkdir(parents=True, exist_ok=True)
    progress(5)
    pieces = drumsep(drums_path, folder / "pieces")
    progress(55)
    found = adtof(drums_path, folder)
    progress(75)
    hits: dict = {k: v for k, v in found.items() if k not in PIECE_OF}
    every = sorted(t for times in found.values() for t in times)
    one_check, agreement = {}, {}
    for kind, piece in PIECE_OF.items():
        own = found.get(kind, [])
        strong = strong_onsets(pieces[piece]) if piece in pieces else []
        at_a_hit = [t for t in strong if near(t, every)]
        agreement[kind] = round(sum(1 for t in at_a_hit if near(t, own)) / len(at_a_hit), 3) if at_a_hit else 0.0
        extra = [t for t in strong if not near(t, own)] if agreement[kind] >= TRUST else []
        hits[kind] = sorted(own + extra)
        one_check[kind] = extra
    hits["one_check"] = one_check
    hits["agreement"] = agreement
    (folder / "drum-hits.json.partial").write_text(json.dumps(hits))
    (folder / "drum-hits.json.partial").replace(folder / "drum-hits.json")
    if not keep_pieces:
        shutil.rmtree(folder / "pieces", ignore_errors=True)
    progress(100)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--keep-pieces"]
    if len(args) != 2:
        raise SystemExit("usage: listen.py <drums stem .wav> <output folder> [--keep-pieces]")
    main(args[0], args[1], "--keep-pieces" in sys.argv)
