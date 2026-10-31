# M3 · Try this

M3 is the timeline. It adds:
- clips on tracks, with Premiere's tools and shortcuts
- linked picture and sound
- Sync Lock and Solo
- snapping, zoom and markers
- a Program monitor that shows the frame under the playhead

Playback (Space, J, K, L) and sound arrive in M4. This checklist takes about 30 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario timeline
open renders/ui/timeline.png
npm run snapshot -- --scenario drag
open renders/ui/drag.png
npm run dev
```

- [ ] `npm run check` ends with **Tests 129 passed (129)**. New in M3 are 33 timeline-engine tests and 3 timecode-typing tests. Together they cover:
  - placing, overwriting and inserting
  - moving and copying
  - trimming, ripple and roll
  - splitting and razor cuts
  - deleting, ripple deleting and closing gaps
  - linking, copy and paste, markers and snapping
  - Sync Lock behaviour
  - undo
  - the project-file upgrade
- [ ] `timeline.png` shows a small edit:
  - linked picture and sound on V1/A1, with thumbnails and a waveform
  - a still on V2 and the song on A2
  - two green markers on the ruler
  - in the Program monitor, the still at 00:00:03:00 (the top clip there)
- [ ] `drag.png` shows the still being dragged (a scripted drag). It snaps to the cut at 00:00:04:00, and a yellow guide marks the snap.
- [ ] `npm run dev` opens the app. Your M2 projects open fine: they're upgraded to the new project format, with Sync Lock on for every track. Once saved, they won't open in older ginosa builds.

Other new scenarios: `icons` (track header states).

## Getting clips in

- [ ] Drag clips from **Media** onto a track. Hold **Cmd** as you drop to insert (push later clips along) instead of overwrite.
  - Several selected items land one after another.
  - Stills last 5 seconds.
- [ ] A camera clip lands **linked**: picture on a video track, sound on the audio track the same distance from the middle (V1 with A1, V2 with A2).
- [ ] Drag the **Source Monitor** picture into the timeline. It uses the In/Out you set there.
- [ ] With a clip open in the Source Monitor, press **,** (Insert) or **.** (Overwrite).
  - The clip goes in at the playhead on the lowest unlocked tracks (V1/A1 unless they're locked).
  - The playhead then jumps to the end of the new clip.

## Selecting and moving (Selection tool, V)

- [ ] Click a clip to select it with its linked partner.
  - **Option-click** selects just one side.
  - **Shift-click** or **Cmd-click** adds or removes clips.
  - Drag across empty space to select with a box.
  - **Cmd+A** selects all; **Shift+Cmd+A** deselects.
- [ ] Drag a clip to move it. It overwrites whatever it lands on, as in Premiere.
  - Drag up or down to change tracks; linked sound mirrors the picture (V2 ↔ A2).
  - Hold **Cmd** while dropping to insert.
  - Hold **Option** while dragging to copy.
- [ ] **Option+←/→** nudges the selection a frame (add Shift for 5 frames). **Option+↑/↓** moves it a track.
- [ ] **S** (or the Snap button) toggles snapping. Edges stick to cuts, the playhead and markers, and a yellow guide shows where.

## Trimming

- [ ] With the Selection tool, drag a clip's edge to **trim** it.
  - It stops at the neighbouring clip and at the end of the media.
  - Linked sound trims too; **Option**-drag an edge to trim one side only.
- [ ] **Cmd**-drag an edge, or use the **Ripple Edit** tool (**B**). The clip's length changes and everything after it follows.
- [ ] **Rolling Edit** tool (**N**): drag the cut between two clips. One gets longer, the other shorter, and nothing else moves.
- [ ] Undo after each one: one step each, named in the Edit menu and History.

## Cutting and deleting

- [ ] **Cmd+K** cuts at the playhead: the selected clips, or every track if nothing is selected. **Shift+Cmd+K** always cuts every track.
- [ ] **Razor** (**C**): click a clip to cut it there. **Shift**-click cuts all tracks.
- [ ] **Delete** removes clips and leaves a gap.
  - **Shift+Delete** (or **Option+Delete**) ripple deletes, closing the gap.
  - Click the empty space between two clips to select that gap; **Delete** closes it.
- [ ] **Cmd+L** unlinks or links. **Cmd+C / Cmd+X / Cmd+V** copy, cut and paste at the playhead. **Shift+Cmd+V** pastes as an insert.
- [ ] **A** / **Shift+A**: Track Select Forward / Backward. Click to select everything from that point on (or up to it). Shift-click for one track only.

## Sync Lock, with a song

This is the important one for music videos.

1. Put a song on A2 and a few clips on V1.
2. Ripple delete a V1 clip. It's refused: A2 has a clip in that time, and closing the gap would move the song out of sync.
3. Click A2's **Sync Lock** button (the square with two arrows) to turn it off. Ripple delete again: V1 closes up and the song stays where it is.
4. Turn Sync Lock back on and do an **Insert** on V1. The song is split to make room, and a message says so. Undo it.

- [ ] That all behaves as described. Usually you'll want Sync Lock **off** on your song track.

## Playhead, zoom and markers

- [ ] Click or drag in the ruler to move the playhead.
  - It snaps to cuts and markers while snapping is on; hold Shift to snap when it's off.
  - **←/→** step a frame (Shift: 5 frames). **↑/↓** jump to the previous or next cut or marker. **Home/End** go to the start or end.
- [ ] Click the blue timecode at the top left of the timeline and type a time. **1000** goes to 00:00:10:00, and **+10** moves 10 frames on.
- [ ] Zoom and scroll:
  - **=** / **−** zoom; **\\** fits the whole edit.
  - Pinch, or Option+scroll, to zoom at the pointer.
  - Two-finger scroll moves along the timeline; the bar underneath scrolls too.
- [ ] Markers:
  - **M** adds a marker at the playhead.
  - Drag markers along the ruler, double-click one to name it, right-click to delete.
  - **Shift+M** goes to the next marker; **Shift+Cmd+M** to the previous one.

## Program monitor

- [ ] It shows the frame under the playhead: the top visible clip, fitted to the frame. Optimised copies are used where they exist.
  - Turning a track's eye off hides it.
  - **Solo** on a video track shows only soloed tracks.
- [ ] Space, J, K and L show a message: playback, blending, Motion and effects are M4.
- [ ] **F** (Match Frame), or double-clicking a clip, opens its source in the Source Monitor at the same frame.

## Track headers

- [ ] Each header has:
  - eye (video) or speaker (audio)
  - **S** for Solo
  - **Sync Lock**
  - a padlock to lock the track
- [ ] Locked tracks are hatched, and their clips can't be selected or changed.
- [ ] Right-click a header to add or delete tracks; double-click a name to rename it.

Tell me anything that feels different from Premiere, especially dragging and trimming. I can tune those by feel.
