import type { EffectClock, ImageSize, ParamValue } from '../../engine/effects/types'
import { GRAIN_NOTES } from './notes'

/**
 * Grain's maths on the CPU (M11), step for step as grain.wgsl, lattice.wgsl and shader.wgsl
 * do it on the GPU: the same integer hash (so the same random numbers), Box–Muller
 * Gaussians on two independent lattices (the grain, and a coarser one at 2.5× its size
 * for clumps), boil between refreshes, then interpolation that keeps each layer's strength
 * the same everywhere (the weights are scaled by the root of their sum of squares, which is
 * exact because the lattice points are independent).
 */

export const COARSE = 2.5
export const COARSE_WEIGHT = 0.5

/** PCG's output hash (O'Neill), on 32-bit unsigned integers. */
export function pcg(v: number): number {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0
  return ((word >>> 22) ^ word) >>> 0
}

export function hash4(a: number, b: number, c: number, d: number): number {
  return pcg((a + pcg((b + pcg((c + pcg(d >>> 0)) >>> 0)) >>> 0)) >>> 0)
}

const uniform01 = (h: number) => ((h >>> 8) + 0.5) / 16777216

export function gaussian(h: number): number {
  return Math.sqrt(-2 * Math.log(uniform01(h))) * Math.cos(2 * Math.PI * uniform01(pcg(h)))
}

const num = (params: Record<string, ParamValue>, id: string, fallback: number) => {
  const v = Number(params[id])
  return Number.isFinite(v) ? v : fallback
}

export interface GrainSettings {
  seed: number
  /** Pixels per lattice step for mono, red, green, blue. */
  spacing: [number, number, number, number]
  /** 0 mono … 1 fully independent channels. */
  colourAmount: number
  sigma: number
  boil: number
  refresh: string
  every: number
  note: string
  amount: number
  composite: string
  shadows: number
  midtones: number
  highlights: number
}

export function grainSettings(input: ImageSize, params: Record<string, ParamValue>): GrainSettings {
  const base = (Math.max(num(params, 'size', 1.2), 0.05) * input.height) / 1080
  const colour = params['grainType'] === 'colour'
  return {
    seed: Math.floor(num(params, 'seed', 0) + 0.5),
    spacing: [base, (base * num(params, 'redSize', 100)) / 100, (base * num(params, 'greenSize', 100)) / 100, (base * num(params, 'blueSize', 130)) / 100],
    colourAmount: colour ? Math.min(1, Math.max(0, num(params, 'colourAmount', 40) / 100)) : 0,
    sigma: 0.25 + 0.35 * Math.min(1, Math.max(0, num(params, 'softness', 40) / 100)),
    boil: Math.min(1, Math.max(0, num(params, 'boil', 100) / 100)),
    refresh: String(params['refresh'] ?? 'frame'),
    every: num(params, 'every', 2),
    note: String(params['note'] ?? '1/8'),
    amount: num(params, 'amount', 15) / 100,
    composite: String(params['composite'] ?? 'film'),
    shadows: num(params, 'shadows', 70) / 100,
    midtones: num(params, 'midtones', 100) / 100,
    highlights: num(params, 'highlights', 50) / 100
  }
}

/** Which grain pattern a frame shows: a new one every frame, every N frames, or on each note (at the nearest frame). */
export function refreshIndex(s: GrainSettings, clock: EffectClock): number {
  if (s.refresh === 'frames') return Math.floor(clock.frame / Math.max(Math.floor(s.every + 0.5), 1))
  if (s.refresh === 'note') {
    let beats = (GRAIN_NOTES.find((n) => n.id === s.note) ?? GRAIN_NOTES[3]!).beats
    if (beats < 0) beats = -beats * clock.beatsPerBar
    return Math.floor((clock.beat + clock.beatsPerFrame * 0.5) / beats)
  }
  return clock.frame
}

const salt = (seed: number, component: number, layer: number) => (Math.imul(seed >>> 0, 64) + component * 4 + layer) >>> 0

/** A lattice point's noise (layer 0: the grain; 1: the coarse clumps), for pattern k. */
export function latticeNoise(i: number, j: number, k: number, component: number, layer: number, seed: number): number {
  return gaussian(hash4(i >>> 0, j >>> 0, k >>> 0, salt(seed, component, layer)))
}

/** Boil: refresh k sits at τ = k × boil along the noise's own time; between whole steps two patterns cross-fade at constant strength. */
export function boiledNoise(i: number, j: number, component: number, layer: number, s: GrainSettings, refresh: number): number {
  const tau = refresh * s.boil
  const k0 = Math.floor(tau)
  const f = tau - k0
  const a = latticeNoise(i, j, k0, component, layer, s.seed)
  if (f <= 0) return a
  const b = latticeNoise(i, j, k0 + 1, component, layer, s.seed)
  return Math.cos((f * Math.PI) / 2) * a + Math.sin((f * Math.PI) / 2) * b
}

/** The smallest lattice spacing in use (mono unless the grain is fully colour, channels when there's colour). */
export function finestSpacing(s: GrainSettings): number {
  return Math.min(s.colourAmount < 1 ? s.spacing[0] : Infinity, ...(s.colourAmount > 0 ? s.spacing.slice(1) : [Infinity]))
}

/**
 * The lattice pass's image: two halves side by side, the grain lattice on the left and the
 * coarse lattice (2.5× apart, so it needs fewer texels) on the right, each one texel per
 * lattice point of the finest lattice in use, plus a margin.
 */
export function latticeSize(input: ImageSize, params: Record<string, ParamValue>): ImageSize {
  const h = finestSpacing(grainSettings(input, params))
  return { width: 2 * (Math.ceil(input.width / h) + 4), height: Math.ceil(input.height / h) + 4 }
}

/** Display luma's weight from Shadows, Midtones and Highlights (quadratic Bernstein curves, which add up to one). */
export function distribution(s: GrainSettings, y: number): number {
  const t = Math.min(1, Math.max(0, y))
  return s.shadows * (1 - t) * (1 - t) + s.midtones * 2 * t * (1 - t) + s.highlights * t * t
}
