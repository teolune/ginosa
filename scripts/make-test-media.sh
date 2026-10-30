#!/usr/bin/env bash
# Generates small synthetic test clips into media/test/ (git-ignored).
# The frame counter drawn by ffmpeg's testsrc makes frame accuracy visible,
# and the audio beeps once per second for later sync tests.
set -euo pipefail
cd "$(dirname "$0")/.."
out="media/test"
mkdir -p "$out"

encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
has() { grep -q " $1 " <<<"$encoders"; }

video_src="testsrc=size=1920x1080:rate=24:duration=10"
audio_src="aevalsrc=exprs='0.4*sin(2*PI*1000*t)*lt(mod(t\,1)\,0.05)':sample_rate=48000:duration=10"

if has libx264; then
  h264=(-c:v libx264 -profile:v high -pix_fmt yuv420p -crf 16 -g 12 -bf 2)
else
  h264=(-c:v h264_videotoolbox -profile:v high -b:v 20M -g 12)
fi

echo "H.264 1080p24 with beeps"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_src" -f lavfi -i "$audio_src" \
  "${h264[@]}" -c:a aac -b:a 192k -movflags +faststart "$out/testsrc_1080p24_h264.mp4"

echo "H.264 1080p24, long keyframe interval (10 s)"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_src" \
  "${h264[@]}" -g 240 -movflags +faststart "$out/testsrc_1080p24_h264_longgop.mp4"

if has hevc_videotoolbox; then
  echo "HEVC 1080p24"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_src" \
    -c:v hevc_videotoolbox -b:v 15M -tag:v hvc1 -movflags +faststart "$out/testsrc_1080p24_hevc.mp4"
elif has libx265; then
  echo "HEVC 1080p24"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_src" \
    -c:v libx265 -crf 20 -tag:v hvc1 -pix_fmt yuv420p -movflags +faststart "$out/testsrc_1080p24_hevc.mp4"
fi

if has prores_ks; then
  echo "ProRes 422 1080p24 (expected: not decodable by WebCodecs)"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$video_src" \
    -c:v prores_ks -profile:v 2 -pix_fmt yuv422p10le "$out/testsrc_1080p24_prores.mov"
fi

echo "29.97 fps H.264 (timecode check)"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=1920x1080:rate=30000/1001:duration=5" \
  "${h264[@]}" -movflags +faststart "$out/testsrc_1080p2997_h264.mp4"

echo
ls -lh "$out"
