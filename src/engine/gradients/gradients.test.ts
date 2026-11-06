import { describe, expect, it } from 'vitest'
import { BinaryReader, BinaryWriter, readDescriptor, writeDescriptor } from './descriptor'
import { hsbToRgb, labToRgb, linearToSrgb, sourceToRgb } from './colour'
import { channelAt, gradientTable, sampleGradient, solidAt, tableAt } from './evaluate'
import { BLACK_WHITE, formatGradient, parseGradient, solid, starterGradients, type Gradient, type SolidGradient } from './gradient'
import { readGrd, writeGrd, type GrdEntry } from './grd'
import { compareLevels, parseRenderName } from './fidelity'

// Fixtures from the MIT-licensed `gradient` Ruby gem (Copyright 2015 Philip Vieira): see fixtures/README.md.
// Tests run in Node; the engine's own types don't include Node's, so fs is loaded untyped.
const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { readFileSync(path: URL): Uint8Array }
const fixture = (name: string) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

/** Two gradients the same to within float rounding (writing goes through 0–255 and 0–4096). */
function same(a: Gradient, b: Gradient, tolerance = 1e-9): boolean {
  if (a.kind !== b.kind || a.name !== b.name) return false
  if (a.kind === 'noise' || b.kind === 'noise') return formatGradient(a) === formatGradient(b)
  const sa = a as SolidGradient
  const sb = b as SolidGradient
  const close = (x: number, y: number) => Math.abs(x - y) <= tolerance
  if (!close(sa.smoothness, sb.smoothness) || sa.colourStops.length !== sb.colourStops.length || sa.opacityStops.length !== sb.opacityStops.length) return false
  return (
    sa.colourStops.every((s, i) => {
      const t = sb.colourStops[i]!
      return s.kind === t.kind && close(s.location, t.location) && close(s.midpoint, t.midpoint) && s.colour.every((v, k) => close(v, t.colour[k]!)) && JSON.stringify(s.source) === JSON.stringify(t.source)
    }) && sa.opacityStops.every((s, i) => close(s.location, sb.opacityStops[i]!.location) && close(s.opacity, sb.opacityStops[i]!.opacity) && close(s.midpoint, sb.opacityStops[i]!.midpoint))
  )
}

