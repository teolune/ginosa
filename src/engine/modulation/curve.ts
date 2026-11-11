import { ANALYSIS_RATE, type AudioAnalysis, type BandAnalysis } from '../audio/analysis'
import { beatAt, beatLength, beatTime } from '../audio/beat-grid'
import { sampleAt } from '../audio/dsp'
import { evaluate } from '../keyframes/keyframes'
import type { BeatGrid, Rack, RackRow } from '../project/model'
import { channelHits, cubeAmount, hitBeat } from '../timeline/rack'
import { secondsToTicks, ticksToSeconds, type Ticks } from '../time'
import { MODULATOR_PARAMS, NOTE_VALUES, type ModSource, type Modulator, type ModulatorParam, type NoteValue, type ResponseCurve } from './types'

/**
 * A modulator's output over the whole sequence, worked out in advance at the analysis
 * rate (200 values a second). Attack and release run over the whole curve from the
 * start, so any frame gets the same value however playback or export reached it.
 */

export const CURVE_RATE = ANALYSIS_RATE

/** What a modulator's source needs: the analysis (and where it starts), a custom band if it uses one, and the beat grid. */
export interface CurveInputs {
  analysis: AudioAnalysis | null
  analysisStart: Ticks
  customBand: BandAnalysis | null
  grid: BeatGrid | null
  /** A Channel Rack channel and its rack (sections of cubes), and how long a frame is (each hit fires for one frame, so the first frame at or after it gets the whole hit). */
  pattern?: { row: RackRow | null; rack: Rack | null; frameSeconds: number }
}

/** Without a beat grid, tempo signals and LFOs run at 120 BPM from the sequence start, 4/4. */
export const DEFAULT_GRID: BeatGrid = { bpm: 120, downbeat: 0, beatsPerBar: 4, sourceId: null }

export function noteBeats(rate: NoteValue, grid: BeatGrid): number {
  const note = NOTE_VALUES[rate]
  return note.bars !== null ? note.bars * grid.beatsPerBar : note.beats
}

