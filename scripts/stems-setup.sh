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

# Python 3.10 or newer, the versions MLX's audio packages are surely built for first.
minor_of() { "$1" -c 'import sys; print(sys.version_info[1] if sys.version_info[0] == 3 else 0)' 2>/dev/null || echo 0; }
python=""
for m in 12 13 11 10 14 15 16; do
  for candidate in "python3.$m" "/opt/homebrew/bin/python3.$m" "/Library/Frameworks/Python.framework/Versions/3.$m/bin/python3" "/usr/local/bin/python3.$m"; do
    if command -v "$candidate" >/dev/null 2>&1 && [[ "$(minor_of "$candidate")" == "$m" ]]; then python="$candidate"; break 2; fi
  done
done
if [[ -z "$python" ]] && command -v python3 >/dev/null 2>&1 && (( $(minor_of python3) >= 10 )); then python="python3"; fi
if [[ -z "$python" ]]; then bad "No Python 3.10 or newer on this Mac."; hint; exit 1; fi
version="$("$python" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
ok "Python $version ($(command -v "$python"))"

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

say "Testing it (the first run downloads the model, about 160 MB)…"
work="$(mktemp -d)"
input="$root/media/test/song_120bpm.wav"
if [[ ! -f "$input" ]]; then
  input="$work/test.wav"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=110:duration=8" -ac 2 -ar 44100 "$input"
fi
start=$(date +%s)
result=0
if "$venv/bin/demucs-mlx" "$input" -o "$work/out" -n htdemucs; then
  count=$(find "$work/out" -type f \( -name 'drums.*' -o -name 'bass.*' -o -name 'vocals.*' -o -name 'other.*' \) | wc -l | tr -d ' ')
  if [[ "$count" == "4" ]]; then
    ok "Split $(basename "$input") into drums, bass, vocals and other in $(( $(date +%s) - start )) s"
  else
    bad "Only $count of the 4 stems were written."; result=1
  fi
else
  bad "demucs-mlx stopped with an error (above)."; result=1
fi
rm -rf "$work"
if (( result == 0 )); then
  say "Ready. In ginosa, the Channel Rack's Detect now separates the song on A1 first."
else
  info "Stem separation isn't working yet; Detect keeps using frequency bands of the whole song."
fi
exit $result
