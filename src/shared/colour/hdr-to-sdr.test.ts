import { describe, expect, it } from 'vitest'
import { hdrToSdr, hdrToSdrCube, rollOff } from './hdr-to-sdr'

describe('HDR to SDR', () => {
  it('maps HLG reference white (75% signal, 203 nits) to bright but unclipped SDR white', () => {
    const [r, g, b] = hdrToSdr([0.75, 0.75, 0.75], 'hlg')
    expect(r).toBeGreaterThan(0.9)
    expect(r).toBeLessThan(1)
    expect(g).toBeCloseTo(r, 3)
    expect(b).toBeCloseTo(r, 3)
  })

  it('maps PQ 203 nits (signal 0.58) close to the same place as HLG reference white', () => {
    const hlg = hdrToSdr([0.75, 0.75, 0.75], 'hlg')[0]
    const pq = hdrToSdr([0.5807, 0.5807, 0.5807], 'pq')[0]
    expect(Math.abs(hlg - pq)).toBeLessThan(0.02)
  })

  it('keeps black black and greys neutral', () => {
    expect(hdrToSdr([0, 0, 0], 'hlg')).toEqual([0, 0, 0])
    for (const v of [0.1, 0.3, 0.5, 0.9]) {
      const [r, g, b] = hdrToSdr([v, v, v], 'pq')
      expect(Math.abs(r - g)).toBeLessThan(1e-3)
      expect(Math.abs(g - b)).toBeLessThan(1e-3)
    }
  })

  it('never exceeds SDR range, even for the brightest HDR', () => {
    for (const transfer of ['hlg', 'pq'] as const) {
      for (const out of [hdrToSdr([1, 1, 1], transfer), hdrToSdr([1, 0, 0], transfer), hdrToSdr([0, 1, 0.2], transfer)]) {
        for (const v of out) {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('gets brighter as the input gets brighter (no inversions)', () => {
    let previous = -1
    for (let i = 0; i <= 64; i++) {
      const v = hdrToSdr([i / 64, i / 64, i / 64], 'pq')[0]
      expect(v).toBeGreaterThanOrEqual(previous)
      previous = v
    }
  })

  it('rolls off smoothly above the knee', () => {
    expect(rollOff(0.5)).toBe(0.5)
    expect(rollOff(0.76)).toBeCloseTo(0.76, 2)
    expect(rollOff(100)).toBeLessThanOrEqual(1)
  })

  it('writes a valid 33-point .cube', () => {
    const cube = hdrToSdrCube('hlg')
    const lines = cube.trim().split('\n')
    expect(lines).toContain('LUT_3D_SIZE 33')
    expect(lines.filter((line) => /^[\d.]+ [\d.]+ [\d.]+$/.test(line))).toHaveLength(33 ** 3)
  })
})
