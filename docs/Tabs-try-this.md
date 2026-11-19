# The clef and project tabs · Try this

Decision 128: the clef alone on its side as the Home button, and open projects as tabs, as in Chrome. About 5 minutes.

## In Terminal

Open a new Terminal tab with Cmd+T. Don't use the tab running `npm run agent`. Quit the app if it's open. Paste one line at a time, without any ``` marks:

```
cd ~/Desktop/video/Developer/Ginosa
npm run check
npm run snapshot -- --scenario tabs
cat renders/ui/tabs.json
open renders/ui/tabs.png
npm start
```

- [ ] `npm run check` ends with **Tests 426 passed (426)**. New tests: several projects open in the main process at once, each with its own lock and journal; opening one that's open already; closing one (its lock goes, nothing to recover when it opens again); Save As moving a tab; and two projects registering in the cache at once.
- [ ] `tabs`: `"verdict":"pass"`, two tabs left (`Snapshot Project` shown, `Second Project`, both unsaved), `"recovered":[2,1]`, and the clef `"width":85.5,"height":30` at `"left":84`.
- [ ] `tabs.png`: the clef on its side at the top left, then the two tabs, the shown one joined to the window below.

## In ginosa

- [ ] The top left shows your clef alone, on its side (its curl to the left), sharp-edged, clear of the window buttons.
- [ ] Open a project, then click the clef: the home page shows, the clef is lit, and the project's tab is still there. Click the tab: the project comes back where you left it (playhead, zoom, scroll, selection).
- [ ] From the home page, create or open a second project: a second tab. Click between them: each has its own timeline and its own undo (⌘Z undoes only the shown project's edits).
- [ ] An edit puts a dot on its own tab only. Click that tab's ×: ginosa asks to save. Cancel keeps it open.
- [ ] Control-Tab and Control-Shift-Tab move between tabs; ⌘W closes the shown one; ⇧⌘H shows home. Window › Home, Next Tab and Previous Tab are there too.
- [ ] File › Open Recent on a project that's already open shows its tab instead of opening it twice.
- [ ] Play, then switch tabs: playback stops.
- [ ] Quit with unsaved changes in two tabs: ginosa shows each in turn and asks.
