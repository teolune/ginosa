import { automationValue } from '../automation/curve'
import type { AutomationPoint, BeatGrid, Sequence } from '../project/model'
import { secondsToTicks, ticksToSeconds, type Ticks } from '../time'

/**
 * The tempo map (W2.3, decision 127): the beat grid's steady tempo with the sequence's tempo
 * clips laid over it. Before the first tempo clip the tempo is the grid's; while one plays, its
 * curve (0–1 across its BPM range); after it, its last value until the next one starts (as every
 * automation clip holds). Beats are counted through ramps exactly: the tempo is sampled every
 * millisecond and the beats integrated between samples as the tempo rises or falls along them,
 * so a cube, a click or a Posterize Time update lands where the music's beat is.
 */

export const TEMPO_STEP = 0.001

/** BPM samples from `start` seconds, and the beats counted from the downbeat at each. */
export interface TempoMap {
  start: number
  step: number
  bpm: Float64Array
  beats: Float64Array
}

export interface TempoClip {
  id: string
  start: Ticks
  duration: Ticks
  sourceIn: Ticks
  points: readonly AutomationPoint[]
  min: number
  max: number
}

/** The sequence's tempo clips that play (not on a muted track), in start order. */
export function tempoClips(sequence: Pick<Sequence, 'clips' | 'tracks'>): TempoClip[] {
  const muted = new Set(sequence.tracks.filter((t) => t.muted).map((t) => t.id))
  return sequence.clips
    .filter((c) => c.kind === 'automation' && c.automation?.tempo && !muted.has(c.trackId))
    .map((c) => ({ id: c.id, start: c.start, duration: c.duration, sourceIn: c.sourceIn, points: c.automation!.points, min: c.automation!.tempo!.min, max: c.automation!.tempo!.max }))
    .sort((a, b) => a.start - b.start)
}

/** The tempo at `seconds` (see above), from the grid's `base` BPM and the tempo clips in start order. */
export function tempoCurveAt(base: number, clips: readonly TempoClip[], seconds: number): number {
  let clip: TempoClip | null = null
  for (const c of clips) {
    if (ticksToSeconds(c.start) <= seconds) clip = c
    else break
  }
  if (!clip) return base
  const end = ticksToSeconds(clip.start + clip.duration)
  const at = seconds < end ? clip.sourceIn + secondsToTicks(seconds) - clip.start : clip.sourceIn + clip.duration
  return clip.min + (clip.max - clip.min) * automationValue(clip.points, at)
}

/** The map over the tempo clips' span (and the downbeat); outside it the tempo is steady, so it's extended exactly. */
export function buildTempoMap(grid: BeatGrid, clips: readonly TempoClip[]): TempoMap {
  const downbeat = ticksToSeconds(grid.downbeat)
  const from = Math.min(downbeat, ...clips.map((c) => ticksToSeconds(c.start))) - 0.01
  const to = Math.max(downbeat, ...clips.map((c) => ticksToSeconds(c.start + c.duration))) + 0.01
  const n = Math.ceil((to - from) / TEMPO_STEP) + 1
  const bpm = new Float64Array(n)
  const beats = new Float64Array(n)
  for (let i = 0; i < n; i++) bpm[i] = Math.max(1, tempoCurveAt(grid.bpm, clips, from + i * TEMPO_STEP))
  for (let i = 1; i < n; i++) beats[i] = beats[i - 1]! + ((bpm[i - 1]! + bpm[i]!) / 2) * (TEMPO_STEP / 60)
  const map: TempoMap = { start: from, step: TEMPO_STEP, bpm, beats }
  const offset = beatsAt(map, downbeat)
  for (let i = 0; i < n; i++) beats[i] = beats[i]! - offset
  return map
}

