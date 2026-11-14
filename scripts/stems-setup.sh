#!/usr/bin/env bash
# Sets up stem separation for the Channel Rack's Automatic Detection (decision 108): a
# Python environment in .stems/venv with demucs-mlx (MIT), which splits a song into drums,
# bass, vocals and the rest on this Mac, with Apple's MLX. Run it once:  npm run stems-setup
#
# Everything goes in .stems/ in this folder, the model's weights too (htdemucs, about
# 160 MB, downloaded from Hugging Face on the first run and checked against digests built
# into demucs-mlx). Delete .stems/ to remove it all. Running it again is safe.
set -u

DEMUCS_MLX_VERSION="1.6.1"
root="$(cd "$(dirname "$0")/.." && pwd)"
stems="$root/.stems"
venv="$stems/venv"
export DEMUCS_MLX_CACHE_DIR="$stems/weights"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
hint() {
  info "demucs-mlx's MLX audio packages are built for particular Python versions; 3.12 is the safe choice."
  if command -v brew >/dev/null 2>&1; then
    info "Install it with Homebrew, then run this again (it picks 3.12 first):"
    info "  brew install python@3.12"
    info "  npm run stems-setup"
  else
    info "Install Python 3.12 from python.org, then run  npm run stems-setup  again."
  fi
}

say "ginosa: stem separation setup"
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then bad "This needs a Mac with Apple silicon."; exit 1; fi

# Python 3.10 to 3.13: the versions MLX's audio packages are built for (none for 3.15 yet).
minor_of() { "$1" -c 'import sys; print(sys.version_info[1] if sys.version_info[0] == 3 else 0)' 2>/dev/null || echo 0; }
find_python() {
  local m candidate
  for m in 12 13 11 10; do
    for candidate in "python3.$m" "/opt/homebrew/bin/python3.$m" "/Library/Frameworks/Python.framework/Versions/3.$m/bin/python3" "/usr/local/bin/python3.$m" "$stems/python/bin/python3.$m"; do
      if command -v "$candidate" >/dev/null 2>&1 && [[ "$(minor_of "$candidate")" == "$m" ]]; then echo "$candidate"; return; fi
    done
  done
}
# A first version of this script let uv add a python3.12 link in ~/.local/bin; it only ever
# points into .stems/, so it goes (nothing else there is touched).
for link in "$HOME/.local/bin/python3.12"; do
  if [[ -L "$link" && "$(readlink "$link")" == "$stems/"* ]] || { [[ -f "$link" ]] && grep -qa "$stems/python" "$link" 2>/dev/null; }; then
    rm -f "$link" && ok "Removed $link (a link into .stems/ left by the first setup)"
  fi
done

python="$(find_python)"
if [[ -z "$python" ]]; then
  # None on this Mac: a private Python 3.12 in .stems/python (about 40 MB), fetched by uv
  # (Astral's installer, MIT/Apache-2.0) from python-build-standalone. Nothing outside .stems/ changes.
  any=""
  for candidate in python3 /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
    if command -v "$candidate" >/dev/null 2>&1; then any="$candidate"; break; fi
  done
  if [[ -z "$any" ]]; then bad "No Python on this Mac at all."; hint; exit 1; fi
  say "This Mac's Python is $("$any" -c 'import sys; print("%d.%d" % sys.version_info[:2])'); MLX needs 3.10–3.13. Fetching a private Python 3.12 into .stems/python…"
  mkdir -p "$stems"
  if [[ ! -x "$stems/bootstrap/bin/uv" ]]; then
    "$any" -m venv "$stems/bootstrap" && "$stems/bootstrap/bin/python" -m pip install --quiet --upgrade pip uv || { bad "Couldn't install uv to fetch Python 3.12."; hint; exit 1; }
  fi
  export UV_PYTHON_INSTALL_DIR="$stems/python" UV_PYTHON_BIN_DIR="$stems/python/bin" UV_CACHE_DIR="$stems/uv-cache"
  if ! "$stems/bootstrap/bin/uv" python install 3.12; then bad "uv couldn't fetch Python 3.12 (above)."; hint; exit 1; fi
  python="$("$stems/bootstrap/bin/uv" python find 3.12 2>/dev/null)"
  [[ -x "$python" ]] || { bad "Python 3.12 was fetched but can't be found."; exit 1; }
  rm -rf "$stems/uv-cache"
fi
version="$("$python" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
ok "Python $version ($python)"

installed() {
  [[ -x "$venv/bin/python" ]] && "$venv/bin/python" -c "import importlib.metadata as m, sys; sys.exit(0 if m.version('demucs-mlx') == '$DEMUCS_MLX_VERSION' else 1)" >/dev/null 2>&1
}
if installed; then
  ok "demucs-mlx $DEMUCS_MLX_VERSION is already installed in .stems/venv"
