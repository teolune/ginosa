# ginosa

A music video editor and experimental visual effects workstation. It's a personal project, built for one machine: a MacBook Pro (Apple silicon) running macOS.

ginosa pairs a Premiere-style editor with a modular GPU effects system. Effects can be keyframed or driven by the music (bands, transients, beats, tempo), and they apply through adjustment layers. Tool windows float inside the workspace, FL Studio style.

The full plan, with stages, milestones and every design decision, lives in the Stage 2 Technical Plan doc. The repo keeps its own record of decisions in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Status

**M0 · Foundations.** The app opens a diagnostics shell. It proves that WebGPU, hardware video decoding and local file access work on this Mac, and that frames render through a GPU shader. The real editor workspace arrives in M1.

## Setup (once)

```bash
bash scripts/doctor.sh      # checks macOS, Node, FFmpeg, git, GitHub CLI
bash scripts/setup.sh       # installs npm dependencies
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Opens the app with live reload |
| `npm run check` | Typecheck + unit tests |
| `npm run test-media` | Generates synthetic test clips in `media/test/` |
| `npm run render -- --input <file> --frames 0,24 --effect invert` | Renders frames through the GPU pipeline to PNG (in `renders/`), without opening a window |
| `npm run doctor` | Re-runs the environment check |

### Render harness flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--input <path>` | required | Video file to render from |
| `--frames 0,24,48` | `0` | Frame numbers (0-based) |
| `--effect none\|invert` | `none` | M0 test shader |
| `--amount 0..1` | `1` | Effect amount |
| `--out <dir>` | `renders/<file name>` | Output folder |
| `--show` | off | Show the window while rendering |

Each run writes one PNG per frame plus `report.json`, which holds GPU and codec diagnostics, clip info and per-frame timings.

## Layout

```
src/
  main/       Electron main process: windows, file dialogs, read-only media protocol, render harness
  preload/    The bridge between main and renderer (window.ginosa)
  renderer/   Interface and GPU rendering (WebGPU + WGSL)
  engine/     Editing engine: plain TypeScript, no UI code, unit-tested
  shared/     Types and helpers used by every side
scripts/      doctor, setup, test-media generator
docs/         decisions log, milestone checklists
```

## Principles

- Original media is only ever opened read-only.
- The engine stays separate from the interface.
- Nothing pretends to work: unfinished features are labelled as such.
- Every milestone ends with a working app and a "Try this" checklist in `docs/`.
