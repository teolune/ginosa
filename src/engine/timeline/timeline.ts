import { cloneEffect } from '../effects/params'
import { cloneKeyframeMap, shiftKeyframeMap, speedIntegral, timelineForMedia, type Keyframe } from '../keyframes/keyframes'
import type { MediaItem } from '../project/media'
import { CommandError } from '../project/commands'
import { frameRateOf, type Clip, type IdFactory, type Sequence, type Track, type TrackKind } from '../project/model'
import { secondsToTicks, ticksPerFrame, type Ticks } from '../time'

/**
 * Timeline building blocks. Everything here works on a plain (or Immer draft)
 * Sequence and is shared by the edit commands and by the timeline's live drag
 * previews, so what you see while dragging is exactly what the command will do.
 */

/** Stills placed on the timeline last this long, as in Premiere. */
export const DEFAULT_STILL_SECONDS = 5

export function clipEnd(clip: Clip): Ticks {
  return clip.start + clip.duration
}

export function frameTicks(sequence: Sequence): Ticks {
  return ticksPerFrame(frameRateOf(sequence.settings))
}

/** Nearest frame boundary (or the one at/below with 'floor'). */
export function toFrame(ticks: Ticks, frame: Ticks, mode: 'round' | 'floor' | 'ceil' = 'round'): Ticks {
  const n = ticks / frame
  const whole = mode === 'floor' ? Math.floor(n + 1e-9) : mode === 'ceil' ? Math.ceil(n - 1e-9) : Math.round(n)
  return whole * frame
}

export function findTrack(sequence: Sequence, id: string): Track {
  const track = sequence.tracks.find((t) => t.id === id)
  if (!track) throw new CommandError(`No track with id ${id}`)
  return track
}

export function findClip(sequence: Sequence, id: string): Clip {
  const clip = sequence.clips.find((c) => c.id === id)
  if (!clip) throw new CommandError(`No clip with id ${id}`)
  return clip
}

/** Tracks of one kind in order: V1, V2… or A1, A2… */
export function tracksOf(sequence: Sequence, kind: TrackKind): Track[] {
  return sequence.tracks.filter((t) => t.kind === kind)
}

export function trackIndex(sequence: Sequence, track: Track): number {
  return tracksOf(sequence, track.kind).findIndex((t) => t.id === track.id)
}

/** The track `offset` places away from `track` among tracks of its kind (V up, A down), or null. */
export function offsetTrack(sequence: Sequence, track: Track, offset: number): Track | null {
  return tracksOf(sequence, track.kind)[trackIndex(sequence, track) + offset] ?? null
}

export function clipsOnTrack(sequence: Sequence, trackId: string): Clip[] {
  return sequence.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start)
}

export function sequenceEnd(sequence: Sequence): Ticks {
  return sequence.clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0)
}

export function assertUnlocked(track: Track): void {
  if (track.locked) throw new CommandError(`${track.name} is locked`)
}

/** How much of the media exists, in ticks; null for stills, which can be any length. */
export function mediaLength(item: MediaItem): Ticks | null {
  if (item.kind === 'image') return null
  return secondsToTicks(item.info.durationSeconds)
}

export function mediaFor(media: MediaItem[], clip: Clip): MediaItem | undefined {
  return media.find((m) => m.id === clip.mediaId)
}

/** Clip ids plus every clip linked to them. */
export function withLinked(sequence: Sequence, ids: Iterable<string>): string[] {
  const result = new Set(ids)
  const links = new Set(sequence.clips.filter((c) => result.has(c.id) && c.linkId).map((c) => c.linkId))
  for (const clip of sequence.clips) if (clip.linkId && links.has(clip.linkId)) result.add(clip.id)
  return [...result]
}

