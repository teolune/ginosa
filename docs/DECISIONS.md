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
| 11 | Direct 1080p import with automatic optimised copies; proxies later | Approved | |
| 12 | Any standard frame rate up to 60 fps; real-time 1080p preview target | Approved | |
| 13 | Working colour Rec.709 SDR, processed in 16-bit float | Approved | Camera footage is log: log-to-Rec.709 conversion and camera `.cube` LUTs move into M4 |
| 14 | React for panels; timeline, keyframe editor and scopes drawn on canvas/GPU | Approved | M0 uses plain DOM; React arrives in M1 |
| 15 | Gradient Map: Photoshop-matching editor plus .GRD import of solid gradients | Approved | |
| 16 | Workflow: Mac linked to Claude, local git repo, private GitHub repo as backup | Approved | Repo: `teolune/ginosa` |
| 17 | Effects build order as listed in the plan's milestones | Proposed | |
| 18 | App name: **ginosa** | Approved | 2026-10-30 |
| 19 | Log footage support (camera conversion + `.cube` LUT per clip) moves into M4 | Proposed | Raised by M0: camera originals are log |
| 20 | HDR clips (HLG/PQ, e.g. iPhone's normal HDR mode) stay HDR: no automatic SDR copy. They're converted to the Rec.709 sequence live on the GPU, as a per-clip input setting alongside Apple Log (M4), so grading keeps the highlights. Export stays SDR | Approved | 2026-10-31. A full HDR timeline and export was offered and not chosen |
| 21 | Interface icons are Apple's SF Symbols, drawn by macOS at runtime; text fallback if a symbol is missing | Approved | 2026-10-31, your request |

## Implementation notes (engineering choices, no approval needed)

- **Time** is stored as integer ticks at 254,016,000,000 per second (Premiere's rate). See `src/engine/time.ts`.
- **Local media** is served to the renderer through a read-only `ginosa-media://` protocol with HTTP range support. Mediabunny reads files in pieces rather than loading them whole.
- **M0 UI** is plain DOM on purpose. It is a diagnostics shell, replaced by the real workspace in M1.
- **Media files** are identified by a fingerprint: size, modification time, and a SHA-1 of the first and last MiB. A file that changes size shows as *Changed*; a missing one shows as *Offline*.
- **Optimised copies** (M2): H.264 CRF 16 for 8-bit sources, HEVC Main10 via VideoToolbox for 10-bit and all HDR sources, keyframes every 0.5 s, 24-bit PCM audio, in `.mov`. Made automatically only when needed (codec not decodable by WebCodecs, variable frame rate); offered for keyframes more than 2 s apart. HDR copies keep their BT.2020 + HLG/PQ labels, stamped into the bitstream because Apple's encoder drops them. File names carry a format version (now v2), so changing the recipe never reuses stale copies.
- **HDR to Rec.709** maths lives in `src/shared/colour/hdr-to-sdr.ts`, ready for M4: HLG inverse OETF + OOTF at 1000 nits (PQ via its EOTF), 203-nit reference white mapped to 1.0, a soft roll-off above 0.75, BT.2020→709 matrix, then BT.709 gamma, generated as a 33³ `.cube`. Until M4, the Source Monitor shows HDR clips with Chromium's own conversion.
- **Cache** lives at `~/Movies/ginosa Cache/<project id>/<category>/` with an `index.json` naming each project. Every delete goes through `CacheService`, which checks the project ID and category, resolves real paths, stays inside the cache root and refuses symlinks. A chosen location always gets its own `ginosa Cache` subfolder.
