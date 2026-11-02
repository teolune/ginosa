import { describe, expect, it } from 'vitest'
import { grainReference } from '../../effects/grain/reference'
import { boiledNoise, gaussian, grainSettings, hash4, latticeNoise, latticeSize, pcg, refreshIndex } from '../../effects/grain/maths'
import { effectById } from '../../effects/registry'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { frameKeys } from '../render/frame-keys'
import { secondsToTicks } from '../time'
import { placeMedia } from '../timeline/edits'
import { addEffect } from '../timeline/effect-edits'
import { clockAt } from '../timeline/render-plan'
import { toLinear } from './colour-spaces'
import type { EffectClock, ParamValue } from './types'

const SIZE = { width: 1920, height: 1080 }
const defaults = Object.fromEntries(effectById('grain')!.params.map((p) => [p.id, p.default])) as Record<string, ParamValue>
const clock = (frame: number, bpm = 120, fps = 25): EffectClock => ({ frame, beat: (frame / fps) * (bpm / 60), beatsPerFrame: bpm / 60 / fps, beatsPerBar: 4 })
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
const variance = (v: number[]) => {
  const m = mean(v)
  return mean(v.map((x) => (x - m) ** 2))
}
const correlation = (a: number[], b: number[]) => {
  const ma = mean(a)
  const mb = mean(b)
  let ab = 0, aa = 0, bb = 0
  a.forEach((x, i) => ((ab += (x - ma) * (b[i]! - mb)), (aa += (x - ma) ** 2), (bb += (b[i]! - mb) ** 2)))
  return ab / Math.sqrt(aa * bb)
}
/** The grain (green channel, unit strength) at a grid of pixels. */
const field = (params: Record<string, ParamValue>, at: EffectClock, points = grid(40, 40, 7)) => {
  const r = grainReference(SIZE, { ...defaults, ...params }, at)
  return points.map(([x, y]) => r.grain(x, y)[1])
}
function grid(nx: number, ny: number, step: number, x0 = 100, y0 = 100): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.push([x0 + i * step, y0 + j * step])
  return out
}

describe('grain noise', () => {
  it('hashes 32-bit integers the same way every time, spread evenly', () => {
    expect(pcg(0)).toBe(pcg(0))
    expect(pcg(1)).not.toBe(pcg(2))
    for (const v of [0, 1, 0xffffffff, 123456789]) expect(Number.isInteger(pcg(v)) && pcg(v) >= 0 && pcg(v) < 2 ** 32).toBe(true)
    // Negative inputs (beats before the downbeat) wrap like the GPU's bitcast.
    expect(hash4(-1 >>> 0, 2, 3, 4)).toBe(hash4(0xffffffff, 2, 3, 4))
    const bits = Array.from({ length: 20000 }, (_, i) => pcg(i) / 2 ** 32)
    expect(Math.abs(mean(bits) - 0.5)).toBeLessThan(0.01)
  })

  it('makes unit Gaussians, at lattice points and once boiled', () => {
    const g = Array.from({ length: 40000 }, (_, i) => gaussian(hash4(i, 7, 0, 3)))
    expect(Math.abs(mean(g))).toBeLessThan(0.02)
    expect(Math.abs(variance(g) - 1)).toBeLessThan(0.03)
    const coarse = Array.from({ length: 20000 }, (_, i) => latticeNoise(i % 200, Math.floor(i / 200), 5, 1, 1, 0))
    expect(Math.abs(variance(coarse) - 1)).toBeLessThan(0.05)
    // The two layers and neighbouring points are independent.
    expect(Math.abs(correlation(coarse, Array.from({ length: 20000 }, (_, i) => latticeNoise(i % 200, Math.floor(i / 200), 5, 1, 0, 0))))).toBeLessThan(0.03)
    const s = grainSettings(SIZE, { ...defaults, boil: 37 })
    const boiled = Array.from({ length: 20000 }, (_, i) => boiledNoise(i % 200, Math.floor(i / 200), 0, 0, s, 7))
    expect(Math.abs(variance(boiled) - 1)).toBeLessThan(0.05)
  })

  it('keeps the same strength everywhere between lattice points (no grid pattern), at any size and softness', () => {
    for (const [size, softness] of [[1, 0], [1, 100], [3, 40], [0.6, 60]] as const) {
      const r = grainReference(SIZE, { ...defaults, size, softness, grainType: 'mono' }, clock(3))
      const h = r.settings.spacing[0]
      // Pixels at three places in their lattice cells, over many cells 8 lattice steps apart.
      for (const offset of [0, 0.25, 0.5]) {
        const values: number[] = []
        for (let i = 0; i < 2500; i++) values.push(r.grain(Math.floor((20 + (i % 50) * 8 + offset) * h), Math.floor((20 + Math.floor(i / 50) * 8 + offset) * h))[0])
        expect(Math.abs(variance(values) - 1), `size ${size}, softness ${softness}, offset ${offset}`).toBeLessThan(0.09)
      }
    }
  })

  it('grows with Size: neighbouring pixels agree more on bigger grain', () => {
    const neighbours = (size: number) => {
      const points = grid(60, 30, 5)
      return correlation(field({ size, grainType: 'mono' }, clock(0), points), field({ size, grainType: 'mono' }, clock(0), points.map(([x, y]) => [x + 1, y])))
    }
    const small = neighbours(0.5)
    const big = neighbours(4)
    expect(small).toBeLessThan(0.35)
    expect(big).toBeGreaterThan(0.85)
    expect(neighbours(1.5)).toBeGreaterThan(small)
  })
})

