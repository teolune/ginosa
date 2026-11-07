#!/usr/bin/env bash
# M14 side by side: your two Apple Log clips (in Reference Materials, only read) cut together and
# moshed by Datamosh several ways, next to a real codec mosh of the same picture (an MPEG-4
# stream with the cut's I-frame removed, and with a P-frame repeated). Writes contact sheets and
# side-by-side videos to renders/m14/footage. Needs FFmpeg and Python 3; the app's exports go to renders/export.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run snapshot -- --scenario moshfootage
E=renders/export
O=renders/m14/footage
mkdir -p "$O"
python3 scripts/codec-mosh.py cut "$E/mosh-plain.mov" 75 "$O/codec-cut.mov"
python3 scripts/codec-mosh.py bloom "$E/mosh-plain.mov" 90 12 "$O/codec-bloom.mov"
python3 scripts/codec-mosh.py sheet "$O/cut-sheet.png" "A cut (frame 75) moshed: a real MPEG-4 mosh (its I-frame removed) next to Datamosh" 76,78,82,90,105,130 \
  "Plain=$E/mosh-plain.mov" "Real codec mosh=$O/codec-cut.mov@1" "Codec Mosh preset=$E/mosh-codec.mov" "Reset on Cuts off only=$E/mosh-cut.mov" "Transition Melt=$E/mosh-melt.mov"
python3 scripts/codec-mosh.py sheet "$O/bloom-sheet.png" "Bloom on frame 90: a real P-frame repeated 12 times next to Datamosh Bloom (12 frames)" 91,94,98,101,106,120 \
  "Plain=$E/mosh-plain.mov" "Real codec bloom=$O/codec-bloom.mov" "Datamosh Bloom=$E/mosh-bloom.mov"
python3 scripts/codec-mosh.py sheet "$O/modes-sheet.png" "Datamosh modes on your clips (cut at frame 75)" 30,60,80,95,115,140 \
  "Plain=$E/mosh-plain.mov" "Freeze and Drift=$E/mosh-freeze.mov" "Fluid (from 74)=$E/mosh-fluid.mov" "Transition Melt (from 74)=$E/mosh-melt.mov" "Codec Mosh (from 74)=$E/mosh-codec.mov"
python3 scripts/codec-mosh.py video "$O/cut-side-by-side.mp4" 50 150 "Plain=$E/mosh-plain.mov" "Real codec mosh=$O/codec-cut.mov" "Codec Mosh preset=$E/mosh-codec.mov" "Transition Melt=$E/mosh-melt.mov"
python3 scripts/codec-mosh.py video "$O/bloom-side-by-side.mp4" 80 135 "Plain=$E/mosh-plain.mov" "Real codec bloom=$O/codec-bloom.mov" "Datamosh Bloom=$E/mosh-bloom.mov"
echo "Contact sheets and videos in $O"