describe('.grd files', () => {
  it('reads kiwi.grd: one gradient, every stop, colour, location and midpoint', () => {
    const lib = readGrd(fixture('kiwi.grd'))
    expect(lib.version).toBe(5)
    expect(lib.warnings).toEqual([])
    expect(lib.entries).toHaveLength(1)
    const g = lib.entries[0]!.gradient as SolidGradient
    expect(g).toMatchObject({ kind: 'solid', name: 'Kiwi', smoothness: 1 })
    expect(g.colourStops.map((s) => Math.round(s.location * 4096))).toEqual([0, 1503, 3270, 3609, 3895])
    expect(g.colourStops[0]!.colour.map((v) => v * 255)).toEqual([61.00389115512371, 17.00389187783003, 3.0038910498842597].map((v) => expect.closeTo(v, 9)))
    expect(g.colourStops.every((s) => s.midpoint === 0.5 && s.kind === 'user' && !s.source)).toBe(true)
    expect(g.opacityStops).toEqual([{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 1 }])
  })

  it('reads nine.grd: 3,397 gradients in every colour model, noise gradients too', () => {
    const lib = readGrd(fixture('nine.grd'))
    expect(lib.warnings).toEqual([])
    expect(lib.entries).toHaveLength(3397)
    const gradients = lib.entries.map((e) => e.gradient)
    expect(gradients.filter((g) => g.kind === 'solid')).toHaveLength(2962)
    expect(gradients.filter((g) => g.kind === 'noise')).toHaveLength(435)
    const stops = gradients.flatMap((g) => (g.kind === 'solid' ? g.colourStops : []))
    const models = new Map<string, number>()
    for (const s of stops) models.set(s.source?.model ?? (s.kind === 'user' ? 'rgb' : s.kind), (models.get(s.source?.model ?? (s.kind === 'user' ? 'rgb' : s.kind)) ?? 0) + 1)
    expect(Object.fromEntries(models)).toEqual({ rgb: 15071, hsb: 4044, cmyk: 512, gray: 81, lab: 8, book: 11, foreground: 21, background: 7 })
    // Foreground and background stops take Photoshop's defaults.
    expect(stops.filter((s) => s.kind === 'foreground').every((s) => s.colour.every((v) => v === 0))).toBe(true)
    expect(stops.filter((s) => s.kind === 'background').every((s) => s.colour.every((v) => v === 1))).toBe(true)
    // A Pantone stop keeps its book and name (there are no colour values to show).
    const book = stops.find((s) => s.source?.model === 'book')!.source!
    expect(book).toMatchObject({ model: 'book', book: 'PANTONE® solid coated', name: 'PANTONE 123 C', bookId: 3002 })
    const noise = gradients.find((g) => g.kind === 'noise')!
    expect(noise).toMatchObject({ kind: 'noise', name: 'Custom', seed: 1331600876, model: 'rgb', transparency: true, restrict: false })
    expect(noise.kind === 'noise' && noise.roughness).toBeCloseTo(3113 / 4096, 9)
    expect(noise.kind === 'noise' && noise.min).toEqual([0.81, 1, 0.58, 0])
  })

  it('reads and writes descriptors byte for byte', () => {
    for (const name of ['kiwi.grd', 'nine.grd']) {
      const bytes = fixture(name)
      const r = new BinaryReader(bytes, 10)
      const root = readDescriptor(r)
      expect(r.offset).toBe(bytes.length)
      const w = new BinaryWriter()
      writeDescriptor(w, root)
      const out = w.finish()
      expect(out.length).toBe(bytes.length - 10)
      expect(equalBytes(out, bytes.subarray(10))).toBe(true)
    }
  })

  it('writes version 5 files that read back the same, every gradient of nine.grd', () => {
    const lib = readGrd(fixture('nine.grd'))
    const again = readGrd(writeGrd(lib.entries))
    expect(again.warnings).toEqual([])
    expect(again.entries).toHaveLength(lib.entries.length)
    const different = lib.entries.filter((e, i) => !same(e.gradient, again.entries[i]!.gradient)).map((e) => e.gradient.name)
    expect(different).toEqual([])
    // kiwi.grd is written exactly as Photoshop wrote it.
    const kiwi = fixture('kiwi.grd')
    const written = writeGrd(readGrd(kiwi).entries)
    expect(equalBytes(written, kiwi)).toBe(true)
  })

  it('keeps folders (preset hierarchy), empty ones too, with gradients in their folders', () => {
    const g = (name: string) => solid(name, [[0, [0, 0, 0]], [1, [1, 1, 1]]])
    const entries: GrdEntry[] = [
      { gradient: g('Top'), folder: [] },
      { gradient: g('Warm A'), folder: ['Film', 'Warm'] },
      { gradient: g('Film 1'), folder: ['Film'] },
      { gradient: g('Warm B'), folder: ['Film', 'Warm'] },
      { gradient: g('Top 2'), folder: [] }
    ]
    const lib = readGrd(writeGrd(entries, [['Film'], ['Empty']]))
    expect(lib.warnings).toEqual([])
    expect(lib.folders).toEqual([['Film'], ['Film', 'Warm'], ['Empty']])
    // Photoshop matches folder entries to gradients by position, so they're written in folder order.
    expect(lib.entries.map((e) => [e.gradient.name, e.folder.join('/')])).toEqual([
      ['Top', ''],
      ['Top 2', ''],
      ['Film 1', 'Film'],
      ['Warm A', 'Film/Warm'],
      ['Warm B', 'Film/Warm']
    ])
    // No folders, no hierarchy block.
    const plain = writeGrd([{ gradient: g('A'), folder: [] }])
    expect(readGrd(plain).folders).toEqual([])
    expect(new TextDecoder().decode(plain).includes('phry')).toBe(false)
  })

  it('reads version 3 files (Photoshop 5) in every colour model', () => {
    const w = new BinaryWriter()
    w.ascii('8BGR')
    w.u16(3)
    w.u16(1)
    w.u8(4)
    w.ascii('Old!')
    const stops: Array<[number, number, number, number[], number]> = [
      [0, 50, 0, [65535, 0, 32768, 0], 0], // RGB
      [1024, 30, 1, [21845, 65535, 65535, 0], 0], // HSB 120°, 100%, 100%
      [2048, 50, 7, [5000, 0, 0, 0], 0], // Lab 50, 0, 0
      [2560, 50, 8, [10000, 0, 0, 0], 0], // gray, 10000 = white
      [3072, 50, 2, [0, 0, 0, 0], 0], // CMYK: 0 is full ink
      [3500, 50, 0, [0, 0, 0, 0], 1], // foreground
      [4096, 70, 0, [0, 0, 0, 0], 2] // background
    ]
    w.u16(stops.length)
    for (const [loc, mid, model, c, type] of stops) {
      w.i32(loc)
      w.i32(mid)
      w.u16(model)
      for (const v of c) w.u16(v)
      w.u16(type)
    }
    w.u16(2)
    w.i32(0)
    w.i32(50)
    w.u16(255)
    w.i32(4096)
    w.i32(50)
    w.u16(51)
    w.bytes(new Uint8Array(6))
    const lib = readGrd(w.finish())
    expect(lib.version).toBe(3)
    expect(lib.warnings).toEqual([])
    const g = lib.entries[0]!.gradient as SolidGradient
    expect(g.name).toBe('Old!')
    const c = g.colourStops.map((s) => s.colour.map((v) => Math.round(v * 255)))
    expect(c).toEqual([[255, 0, 128], [0, 255, 0], [119, 119, 119], [255, 255, 255], [0, 0, 0], [0, 0, 0], [255, 255, 255]])
    expect(g.colourStops[1]!.midpoint).toBe(0.3)
    expect(g.colourStops.map((s) => s.kind).slice(-2)).toEqual(['foreground', 'background'])
    expect(g.opacityStops[1]!.opacity).toBeCloseTo(0.2, 9)
  })

  it('refuses files that aren\'t gradients, with a reason', () => {
    expect(() => readGrd(new TextEncoder().encode('8BPS....'))).toThrow(/8BGR/)
    const truncated = fixture('kiwi.grd').slice(0, 400)
    expect(() => readGrd(truncated)).toThrow(/ends/)
  })
})

