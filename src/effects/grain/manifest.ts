import type { EffectManifest } from '../../engine/effects/types'
import grain from './grain.wgsl?raw'
import lattice from './lattice.wgsl?raw'
import { latticeSize } from './maths'
import { GRAIN_NOTES, NOTES_WGSL } from './notes'
import shader from './shader.wgsl?raw'

/**
 * Grain (M11): film grain or sensor noise, generated on the GPU from Gaussian noise seeded by
 * the frame (so playback, stills, the render cache and export all agree). A pass computes
 * the noise on a lattice sized relative to the picture's height; the main pass interpolates
 * it, weights it by brightness and composites it. The maths is in maths.ts.
 */
const common = NOTES_WGSL + grain

const grainEffect: EffectManifest = {
  id: 'grain',
  name: 'Grain',
  category: 'Noise & Grain',
  description: 'Film grain or digital sensor noise that changes every frame, on a refresh rate or on the beat.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  readsClock: true,
  params: [
    { id: 'amount', label: 'Amount', type: 'number', default: 15, min: 0, max: 100, unit: '%', decimals: 1, group: 'Grain', help: 'How strong the grain is. In Film, 100% moves the light by about a stop either way.' },
    { id: 'size', label: 'Size', type: 'number', default: 1.2, min: 0.5, max: 8, decimals: 2, group: 'Grain', help: 'Grain size in pixels of a 1080-line picture. It scales with the picture, so it looks the same at any resolution or playback quality.' },
    { id: 'softness', label: 'Softness', type: 'number', default: 40, min: 0, max: 100, unit: '%', decimals: 1, group: 'Grain', help: '0% gives crisp, sandy grain; 100% soft, rounded grain.' },
    {
      id: 'composite',
      label: 'Composite',
      type: 'choice',
      default: 'film',
      options: [
        { id: 'film', label: 'Film (density)' },
        { id: 'digital', label: 'Digital (sensor noise)' },
        { id: 'layer', label: 'Grain layer (use Blend Mode)' }
      ],
      group: 'Grain',
      help: 'Film changes the light by a share of itself, as emulsion density does: little grain in deep black. Digital adds noise that grows with the square root of the light, as a camera sensor does, so shadows stay noisy. Grain layer outputs grey grain for the Blend Mode above (Overlay or Soft Light).'
    },
    {
      id: 'grainType',
      label: 'Type',
      type: 'choice',
      default: 'colour',
      options: [
        { id: 'mono', label: 'Monochrome' },
        { id: 'colour', label: 'Colour' }
      ],
      group: 'Colour'
    },
    { id: 'colourAmount', label: 'Colour Amount', type: 'number', default: 40, min: 0, max: 100, unit: '%', decimals: 1, group: 'Colour', showIf: { param: 'grainType', is: ['colour'] }, help: 'How independent the red, green and blue grain are: 0% is the same as Monochrome.' },
    { id: 'redSize', label: 'Red Size', type: 'number', default: 100, min: 50, max: 300, unit: '%', decimals: 1, group: 'Colour', showIf: { param: 'grainType', is: ['colour'] } },
    { id: 'greenSize', label: 'Green Size', type: 'number', default: 100, min: 50, max: 300, unit: '%', decimals: 1, group: 'Colour', showIf: { param: 'grainType', is: ['colour'] } },
    { id: 'blueSize', label: 'Blue Size', type: 'number', default: 130, min: 50, max: 300, unit: '%', decimals: 1, group: 'Colour', showIf: { param: 'grainType', is: ['colour'] }, help: 'Film’s blue-sensitive layer has the coarsest grain.' },
    { id: 'shadows', label: 'Shadows', type: 'number', default: 70, min: 0, max: 200, unit: '%', decimals: 1, group: 'Response', help: 'Grain strength in the darks.' },
    { id: 'midtones', label: 'Midtones', type: 'number', default: 100, min: 0, max: 200, unit: '%', decimals: 1, group: 'Response', help: 'Grain strength in the middle tones (where film grain shows most).' },
    { id: 'highlights', label: 'Highlights', type: 'number', default: 50, min: 0, max: 200, unit: '%', decimals: 1, group: 'Response', help: 'Grain strength in the brights.' },
    {
      id: 'refresh',
      label: 'Refresh',
      type: 'choice',
      default: 'frame',
      options: [
        { id: 'frame', label: 'Every frame' },
        { id: 'frames', label: 'Every N frames' },
        { id: 'note', label: 'On a note value' }
      ],
      group: 'Time',
      help: 'When a new grain pattern is drawn. On a note value follows the beat grid (Audio Analysis), each change landing on the nearest frame.'
    },
    { id: 'every', label: 'Every N Frames', type: 'number', default: 2, min: 1, max: 48, decimals: 0, group: 'Time', modulatable: false, showIf: { param: 'refresh', is: ['frames'] } },
    { id: 'note', label: 'Note', type: 'choice', default: '1/8', options: GRAIN_NOTES.map((n) => ({ id: n.id, label: n.label })), group: 'Time', showIf: { param: 'refresh', is: ['note'] } },
    { id: 'boil', label: 'Boil', type: 'number', default: 100, min: 0, max: 100, unit: '%', decimals: 1, group: 'Time', help: 'How far the grain moves on at each refresh: 100% is a completely new pattern, lower values let some carry over, 0% freezes it.' },
    { id: 'seed', label: 'Seed', type: 'number', default: 0, min: 0, max: 999, decimals: 0, group: 'Time', modulatable: false, help: 'A different seed gives different grain with the same settings.' }
  ],
  closedGroups: ['Colour', 'Response', 'Time'],
  passes: [{ shader: common + lattice, size: latticeSize }],
  shader: common + shader
}

export default grainEffect
