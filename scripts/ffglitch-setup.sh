#!/usr/bin/env bash
# Sets up FFglitch for Datamosh Bake (M15, decision 133): FFglitch 0.10.2 for macOS on Apple
# silicon, by Ramiro Polla (GPL-2.0-or-later, an FFmpeg fork), from ffglitch.org. ginosa runs its
# programs as separate tools: ffgac (FFmpeg with glitch options) encodes the bake, ffedit edits
# the motion vectors inside it.
# Run it once:  npm run ffglitch-setup
#
# Everything goes in .ffglitch/ in this folder (about 75 MB). Delete .ffglitch/ to remove it.
# Running it again is safe: it checks what's there first.
set -u

VERSION="0.10.2"
NAME="ffglitch-$VERSION-macos-aarch64"
URL="https://ffglitch.org/pub/bin/macos-aarch64/$NAME.zip"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/.ffglitch"
bin="$dir/bin"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

say "ginosa: FFglitch setup (Datamosh Bake)"
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then bad "This needs a Mac with Apple silicon."; exit 1; fi

# A tool works if it starts (killed at once, or not runnable, gives an exit code of 126 or more).
works() { [[ -x "$bin/$1" ]] || return 1; "$bin/$1" -version >/dev/null 2>&1; [[ $? -lt 126 ]]; }

if [[ -f "$dir/version" && "$(cat "$dir/version")" == "$VERSION" ]] && works ffgac && works ffedit; then
  ok "FFglitch $VERSION is already set up in .ffglitch/bin"
else
  mkdir -p "$dir"
  zip="$dir/$NAME.zip"
  say "Downloading FFglitch $VERSION from ffglitch.org…"
  if ! curl -fL --progress-bar -o "$zip.part" "$URL"; then
    bad "Couldn't download $URL"
    info "Check the internet connection and run  npm run ffglitch-setup  again."
    rm -f "$zip.part"; exit 1
  fi
  mv "$zip.part" "$zip"
  # ffglitch.org publishes no checksums; this one is printed so a later download can be compared.
  info "SHA-256: $(shasum -a 256 "$zip" | cut -d' ' -f1)"
  rm -rf "$dir/$NAME" "$bin"
  if ! unzip -q "$zip" -d "$dir"; then bad "The download isn't a working zip file."; rm -f "$zip"; exit 1; fi
  mv "$dir/$NAME" "$bin"
  rm -f "$zip"
  # Downloaded with curl, so macOS hasn't quarantined it; this only makes sure.
  xattr -dr com.apple.quarantine "$bin" 2>/dev/null || true
  for tool in ffgac ffedit; do
    if ! works "$tool"; then
      # Apple silicon only runs signed programs: an unsigned build gets a local (ad-hoc) signature.
      codesign --force --sign - "$bin/$tool" >/dev/null 2>&1 || true
    fi
    if works "$tool"; then ok "$tool $VERSION works"; else bad "$tool doesn't run:"; "$bin/$tool" -version 2>&1 | head -3 | sed 's/^/    /'; exit 1; fi
  done
  echo "$VERSION" > "$dir/version"
fi

say "Done. Datamosh Bake (Effects › Time) can bake now; quit and restart ginosa if it's open."
