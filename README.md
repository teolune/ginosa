# ginosa

A music video editor and experimental visual effects workstation. It's a personal project, built for one machine: a MacBook Pro (Apple silicon) running macOS.

ginosa pairs a Premiere-style editor with a modular GPU effects system. Effects can be keyframed or driven by the music (bands, transients, beats, tempo), and they apply through adjustment layers. Tool windows float inside the workspace, FL Studio style.

The full plan, with stages, milestones and every design decision, lives in the Stage 2 Technical Plan doc. The repo keeps its own record of decisions in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Status

**M9 · Masks and the temporal engine.** Shared masks (rectangle, ellipse, pen path, edge, luminance range) that any effect or adjustment layer can use, keyframed or driven by the music and drawn on the Program monitor; stateful effects with checkpoints, starting with Feedback; a render cache with a render bar, Enter to render, and a full Cache Manager. Built on M8's audio and modulation, M7's keyframes, M6's effects, M5's export, M4's playback, M3's timeline, M2's media and M1's projects. Next: M10 (Colour & Light, Mosaic).

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
| `npm run agent` | Lets Claude run the commands above on this Mac (see `scripts/agent-runner.mjs`) |
| `npm run sync-test` | Plays a flash-and-beep clip and measures picture/sound sync; writes `renders/sync/sync.json` |
| `npm run speed-test` | Plays speed, reverse, hold and dissolve clips and checks every frame; writes `renders/speed/speed.json` |
| `npm run snapshot -- --scenario effectsgpu` | Runs every effect setting and blend mode on the GPU and compares with the CPU maths; writes `renders/ui/effectsgpu.json` (also `masksgpu` and `feedbackgpu`) |
| `npm run snapshot -- --scenario feedback` | M9's done-when test: Feedback exported, played, scrubbed and cached, each checked; writes `renders/ui/feedback.json` |
| `npm run export-test` | Exports test projects and reads the files back: A/V sync, colour and tags in four formats, every frame of speed/reverse/dissolve; writes `renders/export/*.json` |
| `npm run snapshot -- --scenario workspace` | Saves a screenshot of the app in a scripted state to `renders/ui/` (scenarios: start, workspace, windows, settings, docked, recovery, recovered, media, source, waveform, cache, icons, timeline, drag, composite, playback, sync) |

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
  main/       Electron main process: windows, menus, projects, read-only media protocol,
              media probing and optimised copies (FFmpeg), cache service, render harness
  preload/    The bridge between main and renderer (window.ginosa)
  renderer/   Interface and GPU rendering (WebGPU + WGSL)
  engine/     Editing engine: plain TypeScript, no UI code, unit-tested
  shared/     Types and helpers used by every side
scripts/      doctor, setup, test-media generator
docs/         decisions log, milestone checklists
```

## Principles

- Original media is only ever opened read-only. Everything ginosa generates lives in its cache (`~/Movies/ginosa Cache` by default), and deleting is only possible inside it.
- The engine stays separate from the interface.
- Nothing pretends to work: unfinished features are labelled as such.
- Every milestone ends with a working app and a "Try this" checklist in `docs/`.
