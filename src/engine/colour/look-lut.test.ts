import { describe, expect, it } from 'vitest'
import { parseCube, sampleCube } from './cube'
import { cubeAt, lookLutFiles, lookReference, ONE_D_CUBE_SIZE, unitCube } from './look-lut'
import type { Sequence } from '../project/model'

const cube3d = (n: number, f: (r: number, g: number, b: number) => number[], extra = '') => {
  const lines = [`LUT_3D_SIZE ${n}`, extra]
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).join(' '))
  return parseCube(lines.join('\n'))
}

describe('look LUTs', () => {
  it('uses a 0–1 cube as it is, and resamples 1D LUTs and other domains into one', () => {
    const plain = cube3d(5, (r, g, b) => [b, g, r])
    expect(unitCube(plain).data).toBe(plain.data)
    const lines = ['LUT_1D_SIZE 256']
    for (let i = 0; i < 256; i++) lines.push([0, 1, 2].map((k) => ((i / 255) ** (1 + k * 0.5)).toFixed(6)).join(' '))
    const oneD = parseCube(lines.join('\n'))
    const asCube = unitCube(oneD)
    expect(asCube.size).toBe(ONE_D_CUBE_SIZE)
    // Exact at the lattice points, close between them.
    for (const v of [0, 16 / 64, 0.5, 1]) cubeAt(asCube, [v, v, v]).forEach((x, k) => expect(x).toBeCloseTo(sampleCube(oneD, [v, v, v])[k]!, 6))
    for (const v of [0.13, 0.61, 0.97]) cubeAt(asCube, [v, 0.3, 0.8]).forEach((x, k) => expect(Math.abs(x - sampleCube(oneD, [v, 0.3, 0.8])[k]!)).toBeLessThan(0.002))
    const domain = cube3d(9, (r, g, b) => [r, g, b], 'DOMAIN_MIN 0.2 0.2 0.2\nDOMAIN_MAX 0.8 0.8 0.8')
    const resampled = unitCube(domain)
    for (const v of [0, 0.1, 0.35, 0.9]) cubeAt(resampled, [v, v, v]).forEach((x, k) => expect(x).toBeCloseTo(sampleCube(domain, [v, v, v])[k]!, 5))
  })

  it('scales the LUT’s change by Strength and keeps light past white', () => {
    const cube = unitCube(cube3d(9, (r, g, b) => [r * 0.5, g, 1 - b]))
    const c: [number, number, number] = [0.6, 0.4, 0.2]
    expect(lookReference(cube, c, 0)).toEqual(c)
    lookReference(cube, c, 100).forEach((v, k) => expect(v).toBeCloseTo([0.3, 0.4, 0.8][k]!, 9))
    lookReference(cube, c, 50).forEach((v, k) => expect(v).toBeCloseTo([0.45, 0.4, 0.5][k]!, 9))
    lookReference(cube, c, 200).forEach((v, k) => expect(v).toBeCloseTo([0, 0.4, 1.4][k]!, 9))
    // 1.3 is white (1) plus 0.3: the LUT's white, plus 0.3.
    expect(lookReference(cube, [1.3, 1, 1], 100)[0]).toBeCloseTo(0.5 + 0.3, 9)
    expect(lookReference(null, c, 100)).toEqual(c)
  })

  it('lists the LUT files a sequence uses, from values and keyframes', () => {
    const effect = (lut: string, keyframes: string[] = [], enabled = true) => ({ effectId: 'look-lut', enabled, params: { lut, strength: 100 }, keyframes: keyframes.length ? { lut: keyframes.map((value, i) => ({ id: `k${i}`, time: i, value })) } : {} })
    const sequence = { clips: [{ effects: [effect('luts/A.cube'), effect('', ['luts/B.cube', 'luts/A.cube'])] }, { effects: [effect('luts/C.cube', [], false), { effectId: 'invert', enabled: true, params: {}, keyframes: {} }] }] } as unknown as Sequence
    expect(lookLutFiles(sequence).sort()).toEqual(['luts/A.cube', 'luts/B.cube'])
  })
})
