/**
 * Colours of gradient stops (M13): the colour models a .grd stop can be in, converted to the
 * display (sRGB-encoded) values the gradient works with, 0–1. Photoshop converts through the
 * document's working space; for an sRGB document that is:
 *
 * - RGB: the numbers themselves (0–255).
 * - HSB: the usual hexcone. Exact.
 * - Grayscale: ink coverage, so 0% is white; shown as 1 − gray (Gray Gamma 2.2 working gray is
 *   within a level of this; Dot Gain 20% would differ a little).
 * - Lab: CIE L*a*b* (D50, as in ICC profiles) to XYZ, Bradford-adapted to D65, then sRGB.
 *   Exact apart from clipping out-of-gamut colours, as Photoshop's relative colorimetric does.
 * - CMYK: depends on the CMYK working space, which the file doesn't carry, so this is a plain
 *   approximation ((1 − C)(1 − K) …) and the stop is flagged.
 * - Book colours (Pantone…): the file stores only the book and colour names, so the stop is
 *   flagged and shown mid-grey until you pick a colour.
 */

export type Rgb = [number, number, number]

/** A stop's colour as the file stored it, kept so an export writes it back unchanged. */
export type StopColourSource =
  | { model: 'hsb'; h: number; s: number; b: number }
  | { model: 'lab'; l: number; a: number; b: number }
  | { model: 'cmyk'; c: number; m: number; y: number; k: number }
  | { model: 'gray'; gray: number }
  | { model: 'book'; book: string; name: string; bookId: number | null; bookKey: string | null }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** sRGB's own transfer curve (IEC 61966-2-1), which Photoshop's sRGB working space uses. */
export function srgbToLinear(v: number): number {
  const a = Math.abs(v)
  const l = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4
  return v < 0 ? -l : l
}

export function linearToSrgb(v: number): number {
  const a = Math.abs(v)
  const e = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055
  return v < 0 ? -e : e
}

/** Hue in degrees, saturation and brightness in percent. */
export function hsbToRgb(h: number, s: number, b: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60
  const sat = clamp01(s / 100)
  const v = clamp01(b / 100)
  const c = v * sat
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v - c
  const sector = Math.floor(hh) % 6
  const [r, g, bl] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ][sector]! as Rgb
  return [r + m, g + m, bl + m]
}

export function rgbToHsb([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  return [h, max > 0 ? (d / max) * 100 : 0, max * 100]
}

// D50 white (ICC PCS) and the Bradford adaptation D50 → D65, then XYZ (D65) → linear sRGB.
const D50 = [0.9642, 1, 0.8249] as const
const BRADFORD_D50_TO_D65 = [
  [0.9555766, -0.0230393, 0.0631636],
  [-0.0282895, 1.0099416, 0.0210077],
  [0.0122982, -0.020483, 1.3299098]
] as const
const XYZ_TO_SRGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.969266, 1.8760108, 0.041556],
  [0.0556434, -0.2040259, 1.0572252]
] as const

const mul = (m: readonly (readonly number[])[], v: readonly number[]): Rgb => [0, 1, 2].map((i) => m[i]![0]! * v[0]! + m[i]![1]! * v[1]! + m[i]![2]! * v[2]!) as Rgb

export function labToRgb(l: number, a: number, b: number): Rgb {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const e = 216 / 24389
  const k = 24389 / 27
  const inv = (f: number) => (f ** 3 > e ? f ** 3 : (116 * f - 16) / k)
  const xyz50 = [inv(fx) * D50[0], (l > k * e ? fy ** 3 : l / k) * D50[1], inv(fz) * D50[2]]
  const lin = mul(XYZ_TO_SRGB, mul(BRADFORD_D50_TO_D65, xyz50))
  return lin.map((v) => clamp01(linearToSrgb(v))) as Rgb
}

/** Percent ink, 0 = none. A plain conversion: the real one depends on the CMYK working space. */
export function cmykToRgb(c: number, m: number, y: number, k: number): Rgb {
  const kk = 1 - clamp01(k / 100)
  return [(1 - clamp01(c / 100)) * kk, (1 - clamp01(m / 100)) * kk, (1 - clamp01(y / 100)) * kk]
}

/** Display values for a stop colour stored in another model. */
export function sourceToRgb(source: StopColourSource): Rgb {
  switch (source.model) {
    case 'hsb':
      return hsbToRgb(source.h, source.s, source.b)
    case 'lab':
      return labToRgb(source.l, source.a, source.b)
    case 'cmyk':
      return cmykToRgb(source.c, source.m, source.y, source.k)
    case 'gray': {
      const v = clamp01(1 - source.gray / 100)
      return [v, v, v]
    }
    case 'book':
      return [0.5, 0.5, 0.5]
  }
}

/** Whether a source colour can't be shown exactly (and the stop should be flagged). */
export function isApproximate(source: StopColourSource | undefined): boolean {
  return source?.model === 'cmyk' || source?.model === 'book'
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('')}`
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
