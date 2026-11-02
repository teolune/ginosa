/** Note values for Grain's Refresh (M11): length in beats, or (negative) in bars. */
export const GRAIN_NOTES: ReadonlyArray<{ id: string; label: string; beats: number }> = [
  { id: '1/32', label: '1/32', beats: 0.125 },
  { id: '1/16', label: '1/16', beats: 0.25 },
  { id: '1/8T', label: '1/8 triplet', beats: 1 / 3 },
  { id: '1/8', label: '1/8', beats: 0.5 },
  { id: '1/8D', label: '1/8 dotted', beats: 0.75 },
  { id: '1/4T', label: '1/4 triplet', beats: 2 / 3 },
  { id: '1/4', label: '1/4 (a beat)', beats: 1 },
  { id: '1/4D', label: '1/4 dotted', beats: 1.5 },
  { id: '1/2', label: '1/2', beats: 2 },
  { id: '1 bar', label: '1 bar', beats: -1 },
  { id: '2 bars', label: '2 bars', beats: -2 },
  { id: '4 bars', label: '4 bars', beats: -4 }
]

/** The WGSL lookup, built from the same list so the two can't disagree. */
export const NOTES_WGSL = `fn grainNoteBeats(index: u32) -> f32 {
  var notes = array<f32, ${GRAIN_NOTES.length}>(${GRAIN_NOTES.map((n) => n.beats.toFixed(9)).join(', ')});
  var beats = notes[min(index, ${GRAIN_NOTES.length - 1}u)];
  if (beats < 0.0) { beats = -beats * beatsPerBar(); }
  return beats;
}
`
