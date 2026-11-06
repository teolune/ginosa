import { hsbToRgb, isApproximate, type Rgb, type StopColourSource } from './colour'

/**
 * Gradients (M13), as Photoshop has them. A solid gradient has colour stops and opacity
 * stops, each at a location along the bar (0–1), with a midpoint between each stop and the
 * one before it, and a smoothness. A noise gradient has only its generator's settings.
 *
 * In an effect a gradient is a parameter whose value is this object as JSON text
 * (`formatGradient`), so it saves, copies and keyframes (holding between keyframes) like a curve.
 */

export type GradientMethod = 'classic' | 'perceptual' | 'linear' | 'smooth'
export const GRADIENT_METHODS: ReadonlyArray<{ id: GradientMethod; label: string }> = [
  { id: 'classic', label: 'Classic' },
  { id: 'perceptual', label: 'Perceptual' },
  { id: 'linear', label: 'Linear' },
  { id: 'smooth', label: 'Smooth' }
]

export type StopKind = 'user' | 'foreground' | 'background'

export interface ColourStop {
  /** 0–1 along the bar (Photoshop stores 0–4096). */
  location: number
  /**
   * 0–1: where between the stop before and this one the colour is half-way (Photoshop stores
   * it on the later stop, 0–100%). Ignored on the first stop.
   */
  midpoint: number
  /** Display (sRGB-encoded) values, 0–1. */
  colour: Rgb
  /** Foreground and background stops take Photoshop's default colours (black and white) when imported. */
  kind: StopKind
  /** The colour as a file stored it, if not RGB: kept so export writes it back unchanged. Cleared when you change the colour. */
  source?: StopColourSource
}

export interface OpacityStop {
  location: number
  midpoint: number
  /** 0–1. */
  opacity: number
}

export interface SolidGradient {
  kind: 'solid'
  name: string
  /** 0–1 (Photoshop's Smoothness, stored 0–4096). 1 is Photoshop's default. */
  smoothness: number
  colourStops: ColourStop[]
  opacityStops: OpacityStop[]
  /** The interpolation method a newer Photoshop saved with it, if any. */
  method?: GradientMethod
}

export type NoiseModel = 'rgb' | 'hsb' | 'lab'

export interface NoiseGradient {
  kind: 'noise'
  name: string
  seed: number
  /** 0–1 (Photoshop's Roughness, stored 0–4096). */
  roughness: number
  model: NoiseModel
  /** Per channel 0–1 (Photoshop stores 0–100 for each of four channels). */
  min: [number, number, number, number]
  max: [number, number, number, number]
  /** Add Transparency. */
  transparency: boolean
  /** Restrict Colours (keeps them from oversaturating). */
  restrict: boolean
}

export type Gradient = SolidGradient | NoiseGradient

export const BLACK: Rgb = [0, 0, 0]
export const WHITE: Rgb = [1, 1, 1]

export function solid(name: string, stops: Array<[number, Rgb]>, smoothness = 1): SolidGradient {
  return {
    kind: 'solid',
    name,
    smoothness,
    colourStops: stops.map(([location, colour]) => ({ location, midpoint: 0.5, colour: [...colour] as Rgb, kind: 'user' as const })),
    opacityStops: [
      { location: 0, midpoint: 0.5, opacity: 1 },
      { location: 1, midpoint: 0.5, opacity: 1 }
    ]
  }
}

export const BLACK_WHITE = solid('Black, White', [[0, BLACK], [1, WHITE]])
export const DEFAULT_GRADIENT_TEXT = formatGradient(BLACK_WHITE)

