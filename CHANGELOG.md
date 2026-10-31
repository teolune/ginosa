# Changelog

## M4 · Playback (part 1)

- **Playback with sound:** Space plays and stops; J/K/L shuttle (L up to 8×, J reverse).
  - Web Audio is the master clock, and the picture always shows the frame for the moment being heard.
  - Decoders start before the clock does, so playback begins without a drop.
  - Mute, solo and Volume apply live; edits made during playback carry on playing.
- **GPU compositor (WebGPU)** in 16-bit float, shared by the paused frame and playback (and export in M5):
  - Motion: position, scale, Scale Width, rotation, anchor; soft edges.
  - Opacity and 13 Photoshop/Premiere blend modes, on display values.
  - Stills, and rotation metadata.
- **New clips are Set to Frame Size** (4K in a 1080p timeline arrives at 50%), Premiere style. M3 projects keep their fitted look.
- **Effect Controls window** (⌥7, docked by default):
  - Motion, Opacity + Blend Mode and Volume (dB), with Premiere-style scrubbable numbers (Shift faster, Option finer, click to type).
  - Each drag is one undo step, with reset buttons and Set to Frame Size.
- **Program monitor:** transport buttons, playback resolution (Full, 1/2, 1/4), and a timing overlay (fps, dropped frames, render time, A/V offset).
- **Sync test** (`npm run sync-test`): plays a flash-and-beep clip and writes `renders/sync/sync.json`. It measures A/V offset per frame, checks every frame by reading the composite back, and reports clock drift and dropped frames. Measured: 0 dropped, 0 wrong frames, 95% within 28 ms.
- **Project format v4:** Motion, opacity, blend mode and volume on every clip.
- 135 tests.

## M3 · Timeline

- **Clips on tracks:**
  - Drag in from Media or the Source Monitor (Cmd inserts), or press , / . to Insert / Overwrite from the Source Monitor at the playhead.
  - Camera clips arrive with their sound, linked.
  - Stills last 5 s.
- **Premiere's tools and shortcuts:**
  - Tools: Selection (V), Track Select Forward/Backward (A, Shift+A), Ripple Edit (B), Rolling Edit (N), Razor (C).
  - Move, copy (Option-drag), insert-move (Cmd-drag), trim, ripple trim (Cmd-drag an edge) and roll.
  - Add Edit (Cmd+K, Shift+Cmd+K), delete and ripple delete (Shift/Option+Delete), close gaps.
  - Nudge (Option+arrows), link/unlink (Cmd+L), copy/cut/paste/paste insert, select all.
- **Sync Lock and Solo** on every track, alongside eye/mute and lock. Ripple and insert edits shift sync-locked tracks Premiere-style. A ripple that would knock a sync-locked track out of sync is refused, and an insert that splits one says so.
- **Snapping** (S) to cuts, the playhead and markers, with a guide line.
- **Markers:** add (M), move, name, delete, next/previous.
- **Navigation:** zoom (=, −, \, pinch, Option+scroll), trackpad scrolling, a scrollbar, frame stepping, edit-point jumps (↑/↓) and typed timecode (Premiere style: "1000", "+10").
- **Timeline drawn on canvas:** thumbnails on video clips, waveforms on audio clips, a hatched look for locked tracks, offline clips in red, and live previews while dragging. Every preview runs the same engine function as the real edit.
- **Program monitor still frame:** the top visible (or soloed) clip under the playhead, fitted to the frame. Match Frame (F) opens the source at that frame.
- **Engine:** every edit is a command with a pure function behind it, frame-accurate and undoable.
  - Removing media or a track removes its clips (with a notice).
  - The frame rate is fixed once clips exist.
- **Project format v3:** adds clips, markers, sync lock and solo. M2 projects upgrade automatically.
- 129 tests (33 new timeline-engine tests, 3 new timecode tests).

## M2 · Media and cache

- **Import:** Cmd+I, the Import button, or drag from Finder. Folders become bins. Duplicates are skipped, unreadable files are reported, and each import is one undo step.
- **File details:** FFmpeg's ffprobe reads codec, size, rotation, frame rate, bit depth, colour tags and audio format, then scans the first 10 s for variable frame rate and keyframe spacing. Each file gets a fingerprint (size, date, and a hash of its first and last MiB).
- **Media panel (Premiere style):**
  - Bins nest and can be dragged into each other.
  - Selection works with Cmd and Shift, items rename inline, and search filters by name.
  - Columns (Name, Duration, Size, FPS, Codec, Status) appear as the panel widens.
  - Right-click menus, plus status pills for offline, changed, copying and optimised items.
- **Thumbnails and waveforms:** made by FFmpeg and stored in the cache. Waveforms keep 100 min/max peaks per second.
- **Source Monitor (⌥5):** plays video (from the optimised copy when there is one), steps frames, and shows waveforms for audio. In and Out marks (I/O) are saved with the project and undoable.
- **Optimised copies:** made automatically when a file can't be decoded here (ProRes) or has a variable frame rate. Offered, not forced, when keyframes are far apart.
  - 8-bit sources become H.264 and 10-bit sources become HEVC 10-bit (VideoToolbox), with keyframes every half second. Audio becomes 24-bit PCM.
  - HDR clips (HLG/PQ) are kept as HDR, with no automatic SDR copy (decision 20). When one needs a copy for another reason, the copy stays 10-bit HDR with its colour labels.
  - Copies are made one at a time, with progress shown and Cancel available. Partial files are removed if a copy fails or is cancelled.
- **Relink:** offline files show a pill. Locate a single file, or pick a folder and ginosa finds every missing file inside it by name and size.
- **Cache Manager (⌥6):**
  - Shows the cache folder, size per project and category, and active copies.
  - Clear a category, or Clean Up a whole project, with a two-click confirm.
  - The cache location can be changed.
  - Deletion is guarded: project-ID and category checks, real-path containment, and symlinks are refused. Originals are opened read-only and never touched.
- **Icons:** interface icons are SF Symbols, drawn by macOS at runtime and coloured like text: the track-header toggles (eye, speaker, padlock), window buttons, bins, audio and play.
- **Project format v2:** adds media and bins. v1 projects upgrade automatically.
- 93 unit and integration tests. The media tests run the real FFmpeg on generated clips.

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
