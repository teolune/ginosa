import { gradientTable, tableAt } from '../../engine/gradients/evaluate'
import type { GradientMethod } from '../../engine/gradients/gradient'

/** The CPU version of shader.wgsl, for tests: display R'G'B' (0–1) in, display out (Normal blending, no dither). */

type Rgb = [number, number, number]

export interface GradientMapParams {
  gradient: string
  method: GradientMethod
  reverse: boolean
  inputBlack: number
  inputWhite: number
  offset: number
  repeat: number
  edges: 'wrap' | 'mirror' | 'clamp'
  gradientB: string
  morph: number
  opacityStops: boolean
  /** The shader's dither (not modelled here: the GPU test checks it on its own). */
  dither?: boolean
}

export const LUMA: Rgb = [0.3, 0.59, 0.11]

export function mapPosition(y: number, p: GradientMapParams): number {
  const black = p.inputBlack / 100
  const white = p.inputWhite / 100
  const t = Math.abs(white - black) < 1e-5 ? (y >= black ? 1 : 0) : Math.min(1, Math.max(0, (y - black) / (white - black)))
  const q = t * p.repeat + p.offset / 100
  let x: number
  if (p.edges === 'clamp') x = Math.min(1, Math.max(0, q))
  else if (p.edges === 'mirror') x = 1 - Math.abs(1 - (q - 2 * Math.floor(q / 2)))
  else {
    x = q - Math.floor(q)
    if (x === 0 && q > 0) x = 1
  }
  return p.reverse ? 1 - x : x
}

export function gradientMapReference(rgb: Rgb, p: GradientMapParams): Rgb {
  const y = rgb.reduce((sum, v, i) => sum + Math.min(1, Math.max(0, v)) * LUMA[i]!, 0)
  const x = mapPosition(y, p)
  let g = tableAt(gradientTable(p.gradient, p.method), x)
  if (p.morph > 0) {
    const b = tableAt(gradientTable(p.gradientB, p.method), x)
    g = g.map((v, i) => v + (b[i]! - v) * (p.morph / 100)) as typeof g
  }
  const a = p.opacityStops ? g[3] : 1
  return [0, 1, 2].map((i) => rgb[i]! + (g[i]! - rgb[i]!) * a) as Rgb
}
