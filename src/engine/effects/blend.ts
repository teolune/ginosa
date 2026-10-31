import { BLEND_MODES, type BlendMode } from '../project/model'

/** The CPU version of blend.wgsl, for tests: d = beneath, s = blended onto it (display values 0–1). */
type Rgb = [number, number, number]

const burn = (d: number, s: number) => (d >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - d) / s))
const dodge = (d: number, s: number) => (d <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, d / (1 - s)))
const softLight = (d: number, s: number) => {
  if (s <= 0.5) return d - (1 - 2 * s) * d * (1 - d)
  const g = d <= 0.25 ? ((16 * d - 12) * d + 4) * d : Math.sqrt(d)
  return d + (2 * s - 1) * (g - d)
}

const CHANNEL: Partial<Record<BlendMode, (d: number, s: number) => number>> = {
  normal: (_d, s) => s,
  darken: Math.min,
  multiply: (d, s) => d * s,
  'color-burn': burn,
  lighten: Math.max,
  screen: (d, s) => 1 - (1 - d) * (1 - s),
  'color-dodge': dodge,
  add: (d, s) => Math.min(1, d + s),
  overlay: (d, s) => (d <= 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s)),
  'soft-light': softLight,
  'hard-light': (d, s) => (s <= 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s)),
  difference: (d, s) => Math.abs(d - s),
  exclusion: (d, s) => d + s - 2 * d * s,
  'linear-burn': (d, s) => Math.max(0, d + s - 1),
  'vivid-light': (d, s) => (s <= 0.5 ? burn(d, 2 * s) : dodge(d, 2 * (s - 0.5))),
  'linear-light': (d, s) => Math.min(1, Math.max(0, d + 2 * s - 1)),
  'pin-light': (d, s) => (s <= 0.5 ? Math.min(d, 2 * s) : Math.max(d, 2 * s - 1)),
  'hard-mix': (d, s) => (d + s >= 1 ? 1 : 0),
  subtract: (d, s) => Math.max(0, d - s),
  divide: (d, s) => (s <= 0 ? (d > 0 ? 1 : 0) : Math.min(1, d / s))
}

const lum = (c: Rgb) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
function clipColor(c: Rgb): Rgb {
  const l = lum(c)
  const n = Math.min(...c)
  const x = Math.max(...c)
  let out = c
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / Math.max(l - n, 1e-6)) as Rgb
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / Math.max(x - l, 1e-6)) as Rgb
  return out
}
const setLum = (c: Rgb, l: number) => clipColor(c.map((v) => v + (l - lum(c))) as Rgb)
const sat = (c: Rgb) => Math.max(...c) - Math.min(...c)
function setSat(c: Rgb, s: number): Rgb {
  const n = Math.min(...c)
  const x = Math.max(...c)
  return x <= n ? [0, 0, 0] : (c.map((v) => ((v - n) * s) / (x - n)) as Rgb)
}

export function blendRgb(d: Rgb, s: Rgb, mode: BlendMode): Rgb {
  switch (mode) {
    case 'hue':
      return setLum(setSat(s, sat(d)), lum(d))
    case 'saturation':
      return setLum(setSat(d, sat(s)), lum(d))
    case 'color':
      return setLum(s, lum(d))
    case 'luminosity':
      return setLum(d, lum(s))
    default: {
      const f = CHANNEL[mode]!
      return [f(d[0], s[0]), f(d[1], s[1]), f(d[2], s[2])]
    }
  }
}

export function blendIndex(mode: BlendMode): number {
  return BLEND_MODES.findIndex((m) => m.id === mode)
}
