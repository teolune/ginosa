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
| GitHub CLI (gh) | Pushing to the private repo | MIT |

## FFglitch (M15, decision 133; downloaded by `npm run ffglitch-setup` into `.ffglitch/`, not bundled)

| What | Use | Licence |
| --- | --- | --- |
| [FFglitch](https://ffglitch.org) 0.10.2 for macOS on Apple silicon (`ffgac`, `ffedit`; by Ramiro Polla, from `ffglitch.org/pub/bin/macos-aarch64/`; the zip downloaded on 20 Nov 2026 had SHA-256 `25a5a7d51217919db5a093b211fd8a1e27845284efb0a6f616b8f371f6638eef`, which the setup prints each time it downloads, since ffglitch.org publishes no checksums) | Datamosh Bake: ffgac (FFmpeg with glitch options) encodes each bake as MPEG-4 Part 2; ffedit runs the bake's script on its motion vectors. ginosa runs them as separate programs and links nothing from them | GPL-2.0-or-later (an FFmpeg fork). Run as separate tools, so ginosa's own code isn't affected; a personal app that isn't distributed either way |
| [ffglitch-scripts](https://github.com/ramiropolla/ffglitch-scripts) and FFglitch's documentation and source (`ffglitch-core`) | Read for how ffedit's scripts see motion vectors (`frame.mv.forward`, `MV2DArray`, `overflow`) and the encoder options; ginosa's scripts are its own, no code copied | Unlicense (scripts); GPL-2.0-or-later (source, read only) |

## Provided by macOS

| Asset | Use | Terms |
| --- | --- | --- |
| SF Symbols | Interface icons, drawn by macOS at runtime through Electron's `nativeImage.createFromNamedImage`; nothing is bundled or copied into the repo | Apple's SF Symbols terms: only in apps for Apple platforms, and never in app icons, logos or other trademark use. Fine for a personal Mac-only app; the app icon must be our own |

## The ginosa mark (decision 113)

| What | Use | Licence |
| --- | --- | --- |
| Your 8-bit treble clef (`Reference Materials/8bitG (high res).png`), redrawn pixel for pixel in `assets/logo` | The logo: title bar, title screen, Dock icon, `Ginosa.icon` | Yours to use: you confirmed on 11 Nov 2026 that you drew it or hold rights that cover a logo. Its low-res copy (`8bitG.png`) carries Adobe Stock preview watermarks, and Adobe Stock's licences don't allow its images in logos |
| Your `Ginosa.icon` (Icon Composer) | Its settings (gradient, lavender glass layer, scale, shadow, translucency) for the Dock icon and the project's own `assets/logo/Ginosa.icon` | Yours |

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
| Python 3.12 (a private copy in `.stems/python`, from [python-build-standalone](https://github.com/astral-sh/python-build-standalone), when this Mac has no Python 3.10–3.13; yours is 3.15) | Runs demucs-mlx and the detection lab | PSF License (and the licences of the libraries it bundles, listed in its distribution) |
| [uv](https://github.com/astral-sh/uv) (in `.stems/bootstrap`) | Fetches that Python 3.12 | MIT or Apache-2.0 |
| [mlx-audio-separator](https://pypi.org/project/mlx-audio-separator/) 0.1.20 | Runs BS-RoFormer-SW (and other separation models) on MLX for Detect (W4.2) | MIT (derived from python-audio-separator, MIT) |
| BS-RoFormer-SW weights (jarredou; downloaded by mlx-audio-separator into `.stems/models`, converted for MLX once) | The separator Detect uses first: six stems | CC BY-NC-SA 4.0 (non-commercial; approved for this personal app, decision 117) |
| [PyTorch](https://pytorch.org) 2.15.0 | Converts BS-RoFormer-SW's and DrumSep's checkpoints for MLX once; runs ADTOF (W4.3) | BSD-3-Clause |
| [ADTOF-pytorch](https://github.com/xavriley/ADTOF-pytorch) (commit 85c192e, its weights included) | The drum transcriber's main ear (W4.3): kick, snare, toms, hi-hat and cymbal hits in the drums stem. Xavier Riley's PyTorch port of ADTOF (Zehren, Alunno and Bientinesi, 2023) | CC BY-NC-SA 4.0, as ADTOF (non-commercial; approved, decision 117) |
| DrumSep weights (MDX23C, by aufr33 and jarredou; downloaded by mlx-audio-separator into `.stems/models`, converted for MLX once, the checkpoint then an empty placeholder) | Splits the drums stem into kick, snare, toms, hi-hat, ride and crash, whose onsets add the hits ADTOF missed (W4.3) | Not stated by its authors (approved, decision 117) |
| [librosa](https://librosa.org) 1.0.1, with numba 0.68.1, llvmlite 0.50.0, soxr 1.1.0 | Onsets in DrumSep's pieces; audio loading for ADTOF | ISC; numba BSD-2-Clause; llvmlite BSD-2-Clause and Apache-2.0 with LLVM exception; soxr LGPL-2.1 or later (its notice inside the package) |
| [pretty_midi](https://github.com/craffel/pretty-midi) 0.2.11.post0, with mido 1.3.3 | Reads ADTOF's MIDI | MIT; MIT |
| [Beat This!](https://github.com/CPJKU/beat_this) 1.1.0 (`beat-this`), its final0 checkpoint (81 MB, from JKU's server into `.stems/torch`) | The tempo and bar 1 of the song on A1 (W4.5): the song's beats and downbeats | MIT (code and weights; Institute of Computational Perception, JKU Linz) |
| torchaudio 2.11.1, einops 0.8.2, rotary-embedding-torch 0.9.2 | Beat This!'s spectrogram and its model's parts | BSD-2-Clause; MIT; MIT |
| [Basic Pitch](https://github.com/spotify/basic-pitch) 0.4.0 (`basic-pitch`, its ONNX model included; installed without its own requirements, which ask for TensorFlow on Python 3.12) | The bass ear's note transcriber (W4.4): the notes in the bass stem | Apache-2.0 (Spotify) |
| [ONNX Runtime](https://onnxruntime.ai) 1.32.0, with flatbuffers and protobuf; resampy 0.4.3; mir_eval 0.8.2 | Runs Basic Pitch's model; resampling and note helpers it imports | MIT, Apache-2.0, BSD-3-Clause; ISC; MIT |
| safetensors 0.8.0, soundfile 0.14.0, requests, PyYAML | Weights, audio files and downloads for the separator | Apache-2.0, BSD-3-Clause, Apache-2.0, MIT |
| [STAR Drums](https://doi.org/10.5281/zenodo.15690078) preview (in `media/bench`, not in the repo) | The detection bench's real songs with exact drum hits (W4.1) | Code and annotations BSD-3-Clause; audio under various Creative Commons licences, listed in its `LICENSE` folder |
| [BabySlakh](https://zenodo.org/records/4603870) (in `media/bench`, not in the repo; 883 MB download) | The detection bench's songs with exact bass notes (W4.4): 20 songs rendered from MIDI with sampled instruments, with their stems and MIDI (Manilow et al., WASPAA 2019) | CC BY 4.0 |

No new npm packages.

