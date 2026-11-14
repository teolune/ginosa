#!/usr/bin/env bash
# The detection lab (W4): tries separation and transcription models on this Mac, in the
# Python environment `npm run stems-setup` makes (.stems/venv). Results go to media/bench/lab/.
#   npm run detect-lab -- env          what's installed, and the Mac's GPU
#   npm run detect-lab -- <command> …  see scripts/detect/lab.py
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
py="$root/.stems/venv/bin/python"
if [[ ! -x "$py" ]]; then echo "No .stems/venv yet: run  npm run stems-setup  first."; exit 1; fi
export DEMUCS_MLX_CACHE_DIR="$root/.stems/weights"
export HF_HOME="$root/.stems/hf"
exec "$py" "$root/scripts/detect/lab.py" "$@"
