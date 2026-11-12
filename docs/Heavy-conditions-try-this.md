# Heavy conditions · Try this

The code review of 12 Nov looked for what breaks once a project gets big or busy. Six things got fixed, each with a test that showed the problem first: more than 12 files playing at once, the graphics card resetting, big photo montages and panoramas, long Datamosh exports, edits while playing, and a catch-up stuck on a frame that never comes. About 10 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run test-media
npm run snapshot -- --scenario heavy
cat renders/ui/heavy.json
npm start
```

- [ ] `npm run check` ends with **Tests 402 passed (402)**.
- [ ] `npm run test-media` makes `media/heavy` the first time (14 tones, 24 photos of 4000 × 3000, a 12000 px panorama; about 5 MB, ignored by git), then skips it.
- [ ] `heavy` takes about 45 seconds and plays sound for part of it. Its report ends with `"verdict":"pass"`. Its parts, roughly:
  - `exportMemory`: 8 s of Datamosh exported with `peakStates` **2** and about **87 MB** (it held 9 states, 392 MB, before; a long export grew to 2 GB);
  - `editsWhilePlaying`: `starts` **0** and `catchUps` **0** through cube and effect edits (it was 5 and 2); `loudnessSpreadDb` about **9** while the Kick row ducks the tone, about **0.1–0.3** with its cubes off (the test allows up to 1.5), about **9** again with them back on;
  - `stuckCatchUp`: `play` and `jump` `"ok":true` in about **3.5 s** with a catch-up stuck (before: never); `alone` gives up with a *Couldn't catch up* message and a preview;
  - `manyFiles`: all 14 `toneLevels` **0.25** (before, files over 12 were closed while being read and went silent); `unheldReadsCancelled` above 0 shows that hazard still exists for reads that don't hold their file;
  - `deviceLoss`: `before` and `after` the same, `playbackCarriedOn` **true**;
  - `stills`: `gpuAfterMB` at most **1024** and `decodedAfterMB` at most **384** after 24 big photos, `first` and `firstAgain` the same, `panoramaCentre` **[1,1,1]** (a 12000 px picture used to fail);
  - `heldAtEnd`: **[]**.

## In ginosa

- [ ] **Edits while playing**: put Datamosh on a clip and link a Channel Rack channel to one of its values. Play, and click cubes on and off while it plays: playback carries on, with no "catching up" and no jump back. Drag an effect's value while playing: the same. Pause: the exact frame follows a moment later.
- [ ] **Sound follows the rack**: link a channel to an audio clip's Volume (it ducks on each hit), play, and switch the channel's cubes off: the ducking stops at once, without the playback starting again.
- [ ] **Edits that move things still start again from where you are**: delete or move a clip while playing. Playback carries on from the same place with the new edit.
- [ ] **A big montage**: drop 20 or more large photos on the timeline and step through them. Nothing goes black, and photos you come back to look the same.
- [ ] **Many sounds at once**: 13 or more audio clips playing or exporting together all come through.

## Your call

Decision 115 (Proposed): edits while playing carry on playing, and stateful effects carry on from the state they had, as a preview until you pause. Before, each edit started playback again with an exact catch-up first (seconds on a 4K Datamosh clip, for every cube).
