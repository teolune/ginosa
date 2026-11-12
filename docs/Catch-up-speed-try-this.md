# Catching up after edits · Try this

Your recording of 11 Nov: after Channel Rack edits, Datamosh on your 4K clip sat on "Stateful effects: catching up" for most of a minute while playback crawled. Now an edit only redoes the frames from the section you changed, one catch-up runs at a time, and Play no longer runs over itself. About 10 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario catchup4k
cat renders/ui/catchup4k.json
npm start
```

- [ ] `npm run check` ends with **Tests 401 passed (401)**.
- [ ] `catchup4k` (your two Apple Log clips from Reference Materials, only read; Datamosh on each, a Kick channel moving its Strength, 2-bar sections at 167 BPM). Roughly, on your Mac:
  - `afterEdit`: about **34 frames** in about **1.4 s** (it used to redo all 274, 8.9 s);
  - `carriedVsReplayed`: `"differing":0` (the frame from the kept states is exactly the frame replayed from the clip's start);
  - `playAfterEdit`: `msUntilPicture` about **1200–1500** (was 6300);
  - `playPausePlay`: `catchUpsAtOnce` **1** and `fps` about **25** (was 2 at once, then 16 fps);
  - `cold` (nothing kept, from the clip's start): about 6.8 s for 235 frames; `coldAtHalf` (the monitor at 1/2): about 3.9 s.

## In ginosa

- [ ] Put Datamosh (any of its presets) on a 4K clip, link a Channel Rack channel to one of its values, and play well into the clip once.
- [ ] Change a cube in the section under the playhead and press Play: the picture moves after about a second, not after "catching up" all the way from the clip's start.
- [ ] Press Space three times quickly (play, pause, play): playback is smooth, and there's never more than one "catching up" message.
- [ ] Press Pause while it's still catching up: the playhead stays where you pressed Play (it used to run on while nothing was shown).
- [ ] Still slow on a long 4K clip? Set the monitor to **1/2** (the resolution menu by the preview): catching up and playback get about twice as quick; export is unaffected.

## Your call

Decision 114 (Proposed): run a clip's effects at the size it's shown at in the frame, instead of at its own size (decision 37). A 4K clip fitted to a 1080p frame would then catch up and play about as fast as at 1/2 today, at full quality, unless you zoom in on it. See the decision for what changes.
