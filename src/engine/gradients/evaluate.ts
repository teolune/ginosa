import { hsbToRgb, labToRgb, linearToSrgb, rgbToHsb, srgbToLinear, type Rgb } from './colour'
import { parseGradient, type Gradient, type GradientMethod, type NoiseGradient, type SolidGradient } from './gradient'

/**
 * Drawing a gradient (M13): its colour and opacity at any point along the bar, and the
 * 4096-entry table the Gradient Map shader reads.
 *
 * Classic follows the reverse-engineered description in Ilia Malanin's "Photoshop Algorithms
 * Arcana" (pastila.org, 2026), which matches Photoshop's curve to a tenth of a level: each
 * channel on its own, in the document's (display) values; between two stops the position is
 * remapped by the segment's midpoint (piecewise linear, so the midpoint lands half-way), then
 * a cubic Hermite curve runs through the stops with Catmull-Rom tangents (the average of the
 * chords either side, a missing chord counting as zero) pulled towards the segment's own
 * chord by (1 − Smoothness), and the result is clamped to the two stops' range.
 *
 * Linear does the same on linear light and Perceptual on OKLab (sRGB's own transfer curve,
 * as Photoshop's sRGB working space uses: black→white is 188 and 99 half-way, as measured).
 * Smooth (Photoshop 2024+) is OKLab too, ignores Smoothness and eases each segment its own
 * way, which hasn't been published; ginosa's version (a power midpoint like CSS colour hints,
 * full smoothness) is an approximation until it's fitted to your Photoshop's ramps.
 *
 * Opacity stops are drawn the Classic way.
 */

export const GRADIENT_SAMPLES = 4096

type Remap = 'linear' | 'power'

function remap(u: number, m: number, kind: Remap): number {
  const mm = Math.min(0.999, Math.max(0.001, m))
  if (kind === 'power') return u <= 0 ? 0 : u >= 1 ? 1 : u ** (Math.log(0.5) / Math.log(mm))
  return u <= mm ? u / (2 * mm) : 0.5 + (u - mm) / (2 * (1 - mm))
}