/** Tracks that ripple along with an edit on `edited`: sync-locked, unlocked, not already edited. */
export function syncTracks(sequence: Sequence, edited: Iterable<string>): string[] {
  const skip = new Set(edited)
  return sequence.tracks.filter((t) => t.syncLock && !t.locked && !skip.has(t.id)).map((t) => t.id)
}

/**
 * Shared state for one edit: fresh ids, and new link ids for the right-hand halves of
 * split clips, so halves split in the same edit stay linked to each other.
 */
export class EditContext {
  private links = new Map<string, string>()
  /** Clips on tracks the user didn't edit that this edit had to split (for a notice). */
  readonly splitElsewhere: Clip[] = []
  constructor(readonly newId: IdFactory) {}

  linkForRightHalf(linkId: string | null): string | null {
    if (!linkId) return null
    let next = this.links.get(linkId)
    if (!next) {
      next = this.newId()
      this.links.set(linkId, next)
    }
    return next
  }
}

/** A deep copy (nested objects aren't shared, which matters inside Immer drafts). */
export function cloneClip(clip: Clip): Clip {
  return {
    ...clip,
    motion: { ...clip.motion },
    transitionIn: clip.transitionIn ? { ...clip.transitionIn } : null,
    transitionOut: clip.transitionOut ? { ...clip.transitionOut } : null,
    // Effects are copied with their ids (ids only need to be unique within a clip).
    effects: clip.effects.map((e) => cloneEffect(e)),
    keyframes: cloneKeyframeMap(clip.keyframes)
  }
}

/** A clip's Speed keyframes, if it's speed-ramped (forward video only). */
export function speedRamp(clip: Clip): Keyframe[] | null {
  const track = clip.keyframes['speed']
  return track && track.length > 0 && clip.speed > 0 && !clip.reverse ? track : null
}

/** How much media a clip uses, in ticks (its duration × speed, or what its speed ramp covers; 0 for a frame hold). */
export function sourceSpan(clip: Clip): Ticks {
  const ramp = speedRamp(clip)
  if (ramp) return Math.round(speedIntegral(ramp, clip.duration))
  return Math.round(clip.duration * clip.speed)
}

/**
 * Where in its media a clip is during the sequence frame starting at `time` (`frame` is
 * the sequence's frame length), with speed, reverse and frame hold. A reversed clip shows
 * the same frames as it would forwards, in the opposite order: its first frame is the
 * forward clip's last. Times past the media's ends (a transition needing more than there
 * is) hold the edge frame, as Premiere does. A speed-ramped clip has travelled as far
 * as its Speed keyframes have carried it.
 */
export function sourceTimeAt(clip: Clip, time: Ticks, frame: Ticks, length: Ticks | null = null): Ticks {
  let t: Ticks
  const ramp = speedRamp(clip)
  if (ramp) t = clip.sourceIn + Math.round(speedIntegral(ramp, time - clip.start))
  else if (clip.speed === 0) t = clip.sourceIn
  else if (clip.reverse) t = clip.sourceIn + sourceSpan(clip) - Math.round((time - clip.start + frame) * clip.speed)
  else t = clip.sourceIn + Math.round((time - clip.start) * clip.speed)
  if (length !== null) t = Math.min(Math.max(0, t), Math.max(0, length - 1))
  return t
}

/**
 * Removes `ticks` from the clip's start (negative: extends it). Which end of the media
 * that touches depends on direction: a reversed clip starts at the end of its media.
 */
export function cutHead(clip: Clip, ticks: Ticks): void {
  const ramp = speedRamp(clip)
  clip.start += ticks
  clip.duration -= ticks
  if (ramp) clip.sourceIn += Math.round(speedIntegral(ramp, ticks))
  else if (clip.speed > 0 && !clip.reverse) clip.sourceIn += Math.round(ticks * clip.speed)
  // Keyframes stay where they were in the sequence, with the picture.
  shiftKeyframeMap(clip.keyframes, -ticks)
  for (const effect of clip.effects) shiftKeyframeMap(effect.keyframes, -ticks)
}

