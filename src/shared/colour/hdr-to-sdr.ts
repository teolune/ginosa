/**
 * HDR (BT.2100 HLG or PQ, BT.2020 primaries) to SDR Rec.709 conversion, generated
 * as a 3D LUT (.cube). Used for optimised copies (FFmpeg's lut3d filter) because
 * this Mac's FFmpeg has no zscale; the same maths will serve the GPU colour
 * pipeline in M4.
 *
 * Steps: decode to display light (HLG: inverse OETF + OOTF at 1000 nits; PQ: EOTF),
 * scale so HDR reference white (203 nits) = 1.0, compress highlights above 0.75
 * on luminance (keeps hue), convert BT.2020 → BT.709 primaries, clip, encode for
 * an SDR display (gamma 2.4).
 */

export type HdrTransfer = 'hlg' | 'pq'

const HLG_A = 0.17883277
const HLG_B = 1 - 4 * HLG_A
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A)
const REFERENCE_WHITE_NITS = 203
const HLG_PEAK_NITS = 1000
const KNEE = 0.75

const BT2020_TO_BT709 = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187]
] as const

function hlgInverseOetf(e: number): number {
  return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HLG_C) / HLG_A) + HLG_B) / 12
}

function pqEotfNits(e: number): number {
  const m1 = 2610 / 16384
  const m2 = (2523 / 4096) * 128
  const c1 = 3424 / 4096
  const c2 = (2413 / 4096) * 32
  const c3 = (2392 / 4096) * 32
  const p = Math.pow(Math.max(e, 0), 1 / m2)
  return 10_000 * Math.pow(Math.max(p - c1, 0) / (c2 - c3 * p), 1 / m1)
}

const luma2020 = (r: number, g: number, b: number) => 0.2627 * r + 0.678 * g + 0.0593 * b

/** Highlight roll-off: identity up to the knee, then an asymptote at 1.0 with matching slope. */
export function rollOff(y: number): number {
  if (y <= KNEE) return y
  return KNEE + (1 - KNEE) * (1 - Math.exp(-(y - KNEE) / (1 - KNEE)))
}

/** Converts one non-linear BT.2020 HDR RGB triple (0..1) to non-linear Rec.709 SDR RGB (0..1). */
export function hdrToSdr(rgb: readonly [number, number, number], transfer: HdrTransfer): [number, number, number] {
  let linear: number[]
  if (transfer === 'hlg') {
    const scene = rgb.map(hlgInverseOetf)
    const ys = luma2020(scene[0]!, scene[1]!, scene[2]!)
    const gain = HLG_PEAK_NITS * Math.pow(Math.max(ys, 1e-9), 0.2)
    linear = scene.map((v) => (v * gain) / REFERENCE_WHITE_NITS)
  } else {
    linear = rgb.map((v) => pqEotfNits(v) / REFERENCE_WHITE_NITS)
  }
  const y = luma2020(linear[0]!, linear[1]!, linear[2]!)
  const scale = y > 0 ? rollOff(y) / y : 0
  const toned = linear.map((v) => v * scale)
  const out = BT2020_TO_BT709.map((row) => row[0] * toned[0]! + row[1] * toned[1]! + row[2] * toned[2]!)
  return out.map((v) => Math.pow(Math.min(Math.max(v, 0), 1), 1 / 2.4)) as [number, number, number]
}

/** A .cube file (red varies fastest), as FFmpeg's lut3d and most grading tools expect. */
export function hdrToSdrCube(transfer: HdrTransfer, size = 33): string {
  const lines = [
    `TITLE "ginosa ${transfer.toUpperCase()} BT.2020 to Rec.709 SDR"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0'
  ]
  const max = size - 1
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = hdrToSdr([r / max, g / max, b / max], transfer)
        lines.push(out.map((v) => v.toFixed(6)).join(' '))
      }
    }
  }
  return `${lines.join('\n')}\n`
}
