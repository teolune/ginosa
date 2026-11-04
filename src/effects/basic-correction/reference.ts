import { fromOklab, toDisplay, toLinear, toOklab } from '../../engine/effects/colour-spaces'
import { BUMP_LIMIT, HIGHLIGHTS_SHADOWS_REACH, TINT_STOPS, WHITES_BLACKS_REACH, temperatureLog2 } from './maths'

/** The CPU version of shader.wgsl, for tests: display R'G'B' (0–1) in, display out. */

type Rgb = [number, number, number]

export interface BasicCorrectionParams {
  temperature: number
  tint: number
  exposure: number
  brightness: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  saturation: number
  vibrance: number
  hue: number
}

export const BASIC_DEFAULTS: BasicCorrectionParams = { temperature: 0, tint: 0, exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, saturation: 100, vibrance: 0, hue: 0 }

/** OKLab hue of typical skin (about 53° for sRGB 224,172,140), which Vibrance spares. */
const SKIN_HUE = (55 * Math.PI) / 180
const SKIN_WIDTH = 0.35
/** Chroma at which Vibrance stops acting (OKLab; vivid sRGB primaries reach 0.26–0.32). */
const VIBRANCE_CHROMA = 0.25

const powPos = (x: number, y: number) => (x <= 0 ? 0 : Math.pow(x, y))
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * The tone curve on OKLab lightness L (0 black, 1 white), in the order of the controls.
 * Brightness is a gamma (black and white fixed); contrast an S-curve through 0.5; highlights
 * and shadows smooth bumps peaking at 2/3 and 1/3 (about 0.3 of L at ±100: two bumps of up to
 * 0.148 each, so the curve never turns back); whites and blacks lift or lower the ends by up
 * to 0.25. Super-whites (L above 1) keep their distance above white.
 */
export function basicTone(l0: number, p: BasicCorrectionParams): number {
  let l = clamp(l0, 0, 1)
  l = powPos(l, 2 ** (-p.brightness / 100))
  const k = 2 ** (p.contrast / 100)
  l = l < 0.5 ? 0.5 * powPos(2 * l, k) : 1 - 0.5 * powPos(2 * (1 - l), k)
  for (const a of bumps(p.highlights)) l += a * 6.75 * l * l * (1 - l)
  for (const a of bumps(p.shadows)) l += a * 6.75 * l * (1 - l) * (1 - l)
  l = clamp(l, 0, 1)
  l += WHITES_BLACKS_REACH * (p.whites / 100) * l * l * l
  const below = Math.max(1 - l, 0)
  l += WHITES_BLACKS_REACH * (p.blacks / 100) * below * below * below
  return Math.max(l, 0) + Math.max(l0 - 1, 0)
}

/** A Highlights or Shadows value as the two bumps it's applied in (each small enough to keep the curve rising). */
export function bumps(value: number): [number, number] {
  const x = HIGHLIGHTS_SHADOWS_REACH * (value / 100)
  const first = clamp(x, -BUMP_LIMIT, BUMP_LIMIT)
  return [first, x - first]
}

/** White balance gains on linear R, G, B (maths.ts), normalised so grey keeps its luminance. */
export function whiteBalanceGains(temperature: number, tint: number): Rgb {
  const g = (tint / 100) * TINT_STOPS
  const [r, gr, b] = temperatureLog2(temperature)
  const gains: Rgb = [2 ** (r + g / 3), 2 ** (gr - (2 * g) / 3), 2 ** (b + g / 3)]
  const luma = 0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2]
  return gains.map((v) => v / luma) as Rgb
}

export function basicCorrectionReference(rgb: Rgb, p: BasicCorrectionParams): Rgb {
  const gains = whiteBalanceGains(p.temperature, p.tint)
  const exposure = 2 ** p.exposure
  const lin = toLinear(rgb).map((v, i) => Math.max(0, v) * gains[i]! * exposure)
  const [L, a0, b0] = toOklab(lin)
  const l = basicTone(L!, p)
  // Chroma follows lightness, so a brighter colour stays as colourful (at most 4×, for lifted blacks).
  const k = L! > 1e-6 ? clamp(l / L!, 0, 4) : 1
  const s = p.saturation / 100
  let a = a0! * k * s
  let b = b0! * k * s
  const v = p.vibrance / 100
  const c = Math.hypot(a, b)
  if (v !== 0 && c > 1e-7) {
    let d = Math.atan2(b, a) - SKIN_HUE
    d -= 2 * Math.PI * Math.floor(d / (2 * Math.PI) + 0.5)
    const skin = Math.exp(-(d * d) / (2 * SKIN_WIDTH * SKIN_WIDTH))
    const w = clamp(1 - c / VIBRANCE_CHROMA, 0, 1) * (1 - 0.6 * skin)
    const f = v > 0 ? 1 + 0.8 * v * w : 1 + v * w
    a *= f
    b *= f
  }
  const turn = (p.hue * Math.PI) / 180
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  const out = fromOklab([l, a * cos - b * sin, a * sin + b * cos]).map((x) => Math.max(0, x))
  return toDisplay(out)
}
