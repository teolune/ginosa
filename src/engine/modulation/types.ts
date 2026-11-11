import type { BandId } from '../audio/analysis'
import type { KeyframeMap } from '../keyframes/keyframes'

/**
 * Modulation (M8). A modulator turns a signal into movement through a fixed chain:
 * source → input gain → threshold (soft knee) → attack/release → response curve, giving
 * 0–1. Each value it drives has a link with its own mapping (min/max in the value's units,
 * invert, add / multiply / replace, amount). One modulator can drive any number of values.
 */

/** A band of an analysis source: one of the six, or a range you define (Hz). */
export type BandRef = BandId | { low: number; high: number }

export type AudioSignal = 'level' | 'transient' | 'hits' | 'loudness' | 'peak'
export type TempoSignal = 'beat-phase' | 'bar-phase' | 'beat-trigger' | 'bar-trigger'
export type LfoShape = 'sine' | 'triangle' | 'saw' | 'square' | 'random-steps'

/** Musical lengths for LFO rates, in beats of a 4/4 bar ('bar' lengths follow the grid's beats per bar). */
export const NOTE_VALUES = {
  '4 bars': { label: '4 bars', beats: null, bars: 4 },
  '2 bars': { label: '2 bars', beats: null, bars: 2 },
  '1 bar': { label: '1 bar', beats: null, bars: 1 },
  '1/2': { label: '1/2', beats: 2, bars: null },
  '1/4': { label: '1/4', beats: 1, bars: null },
  '1/4T': { label: '1/4 triplet', beats: 2 / 3, bars: null },
  '1/8': { label: '1/8', beats: 0.5, bars: null },
  '1/8T': { label: '1/8 triplet', beats: 1 / 3, bars: null },
  '1/16': { label: '1/16', beats: 0.25, bars: null },
  '1/32': { label: '1/32', beats: 0.125, bars: null },
  '1/4D': { label: '1/4 dotted', beats: 1.5, bars: null },
  '1/8D': { label: '1/8 dotted', beats: 0.75, bars: null }
} as const
export type NoteValue = keyof typeof NOTE_VALUES

export type ModSource =
  | { kind: 'audio'; sourceId: string; signal: AudioSignal; band: BandRef }
  | { kind: 'tempo'; signal: TempoSignal }
  | { kind: 'lfo'; shape: LfoShape; rate: NoteValue; seed: number }
  | { kind: 'random'; seed: number; rate: number }
  /** A Channel Rack row (M12): fires on its steps. */
  | { kind: 'pattern'; rowId: string }

export type ResponseCurve = 'linear' | 'exponential' | 'logarithmic' | 's-curve' | 'custom'

export interface Modulator {
  id: string
  name: string
  source: ModSource
  /** dB. */
  gain: number
  /** 0–1 of the signal: everything below is ignored. */
  threshold: number
  /** 0–1: width of the soft knee around the threshold. */
  knee: number
  /** ms. */
  attack: number
  release: number
  curve: ResponseCurve
  /** For 'custom': y at x = 0, 0.25, 0.5, 0.75, 1 (a curve you draw). */
  points: number[]
  /** 0–1, added to an LFO's position in its cycle. */
  phase: number
  /** Keyframes for gain, threshold, knee, attack, release and phase, in ticks from the sequence start. */
  keyframes: KeyframeMap
}

/** The modulator settings that can be keyframed, with their ranges. */
export const MODULATOR_PARAMS = {
  gain: { label: 'Input Gain', min: -48, max: 48, unit: 'dB', decimals: 1 },
  threshold: { label: 'Threshold', min: 0, max: 1, unit: '', decimals: 2 },
  knee: { label: 'Knee', min: 0, max: 1, unit: '', decimals: 2 },
  attack: { label: 'Attack', min: 0, max: 5000, unit: 'ms', decimals: 0 },
  release: { label: 'Release', min: 0, max: 10000, unit: 'ms', decimals: 0 },
  phase: { label: 'Phase', min: 0, max: 1, unit: '', decimals: 2 }
} as const
export type ModulatorParam = keyof typeof MODULATOR_PARAMS

export type LinkMode = 'add' | 'multiply' | 'replace'

/** One value driven by one modulator. Lives on the clip or effect with the value, so it moves, splits and copies with it. */
export interface ModLink {
  id: string
  modulatorId: string
  mode: LinkMode
  /** The modulator's 0 and 1 mapped into the value's units (one number, or two for a point). */
  min: number[]
  max: number[]
  invert: boolean
  /** 0–100%: how much of the modulation is applied. */
  amount: number
}

export type ModulationMap = Record<string, ModLink[]>

/** What modulation needs at render time: each modulator's 0–1 output at a sequence time (null while it isn't ready). */
export interface ModulationContext {
  value(modulatorId: string, time: number): number | null
  /** A link's own value, when it has one: a Channel Rack link follows its cubes' amounts (decision 109). Null: use the modulator's. */
  linkValue?(link: ModLink, time: number): number | null
  /** Identifies the curves: two contexts with the same id give the same values (stateful effects and the render cache key on it). */
  readonly id?: string
}