else
  say "Installing demucs-mlx $DEMUCS_MLX_VERSION and MLX into .stems/venv (a few hundred MB)…"
  rm -rf "$venv"
  mkdir -p "$stems"
  if ! "$python" -m venv "$venv"; then bad "Couldn't make the Python environment."; exit 1; fi
  "$venv/bin/python" -m pip install --quiet --upgrade pip
  # MLX and its audio packages only from ready-made builds: no compiling on this Mac.
  if ! "$venv/bin/python" -m pip install --prefer-binary --only-binary=mlx,mlx-metal,mlx-audio-io,mlx-spectro "demucs-mlx==$DEMUCS_MLX_VERSION"; then
    bad "pip couldn't install demucs-mlx for Python $version (the error is above)."
    rm -rf "$venv"
    hint
    exit 1
  fi
  installed && ok "demucs-mlx $DEMUCS_MLX_VERSION installed" || { bad "demucs-mlx didn't install properly."; exit 1; }
fi

# W4.2: BS-RoFormer-SW (six stems, the better separator) through mlx-audio-separator (MIT), with
# PyTorch to convert its checkpoint for MLX once (and for W4.3's drum transcriber).
SEPARATOR_VERSION="0.1.20"
TORCH_VERSION="2.15.0"
separator_installed() {
  "$venv/bin/python" -c "import importlib.metadata as m, sys; sys.exit(0 if m.version('mlx-audio-separator') == '$SEPARATOR_VERSION' and m.version('torch') == '$TORCH_VERSION' else 1)" >/dev/null 2>&1
}
if separator_installed; then
  ok "mlx-audio-separator $SEPARATOR_VERSION and PyTorch $TORCH_VERSION are already installed"
else
  say "Installing mlx-audio-separator $SEPARATOR_VERSION and PyTorch $TORCH_VERSION (about 500 MB)…"
  if ! "$venv/bin/python" -m pip install --prefer-binary "mlx-audio-separator==$SEPARATOR_VERSION" "torch==$TORCH_VERSION" "safetensors==0.8.0" "soundfile==0.14.0"; then
    bad "pip couldn't install them (the error is above)."; exit 1
  fi
  separator_installed && ok "mlx-audio-separator and PyTorch installed" || { bad "They didn't install properly."; exit 1; }
fi
models="$stems/models"
if [[ -s "$models/BS-Roformer-SW.safetensors" && -f "$models/BS-Roformer-SW.ckpt" && -f "$models/BS-Roformer-SW.yaml" ]]; then
  ok "BS-RoFormer-SW is downloaded and converted for MLX"
else
  say "Downloading BS-RoFormer-SW (about 700 MB) and converting it for MLX…"
  mkdir -p "$models"
  if ! HF_HOME="$stems/hf" "$venv/bin/mlx-audio-separator" -m BS-Roformer-SW.ckpt --model_file_dir "$models" --preconvert_only --save_converted_safetensors; then
    bad "Couldn't download or convert BS-RoFormer-SW (above)."; exit 1
  fi
  [[ -s "$models/BS-Roformer-SW.safetensors" ]] || { bad "BS-RoFormer-SW wasn't converted."; exit 1; }
  ok "BS-RoFormer-SW downloaded and converted"
fi
# Only the converted copy is used; the separator just checks the checkpoint is there before
# loading it, so the 700 MB original becomes an empty placeholder (mlx-audio-separator 0.1.20).
if [[ -s "$models/BS-Roformer-SW.ckpt" && -s "$models/BS-Roformer-SW.safetensors" ]]; then
  : > "$models/BS-Roformer-SW.ckpt" && ok "Freed 700 MB: the original checkpoint isn't needed once converted"
fi

say "Testing it (the first run downloads the model, about 160 MB)…"
work="$(mktemp -d)"
input="$root/media/test/song_120bpm.wav"
if [[ ! -f "$input" ]]; then
  input="$work/test.wav"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=110:duration=8" -ac 2 -ar 44100 "$input"
fi
start=$(date +%s)
result=0
mkdir -p "$work/sw"
# BS-RoFormer-SW only takes stereo (ginosa always hands it a stereo WAV); the test song is mono.
ffmpeg -hide_banner -loglevel error -y -i "$input" -ac 2 -ar 44100 "$work/stereo.wav" && input="$work/stereo.wav"
if "$venv/bin/demucs-mlx" "$input" -o "$work/out" -n htdemucs && HF_HOME="$stems/hf" "$venv/bin/mlx-audio-separator" "$input" -m BS-Roformer-SW.ckpt --model_file_dir "$models" --output_dir "$work/sw" --output_format WAV > "$work/sw.log" 2>&1; then
  count=$(find "$work/out" -type f \( -name 'drums.*' -o -name 'bass.*' -o -name 'vocals.*' -o -name 'other.*' \) | wc -l | tr -d ' ')
  if [[ "$count" == "4" ]]; then
    sw=$(find "$work/sw" -type f -name '*_(drums)_*' | wc -l | tr -d ' ')
    if [[ "$sw" == "1" ]]; then ok "Split $(basename "$input") with Demucs and with BS-RoFormer-SW in $(( $(date +%s) - start )) s"; else bad "BS-RoFormer-SW wrote no drums stem."; result=1; fi
  else
    bad "Only $count of the 4 stems were written."; result=1
  fi
else
  bad "A separator stopped with an error:"; [[ -f "$work/sw.log" ]] && tail -5 "$work/sw.log"; result=1
fi
rm -rf "$work"
if (( result == 0 )); then
  say "Ready. In ginosa, the Channel Rack's Detect now separates the song on A1 first."
else
  info "Stem separation isn't working yet; Detect keeps using frequency bands of the whole song."
fi
exit $result
