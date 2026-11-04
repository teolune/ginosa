import { describe, expect, it } from 'vitest'
import { BASIC_DEFAULTS, basicCorrectionReference, basicTone, whiteBalanceGains, type BasicCorrectionParams } from '../../effects/basic-correction/reference'
import { curvesReference } from '../../effects/curves/reference'
import { IDENTITY_LEVEL, level, levelsReference } from '../../effects/levels/reference'
import { mosaicCellsSize, mosaicGrid, mosaicRowsSize } from '../../effects/mosaic/grid'
import { mosaicReference, type RefImage } from '../../effects/mosaic/reference'
import { effectById } from '../../effects/registry'
import { toDisplay, toLinear, toOklab } from './colour-spaces'
import { curveTable, curveValue, formatCurve, IDENTITY_CURVE, parseCurve, tableValue } from './curves'
import { sanitiseValue, upgradeInstance } from './params'
import { warmthStops } from '../../effects/basic-correction/maths'
import type { EffectInstance } from './types'

type Rgb = [number, number, number]
const COLOURS: Rgb[] = [
  [230, 40, 30], [30, 200, 60], [40, 70, 220], [240, 240, 240], [20, 20, 20], [128, 128, 128],
  [200, 150, 60], [90, 30, 120], [224, 172, 140], [5, 5, 8], [255, 255, 255], [0, 0, 0]
].map((c) => c.map((v) => v / 255) as Rgb)
const basic = (p: Partial<BasicCorrectionParams>) => (c: Rgb) => basicCorrectionReference(c, { ...BASIC_DEFAULTS, ...p })
const worst = (a: Rgb[], b: Rgb[]) => Math.max(...a.flatMap((c, i) => c.map((v, k) => Math.abs(v - b[i]![k]!))))
const luminance = (c: Rgb) => { const l = toLinear(c); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] }

describe('curves', () => {
  it('parses, formats and refuses bad curves', () => {
    expect(parseCurve('0,0 0.5,0.7 1,1')).toEqual([[0, 0], [0.5, 0.7], [1, 1]])
    expect(parseCurve('0,0')).toBeNull()
    expect(parseCurve('0,0 0.5,0.5 0.4,1')).toBeNull()
    expect(parseCurve('0,0 1,1.2')).toBeNull()
    expect(formatCurve([[0, 0], [0.33333333, 0.5], [1, 1]])).toBe('0,0 0.3333,0.5 1,1')
    expect(sanitiseValue(effectById('curves')!.params[0]!, 'nonsense', { width: 100, height: 100 })).toBe(IDENTITY_CURVE)
  })

  it('goes through its points smoothly, flat beyond the ends and within 0–1', () => {
    const points = parseCurve('0.1,0.05 0.5,0.75 0.9,0.95')!
    expect(curveValue(points, 0.5)).toBeCloseTo(0.75, 9)
    expect(curveValue(points, 0)).toBe(0.05)
    expect(curveValue(points, 1)).toBe(0.95)
    // A steep curve overshoots; the result is clipped.
    const steep = parseCurve('0,0 0.2,0.95 0.4,1 1,0.2')!
    for (let x = 0; x <= 1; x += 0.01) expect(curveValue(steep, x)).toBeGreaterThanOrEqual(0), expect(curveValue(steep, x)).toBeLessThanOrEqual(1)
    const table = curveTable(IDENTITY_CURVE)
    for (const x of [0, 0.123, 0.5, 0.999]) expect(tableValue(table, x)).toBeCloseTo(x, 6)
  })

  it('applies each channel curve, then the RGB curve', () => {
    const identity = { master: IDENTITY_CURVE, red: IDENTITY_CURVE, green: IDENTITY_CURVE, blue: IDENTITY_CURVE }
    expect(worst(COLOURS.map((c) => curvesReference(c, identity)), COLOURS)).toBeLessThan(1e-6)
    const out = curvesReference([0.5, 0.5, 0.5], { ...identity, master: '0,0 0.5,0.75 1,1' })
    expect(out[0]).toBeCloseTo(0.75, 2)
    // Red inverted, then RGB halved: red 0.2 → 0.8 → 0.4.
    expect(curvesReference([0.2, 0.2, 0.2], { ...identity, red: '0,1 1,0', master: '0,0 1,0.5' })[0]).toBeCloseTo(0.4, 5)
  })
})

