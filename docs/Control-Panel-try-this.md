# Wireframe phase 1: look, layout, Control Panel · Try this

Your wireframes, phase 1: the title screen, the layout with the Control Panel on top, frames (landscape and portrait), the purple look and the media column's folder browser. About 15 minutes. Automation clips and the Channel Rack additions come next.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario controlpanel
cat renders/ui/controlpanel.json
open renders/ui/controlpanel.png
npm start
```

- [ ] `npm run check` ends with **Tests 392 passed (392)**. New tests: the layouts of both frames and how old layouts move over, the tempo knob (typing, dragging, 999.999), New Project sizes and ratios, Date Created in Recent, and the folder listing.
- [ ] `controlpanel` (it plays sound for a few seconds, with metronome clicks): expect `"verdict":"pass"` with
  - `detectedBpm` **120** (Automatic Detection on the snapshot song),
  - `metronome`: `offGrid` 0, `wrongBars` 0, `lateClicks` 0, and `scheduledThroughHeard` equal to `heardBeats` (one click per beat that played),
  - `folder`: 18 entries (the test media folder).
- [ ] `controlpanel.png`: the portrait frame (a 9:16 sequence) with the folder browser open.

## Title screen

- [ ] The mark and **ginosa** at the top, **New Project** on the left and **Recent** on the right.
- [ ] Pick **1080p Video** or **4K Video**, flip **16:9 ↔ 9:16**: the size under it changes (1920 × 1080, 1080 × 1920, 3840 × 2160, 2160 × 3840).
- [ ] **Custom Ratio**: type 4:5 → 1080 × 1350 (4K: 2160 × 2700). 1:1 and 2.39:1 work too. The short side stays 1080 or 2160.
- [ ] **Custom Resolution**: type a width and height. Odd numbers are refused (video encoders need even sizes).
- [ ] The frame-rate menu (25 by default; not in your wireframe, I added it so you don't have to change it afterwards). **Create** asks where to save, then opens the project at that size. Your last choices are remembered.
- [ ] **Recent** lists projects with the date each was made (**Date Created**). Hover one for its folder and when you last opened it. **Open Project…** is at the bottom.

## Layout and frames

- [ ] With a project open: the **Control Panel** across the top; media on the left; the preview in the middle; the timeline under both; **Effect Controls | Add Effects** on the right at full height. Panels are rounded, with gaps you can drag to resize.
- [ ] Your saved layout moved over: History is closed (Window › History brings it back as a tab) and floating windows stayed where they were.
- [ ] **Frames** (the last Control Panel button): **Auto** (the default) picks the layout from the sequence's shape; **Landscape** and **Portrait (mobile)** fix it. Make a 9:16 project, or change the sequence to 1080 × 1920 with the gear in the preview: the layout switches to portrait: media | effects, the timeline under both, a tall preview on the right with Full, the timing overlay, the gear and the timecode above it and the transport below.
- [ ] Drag the gap left of the tall preview to make it wider or narrower.

## Control Panel

- [ ] **Tempo knob**: drag up or down (whole BPM, keeping decimals), Shift for 10 at a time, Option for hundredths; scroll works too. Click the number to type one, up to **999.999**. With no beat grid yet it shows 120 in grey; turning or typing makes a grid starting at the playhead.
- [ ] **Sparkles** (Automatic Detection): finds the tempo and downbeat of the music. It analyses the grid's source, or adds the full mix as a source if there's none. It pulses while it listens; bar numbers then appear on the ruler.
- [ ] **Up / down arrows**: double or halve the tempo (undoable).
- [ ] **Transport**: back to start; **Play/Pause** (Pause stays where it is); **Stop** goes back to where Play started, and pressed again goes to the start; skip to end. Space is still Play/Pause.
- [ ] **New Adjustment Layer**: 5 seconds at the playhead, above the clips there.
- [ ] **Channel Rack** opens and closes its window (it floats, as you chose). **Import folder** opens and closes the media column. **Full-screen preview** fills the screen with the preview; Esc leaves.
- [ ] **Metronome**: clicks on every beat while playing, higher on each bar's first beat. It needs a tempo.
- [ ] The playhead's timecode and bar.beat are on the right.
- [ ] **Automate BPM** (the small wave) and **New automation clip** are greyed out: they arrive with automation clips (next phase). Hover them to see.

## Media column: Folder

- [ ] **Media | Folder** at the top of the left column. **Folder** → **Open Folder…** and pick a folder of footage or music (for example `Reference Materials`). Subfolders first, then media files with their sizes; other files are counted at the bottom, not listed.
- [ ] Double-click a folder to go in; the arrow goes up; click a part of the path to jump back.
- [ ] Double-click a file to import it, or select several (Cmd-click, Shift-click) and press **Import**. **Import Folder** brings in everything inside into a bin. Files already in the project say **In project**. The folder is only read: nothing in it is copied, moved or changed.

## Look

- [ ] Near-black violet with purple accents (#0e0c12, #271170, #bb91fa): buttons, selections, the playhead, video clips (purple), adjustment layers (now rose so they stand apart from video), keyframe and modulation views.

## Limits and what's next

- [ ] Automation clips (an FL-style keyframe editor opened by double-clicking a clip on the timeline; tempo, effects, volume) are next, then the Channel Rack additions (effects on peaks in a frequency band, vocal isolation with a local model).
- [ ] Changing a sequence from 16:9 to 9:16 keeps clips where their Motion puts them (top left), as before; nothing re-fits them yet.
- [ ] Cmd+N in an open project still makes a 1080p project at 25 fps (change it with the gear). The title screen has the full choices.
- [ ] Decisions 94–103 are in `docs/DECISIONS.md`; the ones marked Proposed are my choices where the wireframe left room (Auto frames, the knob's steps, the folder browser's tabs, the frame-rate menu…).