describe('stop colours', () => {
  it('converts HSB, Lab (D50, as Photoshop) and grayscale to sRGB', () => {
    expect(hsbToRgb(0, 100, 100)).toEqual([1, 0, 0])
    expect(hsbToRgb(240, 50, 80).map((v) => Math.round(v * 255))).toEqual([102, 102, 204])
    expect(labToRgb(100, 0, 0).map((v) => Math.round(v * 255))).toEqual([255, 255, 255])
    expect(labToRgb(0, 0, 0)).toEqual([0, 0, 0])
    // L* 50 neutral is sRGB 119 (Photoshop's Lab picker shows the same).
    expect(labToRgb(50, 0, 0).map((v) => Math.round(v * 255))).toEqual([119, 119, 119])
    expect(sourceToRgb({ model: 'gray', gray: 25 })).toEqual([0.75, 0.75, 0.75])
  })
})

describe('drawing gradients', () => {
  const bw = (smoothness: number) => ({ ...BLACK_WHITE, smoothness })
  const grey = (g: SolidGradient, method: Parameters<typeof solidAt>[1], x: number) => solidAt(g, method, x)[0]

  it('Classic at 0% smoothness is straight; at 100% a gentle S between two stops', () => {
    for (const x of [0, 0.1, 0.5, 0.77, 1]) expect(grey(bw(0), 'classic', x)).toBeCloseTo(x, 12)
    // Two stops: both tangents are half the chord, so the curve is −t³ + 1.5t² + 0.5t.
    for (const t of [0.25, 0.5, 0.9]) expect(grey(bw(1), 'classic', t)).toBeCloseTo(-(t ** 3) + 1.5 * t * t + 0.5 * t, 12)
  })

  it('moves the half-way point with the midpoint (stored on the later stop)', () => {
    const g = bw(0)
    g.colourStops = g.colourStops.map((s, i) => (i === 1 ? { ...s, midpoint: 0.25 } : s))
    expect(grey(g, 'classic', 0.25)).toBeCloseTo(0.5, 12)
    expect(grey(g, 'classic', 0.125)).toBeCloseTo(0.25, 12)
    expect(grey(g, 'classic', 0.625)).toBeCloseTo(0.75, 12)
  })

  it('matches Photoshop half-way along black to white: Classic 128, Linear 188, Perceptual 99', () => {
    expect(grey(bw(1), 'classic', 0.5) * 255).toBeCloseTo(127.5, 9)
    expect(Math.round(grey(bw(1), 'linear', 0.5) * 255)).toBe(188)
    expect(Math.round(grey(bw(1), 'perceptual', 0.5) * 255)).toBe(99)
    expect(linearToSrgb(0.5) * 255).toBeCloseTo(187.5, 0)
  })

  it('uses Catmull-Rom tangents across stops and clamps each segment to its stops', () => {
    // 0 → 1 → 0: the middle stop's tangent is flat, so there's no overshoot past 1.
    const values = [0, 1, 0]
    const positions = [0, 0.5, 1]
    const mids = [0.5, 0.5, 0.5]
    expect(channelAt(values, positions, mids, 1, 0.25)).toBeCloseTo(0.5625, 12)
    for (let x = 0; x <= 1; x += 0.01) expect(channelAt(values, positions, mids, 1, x)).toBeLessThanOrEqual(1)
    // 0 → 0.4 → 0.6 → 1: the middle segment's curve would overshoot 0.6; it's clamped.
    const steep = [0, 0.4, 0.6, 1]
    for (let x = 1 / 3; x <= 2 / 3; x += 0.005) {
      const v = channelAt(steep, [0, 1 / 3, 2 / 3, 1], [0.5, 0.5, 0.5, 0.5], 1, x)
      expect(v).toBeGreaterThanOrEqual(0.4)
      expect(v).toBeLessThanOrEqual(0.6)
    }
    // Before the first stop and after the last, the end colours hold.
    expect(channelAt([0.2, 0.8], [0.3, 0.7], [0.5, 0.5], 1, 0.1)).toBe(0.2)
    expect(channelAt([0.2, 0.8], [0.3, 0.7], [0.5, 0.5], 1, 0.9)).toBe(0.8)
  })

  it('draws opacity stops, and two stops in one place as a hard edge', () => {
    const g = solid('Edge', [[0, [1, 0, 0]], [0.5, [1, 0, 0]], [0.5, [0, 0, 1]], [1, [0, 0, 1]]], 0)
    g.opacityStops = [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 0 }]
    expect(solidAt(g, 'classic', 0.49)).toEqual([1, 0, 0, expect.closeTo(0.51, 9)])
    expect(solidAt(g, 'classic', 0.5).slice(0, 3)).toEqual([0, 0, 1])
  })

  it('bakes a 4096-entry table, cached, read linearly like the shader', () => {
    const text = formatGradient(starterGradients()[3]!)
    const a = gradientTable(text, 'classic')
    expect(a.length).toBe(4096 * 4)
    expect(gradientTable(text, 'classic')).toBe(a)
    expect(gradientTable(text, 'perceptual')).not.toBe(a)
    const g = parseGradient(text) as SolidGradient
    for (const x of [0, 0.123, 0.5, 0.876, 1]) {
      const exact = solidAt(g, 'classic', x)
      // Between samples the table is straight: within a fiftieth of a level of the curve.
      tableAt(a, x).forEach((v, k) => expect(Math.abs(v - exact[k]!)).toBeLessThan(1e-4))
    }
  })

  it('generates noise gradients the same way every time, within their ranges', () => {
    const noise: Gradient = { kind: 'noise', name: 'N', seed: 42, roughness: 0.5, model: 'rgb', min: [0.2, 0, 0.5, 0], max: [0.6, 1, 0.5, 1], transparency: false, restrict: false }
    const a = sampleGradient(noise, 'classic', 512)
    expect(sampleGradient(noise, 'classic', 512)).toEqual(a)
    expect(sampleGradient({ ...noise, seed: 43 }, 'classic', 512)).not.toEqual(a)
    for (let i = 0; i < 512; i++) {
      expect(a[i * 4]!).toBeGreaterThanOrEqual(0.2 - 1e-6)
      expect(a[i * 4]!).toBeLessThanOrEqual(0.6 + 1e-6)
      expect(a[i * 4 + 2]!).toBeCloseTo(0.5, 6)
      expect(a[i * 4 + 3]!).toBe(1)
    }
  })

  it('keeps gradients as parameter text and refuses anything else', () => {
    for (const g of starterGradients()) expect(parseGradient(formatGradient(g))).toEqual(JSON.parse(formatGradient(g)))
    expect(parseGradient('nonsense')).toBeNull()
    expect(parseGradient('{"kind":"solid","colourStops":[]}')).toBeNull()
    const lib = readGrd(fixture('nine.grd'))
    for (const e of lib.entries.slice(0, 200)) expect(same(parseGradient(formatGradient(e.gradient))!, e.gradient, 1e-6)).toBe(true)
  })
})

describe('the Photoshop fidelity check', () => {
  it('reads what a render is from its file name', () => {
    expect(parseRenderName('Kiwi - Classic.png')).toEqual({ gradient: 'Kiwi', method: 'classic', smoothness: null, input: 'ramp' })
    expect(parseRenderName('Photoshop/Blue - Red - Perceptual - 0% - chart.png')).toEqual({ gradient: 'Blue - Red', method: 'perceptual', smoothness: 0, input: 'chart' })
    expect(parseRenderName('Kiwi - smooth - 50%.PNG')).toEqual({ gradient: 'Kiwi', method: 'smooth', smoothness: 0.5, input: 'ramp' })
    expect(parseRenderName('Kiwi.png')).toBeNull()
    expect(parseRenderName('Kiwi - Classic - wobbly.png')).toBeNull()
  })

  it('measures the difference in levels', () => {
    const c = compareLevels([[10, 20, 30], [0, 0, 0]], [[11, 20, 27], [0, 0, 0]], (i) => `level ${i}`)
    expect(c.mean).toBeCloseTo(4 / 6, 9)
    expect(c.max).toBe(3)
    expect(c.worst).toBe('level 0: Photoshop 11, 20, 27, ginosa 10, 20, 30')
  })
})
