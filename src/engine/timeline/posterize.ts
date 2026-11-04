import { beatTime } from '../audio/beat-grid'
import type { ParamValue } from '../effects/types'
import { DEFAULT_GRID } from '../modulation/curve'
import type { BeatGrid } from '../project/model'
import { secondsToTicks, type Ticks } from '../time'

/**
 * Posterize Time (M12): the picture updates only on musical time, and holds in between.
 * Update k falls at beat k × L + Phase (L the note length in beats), the odd ones later by
 * Swing × L, each rounded to the nearest frame, so holds never drift from the beat grid
 * (at 128 BPM, 24 fps, 1/16 notes they run 3, 3, 2, 3… frames and average exactly 2.8125).
 * In Free mode the updates come Rate times a second instead.
 */

/** The knob's steps, slowest to fastest (so turning it up, or modulating it up, always goes faster). Beats of a 4/4 bar. */
export const POSTERIZE_RATES: ReadonlyArray<{ id: string; label: string; beats: number }> = [
  { id: 'off', label: 'Off', beats: 0 },
  { id: '1/1', label: '1/1', beats: 4 },
  { id: '1/2', label: '1/2', beats: 2 },
  { id: '1/4D', label: '1/4 dotted', beats: 1.5 },
  { id: '1/2T', label: '1/2 triplet', beats: 4 / 3 },
  { id: '1/4', label: '1/4', beats: 1 },
  { id: '1/8D', label: '1/8 dotted', beats: 0.75 },
  { id: '1/4T', label: '1/4 triplet', beats: 2 / 3 },
  { id: '1/8', label: '1/8', beats: 0.5 },
  { id: '1/8T', label: '1/8 triplet', beats: 1 / 3 },
  { id: '1/16', label: '1/16', beats: 0.25 },
  { id: '1/16T', label: '1/16 triplet', beats: 1 / 6 },
  { id: '1/32', label: '1/32', beats: 0.125 }
]

export interface PosterizeSettings {
  timing: 'beat' | 'free'
  /** Index into POSTERIZE_RATES (0 is Off). */
  rate: number
  fps: number
  tempo: 'grid' | 'manual'
  bpm: number
  /** Beats (beat timing) or updates (free timing). */
  phase: number
  /** 0–0.75 of an update. */
  swing: number
  sample: 'start' | 'middle'
  cuts: 'hold' | 'switch'
}

export function posterizeSettings(params: Record<string, ParamValue>): PosterizeSettings {
  const num = (id: string, fallback: number) => (Number.isFinite(Number(params[id])) ? Number(params[id]) : fallback)
  return {
    timing: params['timing'] === 'free' ? 'free' : 'beat',
    rate: Math.min(POSTERIZE_RATES.length - 1, Math.max(0, Math.round(num('rate', 8)))),
    fps: Math.max(0.1, num('fps', 8)),
    tempo: params['tempo'] === 'manual' ? 'manual' : 'grid',
    bpm: Math.max(1, num('bpm', 120)),
    phase: num('phase', 0),
    swing: Math.min(0.75, Math.max(0, num('swing', 0) / 100)),
    sample: params['sample'] === 'middle' ? 'middle' : 'start',
    cuts: params['cuts'] === 'switch' ? 'switch' : 'hold'
  }
}

/** The grid a Posterize Time follows: the sequence's beat grid (120 BPM from 0 without one), or its own BPM from the sequence start. */
export function posterizeGrid(s: PosterizeSettings, grid: BeatGrid | null): BeatGrid {
  if (s.tempo === 'manual') return { bpm: s.bpm, downbeat: 0, beatsPerBar: grid?.beatsPerBar ?? 4, sourceId: null }
  return grid ?? DEFAULT_GRID
}

/** How many frames a second the updates come at, for the knob's readout (null when Off). */
export function updatesPerSecond(s: PosterizeSettings, grid: BeatGrid): number | null {
  if (s.timing === 'free') return s.fps
  const beats = POSTERIZE_RATES[s.rate]!.beats
  return beats > 0 ? grid.bpm / 60 / beats : null
}

export interface Hold {
  /** The update's frame (sequence frames). */
  start: number
  /** The next update's frame. */
  end: number
  /** The frame shown throughout. */
  sample: number
}

/** The frame update k lands on (sequence frames), for `frame` ticks a frame. */
export function updateFrame(s: PosterizeSettings, grid: BeatGrid, frame: Ticks, k: number): number {
  const odd = Math.abs(k % 2) === 1
  let time: number
  if (s.timing === 'free') time = secondsToTicks((k + s.phase + (odd ? s.swing : 0)) / s.fps)
  else {
    const beats = POSTERIZE_RATES[s.rate]!.beats
    time = beatTime(grid, k * beats + s.phase + (odd ? s.swing * beats : 0))
  }
  return Math.round(time / frame)
}

/** The hold that sequence frame `f` falls in (null when the knob is Off). */
export function holdAt(s: PosterizeSettings, grid: BeatGrid, frame: Ticks, f: number): Hold | null {
  if (s.timing === 'beat' && POSTERIZE_RATES[s.rate]!.beats <= 0) return null
  // Where f is in updates, roughly; then step until update k ≤ f < update k + 1.
  const periodFrames = s.timing === 'free' ? secondsToTicks(1 / s.fps) / frame : (POSTERIZE_RATES[s.rate]!.beats * secondsToTicks(60 / grid.bpm)) / frame
  if (!(periodFrames > 0) || !Number.isFinite(periodFrames)) return null
  const origin = updateFrame(s, grid, frame, 0)
  let k = Math.floor((f - origin) / periodFrames)
  while (updateFrame(s, grid, frame, k) > f) k--
  while (updateFrame(s, grid, frame, k + 1) <= f) k++
  const start = updateFrame(s, grid, frame, k)
  let end = updateFrame(s, grid, frame, k + 1)
  // At very fast rates two updates can land on one frame: the hold is that one frame.
  if (end <= start) end = start + 1
  return { start, end, sample: s.sample === 'middle' ? start + Math.floor((end - start) / 2) : start }
}

/** A hold restarted at a cut (Reset on cuts: switch at the cut): from the cut to the next update. */
export function holdFromCut(s: PosterizeSettings, hold: Hold, cut: number): Hold {
  return { start: cut, end: hold.end, sample: s.sample === 'middle' ? cut + Math.floor((hold.end - cut) / 2) : cut }
}