describe('levels', () => {
  it('matches Photoshop’s formula', () => {
    expect(level(128 / 255, { ...IDENTITY_LEVEL, inBlack: 50, inWhite: 200 })).toBeCloseTo((128 - 50) / 150, 9)
    expect(level(0.25, { ...IDENTITY_LEVEL, gamma: 2 })).toBeCloseTo(0.5, 9)
    expect(level(0, { ...IDENTITY_LEVEL, outBlack: 20, outWhite: 230 })).toBeCloseTo(20 / 255, 9)
    expect(level(1, { ...IDENTITY_LEVEL, outBlack: 20, outWhite: 230 })).toBeCloseTo(230 / 255, 9)
    expect(level(40 / 255, { ...IDENTITY_LEVEL, inBlack: 50 })).toBe(0)
    // Input white at or below input black is a hard threshold.
    expect(level(0.5, { ...IDENTITY_LEVEL, inBlack: 100, inWhite: 100 })).toBe(1)
    expect(level(0.3, { ...IDENTITY_LEVEL, inBlack: 100, inWhite: 100 })).toBe(0)
  })

  it('is identity at its defaults and runs channels before RGB', () => {
    expect(worst(COLOURS.map((c) => levelsReference(c, {})), COLOURS)).toBeLessThan(1e-9)
    // Red output white 128, then RGB input white 128: red 1 → 128/255 → 1.
    const out = levelsReference([1, 1, 1], { redOutWhite: 128, inWhite: 128 })
    expect(out[0]).toBeCloseTo(1, 9)
    expect(out[1]).toBeCloseTo(1, 9)
  })
})