/** One channel's value at x: positions ascending, the midpoint of segment i stored on stop i + 1. */
export function channelAt(values: readonly number[], positions: readonly number[], midpoints: readonly number[], smoothness: number, x: number, kind: Remap = 'linear'): number {
  const n = values.length
  if (n === 1 || x <= positions[0]!) return values[0]!
  if (x >= positions[n - 1]!) return values[n - 1]!
  let i = 0
  while (i < n - 2 && positions[i + 1]! <= x) i++
  // Skip zero-length segments (two stops at the same place make a hard edge).
  while (i < n - 2 && positions[i + 1]! <= positions[i]!) i++
  const span = positions[i + 1]! - positions[i]!
  if (span <= 0) return values[i + 1]!
  const u = (x - positions[i]!) / span
  const t = remap(u, midpoints[i + 1]!, kind)
  const v0 = values[i]!
  const v1 = values[i + 1]!
  const d = v1 - v0
  const chord = (k: number) => (k >= 0 && k < n - 1 ? values[k + 1]! - values[k]! : 0)
  const s = Math.min(1, Math.max(0, smoothness))
  const t0 = (1 - s) * d + (s * (chord(i - 1) + chord(i))) / 2
  const t1 = (1 - s) * d + (s * (chord(i) + chord(i + 1))) / 2
  const t2 = t * t
  const t3 = t2 * t
  const h = (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * t0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * t1
  return Math.min(Math.max(v0, v1), Math.max(Math.min(v0, v1), h))
}

// ---- Colour spaces each method works in --------------------------------------------------

function linearToOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

function oklabToLinear([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function toSpace(c: Rgb, method: GradientMethod): Rgb {
  if (method === 'classic') return c
  const lin = c.map(srgbToLinear) as Rgb
  return method === 'linear' ? lin : linearToOklab(lin)
}

function fromSpace(c: Rgb, method: GradientMethod): Rgb {
  if (method === 'classic') return c.map(clamp01) as Rgb
  const lin = method === 'linear' ? c : oklabToLinear(c)
  return lin.map((v) => clamp01(linearToSrgb(v))) as Rgb
}

/** A solid gradient's colour and opacity at x (0–1), as display values. */
export function solidAt(g: SolidGradient, method: GradientMethod, x: number): [number, number, number, number] {
  return solidSampler(g, method)(x)
}

function solidSampler(g: SolidGradient, method: GradientMethod): (x: number) => [number, number, number, number] {
  const stops = g.colourStops
  const positions = stops.map((s) => s.location)
  const midpoints = stops.map((s) => s.midpoint)
  const space = stops.map((s) => toSpace(s.colour, method))
  const channels = [0, 1, 2].map((k) => space.map((c) => c[k]!))
  const smoothness = method === 'smooth' ? 1 : g.smoothness
  const kind: Remap = method === 'smooth' ? 'power' : 'linear'
  const op = g.opacityStops.length ? g.opacityStops : [{ location: 0, midpoint: 0.5, opacity: 1 }]
  const opPositions = op.map((s) => s.location)
  const opMidpoints = op.map((s) => s.midpoint)
  const opValues = op.map((s) => s.opacity)
  return (x) => {
    const c = channels.map((values) => channelAt(values, positions, midpoints, smoothness, x, kind)) as Rgb
    const [r, gg, b] = fromSpace(c, method)
    return [r, gg, b, clamp01(channelAt(opValues, opPositions, opMidpoints, g.smoothness, x))]
  }
}

// ---- Noise gradients ---------------------------------------------------------------------

/** A small seeded generator (mulberry32), so a noise gradient is the same every time. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Noise gradients: Photoshop's generator is undocumented, so this is ginosa's own, driven by
 * the same settings. Each channel wanders randomly within its range; Roughness sets how many
 * changes there are (about 4 at 0%, 128 at 100%) and how sharp they get. Colours are made in
 * the gradient's model (RGB, HSB or Lab). Restrict Colours keeps saturation below 85%; Add
 * Transparency gives the opacity its own random walk.
 */
function noiseSampler(g: NoiseGradient): (x: number) => [number, number, number, number] {
  const next = random(g.seed ^ 0x9e3779b9)
  const segments = Math.round(4 + g.roughness * 124)
  const sharp = g.roughness
  const walks = [0, 1, 2, 3].map(() => Array.from({ length: segments + 1 }, () => next()))
  const range = (k: number): [number, number] => [Math.min(g.min[k]!, g.max[k]!), Math.max(g.min[k]!, g.max[k]!)]
  const ease = (t: number) => {
    const w = Math.max(0.02, 1 - 0.95 * sharp)
    const s = clamp01((t - 0.5) / w + 0.5)
    return s * s * (3 - 2 * s)
  }
  const walk = (k: number, x: number) => {
    const f = clamp01(x) * segments
    const i = Math.min(segments - 1, Math.floor(f))
    const v = walks[k]!
    return v[i]! + (v[i + 1]! - v[i]!) * ease(f - i)
  }
  return (x) => {
    const c = [0, 1, 2].map((k) => {
      const [lo, hi] = range(k)
      // Hue wraps: a minimum above the maximum runs the other way round the wheel.
      if (g.model === 'hsb' && k === 0 && g.min[0]! > g.max[0]!) return (g.min[0]! + walk(0, x) * (1 - g.min[0]! + g.max[0]!)) % 1
      return lo + walk(k, x) * (hi - lo)
    })
    let rgb: Rgb = g.model === 'hsb' ? hsbToRgb(c[0]! * 360, c[1]! * 100, c[2]! * 100) : g.model === 'lab' ? labToRgb(c[0]! * 100, c[1]! * 255 - 128, c[2]! * 255 - 128) : (c as Rgb)
    if (g.restrict) {
      const [h, s, b] = rgbToHsb(rgb)
      if (s > 85) rgb = hsbToRgb(h, 85, b)
    }
    const [lo, hi] = range(3)
    const alpha = g.transparency ? lo + walk(3, x) * (hi - lo) : 1
    return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2]), clamp01(alpha)]
  }
}

// ---- Tables ------------------------------------------------------------------------------

export function gradientSampler(g: Gradient, method: GradientMethod): (x: number) => [number, number, number, number] {
  return g.kind === 'noise' ? noiseSampler(g) : solidSampler(g, method)
}

/** The gradient at `n` evenly spaced points from 0 to 1, as RGBA (display values). */
export function sampleGradient(g: Gradient, method: GradientMethod, n = GRADIENT_SAMPLES): Float32Array {
  const at = gradientSampler(g, method)
  const out = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) out.set(at(n === 1 ? 0 : i / (n - 1)), i * 4)
  return out
}

const tables = new Map<string, Float32Array>()

/** A gradient parameter's table for the shader (cached; the same text and method give the same table). */
export function gradientTable(text: string, method: GradientMethod): Float32Array {
  const key = `${method}\u0001${text}`
  const hit = tables.get(key)
  if (hit) return hit
  const g = parseGradient(text)
  const table = g ? sampleGradient(g, method) : sampleGradient({ kind: 'solid', name: '', smoothness: 1, colourStops: [{ location: 0, midpoint: 0.5, colour: [0, 0, 0], kind: 'user' }, { location: 1, midpoint: 0.5, colour: [1, 1, 1], kind: 'user' }], opacityStops: [] }, method)
  if (tables.size >= 64) tables.delete(tables.keys().next().value!)
  tables.set(key, table)
  return table
}

/** The table read the way the shader reads it (linear between samples), for CPU references. */
export function tableAt(table: Float32Array, x: number): [number, number, number, number] {
  const n = table.length / 4
  const f = clamp01(x) * (n - 1)
  const i = Math.min(n - 2, Math.floor(f))
  const t = f - i
  return [0, 1, 2, 3].map((k) => table[i * 4 + k]! + (table[(i + 1) * 4 + k]! - table[i * 4 + k]!) * t) as [number, number, number, number]
}
