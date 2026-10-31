/**
 * Colour science for input conversion: Apple Log decoding, primaries matrices
 * (BT.2020 and Apple Wide Gamut to Rec.709), and the display transforms. Pure
 * maths, mirrored in the compositor's WGSL and unit-tested here.
 */

export type Matrix3 = [number, number, number, number, number, number, number, number, number]
export type Vec3 = [number, number, number]

export function mul(a: Matrix3, b: Matrix3): Matrix3 {
  const r: number[] = []
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!)
  return r as Matrix3
}

export function apply(m: Matrix3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

export function invert(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}

type XY = [number, number]

function xyz(xy: XY): Vec3 {
  return [xy[0] / xy[1], 1, (1 - xy[0] - xy[1]) / xy[1]]
}

/** RGB → XYZ for a set of primaries and white point (SMPTE RP 177). */
export function rgbToXyz(r: XY, g: XY, b: XY, white: XY): Matrix3 {
  const [xr, yr, zr] = xyz(r)
  const [xg, yg, zg] = xyz(g)
  const [xb, yb, zb] = xyz(b)
  const p: Matrix3 = [xr, xg, xb, yr, yg, yb, zr, zg, zb]
  const s = apply(invert(p), xyz(white))
  return [xr * s[0], xg * s[1], xb * s[2], yr * s[0], yg * s[1], yb * s[2], zr * s[0], zg * s[1], zb * s[2]]
}

const BRADFORD: Matrix3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296]

/** Bradford chromatic adaptation from one white to another (XYZ → XYZ). */
export function bradford(from: XY, to: XY): Matrix3 {
  const s = apply(BRADFORD, xyz(from))
  const d = apply(BRADFORD, xyz(to))
  const scale: Matrix3 = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]]
  return mul(invert(BRADFORD), mul(scale, BRADFORD))
}

export const D65: XY = [0.3127, 0.329]
export const D60: XY = [0.32168, 0.33767]

export const REC709_TO_XYZ = rgbToXyz([0.64, 0.33], [0.3, 0.6], [0.15, 0.06], D65)
export const BT2020_TO_XYZ = rgbToXyz([0.708, 0.292], [0.17, 0.797], [0.131, 0.046], D65)
const AP0_TO_XYZ = rgbToXyz([0.7347, 0.2653], [0.0, 1.0], [0.0001, -0.077], D60)

/** Linear BT.2020 → linear Rec.709. */
export const BT2020_TO_REC709 = mul(invert(REC709_TO_XYZ), BT2020_TO_XYZ)

/**
 * Apple Wide Gamut (Apple Log 2) → ACES2065-1, Bradford-adapted, as published by the
 * ACES/OpenColorIO colour scientists (Apple publishes primaries but no matrix).
 */
export const APPLE_WIDE_GAMUT_TO_AP0: Matrix3 = [
  0.694961049318096, 0.241405268785364, 0.06363368189654, 0.0473627464149325, 1.00429592505428, -0.0516586714692158, -0.021989789359883, -0.0289891049714743,
  1.05097889433136
]

/** Linear Apple Wide Gamut → linear Rec.709 (via ACES2065-1, Bradford D60 → D65). */
export const APPLE_WIDE_GAMUT_TO_REC709 = mul(invert(REC709_TO_XYZ), mul(bradford(D60, D65), mul(AP0_TO_XYZ, APPLE_WIDE_GAMUT_TO_AP0)))

/** Apple Log Profile constants (Apple's white paper); Apple Log 2 uses the same curve. */
export const APPLE_LOG = { R0: -0.05641088, Rt: 0.01, c: 47.28711236, beta: 0.00964052, gamma: 0.08550479, delta: 0.69336945 }

/** Apple Log code value (0–1) → scene-linear reflectance (0.18 = mid grey). */
export function appleLogDecode(p: number): number {
  const { R0, Rt, c, beta, gamma, delta } = APPLE_LOG
  const pt = c * (Rt - R0) ** 2
  if (p >= pt) return 2 ** ((p - delta) / gamma) - beta
  if (p >= 0) return Math.sqrt(p / c) + R0
  return R0
}

export function appleLogEncode(r: number): number {
  const { R0, Rt, c, beta, gamma, delta } = APPLE_LOG
  if (r >= Rt) return gamma * Math.log2(r + beta) + delta
  if (r >= R0) return c * (r - R0) ** 2
  return 0
}

/** Rec.709 camera OETF: scene light → code value. */
export function rec709Oetf(l: number): number {
  return l < 0.018 ? 4.5 * l : 1.099 * Math.pow(l, 0.45) - 0.099
}

/** Gentle highlight shoulder: linear up to `knee`, then easing towards 1. */
export function shoulder(x: number, knee = 0.5): number {
  if (x <= knee) return x
  return knee + (1 - knee) * (1 - Math.exp(-(x - knee) / (1 - knee)))
}

/** Built-in Apple Log / Apple Log 2 → Rec.709 code values (a technical conversion; your LUT replaces it). */
export function appleLogToRec709(rgb: Vec3, gamut: 'bt2020' | 'apple-wide-gamut'): Vec3 {
  const linear = rgb.map(appleLogDecode) as Vec3
  const rec709 = apply(gamut === 'bt2020' ? BT2020_TO_REC709 : APPLE_WIDE_GAMUT_TO_REC709, linear)
  return rec709.map((v) => rec709Oetf(shoulder(Math.max(0, v)))) as Vec3
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/**
 * How macOS (QuickTime, Safari, Chromium) shows Rec.709 video: code values decoded with
 * gamma 1.961, then shown on an sRGB display. Chromium applies this to decoded BT.709
 * frames; the compositor undoes it to work on the file's real values, and applies it
 * again on screen so the preview matches QuickTime.
 */
export const MAC_VIDEO_GAMMA = 1.961

export function macDisplay(code: number): number {
  return linearToSrgb(Math.pow(Math.max(0, code), MAC_VIDEO_GAMMA))
}

export function undoMacDisplay(shown: number): number {
  return Math.pow(Math.max(0, srgbToLinear(shown)), 1 / MAC_VIDEO_GAMMA)
}