describe('grain over time', () => {
  it('draws a new pattern every frame, every N frames, or on a note value (at the nearest frame)', () => {
    expect(Math.abs(correlation(field({}, clock(10)), field({}, clock(11))))).toBeLessThan(0.08)
    const every3 = (f: number) => field({ refresh: 'frames', every: 3 }, clock(f))
    expect(every3(3)).toEqual(every3(5))
    expect(Math.abs(correlation(every3(5), every3(6)))).toBeLessThan(0.08)
    // A beat at 120 BPM is 12.5 frames at 25 fps: changes on frames 12, 25, 37 and 50.
    const s = grainSettings(SIZE, { ...defaults, refresh: 'note', note: '1/4' })
    const index = Array.from({ length: 52 }, (_, f) => refreshIndex(s, clock(f)))
    expect(index.flatMap((k, f) => (f > 0 && k !== index[f - 1] ? [f] : []))).toEqual([12, 25, 37, 50])
    // A bar (4 beats) at 128 BPM: every 46.875 frames → 47, 94.
    const bar = grainSettings(SIZE, { ...defaults, refresh: 'note', note: '1 bar' })
    const bars = Array.from({ length: 100 }, (_, f) => refreshIndex(bar, clock(f, 128)))
    expect(bars.flatMap((k, f) => (f > 0 && k !== bars[f - 1] ? [f] : []))).toEqual([47, 94])
  })

  it('carries grain over by Boil: 0% freezes it, 100% is all new', () => {
    const next = (boil: number) => correlation(field({ boil }, clock(20)), field({ boil }, clock(21)))
    expect(next(0)).toBeCloseTo(1, 9)
    expect(Math.abs(next(100))).toBeLessThan(0.08)
    const half = next(50)
    expect(half).toBeGreaterThan(0.4)
    expect(half).toBeLessThan(0.95)
    expect(next(20)).toBeGreaterThan(half)
  })

  it('takes its pattern from the seed, and the sequence frame from the clock', () => {
    expect(Math.abs(correlation(field({ seed: 0 }, clock(4)), field({ seed: 1 }, clock(4))))).toBeLessThan(0.08)
    const sequence = createProject({ name: 'Clock', createId: () => 'x' }).sequence
    expect(clockAt(sequence, secondsToTicks(2)).frame).toBe(50)
    expect(clockAt(sequence, secondsToTicks(2)).beat).toBeCloseTo(4, 9)
  })
})

