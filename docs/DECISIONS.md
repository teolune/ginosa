# Decisions log

**Approved** means you agreed to it. **Proposed** means Claude suggested it and it is waiting for your approval. Change a status by editing this file or by telling Claude. This file mirrors the decisions table in the Stage 2 Technical Plan doc.

| # | Decision | Status | Notes |
| --- | --- | --- | --- |
| 1 | Electron desktop app, macOS on Apple silicon only, personal use | Approved | No cross-platform or distribution work |
| 2 | TypeScript throughout, WGSL shaders for GPU effects, FFmpeg for media I/O | Approved | |
| 3 | Shared offline audio analysis; one source can drive many parameters | Approved | |
| 4 | Right-click Link to Audio / Create Keyframes / Modulate Parameter | Approved | |
| 5 | Shared mask system usable by any effect or adjustment layer | Approved | |
| 6 | Undo/redo, autosave, crash recovery, beat grid, cache management are core features | Approved | |
| 7 | Floating tool windows inside the main app window (FL Studio model) | Approved | |
| 8 | 1080p target; heavy 4K editing stays in Premiere | Approved | |
| 9 | Datamosh: GPU engine first (all modes), codec-level bake second | Approved | |
| 10 | Use any library needed; record every dependency and licence | Approved | See `DEPENDENCIES.md` |
| 11 | Direct 1080p import with automatic optimised copies; proxies later | Proposed | |
| 12 | Any standard frame rate up to 60 fps; real-time 1080p preview target | Proposed | |
| 13 | Working colour Rec.709 SDR, processed in 16-bit float | Proposed | |
| 14 | React for panels; timeline, keyframe editor and scopes drawn on canvas/GPU | Proposed | M0 uses plain DOM; React arrives in M1 |
| 15 | Gradient Map: Photoshop-matching editor plus .GRD import of solid gradients | Proposed | |
| 16 | Workflow: Mac linked to Claude, local git repo, private GitHub repo as backup | Approved | Repo: `teolune/ginosa` |
| 17 | Effects build order as listed in the plan's milestones | Proposed | |
| 18 | App name: **ginosa** | Approved | 2026-10-30 |

## Implementation notes (engineering choices, no approval needed)

- **Time** is stored as integer ticks at 254,016,000,000 per second (Premiere's rate). See `src/engine/time.ts`.
- **Local media** is served to the renderer through a read-only `ginosa-media://` protocol with HTTP range support. Mediabunny reads files in pieces rather than loading them whole.
- **M0 UI** is plain DOM on purpose. It is a diagnostics shell, replaced by the real workspace in M1.
