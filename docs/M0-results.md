# M0 results: what this Mac can do

Measured on Teo's MacBook Pro (Apple M5, 16 GB, macOS 26.4) on 2026-10-30, with Electron 45.2.0 (Chromium 156) and Node 26.

## Graphics (WebGPU)

- Available on Apple's Metal 3 backend. Max texture size 16384 px.
- Useful features present: `shader-f16` (half-precision maths, faster effects), `timestamp-query` (exact GPU timings per effect), `float32-filterable`, `subgroups`.
- The first frame took 679 ms of GPU time because the shader was being compiled; later frames took 2.3–2.6 ms. **Consequence:** from M6, effect shaders are compiled at startup, so the first use of an effect doesn't stutter.

## Hardware video

| Codec | Decode | Encode |
| --- | --- | --- |
| H.264 High 1080p | yes | yes |
| HEVC Main 1080p | yes | yes |
| HEVC Main 10 | yes | **no** |
| VP9, AV1 | yes | n/a |
| ProRes 422 | **no** | n/a |

**Consequences:**
- ProRes sources get an optimised copy on import (M2), as planned.
- 10-bit HEVC export goes through FFmpeg's `hevc_videotoolbox` instead of WebCodecs (M5).

## Accuracy

- Frames 0, 12 and 100 of the H.264 test clip were rendered and compared with FFmpeg's decode of the same frames. Each render matches its exact source frame (about 40 dB PSNR, the residue being chroma rounding), and the inversion is correct.
- Chromium decodes untagged HD video as BT.709. **Consequence:** the M4 colour pipeline sets the YUV→RGB matrix explicitly, and exports are tagged BT.709.

## Timings (test clip, random access)

- Decode: 13–19 ms per frame jumped to, 81 ms for the first (decoder start-up).
- GPU draw: 2–3 ms.
