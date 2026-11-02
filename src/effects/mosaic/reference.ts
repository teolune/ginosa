import { toDisplay, toLinear } from '../../engine/effects/colour-spaces'
import type { ParamValue } from '../../engine/effects/types'
import { MOSAIC_BIAS, mosaicGrid } from './grid'

/** An image for the reference: straight-alpha display RGBA, 0–1, row by row. */
export interface RefImage {
  width: number
  height: number
  rgba: Float32Array
}

type Rgba = [number, number, number, number]

/**
 * The CPU version of the Mosaic passes, for tests: returns the output colour (display RGBA)
 * of pixel (x, y). Cells average premultiplied linear light, each pixel weighted by how
 * much of it the cell covers.
 */
export function mosaicReference(image: RefImage, params: Record<string, ParamValue>): (x: number, y: number) => Rgba {
  const { width: W, height: H, rgba } = image
  const load = (x: number, y: number): Rgba => {
    const i = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4
    return [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!]
  }
  const premultipliedLinear = (c: Rgba): Rgba => {
    const [r, g, b] = toLinear(c.slice(0, 3))
    return [r * c[3], g * c[3], b * c[3], c[3]]
  }
  const grid = mosaicGrid({ width: W, height: H }, params)
  if (!grid) return (x, y) => load(x, y)
  const [cw, ch] = grid.cell
  const [nx, ny] = grid.count
  const [ox, oy] = grid.origin
  const centre = params.sample === 'centre'
  const span = (start: number, c: number, i: number, size: number) => [Math.max(start + i * c, 0), Math.min(start + (i + 1) * c, size)] as const
  const cells = new Map<number, Rgba>()
  const cellColour = (i: number, j: number): Rgba => {
    i = Math.min(nx - 1, Math.max(0, i))
    j = Math.min(ny - 1, Math.max(0, j))
    const key = j * nx + i
    const known = cells.get(key)
    if (known) return known
    const [x0, x1] = span(ox, cw, i, W)
    const [y0, y1] = span(oy, ch, j, H)
    let out: Rgba = [0, 0, 0, 0]
    if (x1 > x0 && y1 > y0) {
      if (centre) out = premultipliedLinear(load(Math.floor((x0 + x1) / 2 + MOSAIC_BIAS), Math.floor((y0 + y1) / 2 + MOSAIC_BIAS)))
      else {
        const sum = [0, 0, 0, 0]
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0)
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            const w = (Math.min(x + 1, x1) - Math.max(x, x0)) * wy
            premultipliedLinear(load(x, y)).forEach((v, k) => (sum[k] = sum[k]! + v * w))
          }
        }
        const area = (x1 - x0) * (y1 - y0)
        out = sum.map((v) => v / area) as Rgba
      }
    }
    cells.set(key, out)
    return out
  }
  const s = Math.min(1, Math.max(0, Number(params.softness ?? 0) / 100))
  const weight = (t: number) => {
    if (s <= 1e-4) return t >= 0.5 ? 1 : 0
    const k = Math.min(1, Math.max(0, (t - (0.5 - s / 2)) / s))
    return k * k * (3 - 2 * k)
  }
  return (x, y) => {
    const gx = (x + 0.5 - ox + MOSAIC_BIAS) / cw - 0.5
    const gy = (y + 0.5 - oy + MOSAIC_BIAS) / ch - 0.5
    const i0 = Math.floor(gx)
    const j0 = Math.floor(gy)
    const wx = weight(gx - i0)
    const wy = weight(gy - j0)
    const c00 = cellColour(i0, j0), c10 = cellColour(i0 + 1, j0), c01 = cellColour(i0, j0 + 1), c11 = cellColour(i0 + 1, j0 + 1)
    const c = c00.map((v, k) => (v * (1 - wx) + c10[k]! * wx) * (1 - wy) + (c01[k]! * (1 - wx) + c11[k]! * wx) * wy) as Rgba
    if (c[3] <= 1e-8) return [0, 0, 0, 0]
    return [...toDisplay([c[0] / c[3], c[1] / c[3], c[2] / c[3]]), c[3]] as Rgba
  }
}
