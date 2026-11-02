import { fromOklab, toDisplay, toLinear, toOklab } from '../../engine/effects/colour-spaces'

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
 * and shadows smooth bumps peaking at 2/3 and 1/3 (12% of L at ±100); whites and blacks lift
 * or lower the ends by up to 10%. Super-whites (L above 1) keep their distance above white.
 */
export function basicTone(l0: number, p: BasicCorrectionParams): number {
  let l = clamp(l0, 0, 1)
  l = powPos(l, 2 ** (-p.brightness / 100))
  const k = 2 ** (p.contrast / 100)
  l = l < 0.5 ? 0.5 * powPos(2 * l, k) : 1 - 0.5 * powPos(2 * (1 - l), k)
  l += 0.12 * (p.highlights / 100) * 6.75 * l * l * (1 - l)
  l += 0.12 * (p.shadows / 100) * 6.75 * l * (1 - l) * (1 - l)
  l = clamp(l, 0, 1)
  l += 0.1 * (p.whites / 100) * l * l * l
  const below = Math.max(1 - l, 0)
  l += 0.1 * (p.blacks / 100) * below * below * below
  return Math.max(l, 0) + Math.max(l0 - 1, 0)
}

/** White balance gains on linear R, G, B: equal stops each way, normalised so grey keeps its luminance. */
export function whiteBalanceGains(temperature: number, tint: number): Rgb {
  const t = temperature / 100
  const g = tint / 100
  const gains: Rgb = [2 ** (0.3 * t + 0.15 * g), 2 ** (-0.3 * g), 2 ** (-0.3 * t + 0.15 * g)]
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
