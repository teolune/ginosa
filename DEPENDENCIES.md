# Dependencies and licences

ginosa is a personal project that won't be distributed, so licences don't limit which libraries we use. They're still recorded here. Versions are pinned in `package-lock.json`. Run `npm ls --depth=0` to see the exact installed versions.

## npm packages

| Package | Use | Licence | Added |
| --- | --- | --- | --- |
| electron | App shell (bundles Chromium and Node) | MIT; Chromium: BSD-3-Clause plus third-party | M0 |
| electron-vite | Build and dev server for main, preload and renderer | MIT | M0 |
| vite (installed with electron-vite) | Bundler and dev server | MIT | M0 |
| typescript | Language and typechecking | Apache-2.0 | M0 |
| vitest | Unit tests | MIT | M0 |
| @types/node | Node type definitions | MIT | M0 |
| @webgpu/types | WebGPU type definitions | BSD-3-Clause | M0 |
| mediabunny | Reading/writing MP4, MOV, WebM etc.; WebCodecs wrapper | MPL-2.0 | M0 |

## Planned (not installed yet)

| Package | Use | Licence | Milestone |
| --- | --- | --- | --- |
| react, react-dom | Panels and inspectors | MIT | M1 |
| immer | Immutable project state and undo patches | MIT | M1 |
| playwright | UI smoke tests | Apache-2.0 | M2 |
| essentia.js (fallback only) | Beat tracking if our own detector falls short | AGPL-3.0 | M8 |

## External tools (installed with Homebrew, not bundled)

| Tool | Use | Licence |
| --- | --- | --- |
| FFmpeg / ffprobe | Conform, optimised copies, ProRes, export muxing, test media | LGPL-2.1+ / GPL-2+ (Homebrew build includes GPL parts) |
| Python 3 (macOS command line tools) | `scripts/codec-mosh.py`: the real codec mosh for M14's side-by-side tests (standard library only, with FFmpeg) | PSF License |
| ffglitch | Codec-level datamosh (M15) | FFmpeg-derived; checked when added |
| GitHub CLI (gh) | Pushing to the private repo | MIT |

## Provided by macOS

| Asset | Use | Terms |
| --- | --- | --- |
| SF Symbols | Interface icons, drawn by macOS at runtime through Electron's `nativeImage.createFromNamedImage`; nothing is bundled or copied into the repo | Apple's SF Symbols terms: only in apps for Apple platforms, and never in app icons, logos or other trademark use. Fine for a personal Mac-only app; the app icon must be our own |

## Test data and references (M13)

| What | Use | Licence |
| --- | --- | --- |
| `kiwi.grd`, `nine.grd` from the [`gradient`](https://github.com/zeevallin/gradient) Ruby gem (Copyright 2015 Philip Vieira) | Test fixtures in `src/engine/gradients/fixtures`, with the licence notice | MIT |
| [grdkit](https://pub.dev/packages/grdkit) and [psd-grd](https://github.com/hi104/psd-grd) | Cross-checked against while writing ginosa's own .grd reader; no code copied | MIT |
| Michel Mariani's [Photoshop file formats](https://tonton-pixel.codeberg.page/photoshop-file-formats/gradients-file-format.html) | The .grd and descriptor formats | Documentation |
| Ilia Malanin, "Photoshop Algorithms Arcana" ([pastila.org](https://pastila.org/essays/classic-gradient-interpolation/)) | How Classic gradients are drawn, reimplemented from the description | Essay |
| photocraft's published measurements (GitHub, storytold/photocraft) | Gradient Map's brightness weights and where a midpoint is stored | Facts only |

## Stem separation (W3, decision 112; installed by `npm run stems-setup` into `.stems/`, not bundled)

| Package or file | Use | Licence |
| --- | --- | --- |
| [demucs-mlx](https://pypi.org/project/demucs-mlx/) 1.6.1 | Splits the song on A1 into drums, bass, vocals and other for Automatic Detection, on this Mac | MIT (a port of Meta's Demucs, MIT) |
| MLX, mlx-metal | Apple's machine-learning framework that demucs-mlx runs on | MIT |
| mlx-audio-io, mlx-spectro | Audio reading/writing and the STFT for demucs-mlx | MIT; mlx-audio-io includes libsoxr (LGPL-2.1), its notice shipped inside the package |
| htdemucs weights (`ssmall256/demucs-mlx` on Hugging Face, converted from Meta's checkpoints; downloaded on the first run and checked against digests in demucs-mlx) | The separation model | MIT, as the weights' page states (the same licence as Demucs; trained by Alexandre Défossez and others at Meta AI Research). Some read Meta's original checkpoint release as research-only: fine for a personal app that never passes the weights on; check again before ever shipping ginosa to others |
| Python 3.10 or newer (3.12 preferred: `brew install python@3.12`) | Runs demucs-mlx | PSF License |

No new npm packages.