/** Removes `ticks` from the clip's end (negative: extends it). */
export function cutTail(clip: Clip, ticks: Ticks): void {
  clip.duration -= ticks
  if (clip.speed > 0 && clip.reverse) clip.sourceIn += Math.round(ticks * clip.speed)
}

/**
 * Spare media beyond the clip's ends, in timeline ticks (what a trim or transition can
 * reveal). `length` is the media's length, or null for stills; frame holds never run out.
 */
export function handles(clip: Clip, length: Ticks | null): { head: Ticks; tail: Ticks } {
  if (clip.speed === 0 || length === null) return { head: Number.MAX_SAFE_INTEGER, tail: Number.MAX_SAFE_INTEGER }
  const before = Math.max(0, clip.sourceIn)
  const after = Math.max(0, length - clip.sourceIn - sourceSpan(clip))
  const ramp = speedRamp(clip)
  if (ramp) return { head: timelineForMedia(ramp, 0, before, -1), tail: timelineForMedia(ramp, clip.duration, after, 1) }
  const toTimeline = (ticks: Ticks) => Math.floor(ticks / clip.speed)
  return clip.reverse ? { head: toTimeline(after), tail: toTimeline(before) } : { head: toTimeline(before), tail: toTimeline(after) }
}

/** Splits `clip` at `at` (strictly inside it). The clip keeps the left part; returns the new right part. */
export function splitClip(sequence: Sequence, clip: Clip, at: Ticks, ctx: EditContext): Clip {
  const offset = at - clip.start
  const right: Clip = { ...cloneClip(clip), id: ctx.newId(), linkId: ctx.linkForRightHalf(clip.linkId), transitionIn: null }
  cutHead(right, offset)
  cutTail(clip, clip.duration - offset)
  clip.transitionOut = null
  sequence.clips.push(right)
  return right
}

/** Overwrite: empties [start, end) on a track by trimming, splitting or removing what's there. */
export function clearRange(sequence: Sequence, trackId: string, start: Ticks, end: Ticks, ctx: EditContext): void {
  if (end <= start) return
  for (const clip of clipsOnTrack(sequence, trackId)) {
    const cEnd = clipEnd(clip)
    if (cEnd <= start || clip.start >= end) continue
    if (clip.start >= start && cEnd <= end) {
      sequence.clips.splice(sequence.clips.indexOf(clip), 1)
    } else if (clip.start < start && cEnd > end) {
      splitClip(sequence, clip, end, ctx)
      cutTail(clip, clipEnd(clip) - start)
    } else if (clip.start < start) {
      cutTail(clip, cEnd - start)
    } else {
      cutHead(clip, end - clip.start)
    }
  }
}

/**
 * Insert: opens `length` of empty time at `at` on each track. Clips starting at or
 * after `at` move later; a clip spanning `at` is split and its second half moves.
 */
export function insertSpace(sequence: Sequence, trackIds: Iterable<string>, at: Ticks, length: Ticks, ctx: EditContext, edited: Set<string> = new Set()): void {
  if (length <= 0) return
  for (const trackId of trackIds) {
    for (const clip of clipsOnTrack(sequence, trackId)) {
      if (clip.start >= at) clip.start += length
      else if (clipEnd(clip) > at) {
        const right = splitClip(sequence, clip, at, ctx)
        right.start += length
        if (!edited.has(trackId)) ctx.splitElsewhere.push(clip)
      }
    }
  }
}

/** The first clip on each track overlapping [start, end), or none. */
export function blockingClips(sequence: Sequence, trackIds: Iterable<string>, start: Ticks, end: Ticks): Clip[] {
  const blocking: Clip[] = []
  for (const trackId of trackIds) {
    const clip = clipsOnTrack(sequence, trackId).find((c) => c.start < end && clipEnd(c) > start)
    if (clip) blocking.push(clip)
  }
  return blocking
}