/** A repeatable random number in 0–1 for an integer and a seed. */
export function hash01(n: number, seed: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed + 0x632be5ab, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function lfo(shape: string, p: number, step: number, seed: number): number {
  switch (shape) {
    case 'sine':
      return 0.5 - 0.5 * Math.cos(2 * Math.PI * p)
    case 'triangle':
      return p < 0.5 ? 2 * p : 2 - 2 * p
    case 'saw':
      return p
    case 'square':
      return p < 0.5 ? 1 : 0
    default:
      return hash01(step, seed)
  }
}

/** The raw 0–1 source signal at each curve sample (impulses for triggers and hits). */
export function sourceSignal(source: ModSource, inputs: CurveInputs, frames: number): Float32Array {
  const out = new Float32Array(frames)
  const tickAt = (i: number) => secondsToTicks(i / CURVE_RATE)
  const grid = inputs.grid ?? DEFAULT_GRID
  switch (source.kind) {
    case 'audio': {
      const a = inputs.analysis
      if (!a) return out
      const offset = ((inputs.analysisStart / secondsToTicks(1)) * CURVE_RATE)
      const band = typeof source.band === 'string' ? a.bands[source.band] : inputs.customBand
      if (source.signal === 'hits') {
        for (const h of band?.hits ?? []) {
          const i = Math.round(h * (CURVE_RATE / a.rate) + offset)
          if (i >= 0 && i < frames) out[i] = 1
        }
        return out
      }
      let data: Float32Array | null = null
      let max = 1
      if (source.signal === 'loudness') [data, max] = [a.loudness, a.loudnessMax]
      else if (source.signal === 'peak') [data, max] = [a.peak, a.peakMax]
      else if (band) [data, max] = source.signal === 'level' ? [band.level, band.max] : [band.transient, band.transientMax]
      if (!data || !(max > 0)) return out
      for (let i = 0; i < frames; i++) out[i] = Math.min(1, sampleAt(data, (i - offset) * (a.rate / CURVE_RATE)) / max)
      return out
    }
    case 'tempo': {
      if (source.signal === 'beat-trigger' || source.signal === 'bar-trigger') {
        const every = source.signal === 'bar-trigger' ? grid.beatsPerBar : 1
        const step = beatLength(grid) * every
        const end = tickAt(frames)
        let n = Math.ceil(-grid.downbeat / step - 1e-9)
        for (let t = grid.downbeat + n * step; t < end; n++, t = grid.downbeat + n * step) {
          const i = Math.round((t / secondsToTicks(1)) * CURVE_RATE)
          if (i >= 0 && i < frames) out[i] = 1
        }
        return out
      }
      const per = source.signal === 'bar-phase' ? grid.beatsPerBar : 1
      for (let i = 0; i < frames; i++) {
        const b = beatAt(grid, tickAt(i)) / per
        out[i] = b - Math.floor(b)
      }
      return out
    }
    case 'lfo': {
      const beats = noteBeats(source.rate, grid)
      for (let i = 0; i < frames; i++) {
        const cycles = beatAt(grid, tickAt(i)) / beats
        const step = Math.floor(cycles)
        out[i] = lfo(source.shape, cycles - step, step, source.seed)
      }
      return out
    }
    case 'random': {
      // Smooth value noise: a new random value `rate` times a second, eased between.
      const rate = Math.max(0.01, source.rate)
      for (let i = 0; i < frames; i++) {
        const x = (i / CURVE_RATE) * rate
        const n = Math.floor(x)
        const f = x - n
        const s = f * f * (3 - 2 * f)
        out[i] = hash01(n, source.seed) * (1 - s) + hash01(n + 1, source.seed) * s
      }
      return out
    }
    case 'pattern': {
      // A pulse one frame long from each hit (swing and nudge move it, decision 106).
      const p = inputs.pattern
      if (!p?.row || !p.row.enabled || !p.rack) return out
      const width = Math.max(1, Math.round(p.frameSeconds * CURVE_RATE))
      for (const hit of channelHits(p.rack, p.row.id, grid)) {
        const start = Math.ceil(ticksToSeconds(beatTime(grid, hitBeat(hit.step, p.row))) * CURVE_RATE - 1e-6)
        for (let i = Math.max(0, start); i < Math.min(frames, start + width); i++) out[i] = 1
      }
      return out
    }
  }
}

/** The soft-knee threshold: 0 below, rising smoothly through the knee, then straight, scaled so a full signal gives 1. */
export function thresholdKnee(x: number, threshold: number, knee: number): number {
  const t = Math.min(0.999, Math.max(0, threshold))
  const k = Math.max(0, knee)
  let y: number
  if (k > 0 && x > t - k / 2 && x < t + k / 2) y = (x - t + k / 2) ** 2 / (2 * k)
  else y = x <= t ? 0 : x - t
  return Math.min(1, Math.max(0, y / (1 - t)))
}

export function responseCurve(x: number, curve: ResponseCurve, points: readonly number[]): number {
  const v = Math.min(1, Math.max(0, x))
  switch (curve) {
    case 'linear':
      return v
    case 'exponential':
      return (Math.exp(3 * v) - 1) / (Math.exp(3) - 1)
    case 'logarithmic':
      return Math.log(1 + 19 * v) / Math.log(20)
    case 's-curve':
      return v * v * (3 - 2 * v)
    case 'custom': {
      if (points.length < 2) return v
      const at = v * (points.length - 1)
      const i = Math.min(points.length - 2, Math.floor(at))
      return Math.min(1, Math.max(0, points[i]! + (points[i + 1]! - points[i]!) * (at - i)))
    }
  }
}

/** A modulator setting at `time` (absolute ticks): its keyframes if it has them. */
export function settingAt(m: Modulator, param: ModulatorParam, time: Ticks): number {
  const track = m.keyframes[param]
  const spec = MODULATOR_PARAMS[param]
  const value = track?.length ? Number(evaluate(track, time, m[param])) : m[param]
  return Math.min(spec.max, Math.max(spec.min, value))
}

/**
 * The whole chain, sample by sample: source → input gain → threshold → attack/release →
 * response curve. `frames` samples at CURVE_RATE from the sequence start.
 */
export function modulatorCurve(m: Modulator, inputs: CurveInputs, frames: number): Float32Array {
  // LFO phase shifts the cycle; it's applied by moving the grid, so it can be keyframed too.
  const phaseShift = (i: number) => (m.source.kind === 'lfo' ? settingAt(m, 'phase', secondsToTicks(i / CURVE_RATE)) : 0)
  const animatedPhase = (m.keyframes['phase']?.length ?? 0) > 0
  let raw: Float32Array
  if (m.source.kind === 'lfo' && (m.phase !== 0 || animatedPhase)) {
    const grid = inputs.grid ?? DEFAULT_GRID
    const beats = noteBeats(m.source.rate, grid)
    raw = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const cycles = beatAt(grid, secondsToTicks(i / CURVE_RATE)) / beats + phaseShift(i)
      const step = Math.floor(cycles)
      raw[i] = lfo(m.source.shape, cycles - step, step, m.source.seed)
    }
  } else raw = sourceSignal(m.source, inputs, frames)
  const out = shapeSignal(m, raw, frames, false)
  // A channel's strength (0–150%, decision 106) scales what it moves.
  const strength = m.source.kind === 'pattern' ? (inputs.pattern?.row?.strength ?? 100) / 100 : 1
  if (strength !== 1) for (let i = 0; i < frames; i++) out[i] = out[i]! * strength
  return out
}