/** Beats from the downbeat at `seconds`. */
export function beatsAt(map: TempoMap, seconds: number): number {
  const n = map.bpm.length
  const x = (seconds - map.start) / map.step
  if (x <= 0) return map.beats[0]! + ((seconds - map.start) * map.bpm[0]!) / 60
  if (x >= n - 1) return map.beats[n - 1]! + ((seconds - (map.start + (n - 1) * map.step)) * map.bpm[n - 1]!) / 60
  const i = Math.floor(x)
  const u = (x - i) * map.step
  const b0 = map.bpm[i]!
  const b1 = map.bpm[i + 1]!
  return map.beats[i]! + (b0 * u + ((b1 - b0) * u * u) / (2 * map.step)) / 60
}

/** The time (seconds) of a beat counted from the downbeat. */
export function secondsAt(map: TempoMap, beat: number): number {
  const n = map.bpm.length
  if (beat <= map.beats[0]!) return map.start + ((beat - map.beats[0]!) * 60) / map.bpm[0]!
  if (beat >= map.beats[n - 1]!) return map.start + (n - 1) * map.step + ((beat - map.beats[n - 1]!) * 60) / map.bpm[n - 1]!
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (map.beats[mid]! <= beat) lo = mid
    else hi = mid
  }
  // Solve beats(u) = b0·u + (b1 − b0)·u²/(2·step), over 60, for u in the sample's stretch.
  const b0 = map.bpm[lo]!
  const b1 = map.bpm[lo + 1]!
  const d = 60 * (beat - map.beats[lo]!)
  const a = (b1 - b0) / (2 * map.step)
  const u = (2 * d) / (b0 + Math.sqrt(Math.max(0, b0 * b0 + 4 * a * d)))
  return map.start + lo * map.step + u
}

/** The tempo (BPM) at `seconds`. */
export function bpmAt(map: TempoMap, seconds: number): number {
  const n = map.bpm.length
  const x = (seconds - map.start) / map.step
  if (x <= 0) return map.bpm[0]!
  if (x >= n - 1) return map.bpm[n - 1]!
  const i = Math.floor(x)
  return map.bpm[i]! + (map.bpm[i + 1]! - map.bpm[i]!) * (x - i)
}

const cache = new WeakMap<BeatGrid, { key: readonly TempoClip[]; grid: BeatGrid }>()

/**
 * The sequence's beat grid with its tempo map, for everything that places things on beats
 * (playback, export, the Channel Rack, the metronome, Posterize Time, LFOs, snapping, the ruler,
 * Detect). Without tempo clips it's the grid itself. Kept until the grid or a tempo clip changes.
 */
export function tempoGrid(sequence: Pick<Sequence, 'beatGrid' | 'clips' | 'tracks'>): BeatGrid | null {
  const grid = sequence.beatGrid
  if (!grid) return null
  if (!sequence.clips.some((c) => c.automation?.tempo)) return grid
  const clips = tempoClips(sequence)
  if (clips.length === 0) return grid
  const hit = cache.get(grid)
  if (hit && hit.key.length === clips.length && hit.key.every((c, i) => sameClip(c, clips[i]!))) return hit.grid
  const withMap: BeatGrid = { ...grid, map: buildTempoMap(grid, clips) }
  cache.set(grid, { key: clips, grid: withMap })
  return withMap
}

function sameClip(a: TempoClip, b: TempoClip): boolean {
  return a.id === b.id && a.start === b.start && a.duration === b.duration && a.sourceIn === b.sourceIn && a.points === b.points && a.min === b.min && a.max === b.max
}

/** The tempo clip setting the tempo at `time` (playing there, or the last to have played), or null where the grid's own tempo holds. */
export function tempoClipAt(sequence: Pick<Sequence, 'clips' | 'tracks'>, time: Ticks): string | null {
  let id: string | null = null
  for (const c of tempoClips(sequence)) if (c.start <= time) id = c.id
  return id
}

/** A short key of the tempo clips that play, for caches of anything placed on beats ('' with none). */
export function tempoKey(sequence: Pick<Sequence, 'clips' | 'tracks'>): string {
  const clips = tempoClips(sequence)
  return clips.length ? JSON.stringify(clips) : ''
}
