/**
 * .cube LUT files (Adobe/Resolve format): a 3D LUT of LUT_3D_SIZE³ RGB triplets, red
 * changing fastest, with an optional DOMAIN_MIN / DOMAIN_MAX. 1D LUTs are read too.
 */

export interface CubeLut {
  title: string
  kind: '3d' | '1d'
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  /** size³ (3D) or size (1D) RGB triplets, red fastest. */
  data: Float32Array
}

export class CubeFormatError extends Error {}

export function parseCube(text: string): CubeLut {
  let title = ''
  let size3 = 0
  let size1 = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const values: number[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*/, '').trim()
    if (!line) return
    const parts = line.split(/\s+/)
    const keyword = parts[0]!.toUpperCase()
    if (keyword === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '')
    else if (keyword === 'LUT_3D_SIZE') size3 = Number(parts[1])
    else if (keyword === 'LUT_1D_SIZE') size1 = Number(parts[1])
    else if (keyword === 'DOMAIN_MIN') domainMin = parts.slice(1, 4).map(Number) as [number, number, number]
    else if (keyword === 'DOMAIN_MAX') domainMax = parts.slice(1, 4).map(Number) as [number, number, number]
    else if (keyword === 'LUT_3D_INPUT_RANGE' || keyword === 'LUT_1D_INPUT_RANGE') {
      const [lo, hi] = parts.slice(1, 3).map(Number) as [number, number]
      domainMin = [lo, lo, lo]
      domainMax = [hi, hi, hi]
    } else if (/^[-+.\d]/.test(keyword)) {
      if (parts.length < 3) throw new CubeFormatError(`Line ${index + 1}: expected three numbers`)
      for (const p of parts.slice(0, 3)) {
        const n = Number(p)
        if (!Number.isFinite(n)) throw new CubeFormatError(`Line ${index + 1}: "${p}" is not a number`)
        values.push(n)
      }
    }
    // Other keywords (e.g. LUT_IN_VIDEO_RANGE) are ignored.
  })
  const kind = size3 > 0 ? '3d' : size1 > 0 ? '1d' : null
  if (!kind) throw new CubeFormatError('Not a .cube LUT: no LUT_3D_SIZE or LUT_1D_SIZE')
  const size = kind === '3d' ? size3 : size1
  if (!Number.isInteger(size) || size < 2 || size > 256) throw new CubeFormatError(`Unsupported LUT size ${size}`)
  const expected = (kind === '3d' ? size ** 3 : size) * 3
  if (values.length !== expected) throw new CubeFormatError(`Expected ${expected / 3} entries, found ${values.length / 3}`)
  if (domainMin.some((v, i) => !(domainMax[i]! > v))) throw new CubeFormatError('DOMAIN_MAX must be above DOMAIN_MIN')
  return { title, kind, size, domainMin, domainMax, data: Float32Array.from(values) }
}

/** Looks up a colour with trilinear interpolation (reference implementation for tests). */
export function sampleCube(lut: CubeLut, rgb: [number, number, number]): [number, number, number] {
  const n = lut.size
  const t = rgb.map((v, i) => Math.min(1, Math.max(0, (v - lut.domainMin[i]!) / (lut.domainMax[i]! - lut.domainMin[i]!))) * (n - 1))
  if (lut.kind === '1d') {
    return [0, 1, 2].map((c) => {
      const i0 = Math.floor(t[c]!)
      const i1 = Math.min(n - 1, i0 + 1)
      const f = t[c]! - i0
      return lut.data[i0 * 3 + c]! * (1 - f) + lut.data[i1 * 3 + c]! * f
    }) as [number, number, number]
  }
  const [r, g, b] = t as [number, number, number]
  const r0 = Math.floor(r), g0 = Math.floor(g), b0 = Math.floor(b)
  const r1 = Math.min(n - 1, r0 + 1), g1 = Math.min(n - 1, g0 + 1), b1 = Math.min(n - 1, b0 + 1)
  const fr = r - r0, fg = g - g0, fb = b - b0
  const at = (ri: number, gi: number, bi: number, c: number) => lut.data[(bi * n * n + gi * n + ri) * 3 + c]!
  return [0, 1, 2].map((c) => {
    const c00 = at(r0, g0, b0, c) * (1 - fr) + at(r1, g0, b0, c) * fr
    const c10 = at(r0, g1, b0, c) * (1 - fr) + at(r1, g1, b0, c) * fr
    const c01 = at(r0, g0, b1, c) * (1 - fr) + at(r1, g0, b1, c) * fr
    const c11 = at(r0, g1, b1, c) * (1 - fr) + at(r1, g1, b1, c) * fr
    return (c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb
  }) as [number, number, number]
}
