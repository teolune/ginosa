#!/usr/bin/env bash
# Test songs for the detection bench (W4.1), in media/bench/ (ignored by git):
#  - star-preview/: the STAR Drums preview (Weber et al., TISMIR 2025; BSD-3-Clause, audio under
#    Creative Commons licences listed in its LICENSE folder): real recordings with vocals and
#    instruments, whose drums were re-played from annotations, so every drum hit's time is exact.
#  - babyslakh/: BabySlakh (Manilow et al., WASPAA 2019; CC BY 4.0), the first 20 songs of Slakh2100:
#    mixes rendered from MIDI with sampled instruments, each with its stems and MIDI, so every bass
#    note's start is exact (W4.4). 16 kHz.
# Downloaded once from Zenodo (about 97 MB and 883 MB); running it again only checks what's there.
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

tar="$bench/download/babyslakh_16k.tar.gz"
url="https://zenodo.org/record/4603870/files/babyslakh_16k.tar.gz?download=1"
if [[ ! -s "$tar" ]]; then
  echo "Downloading BabySlakh (about 883 MB)…"
  if ! curl -L --fail --retry 3 --silent --show-error -o "$tar.part" "$url"; then bad "Download failed (above)."; rm -f "$tar.part"; exit 1; fi
  mv "$tar.part" "$tar"
fi
ok "BabySlakh: $(du -h "$tar" | cut -f1)"
if [[ ! -d "$bench/babyslakh" ]]; then
  rm -rf "$bench/babyslakh.part"
  mkdir -p "$bench/babyslakh.part"
  if ! tar -xzf "$tar" -C "$bench/babyslakh.part"; then bad "Couldn't unpack it."; exit 1; fi
  mv "$bench/babyslakh.part" "$bench/babyslakh"
fi
ok "Unpacked in media/bench/babyslakh: $(find "$bench/babyslakh" -type f | wc -l | tr -d ' ') files"
find "$bench/babyslakh" -maxdepth 3 | sed "s#$bench/##" | head -30
