import type { MediaItem } from '../project/media'
import type { Clip, Sequence } from '../project/model'
import type { Ticks } from '../time'
import { evaluate } from '../keyframes/keyframes'
import { resolveClip } from '../keyframes/properties'
import type { ModulationContext } from '../modulation/types'
import { resolveMasks, type FrameSize, type ResolvedShape } from '../masks/masks'
import { hasStatefulEffect, stateFrame, stateKey } from './temporal'
import { beatAt } from '../audio/beat-grid'
import { DEFAULT_GRID } from '../modulation/curve'
import type { EffectClock } from '../effects/types'
import { effectById } from '../../effects/registry'
import { holdAt, holdFromCut, posterizeGrid, posterizeSettings } from './posterize'
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
  /** The masks this moment's layers use, worked out once for the frame (shared by every layer). */
  masks: FrameMasks
  /** Clips with stateful effects (M9): frames since their state's reset, and what that state depends on. */
  temporal: LayerTemporal | null
  /** Where this moment is in frames and beats (M11), for effects that change with it (the same for every layer). */
  clock: EffectClock
  /**
   * Posterize Time (M12) holding this layer: its first `effects` effects (those above Posterize
   * Time) were worked out at the held moment, so they read that moment's clock.
   */
  held?: { effects: number; clock: EffectClock } | null
}

/** The clock at a sequence time: its frame number, and its place on the beat grid (120 BPM from 0 without one). */
export function clockAt(sequence: Sequence, time: Ticks): EffectClock {
  const frame = frameTicks(sequence)
  const grid = sequence.beatGrid ?? DEFAULT_GRID
  return { frame: Math.round(time / frame), beat: beatAt(grid, time), beatsPerFrame: beatAt(grid, frame) - beatAt(grid, 0), beatsPerBar: grid.beatsPerBar }
}

export interface LayerTemporal {
  /** Frames since the reset (0 on the first frame the clip is seen). */
  frame: number
  /** When the reset is (sequence time). */
  resetAt: Ticks
  /** Changes whenever anything the state depends on changes. */
  key: string
}

/** Masks at one moment, by id, with the frame size they're drawn on. */
export interface FrameMasks {
  frame: FrameSize
  byId: ReadonlyMap<string, ResolvedShape[]>
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

/**
 * Visible video layers at `time`, V1 first. Hidden tracks are skipped; if any are soloed,
 * only those count. With `modulation`, modulated values are worked out too.
 */
export function videoLayersAt(sequence: Sequence, media: MediaItem[], time: Ticks, modulation: ModulationContext | null = null): VideoLayer[] {
  return layersAt(sequence, media, time, modulation, tracksOf(sequence, 'video').length)
}

/** The first switched-on effect that holds time (Posterize Time) in a clip's stack, or -1. */
function holdingEffect(clip: Clip): number {
  return clip.effects.findIndex((e) => e.enabled && effectById(e.effectId)?.holdsTime === true)
}

/** The latest clip edge (in frames) on these tracks after `from` and up to `to`, or null. */
function latestCut(sequence: Sequence, trackIds: string[], from: number, to: number, frame: Ticks): number | null {
  let cut: number | null = null
  for (const clip of sequence.clips) {
    if (!trackIds.includes(clip.trackId)) continue
    for (const edge of [Math.round(clip.start / frame), Math.round(clipEnd(clip) / frame)]) if (edge > from && edge <= to && (cut === null || edge > cut)) cut = edge
  }
  return cut
}

/** The layers of the first `trackLimit` video tracks at `time` (Posterize Time on an adjustment layer asks for those beneath it at the held moment). */
function layersAt(sequence: Sequence, media: MediaItem[], time: Ticks, modulation: ModulationContext | null, trackLimit: number): VideoLayer[] {
  const tracks = tracksOf(sequence, 'video')
  const soloed = tracks.some((t) => t.solo)
  const frame = frameTicks(sequence)
  let layers: VideoLayer[] = []
  const masks: { frame: FrameSize; byId: Map<string, ResolvedShape[]> } = { frame: { width: sequence.settings.width, height: sequence.settings.height }, byId: new Map() }
  const clock = clockAt(sequence, time)
  for (const [index, track] of tracks.slice(0, trackLimit).entries()) {
    if (!track.visible || (soloed && !track.solo)) continue
    for (const { clip: stored, weight } of trackLayers(sequence, track.id, time)) {
      let clip = resolveClip(stored, time, modulation)
      // Posterize Time (M12): the picture (and the effects above it) from the held moment.
      let shown = time
      let held: VideoLayer['held'] = null
      const p = holdingEffect(clip)
      if (p >= 0) {
        const settings = posterizeSettings(clip.effects[p]!.params)
        const f = Math.round(time / frame)
        let hold = holdAt(settings, posterizeGrid(settings, sequence.beatGrid), frame, f)
        if (hold && clip.adjustment && settings.cuts === 'switch') {
          const cut = latestCut(sequence, tracks.slice(0, index).map((t) => t.id), hold.start, f, frame)
          if (cut !== null) hold = holdFromCut(settings, hold, cut)
        }
        if (hold) {
          let sample = hold.sample * frame
          // A clip starts on its own first frame, and ends on its last; an adjustment layer
          // never samples past its own end (it may sample before its start: the old shot).
          if (!clip.adjustment) sample = Math.min(Math.max(sample, visibleFrom(sequence, stored)), clipEnd(stored) - frame)
          else sample = Math.min(sample, clipEnd(stored) - frame)
          if (sample !== time) {
            shown = sample
            const then = resolveClip(stored, sample, modulation)
            clip = { ...clip, effects: [...then.effects.slice(0, p), ...clip.effects.slice(p)] }
            held = { effects: p, clock: clockAt(sequence, sample) }
            if (clip.adjustment) layers = layersAt(sequence, media, sample, modulation, index)
          }
        }
      }
      let temporal: LayerTemporal | null = null
      if (hasStatefulEffect(stored)) {
        const resetAt = visibleFrom(sequence, stored)
        temporal = { frame: stateFrame(time, resetAt, frame), resetAt, key: `${stateKey(sequence, media, stored, resetAt)}:${modulation?.id ?? 'none'}` }
      }
      // An invisible layer is skipped, unless its effects keep state (that state must still run).
      if ((clip.opacity <= 0 || weight <= 0) && !temporal) continue
      if (clip.adjustment) {
        // An adjustment layer with nothing switched on changes nothing.
        if (clip.effects.some((e) => e.enabled)) layers.push({ clip, item: null, sourceTime: 0, weight: Math.min(1, weight), masks, temporal, clock, held })
        continue
      }
      const item = media.find((m) => m.id === clip.mediaId)
      if (!item) continue
      layers.push({ clip, item, sourceTime: sourceTimeAt(clip, shown, frame, mediaLength(item)), weight: Math.min(1, weight), masks, temporal, clock, held })
    }
  }
  if (sequence.masks.length > 0) {
    const used = layers.flatMap((l) => [l.clip.mask?.id, ...l.clip.effects.map((e) => (e.enabled ? e.mask?.id : undefined))]).filter((id): id is string => id !== undefined)
    for (const [id, shapes] of resolveMasks(sequence.masks, used, time, modulation)) if (!masks.byId.has(id)) masks.byId.set(id, shapes)
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

/** A clip's linear gain at sequence time `time`, from its Volume (keyframed, modulated, or neither). */
export function gainAt(clip: Clip, time: Ticks, modulation: ModulationContext | null = null): number {
  if (modulation && clip.modulation['volume']?.length) return dbToGain(resolveClip(clip, time, modulation).volume)
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
