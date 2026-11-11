#!/usr/bin/env bash
# Checks that this Mac has everything ginosa needs. Safe to run any time; changes nothing.
set -u

pass=0
fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail + 1)); }
info() { printf '    %s\n' "$1"; }

echo "ginosa doctor"
echo

echo "System"
if [[ "$(uname -s)" == "Darwin" ]]; then ok "macOS $(sw_vers -productVersion)"; else bad "Not macOS ($(uname -s))"; fi
if [[ "$(uname -m)" == "arm64" ]]; then ok "Apple silicon (arm64)"; else bad "Not Apple silicon ($(uname -m))"; fi
if command -v sysctl >/dev/null 2>&1; then info "$(sysctl -n machdep.cpu.brand_string 2>/dev/null) · $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB memory"; fi

echo
echo "Tools"
if xcode-select -p >/dev/null 2>&1; then ok "Xcode command line tools ($(xcode-select -p))"; else bad "Xcode command line tools missing: run  xcode-select --install"; fi
if command -v brew >/dev/null 2>&1; then ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"; else bad "Homebrew missing (https://brew.sh)"; fi

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( node_major >= 20 )); then ok "Node.js $(node --version)"; else bad "Node.js $(node --version) is too old; need 20 or newer"; fi
else
  bad "Node.js missing: brew install node"
fi
if command -v npm >/dev/null 2>&1; then ok "npm $(npm --version)"; else bad "npm missing"; fi

if command -v ffmpeg >/dev/null 2>&1; then
  ok "FFmpeg $(ffmpeg -hide_banner -version | head -1 | awk '{print $3}')"
  encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
  for enc in libx264 h264_videotoolbox hevc_videotoolbox prores_ks prores_videotoolbox aac aac_at pcm_s24le; do
    if grep -q " $enc " <<<"$encoders"; then info "encoder $enc: yes"; else info "encoder $enc: no"; fi
  done
  filters="$(ffmpeg -hide_banner -filters 2>/dev/null)"
  for filter in zscale tonemap libplacebo colorspace lut3d; do
    if grep -qE "^ [A-Z.|]+ $filter " <<<"$filters"; then info "filter $filter: yes"; else info "filter $filter: no"; fi
  done
  if ffmpeg -hide_banner -hwaccels 2>/dev/null | grep -q videotoolbox; then info "hwaccel videotoolbox: yes"; fi
else
  bad "FFmpeg missing: brew install ffmpeg"
fi
if command -v ffprobe >/dev/null 2>&1; then ok "ffprobe"; else bad "ffprobe missing (comes with ffmpeg)"; fi

if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"; else bad "git missing"; fi
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then ok "GitHub CLI, logged in"; else bad "GitHub CLI not logged in: run  gh auth login"; fi
else
  bad "GitHub CLI missing: brew install gh && gh auth login"
fi

echo
echo "Stem separation (Channel Rack detection)"
found_py=""
for candidate in python3.13 python3.12 python3.11 python3.10 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    version="$("$candidate" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null)"
    minor="$("$candidate" -c 'import sys; print(sys.version_info[1] if sys.version_info[0] == 3 else 0)' 2>/dev/null)"
    info "$candidate: Python $version ($(command -v "$candidate"))"
    if [[ -z "$found_py" && -n "$minor" ]] && (( minor >= 10 )); then found_py="$candidate"; fi
  fi
done
if command -v uv >/dev/null 2>&1; then info "uv $(uv --version 2>/dev/null | awk '{print $2}')"; fi
if command -v brew >/dev/null 2>&1; then info "Homebrew $(brew --version 2>/dev/null | head -1 | awk '{print $2}') at $(command -v brew)"; else info "Homebrew not found"; fi
if [[ -n "$found_py" ]]; then ok "Python 3.10 or newer: $found_py"; else bad "No Python 3.10 or newer (stem separation needs it): brew install python@3.12"; fi
stems_root="$(cd "$(dirname "$0")/.." && pwd)/.stems"
if [[ -x "$stems_root/venv/bin/python" ]] && "$stems_root/venv/bin/python" -c 'import demucs_mlx' >/dev/null 2>&1; then
  ok "demucs-mlx installed ($("$stems_root/venv/bin/python" -c 'import importlib.metadata as m; print(m.version("demucs-mlx"))' 2>/dev/null))"
else
  info "demucs-mlx not set up yet: npm run stems-setup"
fi

echo
echo "Project"
cd "$(dirname "$0")/.." || exit 1
if [[ -d node_modules ]]; then ok "dependencies installed"; else bad "dependencies not installed: run  bash scripts/setup.sh"; fi
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  remote="$(git remote get-url origin 2>/dev/null || echo 'none')"
  ok "git repository (origin: $remote)"
else
  bad "not a git repository"
fi

echo
if (( fail == 0 )); then echo "All $pass checks passed."; else echo "$fail problem(s), $pass check(s) passed."; fi
exit $(( fail > 0 ? 1 : 0 ))
