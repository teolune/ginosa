import type { ImageSize, ParamValue } from '../../engine/effects/types'

/**
 * Mosaic's grid (shared by the manifest, which sizes the passes, and the CPU reference; the
 * WGSL in grid.wgsl works it out the same way). Cells are Cell Size % of the image's height
 * tall and Aspect × that wide (at least a pixel). There's an odd number of cells each way,
 * enough to cover the image with a pixel to spare, centred on it and snapped to whole
 * pixels (so whole-pixel cells have crisp edges). Cells under a pixel tall turn it off.
 */
export interface MosaicGrid {
  /** Cell width and height in pixels. */
  cell: [number, number]
  /** Cells across and down. */
  count: [number, number]
  /** Where cell (0, 0)'s top-left corner is, in whole pixels (usually off the image). */
  origin: [number, number]
}

/** Moves cell edges that land exactly on a pixel centre consistently onto one side (in pixels). */
export const MOSAIC_BIAS = 0.001

export function mosaicGrid(input: ImageSize, params: Record<string, ParamValue>): MosaicGrid | null {
  const h = (Number(params.cellSize ?? 5) / 100) * input.height
  if (!(h >= 1)) return null
  const cell: [number, number] = [Math.max(h * Number(params.aspect ?? 1), 1), h]
  const across = (size: number, c: number) => 2 * Math.max(0, Math.ceil((size + 1) / (2 * c) - 0.5)) + 1
  const count: [number, number] = [across(input.width, cell[0]), across(input.height, cell[1])]
  const start = (size: number, n: number, c: number) => Math.floor((size - n * c) * 0.5 + 0.5)
  return { cell, count, origin: [start(input.width, count[0], cell[0]), start(input.height, count[1], cell[1])] }
}

/** Pass 1: one value per cell column and pixel row. */
export function mosaicRowsSize(input: ImageSize, params: Record<string, ParamValue>): ImageSize {
  const grid = mosaicGrid(input, params)
  return grid ? { width: grid.count[0], height: input.height } : { width: 1, height: 1 }
}

/** Pass 2: one value per cell (1 × 1 when the effect is off). */
export function mosaicCellsSize(input: ImageSize, params: Record<string, ParamValue>): ImageSize {
  const grid = mosaicGrid(input, params)
  return grid ? { width: grid.count[0], height: grid.count[1] } : { width: 1, height: 1 }
}
