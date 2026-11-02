import type { EffectManifest } from '../../engine/effects/types'
import cells from './cells.wgsl?raw'
import { mosaicCellsSize, mosaicRowsSize } from './grid'
import grid from './grid.wgsl?raw'
import rows from './rows.wgsl?raw'
import shader from './shader.wgsl?raw'

/**
 * Mosaic (M10): the picture as a grid of flat cells, each the average of the light under it
 * (or its centre pixel), optionally with soft edges. The average is exact at any cell size
 * and done in two passes, rows then cells (so each is a short loop); the main pass draws.
 */
const mosaic: EffectManifest = {
  id: 'mosaic',
  name: 'Mosaic',
  category: 'Stylize',
  description: 'Turns the picture into big flat blocks, each the colour of what is under it.',
  version: 1,
  colourSpace: 'linear',
  time: 'per-frame',
  params: [
    { id: 'cellSize', label: 'Cell Size', type: 'number', default: 5, min: 0, max: 100, unit: '%', decimals: 2, help: 'Height of a cell, as a share of the picture’s height (so it looks the same at any resolution). Under a pixel, the effect is off.' },
    { id: 'aspect', label: 'Cell Aspect', type: 'number', default: 1, min: 0.25, max: 4, decimals: 2, help: 'Cell width divided by height: 1 is square, 2 twice as wide as tall.' },
    {
      id: 'sample',
      label: 'Colour',
      type: 'choice',
      default: 'average',
      options: [
        { id: 'average', label: 'Average of the cell' },
        { id: 'centre', label: 'Centre pixel' }
      ],
      help: 'Average mixes all the light in each cell (as in Premiere and After Effects); Centre pixel keeps colours crisp but flickers on moving footage.'
    },
    { id: 'softness', label: 'Edge Softness', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, help: '0% gives hard-edged blocks; 100% blends smoothly from each cell’s centre to the next.' }
  ],
  passes: [
    { shader: grid + rows, size: mosaicRowsSize },
    { shader: grid + cells, size: mosaicCellsSize }
  ],
  shader: grid + shader
}

export default mosaic
