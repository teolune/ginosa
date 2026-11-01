import type { MediaItem } from '../project/media'
import type { Clip, Sequence } from '../project/model'
import type { Ticks } from '../time'
import { evaluate } from '../keyframes/keyframes'
import { resolveClip } from '../keyframes/properties'
import { clipEnd, clipsOnTrack, frameTicks, mediaLength, sourceTimeAt, tracksOf } from './timeline'

export { sourceTimeAt }

/**
 * What plays at a given moment: the video layers to composite (bottom first) and the
 * audio to mix. Pure, so playback, the still preview and export (M5) all agree.
 */

export interface VideoLayer {
  /** The clip as it is at this moment: animated values are worked out from their keyframes. */
  clip: Clip
  /** The clip's media; null for an adjustment layer. */
  item: MediaItem | null
  /** Time in the media file to show, in ticks (0 for adjustment layers). */
  sourceTime: Ticks
  /** Transition weight (0–1), multiplied into the clip's opacity. */
  weight: number
}

/** A transition's length, kept within the clips it joins. */
function transitionLength(duration: Ticks, ...clips: Clip[]): Ticks {
  return Math.max(1, Math.min(duration, ...clips.map((c) => c.duration)))
}

/** The layers one track contributes at `time`, with cross-dissolves and fades worked out. */
function trackLayers(sequence: Sequence, trackId: string, time: Ticks): Array<{ clip: Clip; weight: number }> {
  const clips = clipsOnTrack(sequence, trackId)
  const index = clips.findIndex((c) => c.start <= time && clipEnd(c) > time)
  const current = clips[index]
  // A cross-dissolve into the next clip starts before the cut.
  const next = index >= 0 ? clips[index + 1] : clips.find((c) => c.start > time)
  const nextTouches = current && next && next.start === clipEnd(current)
  if (current && next && nextTouches && next.transitionIn) {
    const length = transitionLength(next.transitionIn.duration, current, next)
    const from = next.start - length / 2
    if (time >= from) return [{ clip: current, weight: 1 }, { clip: next, weight: (time - from) / length }]
  }
  if (!current) return []
  const previous = clips[index - 1]
  const prevTouches = previous && clipEnd(previous) === current.start
  if (current.transitionIn && previous && prevTouches) {
    const length = transitionLength(current.transitionIn.duration, current, previous)
    const until = current.start + length / 2
    if (time < until) return [{ clip: previous, weight: 1 }, { clip: current, weight: (time - (current.start - length / 2)) / length }]
  }
  let weight = 1
  if (current.transitionIn && !prevTouches) {
    const length = transitionLength(current.transitionIn.duration, current)
    if (time < current.start + length) weight *= (time - current.start) / length
  }
  if (current.transitionOut && !nextTouches) {
    const length = transitionLength(current.transitionOut.duration, current)
    if (time >= clipEnd(current) - length) weight *= (clipEnd(current) - time) / length
  }
  return [{ clip: current, weight }]
}

export interface TransitionSpan {
  /** The clip the transition belongs to, and which end. */
  clip: Clip
  end: 'in' | 'out'
  from: Ticks
  to: Ticks
  /** A dissolve between two clips (centred on the cut), rather than a fade at a free end. */
  between: boolean
}

/** Where each transition on a track sits, as the render plan plays it (for drawing and editing). */
export function transitionSpans(sequence: Sequence, trackId: string): TransitionSpan[] {
  const clips = clipsOnTrack(sequence, trackId)
  const spans: TransitionSpan[] = []
  clips.forEach((clip, i) => {
    const previous = clips[i - 1]
    const next = clips[i + 1]
    const prevTouches = previous !== undefined && clipEnd(previous) === clip.start
    const nextTouches = next !== undefined && next.start === clipEnd(clip)
    if (clip.transitionIn) {
      if (prevTouches) {
        const length = transitionLength(clip.transitionIn.duration, clip, previous)
        spans.push({ clip, end: 'in', from: clip.start - length / 2, to: clip.start + length / 2, between: true })
      } else spans.push({ clip, end: 'in', from: clip.start, to: clip.start + transitionLength(clip.transitionIn.duration, clip), between: false })
    }
    if (clip.transitionOut && !nextTouches) spans.push({ clip, end: 'out', from: clipEnd(clip) - transitionLength(clip.transitionOut.duration, clip), to: clipEnd(clip), between: false })
  })
  return spans
}

