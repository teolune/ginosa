# Multi-camera · Try this

Multi-camera editing (W5, decision 134): takes synced to the song by their sound, a group with an angle on each key, the multi-camera view, recording with the keys, favourites, B-roll and Automatic. About 20 minutes. Use a song you've shot takes to (a phone or camera recording the song playing on set is enough: ginosa listens for it).

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

- [ ] `npm run check` ends with **Tests 485 passed (485)**.
- [ ] `multicamsync`: `"verdict":"pass"`. Three takes land within a millisecond of where they belong (5.2 s, 13.36 s and −1.5 s); take_noise is left where it was and flagged.
- [ ] `multicam`: `"verdict":"pass"`. `"recorded"` lists take_a, take_early, take_a, take_b, each `"inSync":true`, and `"views"` are all under 0.002 (each piece shows its take exactly).
- [ ] `multicam.png`: the Program monitor in a 2 × 2 grid, each cell labelled with its key; the Multi-Camera window open.
- [ ] `multicamauto`: `"verdict":"pass"`. `"marked"` is 7–11 s, `"changed"` 12.52, and `"made"` reads take_early 0–6, take_a 6–13, take_noise 13–14, take_b 14–17, take_noise 17–19.52, take_b 19.52–20, with `"gaps"` `[[19.52,20]]`.
- [ ] `multicamauto.png`: the Multi-Camera window with a yellow favourite on each strip, take_noise's B-Roll button lit, and the cut on the Multi-Camera track in blue pieces, with a red flag at its end.

## Your takes

### A group

- [ ] Put the song on A1 (drop it on the **♪ Drop the song here** lane). Import your takes.
- [ ] Select the takes in the Media panel, right-click › **New Multi-Camera Group**. Each goes on a track of its own, lined up with the song, and a **Multi-Camera 1** track appears above them. The message says how many it heard the song in.
- [ ] Window › **Multi-Camera** (⌥⇧7) shows each angle with its key (1, 2, 3…), and **In sync**, **Check** or **Not heard**. Scrub through: the takes' sound should match the song (solo one take's sound to hear it).
- [ ] A take it couldn't hear: put the playhead on a moment in the take you can see or hear (a clap, a hit), press its **Sync Point**, then put the playhead where the song has that moment and press **Line Up Here**.

### Recording

- [ ] Press **Multi-Camera View**: the Program monitor shows every angle in a grid.
- [ ] Put the playhead where you want to start and press **● Record**. The song plays; press 1, 2, 3… to cut to each angle as you go. Press Space to stop. The cuts appear as blue pieces on the Multi-Camera track, each with its key on it. One undo removes them all.
- [ ] Play it back with the view off: each piece shows its angle, in sync. Effects on a take come with its pieces.
- [ ] Select a piece and press another key: it switches angle, keeping its place.

### Favourites and Automatic

- [ ] Under each angle there's a strip. Drag across it over a part you like: a yellow favourite. The Program monitor shows the multi-camera view while you drag, and the playhead follows, so you see the frames. Mark a few on each take.
- [ ] Drag a favourite's ends to change it, or its middle to move it. Click one and press ⌫ to delete it.
- [ ] A take that isn't of the song playing (B-roll: a walk, the city, hands): press its **B-Roll**. Its strip is now the take's own time; mark its good parts the same way.
- [ ] Set In and Out around the part to edit (or don't: Automatic does the whole song). Choose **Cut every** (a bar to start), keep **Use B-roll** on, and press **Make the Edit**. The message says how many shots, and whether anything wasn't covered.
- [ ] Play it: cuts land on the bar lines; the same angle never plays twice in a row unless it's the only one there; B-roll fills stretches none of your synced favourites cover.
- [ ] Red flags on the Multi-Camera track (and the list in the window) are stretches nothing covers. Click one in the list to go there, mark a favourite that covers it, and Make the Edit again.
- [ ] Try **Cut every** a beat and 2 bars on the same favourites. Undo puts back what was there each time.
- [ ] Tell me: does the order of angles feel right? Does B-roll come in where you'd want it? Should a gap hold the last angle (as now) or go to B-roll even if it's used up?