describe('basic correction', () => {
  it('is identity at its defaults', () => {
    expect(worst(COLOURS.map(basic({})), COLOURS)).toBeLessThan(1e-6)
  })

  it('treats exposure as stops of linear light', () => {
    for (const c of COLOURS.filter((c) => Math.max(...toLinear(c)) < 0.45)) {
      const out = toLinear(basic({ exposure: 1 })(c))
      toLinear(c).forEach((v, i) => expect(out[i]).toBeCloseTo(v * 2, 5))
    }
    const down = toLinear(basic({ exposure: -2 })([0.8, 0.5, 0.3]))
    toLinear([0.8, 0.5, 0.3]).forEach((v, i) => expect(down[i]).toBeCloseTo(v / 4, 5))
  })

  it('warms and tints without changing grey’s brightness', () => {
    for (const [t, g] of [[100, 0], [-100, 0], [0, 100], [40, -70]] as const) {
      const gains = whiteBalanceGains(t, g)
      expect(0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2]).toBeCloseTo(1, 9)
      const grey = basic({ temperature: t, tint: g })([0.5, 0.5, 0.5])
      expect(luminance(grey)).toBeCloseTo(luminance([0.5, 0.5, 0.5]), 3)
    }
    const warm = basic({ temperature: 60 })([0.5, 0.5, 0.5])
    expect(warm[0]).toBeGreaterThan(warm[2])
    const magenta = basic({ tint: 60 })([0.5, 0.5, 0.5])
    expect(magenta[1]).toBeLessThan(magenta[0])
  })

  it('warms along the colour of real light: a full gel at ±100 (version 2)', () => {
    // A full CTO from 6504 K lands near 3,500 K: red 1.92 stops over blue (linear sRGB).
    expect(warmthStops(100)).toBeCloseTo(1.92, 2)
    expect(warmthStops(-100)).toBeCloseTo(-1.57, 2)
    expect(warmthStops(0)).toBe(0)
    for (let t = -100; t < 100; t += 0.5) expect(warmthStops(t + 0.5)).toBeGreaterThan(warmthStops(t))
    // Blue falls further than red rises, and green dips a little, as in tungsten light.
    const [r, g, b] = whiteBalanceGains(100, 0).map(Math.log2) as Rgb
    expect(-b).toBeGreaterThan(r)
    expect(g).toBeLessThan(0)
    // Tint ±100 is one stop of green against red and blue.
    const tint = whiteBalanceGains(0, -100).map(Math.log2) as Rgb
    expect(tint[1] - (tint[0] + tint[2]) / 2).toBeCloseTo(1, 9)
  })

  it('shapes tone with black and white held (except Whites and Blacks)', () => {
    for (const p of [{ brightness: 80 }, { brightness: -80 }, { contrast: 100 }, { contrast: -100 }, { highlights: 100 }, { shadows: -100 }]) {
      const params = { ...BASIC_DEFAULTS, ...p }
      expect(basicTone(0, params)).toBeCloseTo(0, 9)
      expect(basicTone(1, params)).toBeCloseTo(1, 9)
    }
    expect(basicTone(0.5, { ...BASIC_DEFAULTS, contrast: 100 })).toBeCloseTo(0.5, 9)
    expect(basicTone(0.3, { ...BASIC_DEFAULTS, contrast: 100 })).toBeLessThan(0.3)
    expect(basicTone(0.3, { ...BASIC_DEFAULTS, brightness: 50 })).toBeGreaterThan(0.3)
    expect(basicTone(2 / 3, { ...BASIC_DEFAULTS, highlights: 100 })).toBeGreaterThan(2 / 3 + 0.25)
    expect(basicTone(1 / 3, { ...BASIC_DEFAULTS, shadows: -100 })).toBeLessThan(1 / 3 - 0.2)
    // Small values are one bump: Highlights 40 moves 2/3 up by 0.296 × 0.4.
    expect(basicTone(2 / 3, { ...BASIC_DEFAULTS, highlights: 40 })).toBeCloseTo(2 / 3 + 0.296 * 0.4, 9)
    expect(basicTone(0, { ...BASIC_DEFAULTS, blacks: 100 })).toBeCloseTo(0.25, 9)
    expect(basicTone(1, { ...BASIC_DEFAULTS, whites: 100 })).toBeCloseTo(1.25, 9)
    // However far they go, the tone controls never turn the curve back on itself.
    for (const p of [{ highlights: 100 }, { highlights: -100 }, { shadows: 100 }, { shadows: -100 }, { blacks: 100 }, { whites: -100 }, { highlights: 100, shadows: 100 }]) {
      const params = { ...BASIC_DEFAULTS, ...p }
      for (let x = 0; x < 1; x += 0.002) expect(basicTone(x + 0.002, params)).toBeGreaterThanOrEqual(basicTone(x, params) - 1e-12)
    }
    // Super-whites keep their distance above white, with no step at white.
    const params = { ...BASIC_DEFAULTS, whites: 50, contrast: 40 }
    expect(basicTone(1.25, params) - basicTone(1, params)).toBeCloseTo(0.25, 9)
    expect(basicTone(1.000001, params) - basicTone(0.999999, params)).toBeLessThan(1e-4)
  })

  it('converts version 1 values (and their keyframes and modulation) so projects look the same', () => {
    // Version 1's maths, for comparison.
    const v1Tone = (l0: number, h: number, s: number, w: number, b: number) => {
      let l = l0
      l += 0.12 * (h / 100) * 6.75 * l * l * (1 - l)
      l += 0.12 * (s / 100) * 6.75 * l * (1 - l) * (1 - l)
      l = Math.min(1, Math.max(0, l))
      l += 0.1 * (w / 100) * l * l * l
      const below = Math.max(1 - l, 0)
      l += 0.1 * (b / 100) * below * below * below
      return Math.max(l, 0)
    }
    const manifest = effectById('basic-correction')!
    const old: EffectInstance = {
      id: 'e', effectId: 'basic-correction', version: 1, enabled: true, mix: 100, blendMode: 'normal', mask: null,
      params: { ...BASIC_DEFAULTS, temperature: 100, tint: -60, highlights: 100, shadows: -100, whites: 80, blacks: -50, contrast: 20 },
      keyframes: { tint: [{ id: 'k', time: 0, value: 50, interpolation: 'bezier', in: { t: 1 / 3, v: [0] }, out: { t: 1 / 3, v: [20] } }] },
      modulation: { whites: [{ id: 'l', modulatorId: 'm', mode: 'add', min: [0], max: [100], invert: false, amount: 100 }], contrast: [{ id: 'c', modulatorId: 'm', mode: 'multiply', min: [1], max: [2], invert: false, amount: 100 }] }
    }
    const up = upgradeInstance(manifest, old, { width: 100, height: 100 })
    expect(up.version).toBe(2)
    const p = up.params as unknown as BasicCorrectionParams
    for (let l = 0; l <= 1; l += 0.05) expect(basicTone(l, { ...BASIC_DEFAULTS, ...p, contrast: 0, brightness: 0 })).toBeCloseTo(v1Tone(l, 100, -100, 80, -50), 9)
    // Tint: the same green.
    const g = whiteBalanceGains(0, p.tint).map(Math.log2) as Rgb
    expect(g[1] - (g[0] + g[2]) / 2).toBeCloseTo(-0.45 * -0.6, 9)
    // Temperature: the same red against blue (0.6 stops at version 1's +100); the hue moves under 0.1 stops.
    const w = whiteBalanceGains(p.temperature, 0).map(Math.log2) as Rgb
    expect(w[0] - w[2]).toBeCloseTo(0.6, 4)
    expect(Math.abs(w[1] - (w[0] + w[2]) / 2)).toBeLessThan(0.1)
    // Keyframes and their handles convert; additive ranges convert; multiply factors don't.
    const k = up.keyframes['tint']![0]!
    expect(k.value).toBeCloseTo(22.5, 9)
    expect(k.out.v[0]).toBeCloseTo(9, 9)
    expect(up.modulation['whites']![0]!.max[0]).toBeCloseTo(40, 9)
    expect(up.modulation['contrast']![0]!.max[0]).toBe(2)
  })

  it('removes colour at 0% saturation, keeps lightness, and turns hue', () => {
    for (const c of COLOURS) {
      const grey = basic({ saturation: 0 })(c)
      expect(Math.max(...grey) - Math.min(...grey)).toBeLessThan(1e-4)
      expect(toOklab(toLinear(grey))[0]).toBeCloseTo(toOklab(toLinear(c))[0]!, 4)
    }
    // A full turn is no change; 180° twice is no change for colours that stay within the
    // gamut when turned (vivid ones clip on the way, as in any hue turn on RGB).
    expect(worst(COLOURS.map(basic({ hue: 360 })), COLOURS)).toBeLessThan(1e-6)
    const muted = COLOURS.filter((c) => Math.hypot(...toOklab(toLinear(c)).slice(1)) < 0.06)
    expect(muted.length).toBeGreaterThan(5)
    expect(worst(muted.map((c) => basic({ hue: 180 })(basic({ hue: 180 })(c))), muted)).toBeLessThan(2e-3)
  })

  it('spares skin and saturated colours with Vibrance', () => {
    const chroma = (c: Rgb) => Math.hypot(...toOklab(toLinear(c)).slice(1))
    const gain = (c: Rgb) => chroma(basic({ vibrance: 100 })(c)) / chroma(c)
    const dull: Rgb = [0.45, 0.5, 0.6]
    const skin: Rgb = [224 / 255, 172 / 255, 140 / 255]
    const vivid: Rgb = [230 / 255, 40 / 255, 30 / 255]
    expect(gain(dull)).toBeGreaterThan(1.5)
    expect(gain(skin)).toBeLessThan(gain(dull) * 0.75)
    expect(gain(vivid)).toBeLessThan(1.05)
  })
})

