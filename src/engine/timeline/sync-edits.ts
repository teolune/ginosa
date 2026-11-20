import { CommandError } from '../project/commands'
import type { MediaItem } from '../project/media'
import { defaultId, type Clip, type IdFactory, type Sequence } from '../project/model'
import { secondsToTicks, type Ticks } from '../time'
import { timelineCommand, type TimelineCommand } from './edits'
import { EditContext, clearRange, clipEnd, frameTicks, mediaLength, speedRamp } from './timeline'

/**
 * Lining takes up with the song (W5.1, decision 134). Sync says where a take's file starts in the
 * song's file (`offset`, seconds: negative when the take starts first). The song clip plays its
 * file from `sourceIn` at `start`, so song-file time u is at timeline time
 * `start − sourceIn + u`, and the take's file time m at `start − sourceIn + offset + m`.
 * A clip starts on a whole frame, so the take keeps its start to the nearest frame and its
 * `sourceIn` takes up the rest: the sound stays in sync to the sample.
 */

/** Where a take goes: its new start (on a frame) and sourceIn, or why it can't. */
export type SyncPlacement = { start: Ticks; sourceIn: Ticks; duration: Ticks } | { problem: string }

/** Whether a clip can be synced by its sound: a video or audio clip at one speed, forwards. */
export function syncable(clip: Clip): string | null {
  if (clip.adjustment || clip.automation) return 'it has no sound of its own'
  if (clip.speed !== 1 || clip.reverse || speedRamp(clip)) return 'it isn’t at 100% speed forwards'
  return null
}

export function syncPlacement(sequence: Sequence, media: readonly MediaItem[], song: Clip, take: Clip, offset: number): SyncPlacement {
  const problem = syncable(take) ?? (song.speed !== 1 || song.reverse || speedRamp(song) ? 'the song isn’t at 100% speed forwards' : null)
  if (problem) return { problem }
  const frame = frameTicks(sequence)
  // Timeline time of the take file's time 0.
  const zero = song.start - song.sourceIn + secondsToTicks(offset)
  let start = Math.round((zero + take.sourceIn) / frame) * frame
  // It can't start before the sequence, or before its file: later frames, then.
  while (start < 0 || start - zero < 0) start += frame
  const sourceIn = start - zero
  const item = media.find((m) => m.id === take.mediaId)
  const length = item ? mediaLength(item) : null
  let duration = take.duration - Math.max(0, start - (zero + take.sourceIn))
  if (length !== null) duration = Math.min(duration, Math.floor((length - sourceIn) / frame) * frame)
  if (duration < frame) return { problem: 'none of it overlaps the song' }
  return { start, sourceIn, duration: Math.round(duration / frame) * frame }
}

/**
 * Moves takes (and the clips linked to them: their own sound) to where they're in sync with the
 * song, overwriting what's there on their tracks, as a move does. One undo step.
 */
export function placeInSync(places: ReadonlyArray<{ clipId: string; start: Ticks; sourceIn: Ticks; duration: Ticks }>, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand(places.length === 1 ? 'Sync to Song' : `Sync ${places.length} Clips to Song`, (draft) => {
    const sequence = draft.sequence
    const ctx = new EditContext(newId)
    const moved: Clip[] = []
    for (const place of places) {
      const clip = sequence.clips.find((c) => c.id === place.clipId)
      if (!clip) throw new CommandError('A clip to sync is gone')
      const family = clip.linkId ? sequence.clips.filter((c) => c.linkId === clip.linkId) : [clip]
      for (const c of family) {
        if (moved.some((m) => m.id === c.id)) continue
        // Linked clips move with it, keeping their offset from it.
        const shift = c.start - clip.start
        const sourceShift = c.sourceIn - clip.sourceIn
        moved.push({ ...c, start: place.start + shift, sourceIn: place.sourceIn + sourceShift, duration: place.duration })
      }
    }
    const ids = new Set(moved.map((c) => c.id))
    sequence.clips = sequence.clips.filter((c) => !ids.has(c.id))
    for (const clip of moved) {
      if (clip.start < 0) throw new CommandError('A synced clip would start before the sequence')
      clearRange(sequence, clip.trackId, clip.start, clipEnd(clip), ctx)
    }
    sequence.clips.push(...moved)
  })
}