describe('grain colour and compositing', () => {
  it('is the same in every channel for Monochrome or 0% colour, independent at 100%', () => {
    const at = grid(30, 30, 9)
    for (const params of [{ grainType: 'mono' }, { grainType: 'colour', colourAmount: 0 }] as Array<Record<string, ParamValue>>) {
      const r = grainReference(SIZE, { ...defaults, ...params }, clock(2))
      for (const [x, y] of at.slice(0, 50)) {
        const g = r.grain(x, y)
        expect(g[0]).toBe(g[1])
        expect(g[2]).toBe(g[1])
      }
    }
    const channels = (amount: number) => {
      const r = grainReference(SIZE, { ...defaults, grainType: 'colour', colourAmount: amount, blueSize: 100 }, clock(2))
      const g = at.map(([x, y]) => r.grain(x, y))
      return correlation(g.map((c) => c[0]), g.map((c) => c[2]))
    }
    expect(Math.abs(channels(100))).toBeLessThan(0.08)
    expect(channels(40)).toBeGreaterThan(0.5)
    expect(channels(40)).toBeLessThan(0.7)
  })

  it('Film moves light by stops (none in black), Digital adds sensor-like noise, Grain layer is grey grain', () => {
    const at = grid(40, 40, 7)
    const grey: [number, number, number] = [0.5, 0.5, 0.5]
    const film = grainReference(SIZE, { ...defaults, amount: 20, grainType: 'mono', composite: 'film', shadows: 100, midtones: 100, highlights: 100 }, clock(1))
    const stops = at.map(([x, y]) => Math.log2(toLinear(film.output(x, y, grey))[1] / toLinear(grey)[1]))
    // Grain strength is 0.2 stop at mid grey (all three weights 100%).
    expect(Math.sqrt(variance(stops))).toBeCloseTo(0.2, 1)
    expect(film.output(10, 10, [0, 0, 0])).toEqual([0, 0, 0])
    const digital = grainReference(SIZE, { ...defaults, amount: 20, grainType: 'mono', composite: 'digital', shadows: 100 }, clock(1))
    const black = at.map(([x, y]) => toLinear(digital.output(x, y, [0, 0, 0]))[1])
    expect(Math.max(...black)).toBeGreaterThan(0)
    const layer = grainReference(SIZE, { ...defaults, amount: 50, grainType: 'mono', composite: 'layer' }, clock(1))
    const values = at.map(([x, y]) => layer.output(x, y, grey)[0])
    expect(Math.abs(mean(values) - 0.5)).toBeLessThan(0.01)
  })

  it('follows Shadows, Midtones and Highlights', () => {
    const at = grid(30, 30, 9)
    const strength = (params: Record<string, number>, level: number) => {
      const r = grainReference(SIZE, { ...defaults, amount: 20, grainType: 'mono', composite: 'film', ...params }, clock(1))
      const c: [number, number, number] = [level, level, level]
      return Math.sqrt(variance(at.map(([x, y]) => Math.log2(toLinear(r.output(x, y, c))[1] / toLinear(c)[1]))))
    }
    expect(strength({ shadows: 0, midtones: 100, highlights: 0 }, 0.5)).toBeCloseTo(0.2 * 0.5, 1)
    expect(strength({ shadows: 0, midtones: 0, highlights: 100 }, 0.5)).toBeCloseTo(0.2 * 0.25, 1)
    expect(strength({ shadows: 100, midtones: 0, highlights: 0 }, 0.98)).toBeLessThan(0.01)
  })

  it('sizes its lattice pass from the finest lattice in use', () => {
    expect(latticeSize(SIZE, { ...defaults, size: 1, grainType: 'mono' })).toEqual({ width: 2 * 1924, height: 1084 })
    expect(latticeSize(SIZE, { ...defaults, size: 2, grainType: 'colour', colourAmount: 100, redSize: 50, greenSize: 100, blueSize: 100 })).toEqual({ width: 2 * 1924, height: 1084 })
    expect(latticeSize({ width: 3840, height: 2160 }, { ...defaults, size: 1, grainType: 'mono' })).toEqual({ width: 2 * 1924, height: 1084 })
  })

  it('gives every frame of a still its own render cache key', () => {
    let n = 0
    const ids = () => `g-${++n}`
    const info: MediaInfo = { container: 'png', durationSeconds: 0, bitRate: null, video: { codec: 'png', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: null, frameCount: 1, pixelFormat: 'rgba', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'pc' }, hdr: null, variableFrameRate: false, keyframeInterval: null }, audio: null } as unknown as MediaInfo
    const still: MediaItem = { id: 'm-still', name: 'still', kind: 'image', path: '/f/still.png', fingerprint: { size: 1, mtimeMs: 1, sample: 'still' }, info, binId: null, importedAt: '2026-11-02T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
    const history = new History(createProject({ name: 'Still', createId: ids }))
    history.dispatch(importMedia([still]))
    const V1 = history.state.sequence.tracks.find((t) => t.kind === 'video')!.id
    history.dispatch(placeMedia({ mediaId: 'm-still', sourceIn: 0, sourceOut: secondsToTicks(2), at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    const clipId = history.state.sequence.clips[0]!.id
    history.dispatch(addEffect([clipId], 'invert', null, ids))
    const plain = frameKeys(history.state.sequence, history.state.media, null).keys.slice(0, 50)
    expect(new Set(plain).size).toBe(1)
    history.dispatch(addEffect([clipId], 'grain', null, ids))
    const grained = frameKeys(history.state.sequence, history.state.media, null).keys.slice(0, 50)
    expect(new Set(grained).size).toBe(50)
  })
})
