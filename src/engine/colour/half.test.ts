import { describe, expect, it } from 'vitest'
import { fromHalf, toHalf } from './half'

describe('half floats', () => {
  it('rounds to the nearest half float, carrying into the exponent', () => {
    for (const v of [0, 1, -1, 0.5, 0.25, 0.1, 0.333, 0.75, 1.5, 3.14159, 1000, 2 ** -14, 2 ** -20, 65504]) {
      const back = fromHalf(toHalf(v))
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(Math.abs(v) * 2 ** -11, 2 ** -25))
    }
    // Just under a power of two rounds up to it (these came out halved before the fix).
    expect(fromHalf(toHalf(0.499931))).toBe(0.5)
    expect(fromHalf(toHalf(0.1249999))).toBe(0.125)
    expect(fromHalf(toHalf(1.99999))).toBe(2)
    expect(fromHalf(toHalf(0.99999))).toBe(1)
    expect(fromHalf(toHalf(70000))).toBe(Infinity)
    // Every half float survives the round trip.
    for (let h = 0; h < 0x7c00; h += 7) expect(toHalf(fromHalf(h))).toBe(h)
  })
})