/**
 * The modulator's chain over a raw signal: input gain, threshold with its knee, attack and
 * release, then the response curve. `signed` (a Channel Rack link, decision 109) keeps the
 * signal's sign: the chain works on its size, and a hit of the other sign takes over at its
 * attack, so each hit reaches its own amount whatever came before it.
 */
function shapeSignal(m: Modulator, raw: Float32Array, frames: number, signed: boolean): Float32Array {
  const out = new Float32Array(frames)
  const animated = (p: ModulatorParam) => (m.keyframes[p]?.length ?? 0) > 0
  const anyAnimated = animated('gain') || animated('threshold') || animated('knee') || animated('attack') || animated('release')
  const dt = 1000 / CURVE_RATE
  let env = 0
  for (let i = 0; i < frames; i++) {
    const time = anyAnimated ? secondsToTicks(i / CURVE_RATE) : 0
    const gain = animated('gain') ? settingAt(m, 'gain', time) : m.gain
    const threshold = animated('threshold') ? settingAt(m, 'threshold', time) : m.threshold
    const knee = animated('knee') ? settingAt(m, 'knee', time) : m.knee
    const attack = animated('attack') ? settingAt(m, 'attack', time) : m.attack
    const release = animated('release') ? settingAt(m, 'release', time) : m.release
    if (!signed) {
      const x = thresholdKnee(Math.min(1, raw[i]! * Math.pow(10, gain / 20)), threshold, knee)
      const time0 = x > env ? attack : release
      env = time0 <= 0 ? x : env + (x - env) * (1 - Math.exp(-dt / time0))
      out[i] = responseCurve(env, m.curve, m.points)
      continue
    }
    const r = raw[i]!
    const x = Math.sign(r) * thresholdKnee(Math.min(1, Math.abs(r) * Math.pow(10, gain / 20)), threshold, knee)
    const rising = x !== 0 && (Math.sign(x) !== Math.sign(env) || Math.abs(x) > Math.abs(env))
    const time0 = rising ? attack : release
    env = time0 <= 0 ? x : env + (x - env) * (1 - Math.exp(-dt / time0))
    out[i] = Math.sign(env) * (responseCurve(Math.abs(env), m.curve, m.points) - responseCurve(0, m.curve, m.points))
  }
  return out
}

/**
 * A channel's curve for one linked value (decision 109): each hit at its cube's amount for
 * this link (−100 to 100%), shaped by the channel's modulator (rise and fall), times the
 * channel's strength. A hit up and a hit down each reach their own amount.
 */
export function patternLinkCurve(m: Modulator, inputs: CurveInputs, frames: number, linkId: string): Float32Array {
  const raw = new Float32Array(frames)
  const p = inputs.pattern
  const grid = inputs.grid ?? DEFAULT_GRID
  if (p?.row && p.row.enabled && p.rack) {
    const width = Math.max(1, Math.round(p.frameSeconds * CURVE_RATE))
    for (const hit of channelHits(p.rack, p.row.id, grid)) {
      const amount = cubeAmount(hit.cube, linkId)
      if (amount === 0) continue
      const start = Math.ceil(ticksToSeconds(beatTime(grid, hitBeat(hit.step, p.row))) * CURVE_RATE - 1e-6)
      for (let i = Math.max(0, start); i < Math.min(frames, start + width); i++) raw[i] = amount
    }
  }
  const out = shapeSignal(m, raw, frames, true)
  const strength = (p?.row?.strength ?? 100) / 100
  if (strength !== 1) for (let i = 0; i < frames; i++) out[i] = out[i]! * strength
  return out
}

/** The curve's value at a sequence time (linear between samples; held past the ends). */
export function curveValue(curve: Float32Array, time: Ticks): number {
  if (curve.length === 0) return 0
  const position = (time / secondsToTicks(1)) * CURVE_RATE
  if (position <= 0) return curve[0]!
  if (position >= curve.length - 1) return curve[curve.length - 1]!
  return sampleAt(curve, position)
}
