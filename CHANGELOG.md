# Changelog

## M1 · Workspace and project

- **Projects:** `Name.ginosa` folders with `project.json`; New / Open / Open Recent / Save / Save As / Close / Show in Finder; start screen with recent projects.
- **Undo/redo:** every edit is a command recorded as Immer patches. Unlimited undo, rapid typing merges into one step, the Edit menu names the step, and a History window lets you jump to any step. The project counts as unsaved only when it differs from the saved point.
- **Autosave:** 5 s after you stop editing (at most every 60 s), rotating 20 snapshots, written atomically.
- **Crash recovery:** a journal records every change; after a crash or force quit, the project reopens automatically and offers to restore every change. Covered by end-to-end tests that simulate a crash.
- **Workspace:** media panel, program monitor (shaped by the sequence settings), timeline with real track headers (rename, hide, mute, lock, add, delete), resizable splitters.
- **Floating windows (FL Studio style):** move, resize, snap to edges and other windows, minimise to a tray, maximise, dock as tabs in a side column, close and reopen (⌥1–⌥4), saved named workspaces.
- **Windows:** Project Settings, History, Diagnostics, Playback Test (the M0 player, kept until the real monitors arrive).
- **Native menus** with Premiere-style shortcuts; unsaved-changes prompt on close and Cmd+Q.
- **Dev tools:** agent runner (`npm run agent`) and UI snapshot mode (`npm run snapshot -- --scenario …`) for automated screenshots.
- 56 unit tests (engine, history, file format, workspace layout, project files and recovery).


## M0 · Foundations (in progress)

Verified on the M5 MacBook Pro (2026-10-30): typecheck clean, 20/20 unit tests, render harness frame-accurate (each render matches its source frame, inverted). See `docs/M0-results.md`.

- Electron + electron-vite + TypeScript project, macOS window with an inset title bar.
- Read-only `ginosa-media://` protocol that streams local files with range requests.
- WebGPU device setup and a WGSL test shader (none / invert) drawing decoded frames.
- Mediabunny clip access: frame-accurate frame-by-index decoding and sequential playback.
- Diagnostics shell: GPU details, hardware decode/encode support per codec, clip info, decode and GPU timings, playback throughput test (no audio yet).
- Render harness: `npm run render` renders chosen frames to PNG without a window and writes `report.json`.
- Engine time module (integer ticks, frame rates, timecode) with unit tests.
- Scripts: `doctor.sh` (environment check), `setup.sh` (dependencies), `make-test-media.sh` (synthetic test clips).
- Docs: README, decisions log, dependencies and licences, M0 checklist.