/** When a clip first appears: its start, or earlier when a cross-dissolve leads into it. */
export function visibleFrom(sequence: Sequence, clip: Clip): Ticks {
  if (!clip.transitionIn) return clip.start
  const previous = clipsOnTrack(sequence, clip.trackId).find((c) => c.id !== clip.id && clipEnd(c) === clip.start)
  if (!previous) return clip.start
  return clip.start - transitionLength(clip.transitionIn.duration, clip, previous) / 2
}

/** Visible video layers at `time`, V1 first. Hidden tracks are skipped; if any are soloed, only those count. */
export function videoLayersAt(sequence: Sequence, media: MediaItem[], time: Ticks): VideoLayer[] {
  const tracks = tracksOf(sequence, 'video')
  const soloed = tracks.some((t) => t.solo)
  const frame = frameTicks(sequence)
  const layers: VideoLayer[] = []
  for (const track of tracks) {
    if (!track.visible || (soloed && !track.solo)) continue
    for (const { clip: stored, weight } of trackLayers(sequence, track.id, time)) {
      const clip = resolveClip(stored, time)
      if (clip.opacity <= 0 || weight <= 0) continue
      if (clip.adjustment) {
        // An adjustment layer with nothing switched on changes nothing.
        if (clip.effects.some((e) => e.enabled)) layers.push({ clip, item: null, sourceTime: 0, weight: Math.min(1, weight) })
        continue
      }
      const item = media.find((m) => m.id === clip.mediaId)
      if (!item) continue
      layers.push({ clip, item, sourceTime: sourceTimeAt(clip, time, frame, mediaLength(item)), weight: Math.min(1, weight) })
    }
  }
  return layers
}

export interface AudioSegment {
  clip: Clip
  item: MediaItem
  /** Linear gain from the clip's volume (dB); with Volume keyframes, see `gainAt`. */
  gain: number
}

/** Volume keyframes are sampled this often (then joined by straight lines, as Web Audio plays a value curve). */
export const GAIN_CURVE_STEP_SECONDS = 0.001

/** A clip's linear gain at sequence time `time`, from its Volume (keyframed or not). */
export function gainAt(clip: Clip, time: Ticks): number {
  const track = clip.keyframes['volume']
  return dbToGain(track?.length ? Number(evaluate(track, time - clip.start, clip.volume)) : clip.volume)
}

export function dbToGain(db: number): number {
  return db <= -96 ? 0 : Math.pow(10, db / 20)
}

/** Whether an audio track is heard: not muted, and soloed if any audio track is. */
export function audibleTracks(sequence: Sequence): Set<string> {
  const tracks = tracksOf(sequence, 'audio')
  const soloed = tracks.some((t) => t.solo)
  return new Set(tracks.filter((t) => !t.muted && (!soloed || t.solo)).map((t) => t.id))
}

/**
 * Audio clips overlapping [from, to) on audible tracks; or, with `only`, exactly those
 * clips whether their tracks are muted or not (an analysis source, e.g. a sidechain).
 */
export function audioSegments(sequence: Sequence, media: MediaItem[], from: Ticks, to: Ticks, only: ReadonlySet<string> | null = null): AudioSegment[] {
  const audible = audibleTracks(sequence)
  const segments: AudioSegment[] = []
  for (const clip of sequence.clips) {
    if (clip.kind !== 'audio' || (only ? !only.has(clip.id) : !audible.has(clip.trackId))) continue
    if (clipEnd(clip) <= from || clip.start >= to) continue
    const item = media.find((m) => m.id === clip.mediaId)
    // Reversed and frame-hold audio is silent (Premiere plays reversed audio; that's planned).
    if (!item || !item.info.audio || clip.reverse || clip.speed === 0) continue
    segments.push({ clip, item, gain: dbToGain(clip.volume) })
  }
  return segments.sort((a, b) => a.clip.start - b.clip.start)
}
