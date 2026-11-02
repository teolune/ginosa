import type { EffectManifest } from '../../engine/effects/types'
import shader from './shader.wgsl?raw'

/**
 * Levels (M10), as Photoshop's: input black and white points, a midtone gamma, and output
 * black and white points, in 0–255 steps on display values; each channel first, then RGB.
 */
const levels: EffectManifest = {
  id: 'levels',
  name: 'Levels',
  category: 'Colour & Light',
  description: 'Sets the black point, white point and midtones, for all channels or each one.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  params: [
    { id: 'inBlack', label: 'Input Black', type: 'number', default: 0, min: 0, max: 255, decimals: 1, group: 'RGB', help: 'All three channels together, after the channel levels.' },
    { id: 'inWhite', label: 'Input White', type: 'number', default: 255, min: 0, max: 255, decimals: 1, group: 'RGB' },
    { id: 'gamma', label: 'Gamma', type: 'number', default: 1, min: 0.1, max: 9.99, decimals: 2, group: 'RGB', help: 'Over 1 brightens the midtones, under 1 darkens them.' },
    { id: 'outBlack', label: 'Output Black', type: 'number', default: 0, min: 0, max: 255, decimals: 1, group: 'RGB' },
    { id: 'outWhite', label: 'Output White', type: 'number', default: 255, min: 0, max: 255, decimals: 1, group: 'RGB' },
    { id: 'redInBlack', label: 'Input Black', type: 'number', default: 0, min: 0, max: 255, decimals: 1, group: 'Red' },
    { id: 'redInWhite', label: 'Input White', type: 'number', default: 255, min: 0, max: 255, decimals: 1, group: 'Red' },
    { id: 'redGamma', label: 'Gamma', type: 'number', default: 1, min: 0.1, max: 9.99, decimals: 2, group: 'Red', help: 'Over 1 brightens the midtones, under 1 darkens them.' },
    { id: 'redOutBlack', label: 'Output Black', type: 'number', default: 0, min: 0, max: 255, decimals: 1, group: 'Red' },
    { id: 'redOutWhite', label: 'Output White', type: 'number', default: 255, min: 0, max: 255, decimals: 1, group: 'Red' },
    { id: 'greenInBlack', label: 'Input Black', type: 'number', default: 0, min: 0, max: 255, decimals: 1, group: 'Green' },
    { id: 'greenInWhite', label: 'Input White', type: 'number', default: 255, min: 0, max: 255, decimals: 1, group: 'Green' },
    { id: 'greenGamma', label: 'Gamma', type: 'number', default: 1, min: 0.1, max: 9.99, decimals: 2, group: 'Green', help: 'Over 1 brightens the midtones, under 1 darkens them.' },
    { id: 'greenOutBlack', label: 'Output Black', type: 'number', default: 0, min: 0, max: 255, decimals: 1, group: 'Green' },
    { id: 'greenOutWhite', label: 'Output White', type: 'number', default: 255, min: 0, max: 255, decimals: 1, group: 'Green' },
    { id: 'blueInBlack', label: 'Input Black', type: 'number', default: 0, min: 0, max: 255, decimals: 1, group: 'Blue' },
    { id: 'blueInWhite', label: 'Input White', type: 'number', default: 255, min: 0, max: 255, decimals: 1, group: 'Blue' },
    { id: 'blueGamma', label: 'Gamma', type: 'number', default: 1, min: 0.1, max: 9.99, decimals: 2, group: 'Blue', help: 'Over 1 brightens the midtones, under 1 darkens them.' },
    { id: 'blueOutBlack', label: 'Output Black', type: 'number', default: 0, min: 0, max: 255, decimals: 1, group: 'Blue' },
    { id: 'blueOutWhite', label: 'Output White', type: 'number', default: 255, min: 0, max: 255, decimals: 1, group: 'Blue' },
  ],
  closedGroups: ['Red', 'Green', 'Blue'],
  shader
}

export default levels
