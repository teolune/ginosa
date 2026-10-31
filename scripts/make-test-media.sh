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

echo "Frame-numbered clip: 10 black/white blocks spell out each frame's number (long GOP with B-frames)"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "nullsrc=s=1280x720:r=25:d=12,format=gray,geq=lum='255*mod(floor(N/pow(2\,floor(X/128)))\,2)'" \
  -c:v libx264 -pix_fmt yuv420p -g 25 -bf 2 -crf 18 -movflags +faststart "$out/framecode_h264.mp4"

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

echo "Song: 20 s, kick-like hits at 120 BPM (for waveform and, later, beat-detection tests)"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "aevalsrc=exprs='0.8*sin(2*PI*55*t)*exp(-14*mod(t\,0.5))+0.15*sin(2*PI*880*t)*exp(-40*mod(t+0.25\,0.5))':sample_rate=48000:duration=20" \
  -c:a pcm_s24le "$out/song_120bpm.wav"

echo "Sync clip: a white frame and a 1 kHz beep at every whole second, 25 fps (for the playback sync test)"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=black:s=1280x720:r=25:d=10,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n\,25)\,0)'" \
  -f lavfi -i "aevalsrc=exprs='if(lt(mod(t\,1)\,0.04)\,0.8*sin(2*PI*1000*t)\,0)':sample_rate=48000:duration=10" \
  -c:v libx264 -pix_fmt yuv420p -g 25 -c:a aac -b:a 192k -shortest -movflags +faststart "$out/sync_flash_beep.mp4"

if has hevc_videotoolbox; then
  # Five patches with known RGB: grey 0.2, grey 0.5, (0.6, 0.25, 0.15), (0.15, 0.45, 0.7), white 0.95,
  # stored as 10-bit BT.2020 Y'CbCr and tagged several ways, to test how Chromium hands each to the GPU.
  patches="color=c=0x333333:s=256x720:r=25:d=2[a];color=c=0x808080:s=256x720:r=25:d=2[b];color=c=0x994026:s=256x720:r=25:d=2[c];color=c=0x2673B3:s=256x720:r=25:d=2[d];color=c=0xF2F2F2:s=256x720:r=25:d=2[e];[a][b][c][d][e]hstack=5,format=gbrp,scale=out_color_matrix=bt2020:out_range=tv,format=p010le"
  for tag in "applelog:9:2" "applelog2:2:2" "hlg:9:18" "srgbtagged:1:13"; do
    name=${tag%%:*}; rest=${tag#*:}; prim=${rest%%:*}; trc=${rest#*:}
    echo "Colour patches tagged like $name (primaries $prim, transfer $trc, BT.2020 matrix)"
    ffmpeg -hide_banner -loglevel error -y -f lavfi -i "nullsrc=s=16x16:d=2" -filter_complex "$patches" \
      -c:v hevc_videotoolbox -profile:v main10 -tag:v hvc1 -q:v 90 \
      -bsf:v "hevc_metadata=colour_primaries=$prim:transfer_characteristics=$trc:matrix_coefficients=9" "$out/patches_$name.mov"
  done
  echo "Colour patches as ordinary, fully tagged Rec.709 (BT.709 matrix, primaries and transfer)"
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "nullsrc=s=16x16:d=2" -filter_complex "${patches/bt2020/bt709}" \
    -c:v hevc_videotoolbox -profile:v main10 -tag:v hvc1 -q:v 90 \
    -bsf:v "hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1" "$out/patches_rec709.mov"
fi

echo "4K still image"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=3840x2160:rate=1" -frames:v 1 "$out/still_4k.png"

echo
ls -lh "$out"
