# Multi-camera · Try this

Multi-camera editing (W5, decision 134), in the window you designed: takes synced to the song by their sound, a clip on each key (1–9 and 0), recording with the keys, favourite parts marked with M, B-roll and Automatic. About 20 minutes. Use a song you've shot takes to (a phone or camera recording the song playing on set is enough: ginosa listens for it).

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run snapshot -- --scenario multicamsync
cat renders/ui/multicamsync.json
npm run snapshot -- --scenario multicam
cat renders/ui/multicam.json
open renders/ui/multicam.png
npm run snapshot -- --scenario multicamauto
cat renders/ui/multicamauto.json
open renders/ui/multicamauto.png
npm start
```

- [ ] `npm run check` ends with **Tests 487 passed (487)**.
- [ ] `multicamsync`: `"verdict":"pass"`. Three takes land within a millisecond of where they belong (5.2 s, 13.36 s and −1.5 s); take_noise is left where it was and flagged.
- [ ] `multicam`: `"verdict":"pass"`. `"recorded"` lists take_a, take_early, take_a, take_b, each `"inSync":true`, and `"views"` are all under 0.002 (each piece shows its take exactly).
- [ ] `multicam.png`: the Program monitor in a 2 × 2 grid, each cell labelled with its key; the Multi-Camera window open.
- [ ] `multicamauto`: `"verdict":"pass"`. `"keys"` is take_a 1, take_b 2, take_early 3, take_noise 4; `"mirrorDiff"` is 0; `"marked"` is `[[7,11]]`; `"made"` reads take_early 0–6, take_a 6–13, take_noise 13–14, take_b 14–17, take_noise 17–19.52, take_b 19.52–20, with `"gaps"` `[[19.52,20]]`; `"closed"` is true.
- [ ] `multicamauto.png`: the Multi-Camera window as your design: the preview showing take_a alone (labelled, with an in-point marked), Record and Play/Pause under it, Add Clip + and Mark Clip (lit), and each clip with its key, solo (take_a's filled yellow) and strip with red marks.

## Your takes

### Opening it and adding clips

- [ ] Put the song on A1 (drop it on the **♪ Drop the song here** lane). Import your takes.
- [ ] Press the **Multi-Camera** button in the Control Panel (the camera in a viewfinder, after the Channel Rack). The window opens, empty, with the preview at the top. Press it again: it closes.
- [ ] Select your takes in the Media panel, then in the window press **Add Clip +** › **Selected in the Media Panel**. Each goes on a track of its own, lined up with the song. The message says how many it heard the song in.
- [ ] Or right-click a clip on the timeline › **Add to Multi-Camera**. It joins the same group on the next free key. **Add Clip +** also lists the timeline's selected clips and each video track.
- [ ] Each clip shows as *name (V2)*, with **In sync**, **Check** or **Not heard**. Scrub through: the takes should match the song.
- [ ] A take it couldn't hear: right-click it › **Sync Point** with the playhead on a moment you can see (a clap, a hit), then put the playhead where the song has that moment and press **Line Up Here**.
- [ ] Click a clip's key box to move it to another key (taking another clip's key swaps them).

### Recording

- [ ] The preview shows every clip in a grid, numbered. The grid button by full screen switches to the edit and back. Full screen (far right) fills the screen with the preview and its controls; Esc leaves.
- [ ] Put the playhead where you want to start and press **Record** (the red button). The song plays; press 1–9 and 0 to cut to each clip. Press Space (or Record again) to stop. The cuts appear on the Multi-Camera track as blue pieces with their key on them, in one undo step.
- [ ] Play it back with the grid off: each piece shows its clip, in sync, with its effects.
- [ ] Select a piece and press another key: it switches clip, keeping its place.

### Marking favourite parts

- [ ] Press **Mark Clip** with nothing soloed: the first clip with nothing marked is soloed (its yellow dot fills), and plays alone in the preview.
- [ ] Play, and press **M** where a good part starts and **M** where it ends: it shows in red on that clip's strip. Mark as many as you like. Esc drops an in-point.
- [ ] While marking, press another clip's number to solo it, or click its yellow button.
- [ ] Drag a red mark's start or end on the strip to change it, or its middle to move it. Click one and press ⌫ to delete it. Click elsewhere on a strip to move the playhead there.
- [ ] With every clip marked and nothing soloed, Mark Clip says so.
- [ ] A take that isn't of the song playing (a walk, the city, hands): right-click › **B-Roll**. Its strip is now the take's own time.

### Automatic

- [ ] Set In and Out around the part to edit (or don't: Automatic does the whole song). Choose **Cut every** (a bar to start), keep **Use B-roll** on, and press **Make the Edit**. The message says how many shots, and whether anything wasn't covered.
- [ ] Play it: cuts land on the bar lines; the same clip never plays twice in a row unless it's the only one there; B-roll fills stretches none of your synced marks cover.
- [ ] Red flags on the Multi-Camera track (and the list in the window) are stretches nothing covers. Click one in the list to go there, mark a part that covers it, and Make the Edit again.
- [ ] Try **Cut every** a beat and 2 bars. Undo puts back what was there each time.
- [ ] Tell me: does the window work the way you drew it? Does the order of clips feel right in Automatic, and does B-roll come in where you'd want it?
