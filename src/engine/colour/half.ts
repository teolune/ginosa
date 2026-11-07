/**
 * Numbers as 16-bit floats (the GPU's rgba16float), rounded to nearest. Used for LUT textures.
 *
 * Fixed 6 Nov 2026: rounding a mantissa up past its top used to OR the carry into the exponent
 * instead of adding it, so values just under 0.5, 0.125 or 2 (an odd exponent) came out halved
 * (0.49995 became 0.25). That showed as dark specks in LUTs with values just under 0.5.
 */
export function toHalf(value: number): number {
  const f = new Float32Array([value])
  const x = new Uint32Array(f.buffer)[0]!
  const sign = (x >>> 16) & 0x8000
  const exp = ((x >>> 23) & 0xff) - 127 + 15
  let mant = x & 0x7fffff
  if (Number.isNaN(value)) return sign | 0x7e00
  if (exp <= 0) {
    if (exp < -10) return sign
    mant = (mant | 0x800000) >> (1 - exp)
    // A subnormal that rounds up into the smallest normal carries into the exponent too.
    return sign | ((mant + 0x1000) >> 13)
  }
  if (exp >= 31) return sign | 0x7c00
  // The rounded mantissa can carry into the exponent: add, don't OR (a carry to 31 is infinity).
  return sign | Math.min(0x7c00, (exp << 10) + ((mant + 0x1000) >> 13))
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}
