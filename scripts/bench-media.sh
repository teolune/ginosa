#!/usr/bin/env bash
# Test songs for the detection bench (W4.1), in media/bench/ (ignored by git):
#  - star-preview/: the STAR Drums preview (Weber et al., TISMIR 2025; BSD-3-Clause, audio under
#    Creative Commons licences listed in its LICENSE folder): real recordings with vocals and
#    instruments, whose drums were re-played from annotations, so every drum hit's time is exact.
# Downloaded once from Zenodo (about 97 MB); running it again only checks what's there.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
bench="$root/media/bench"
mkdir -p "$bench/download"

ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

zip="$bench/download/STAR_Drums_preview.zip"
url="https://zenodo.org/records/15690078/files/STAR_Drums_preview.zip?download=1"
if [[ ! -s "$zip" ]]; then
  echo "Downloading the STAR Drums preview (about 97 MB)…"
  if ! curl -L --fail --retry 3 --silent --show-error -o "$zip.part" "$url"; then bad "Download failed (above)."; rm -f "$zip.part"; exit 1; fi
  mv "$zip.part" "$zip"
fi
ok "STAR Drums preview: $(du -h "$zip" | cut -f1)"
if [[ ! -d "$bench/star-preview" ]]; then
  rm -rf "$bench/star-preview.part"
  mkdir -p "$bench/star-preview.part"
  if ! unzip -q "$zip" -d "$bench/star-preview.part"; then bad "Couldn't unzip it."; exit 1; fi
  mv "$bench/star-preview.part" "$bench/star-preview"
fi
ok "Unzipped in media/bench/star-preview: $(find "$bench/star-preview" -type f | wc -l | tr -d ' ') files"
find "$bench/star-preview" -maxdepth 6 | sed "s#$bench/##" | head -80
