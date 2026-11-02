import { toDisplay, toLinear } from '../../engine/effects/colour-spaces'
import type { EffectClock, ImageSize, ParamValue } from '../../engine/effects/types'
import { boiledNoise, COARSE, COARSE_WEIGHT, distribution, grainSettings, refreshIndex } from './maths'

type Rgb = [number, number, number]

/** Rounds to the nearest half-float (11 significant bits), as the GPU stores the lattice. */
export function half(v: number): number {
  if (v === 0 || !Number.isFinite(v)) return v
  const e = Math.max(-14, Math.floor(Math.log2(Math.abs(v))))
  const step = 2 ** (e - 10)
  return Math.round(v / step) * step
}

/**
 * The CPU version of Grain, for tests: for an input of `input` pixels at `clock`, the
 * output (display RGB) of pixel (x, y) whose input colour is `src`. Lattice values are
 * computed once each.
 */
export function grainReference(input: ImageSize, params: Record<string, ParamValue>, clock: EffectClock) {
  const s = grainSettings(input, params)
  const refresh = refreshIndex(s, clock)
  const lattice = new Map<string, number>()
  const at = (i: number, j: number, component: number, layer = 0) => {
    const key = `${component}:${layer}:${i}:${j}`
    let v = lattice.get(key)
    if (v === undefined) {
      v = half(boiledNoise(i, j, component, layer, s, refresh))
      lattice.set(key, v)
    }
    return v
  }
  const grainAt = (px: number, py: number, component: number) => {
    const h = s.spacing[component]!
    const u = px / h + 1
    const v = py / h + 1
    const bx = Math.floor(u) - 1
    const by = Math.floor(v) - 1
    const k = -0.5 / (s.sigma * s.sigma)
    const wx = [0, 1, 2, 3].map((a) => Math.exp(k * (u - (bx + a)) ** 2))
    const wy = [0, 1, 2, 3].map((b) => Math.exp(k * (v - (by + b)) ** 2))
    let sum = 0
    let squares = 0
    for (let b = 0; b < 4; b++)
      for (let a = 0; a < 4; a++) {
        const w = wx[a]! * wy[b]!
        sum += w * at(bx + a, by + b, component)
        squares += w * w
      }
    const fine = sum / Math.sqrt(squares)
    const cu = px / (COARSE * h) + 1
    const cv = py / (COARSE * h) + 1
    const cx = Math.floor(cu)
    const cy = Math.floor(cv)
    const fx = cu - cx
    const fy = cv - cy
    const bilinear = (at(cx, cy, component, 1) * (1 - fx) + at(cx + 1, cy, component, 1) * fx) * (1 - fy) + (at(cx, cy + 1, component, 1) * (1 - fx) + at(cx + 1, cy + 1, component, 1) * fx) * fy
    const coarse = bilinear / Math.sqrt(((1 - fx) ** 2 + fx ** 2) * ((1 - fy) ** 2 + fy ** 2))
    return (fine + COARSE_WEIGHT * coarse) / Math.sqrt(1 + COARSE_WEIGHT * COARSE_WEIGHT)
  }
  /** The grain itself (unit strength) at a pixel, per channel. */
  const grain = (x: number, y: number): Rgb => {
    const px = x + 0.5
    const py = y + 0.5
    const k = s.colourAmount
    const g: Rgb = [0, 0, 0]
    if (k < 1) {
      const m = grainAt(px, py, 0) * Math.sqrt(1 - k)
      g[0] = g[1] = g[2] = m
    }
    if (k > 0) for (let c = 0; c < 3; c++) g[c] = g[c]! + grainAt(px, py, c + 1) * Math.sqrt(k)
    return g
  }
  const output = (x: number, y: number, src: Rgb): Rgb => {
    const g = grain(x, y)
    const luma = 0.2126 * Math.min(1, Math.max(0, src[0])) + 0.7152 * Math.min(1, Math.max(0, src[1])) + 0.0722 * Math.min(1, Math.max(0, src[2]))
    const w = distribution(s, luma)
    if (s.composite === 'layer') return g.map((v) => Math.min(1, Math.max(0, 0.5 + 0.5 * s.amount * v * w))) as Rgb
    const lin = toLinear(src.map((v) => Math.max(0, v)))
    const out = s.composite === 'digital' ? lin.map((l, c) => Math.max(0, l + s.amount * (0.4 * Math.sqrt(l) + 0.02) * g[c]! * w)) : lin.map((l, c) => l * 2 ** (s.amount * g[c]! * w))
    return toDisplay(out)
  }
  return { settings: s, refresh, grain, output }
}