describe('mosaic', () => {
  const image = (w: number, h: number, f: (x: number, y: number) => Rgb): RefImage => {
    const rgba = new Float32Array(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([...f(x, y), 1], (y * w + x) * 4)
    return { width: w, height: h, rgba }
  }

  it('lays out an odd, centred grid of whole-pixel placement that covers the picture', () => {
    for (const [w, h, size, aspect] of [[1920, 1080, 5, 1], [1920, 1080, 3.7, 1.6], [640, 64, 50, 1], [100, 100, 200, 1], [1280, 720, 0.5, 0.25]] as const) {
      const grid = mosaicGrid({ width: w, height: h }, { cellSize: size, aspect })!
      expect(grid.count[0] % 2).toBe(1)
      expect(grid.count[1] % 2).toBe(1)
      expect(grid.origin.every(Number.isInteger)).toBe(true)
      expect(grid.origin[0]).toBeLessThanOrEqual(0)
      expect(grid.origin[0] + grid.count[0] * grid.cell[0]).toBeGreaterThanOrEqual(w)
      expect(grid.origin[1] + grid.count[1] * grid.cell[1]).toBeGreaterThanOrEqual(h)
      expect((grid.count[0] - 2) * grid.cell[0]).toBeLessThan(w + 1)
      // The middle cell is centred on the picture, to within half a pixel.
      expect(Math.abs(grid.origin[0] + ((grid.count[0] - 1) / 2 + 0.5) * grid.cell[0] - w / 2)).toBeLessThanOrEqual(0.5)
    }
    expect(mosaicGrid({ width: 1920, height: 1080 }, { cellSize: 0.05, aspect: 1 })).toBeNull()
    expect(mosaicCellsSize({ width: 1920, height: 1080 }, { cellSize: 0 })).toEqual({ width: 1, height: 1 })
    expect(mosaicRowsSize({ width: 1920, height: 1080 }, { cellSize: 10, aspect: 1 })).toEqual({ width: 19, height: 1080 })
  })

  it('averages the light in each cell, weighted by coverage', () => {
    // Stripes of black and white one pixel wide: each 4 px cell averages to half the light.
    const stripes = image(40, 20, (x) => (x % 2 ? [1, 1, 1] : [0, 0, 0]))
    const out = mosaicReference(stripes, { cellSize: 20, aspect: 1, sample: 'average', softness: 0 })
    const grid = mosaicGrid({ width: 40, height: 20 }, { cellSize: 20, aspect: 1 })!
    expect(grid.cell).toEqual([4, 4])
    const half = toDisplay([0.5, 0.5, 0.5])[0]
    // Whole-pixel cells of an even width each cover 2 white and 2 black stripes.
    for (let x = 0; x < 40; x++) expect(out(x, 10)[0]).toBeCloseTo(half, 6)
    // Cell edges through the middle of pixels: 2.5 px cells from −1, so pixel 20's cell spans
    // 19–21.5: white 19, black 20, half of white 21, so 60% white.
    expect(mosaicGrid({ width: 40, height: 20 }, { cellSize: 12.5, aspect: 1 })!.origin).toEqual([-1, -1])
    const offset = mosaicReference(stripes, { cellSize: 12.5, aspect: 1, sample: 'average', softness: 0 })
    expect(offset(20, 10)[0]).toBeCloseTo(toDisplay([0.6, 0.6, 0.6])[0], 6)
    // Flat inside a cell, stepping at its edges.
    const ramp = image(64, 32, (x) => [x / 63, 0, 0])
    const blocks = mosaicReference(ramp, { cellSize: 25, aspect: 1, sample: 'average', softness: 0 })
    const g = mosaicGrid({ width: 64, height: 32 }, { cellSize: 25, aspect: 1 })!
    const edge = g.origin[0] + 4 * g.cell[0]
    expect(blocks(Math.floor(edge) - 1, 5)).toEqual(blocks(Math.floor(edge) - 7, 5))
    expect(blocks(Math.floor(edge), 5)[0]).toBeGreaterThan(blocks(Math.floor(edge) - 1, 5)[0])
  })

  it('takes the centre pixel, softens edges, and is off under a pixel', () => {
    const noise = image(30, 30, (x, y) => [((x * 7 + y * 13) % 31) / 30, ((x * 3 + y * 5) % 17) / 16, 0.5])
    const centre = mosaicReference(noise, { cellSize: 100 / 3, aspect: 1, sample: 'centre', softness: 0 })
    expect(mosaicGrid({ width: 30, height: 30 }, { cellSize: 100 / 3, aspect: 1 })!.origin).toEqual([-10, -10])
    // 10 px cells, five each way from −10, the middle one spanning 10–20: centre pixel (15, 15).
    const expected = [(15 * 7 + 15 * 13) % 31 / 30, ((15 * 3 + 15 * 5) % 17) / 16]
    expect(centre(12, 18)[0]).toBeCloseTo(expected[0]!, 5)
    expect(centre(12, 18)[1]).toBeCloseTo(expected[1]!, 5)
    // Full softness blends smoothly: no jumps bigger than a hard edge, and the edge pixel lies between.
    const soft = mosaicReference(noise, { cellSize: 100 / 3, aspect: 1, sample: 'average', softness: 100 })
    const hard = mosaicReference(noise, { cellSize: 100 / 3, aspect: 1, sample: 'average', softness: 0 })
    const a = hard(5, 15)[0], b = hard(15, 15)[0]
    const mid = soft(10, 15)[0]
    expect(mid).toBeGreaterThan(Math.min(a, b) - 1e-9)
    expect(mid).toBeLessThan(Math.max(a, b) + 1e-9)
    expect(soft(15, 15)[0]).toBeCloseTo(b, 2)
    const off = mosaicReference(noise, { cellSize: 2, aspect: 1, sample: 'average', softness: 0 })
    expect(off(7, 9)).toEqual(Array.from(noise.rgba.slice((9 * 30 + 7) * 4, (9 * 30 + 7) * 4 + 4)))
  })
})
