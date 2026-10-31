import type { EffectManifest } from '../../engine/effects/types'
import shader from './shader.wgsl?raw'

/** Invert: a smooth fade from the original to its negative, per channel or in perceptual terms. */
const invert: EffectManifest = {
  id: 'invert',
  name: 'Invert',
  category: 'Colour',
  description: 'Turns the picture (or one aspect of it) into its negative.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  params: [
    { id: 'amount', label: 'Amount', type: 'number', default: 100, min: 0, max: 100, unit: '%', decimals: 1 },
    {
      id: 'channel',
      label: 'Channel',
      type: 'choice',
      default: 'rgb',
      options: [
        { id: 'rgb', label: 'RGB' },
        { id: 'red', label: 'Red' },
        { id: 'green', label: 'Green' },
        { id: 'blue', label: 'Blue' },
        { id: 'luminance', label: 'Luminance only' },
        { id: 'hue', label: 'Hue only' },
        { id: 'chroma', label: 'Chroma only' }
      ],
      help: 'Luminance only flips lightness and keeps colour; Hue only turns hues 180°; Chroma only flips colour and keeps lightness.'
    },
    {
      id: 'space',
      label: 'Space',
      type: 'choice',
      default: 'display',
      options: [
        { id: 'display', label: 'Display (Photoshop look)' },
        { id: 'linear', label: 'Linear light' }
      ],
      help: 'For RGB and single channels. Linear light gives a harsher negative.'
    }
  ],
  shader
}

export default invert