/**
 * Ripple removal: deletes the empty time [start, end) on each track, pulling later
 * clips earlier. Refuses if any track has a clip in that time, since removing it
 * would knock that track out of sync.
 */
export function removeSpace(sequence: Sequence, trackIds: string[], start: Ticks, end: Ticks): void {
  if (end <= start) return
  const blocking = blockingClips(sequence, trackIds, start, end)
  if (blocking.length > 0) {
    const names = [...new Set(blocking.map((c) => findTrack(sequence, c.trackId).name))].join(', ')
    throw new CommandError(
      `Can't ripple: ${names} ${blocking.length === 1 ? 'has a clip' : 'have clips'} in that time. Turn off Sync Lock or lock ${blocking.length === 1 ? 'that track' : 'those tracks'} to leave ${blocking.length === 1 ? 'it' : 'them'} in place.`
    )
  }
  const length = end - start
  const ids = new Set(trackIds)
  for (const clip of sequence.clips) if (ids.has(clip.trackId) && clip.start >= end) clip.start -= length
}

/** How far before `at` the tracks are empty (the most a ripple ending at `at` can remove), capped at `max`. */
export function emptyBefore(sequence: Sequence, trackIds: Iterable<string>, at: Ticks, max: Ticks): Ticks {
  let room = max
  for (const trackId of trackIds) {
    for (const clip of clipsOnTrack(sequence, trackId)) {
      if (clip.start < at && clipEnd(clip) > at) return 0
      if (clipEnd(clip) <= at) room = Math.min(room, at - clipEnd(clip))
    }
  }
  return Math.max(0, room)
}

/** How far after `at` the tracks are empty (the most a ripple starting at `at` can remove), capped at `max`. */
export function emptyAfter(sequence: Sequence, trackIds: Iterable<string>, at: Ticks, max: Ticks): Ticks {
  let room = max
  for (const trackId of trackIds) {
    for (const clip of clipsOnTrack(sequence, trackId)) {
      if (clip.start < at && clipEnd(clip) > at) return 0
      if (clip.start >= at) room = Math.min(room, clip.start - at)
    }
  }
  return Math.max(0, room)
}

/** Sorted, unique clip start and end times (edit points), optionally limited to some tracks. */
export function editPoints(sequence: Sequence, trackIds?: Iterable<string>): Ticks[] {
  const only = trackIds ? new Set(trackIds) : null
  const points = new Set<Ticks>()
  for (const clip of sequence.clips) {
    if (only && !only.has(clip.trackId)) continue
    points.add(clip.start)
    points.add(clipEnd(clip))
  }
  return [...points].sort((a, b) => a - b)
}

/**
 * The clip the program monitor shows at `time`: the highest visible video track with a
 * clip there wins; if any video track is soloed, only soloed tracks count.
 */
export function topVideoClipAt(sequence: Sequence, time: Ticks): Clip | null {
  const video = tracksOf(sequence, 'video')
  const soloed = video.some((t) => t.solo)
  for (const track of [...video].reverse()) {
    if (!track.visible || (soloed && !track.solo)) continue
    // Adjustment layers have no picture of their own.
    const clip = sequence.clips.find((c) => c.trackId === track.id && !c.adjustment && c.start <= time && clipEnd(c) > time)
    if (clip) return clip
  }
  return null
}

/** The empty stretch between clips on a track at `time`, or null (none past the last clip). */
export function gapAt(sequence: Sequence, trackId: string, time: Ticks): { start: Ticks; end: Ticks } | null {
  const clips = clipsOnTrack(sequence, trackId)
  let previousEnd = 0
  for (const clip of clips) {
    if (time < clip.start) return time >= previousEnd && clip.start > previousEnd ? { start: previousEnd, end: clip.start } : null
    if (time < clipEnd(clip)) return null
    previousEnd = clipEnd(clip)
  }
  return null
}
