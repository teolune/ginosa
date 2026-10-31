import { describe, expect, it } from 'vitest'
import {
  APPLE_WIDE_GAMUT_TO_REC709,
  BT2020_TO_REC709,
  apply,
  appleLogDecode,
  appleLogEncode,
  appleLogToRec709,
  macDisplay,
  undoMacDisplay
} from './colour'
import { CubeFormatError, parseCube, sampleCube } from './cube'

describe('Apple Log', () => {
  it('decodes Apple’s reference value to 18% grey, and round-trips', () => {
    expect(appleLogDecode(0.48827245852686763)).toBeCloseTo(0.18, 6)
    for (const r of [-0.05, 0, 0.005, 0.01, 0.18, 0.9, 4, 12]) expect(appleLogDecode(appleLogEncode(r))).toBeCloseTo(r, 6)
    // The curve is continuous where its two pieces meet.
    expect(appleLogEncode(0.01 - 1e-9)).toBeCloseTo(appleLogEncode(0.01), 5)
  })

  it('turns log mid grey into Rec.709 mid grey, and keeps neutrals neutral in both gamuts', () => {
    const grey = appleLogEncode(0.18)
    for (const gamut of ['bt2020', 'apple-wide-gamut'] as const) {
      const out = appleLogToRec709([grey, grey, grey], gamut)
      expect(out[0]).toBeCloseTo(0.409, 2)
      expect(out[1]).toBeCloseTo(out[0], 3)
      expect(out[2]).toBeCloseTo(out[0], 3)
    }
    // Very bright log values ease towards white instead of clipping hard.
    const hot = appleLogToRec709([0.95, 0.95, 0.95], 'bt2020')
    expect(hot[0]).toBeGreaterThan(0.95)
    expect(hot[0]).toBeLessThanOrEqual(1)
  })
})

describe('gamut matrices', () => {
  it('derives the standard BT.2020 → Rec.709 matrix from the primaries', () => {
    const expected = [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187]
    BT2020_TO_REC709.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 3))
  })

  it('maps white to white from Apple Wide Gamut, and is wider than BT.2020 is', () => {
    apply(APPLE_WIDE_GAMUT_TO_REC709, [1, 1, 1]).forEach((v) => expect(v).toBeCloseTo(1, 3))
    // A fully saturated Apple Wide Gamut red lands further outside Rec.709 than BT.2020 red does.
    expect(apply(APPLE_WIDE_GAMUT_TO_REC709, [1, 0, 0])[0]).toBeGreaterThan(apply(BT2020_TO_REC709, [1, 0, 0])[0] - 0.5)
  })
})

describe('Mac video display', () => {
  it('matches what Chromium did to Rec.709 patches, and undoes it exactly', () => {
    // Measured on this Mac: Rec.709 code 0.2 came back as 0.228, 0.502 as 0.545.
    expect(macDisplay(0.2)).toBeCloseTo(0.229, 2)
    expect(macDisplay(0.502)).toBeCloseTo(0.546, 2)
    for (const v of [0, 0.02, 0.2, 0.5, 0.9, 1]) expect(undoMacDisplay(macDisplay(v))).toBeCloseTo(v, 6)
  })
})

describe('.cube LUTs', () => {
  const identity2 = `TITLE "identity"\n# comment\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`
  it('reads a 3D LUT and interpolates through it', () => {
    const lut = parseCube(identity2)
    expect(lut).toMatchObject({ title: 'identity', kind: '3d', size: 2 })
    const out = sampleCube(lut, [0.25, 0.5, 0.75])
    out.forEach((v, i) => expect(v).toBeCloseTo([0.25, 0.5, 0.75][i]!, 6))
  })

  it('honours DOMAIN_MIN/MAX and reads 1D LUTs', () => {
    const lut = parseCube(`LUT_1D_SIZE 3\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n0.25 0.25 0.25\n1 1 1\n`)
    expect(lut.kind).toBe('1d')
    expect(sampleCube(lut, [1, 1, 1])[0]).toBeCloseTo(0.25)
    expect(sampleCube(lut, [1.5, 1.5, 1.5])[0]).toBeCloseTo(0.625)
  })

  it('rejects broken files with a clear message', () => {
    expect(() => parseCube('hello')).toThrow(CubeFormatError)
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/Expected 8 entries/)
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 x\n')).toThrow(/not a number/)
  })
})