/** The starter gradients every library has (from Photoshop's Basics, rebuilt here). */
export function starterGradients(): SolidGradient[] {
  const fgbg = solid('Foreground to Background', [[0, BLACK], [1, WHITE]])
  fgbg.colourStops[0]!.kind = 'foreground'
  fgbg.colourStops[1]!.kind = 'background'
  return [
    fgbg,
    BLACK_WHITE,
    solid('Violet, Orange', [[0, [41 / 255, 10 / 255, 89 / 255]], [1, [1, 124 / 255, 0]]]),
    solid('Blue, Red, Yellow', [[0, [10 / 255, 0, 178 / 255]], [0.5, [1, 0, 0]], [1, [1, 252 / 255, 0]]]),
    solid('Copper', [[0, [151 / 255, 70 / 255, 26 / 255]], [0.3, [251 / 255, 216 / 255, 197 / 255]], [0.83, [108 / 255, 46 / 255, 22 / 255]], [1, [239 / 255, 219 / 255, 205 / 255]]]),
    solid('Spectrum', [0, 60, 120, 180, 240, 300, 360].map((h, i) => [i / 6, hsbToRgb(h, 100, 100)] as [number, Rgb]))
  ]
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const unit = (v: unknown, fallback: number) => (finite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const MAX_STOPS = 256

function parseRgb(v: unknown): Rgb | null {
  return Array.isArray(v) && v.length === 3 && v.every(finite) ? (v.map((x) => Math.min(1, Math.max(0, x))) as Rgb) : null
}

function parseSource(v: unknown): StopColourSource | undefined {
  if (!v || typeof v !== 'object') return undefined
  const s = v as Record<string, unknown>
  switch (s['model']) {
    case 'hsb':
      return finite(s['h']) && finite(s['s']) && finite(s['b']) ? { model: 'hsb', h: s['h'], s: s['s'], b: s['b'] } : undefined
    case 'lab':
      return finite(s['l']) && finite(s['a']) && finite(s['b']) ? { model: 'lab', l: s['l'], a: s['a'], b: s['b'] } : undefined
    case 'cmyk':
      return finite(s['c']) && finite(s['m']) && finite(s['y']) && finite(s['k']) ? { model: 'cmyk', c: s['c'], m: s['m'], y: s['y'], k: s['k'] } : undefined
    case 'gray':
      return finite(s['gray']) ? { model: 'gray', gray: s['gray'] } : undefined
    case 'book':
      return typeof s['book'] === 'string' && typeof s['name'] === 'string'
        ? { model: 'book', book: s['book'], name: s['name'], bookId: finite(s['bookId']) ? s['bookId'] : null, bookKey: typeof s['bookKey'] === 'string' ? s['bookKey'] : null }
        : undefined
  }
  return undefined
}

/** A gradient from loose data (a saved value, the library file), or null if it isn't one. */
export function toGradient(raw: unknown): Gradient | null {
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>
  const name = typeof g['name'] === 'string' ? g['name'] : 'Gradient'
  if (g['kind'] === 'noise') {
    const four = (v: unknown, fallback: number): [number, number, number, number] =>
      Array.isArray(v) && v.length === 4 ? (v.map((x) => unit(x, fallback)) as [number, number, number, number]) : [fallback, fallback, fallback, fallback]
    const model = g['model'] === 'hsb' || g['model'] === 'lab' ? g['model'] : 'rgb'
    return {
      kind: 'noise',
      name,
      seed: finite(g['seed']) ? Math.round(g['seed']) : 0,
      roughness: unit(g['roughness'], 0.5),
      model,
      min: four(g['min'], 0),
      max: four(g['max'], 1),
      transparency: g['transparency'] === true,
      restrict: g['restrict'] !== false
    }
  }
  if (g['kind'] !== 'solid' || !Array.isArray(g['colourStops'])) return null
  const colourStops: ColourStop[] = []
  for (const s of g['colourStops'].slice(0, MAX_STOPS)) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const colour = parseRgb(o['colour'])
    if (!colour || !finite(o['location'])) continue
    const stop: ColourStop = {
      location: unit(o['location'], 0),
      midpoint: unit(o['midpoint'], 0.5),
      colour,
      kind: o['kind'] === 'foreground' || o['kind'] === 'background' ? o['kind'] : 'user'
    }
    const source = parseSource(o['source'])
    if (source) stop.source = source
    colourStops.push(stop)
  }
  if (colourStops.length === 0) return null
  const opacityStops: OpacityStop[] = []
  for (const s of Array.isArray(g['opacityStops']) ? g['opacityStops'].slice(0, MAX_STOPS) : []) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    if (!finite(o['location'])) continue
    opacityStops.push({ location: unit(o['location'], 0), midpoint: unit(o['midpoint'], 0.5), opacity: unit(o['opacity'], 1) })
  }
  const out: SolidGradient = {
    kind: 'solid',
    name,
    smoothness: unit(g['smoothness'], 1),
    colourStops: sortStops(colourStops),
    opacityStops: opacityStops.length ? sortStops(opacityStops) : [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 1 }]
  }
  if (GRADIENT_METHODS.some((m) => m.id === g['method'])) out.method = g['method'] as GradientMethod
  return out
}

/** Stops in location order (stable, so two at the same place keep their order). */
export function sortStops<T extends { location: number }>(stops: T[]): T[] {
  return stops.map((s, i) => [s, i] as const).sort((a, b) => a[0].location - b[0].location || a[1] - b[1]).map(([s]) => s)
}

const cache = new Map<string, Gradient | null>()

/** The gradient in a parameter's text, or null if it isn't one. */
export function parseGradient(text: string): Gradient | null {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  let parsed: Gradient | null = null
  try {
    parsed = toGradient(JSON.parse(text))
  } catch {
    parsed = null
  }
  if (cache.size > 512) cache.clear()
  cache.set(text, parsed)
  return parsed
}

function r4(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/** A gradient as a parameter's text (numbers rounded to six places, so equal gradients compare equal). */
export function formatGradient(g: Gradient): string {
  if (g.kind === 'noise') return JSON.stringify({ ...g, roughness: r4(g.roughness), min: g.min.map(r4), max: g.max.map(r4) })
  const out: Record<string, unknown> = {
    kind: 'solid',
    name: g.name,
    smoothness: r4(g.smoothness),
    colourStops: g.colourStops.map((s) => ({ location: r4(s.location), midpoint: r4(s.midpoint), colour: s.colour.map(r4), kind: s.kind, ...(s.source ? { source: s.source } : {}) })),
    opacityStops: g.opacityStops.map((s) => ({ location: r4(s.location), midpoint: r4(s.midpoint), opacity: r4(s.opacity) }))
  }
  if (g.method) out['method'] = g.method
  return JSON.stringify(out)
}

/** What a gradient can't do exactly here, to flag in the library and the editor. */
export function gradientNotes(g: Gradient): string[] {
  if (g.kind === 'noise') return ['Noise gradient: same settings as Photoshop, but our own generator, so the colours differ']
  const notes: string[] = []
  if (g.colourStops.some((s) => s.source?.model === 'cmyk')) notes.push('CMYK stops: approximate (Photoshop converts them through its CMYK working space)')
  if (g.colourStops.some((s) => s.source?.model === 'book')) notes.push('Book colours (e.g. Pantone): the file has no colour values; pick a replacement')
  if (g.colourStops.some((s) => s.kind !== 'user')) notes.push('Foreground/background stops: set to black and white')
  return notes
}

export function hasApproximateStops(g: Gradient): boolean {
  return g.kind === 'noise' || g.colourStops.some((s) => isApproximate(s.source))
}
