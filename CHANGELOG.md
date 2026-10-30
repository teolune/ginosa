# Changelog

## M0 · Foundations (in progress)

- Electron + electron-vite + TypeScript project, macOS window with an inset title bar.
- Read-only `ginosa-media://` protocol that streams local files with range requests.
- WebGPU device setup and a WGSL test shader (none / invert) drawing decoded frames.
- Mediabunny clip access: frame-accurate frame-by-index decoding and sequential playback.
- Diagnostics shell: GPU details, hardware decode/encode support per codec, clip info, decode and GPU timings, playback throughput test (no audio yet).
- Render harness: `npm run render` renders chosen frames to PNG without a window and writes `report.json`.
- Engine time module (integer ticks, frame rates, timecode) with unit tests.
- Scripts: `doctor.sh` (environment check), `setup.sh` (dependencies), `make-test-media.sh` (synthetic test clips).
- Docs: README, decisions log, dependencies and licences, M0 checklist.
