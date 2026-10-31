import type { EffectManifest } from '../../engine/effects/types'
import shader from './shader.wgsl?raw'

/**
 * Transform: the clip's Motion controls as an effect, so it works on adjustment layers
 * and anywhere in a stack. Positions are in pixels of the image the effect sees (the
 * clip's own pixels in a clip stack; the sequence frame on an adjustment layer).
 */
const transform: EffectManifest = {
  id: 'transform',
  name: 'Transform',
  category: 'Distort',
  description: 'Moves, scales and rotates the picture, with a choice of what fills the uncovered area.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  params: [
    { id: 'position', label: 'Position', type: 'point', default: [0.5, 0.5] },
    { id: 'scale', label: 'Scale', type: 'number', default: 100, min: 0, max: 10000, unit: '%', decimals: 1 },
    { id: 'scaleWidth', label: 'Scale Width', type: 'number', default: 100, min: 0, max: 10000, unit: '%', decimals: 1 },
    { id: 'rotation', label: 'Rotation', type: 'angle', default: 0 },
    { id: 'anchor', label: 'Anchor Point', type: 'point', default: [0.5, 0.5] },
    { id: 'opacity', label: 'Opacity', type: 'number', default: 100, min: 0, max: 100, unit: '%', decimals: 1 },
    {
      id: 'edges',
      label: 'Edges',
      type: 'choice',
      default: 'transparent',
      options: [
        { id: 'transparent', label: 'Transparent' },
        { id: 'repeat', label: 'Repeat edge pixels' },
        { id: 'mirror', label: 'Mirror' },
        { id: 'tile', label: 'Tile' }
      ]
    },
    {
      id: 'sampling',
      label: 'Sampling',
      type: 'choice',
      default: 'smooth',
      options: [
        { id: 'smooth', label: 'Smooth' },
        { id: 'sharp', label: 'Sharp' },
        { id: 'nearest', label: 'Nearest pixel' }
      ]
    }
  ],
  shader
}

export default transform
