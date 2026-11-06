import type { EffectManifest } from '../../engine/effects/types'
import { DEFAULT_GRADIENT_TEXT, formatGradient, GRADIENT_METHODS, starterGradients } from '../../engine/gradients/gradient'
import shader from './shader.wgsl?raw'

/**
 * Gradient Map (M13): each pixel's brightness picks a colour from a gradient, as in
 * Photoshop. Brightness is Photoshop's (0.30 R + 0.59 G + 0.11 B on display values); the
 * gradient is drawn the Classic, Perceptual, Linear or Smooth way (engine/gradients/evaluate.ts)
 * and baked into a 4096-entry table. Beyond Photoshop: Input Range, Offset and Repeat (palette
 * cycling and contour bands), a second gradient to morph to, and, if you want them, opacity
 * stops that let the picture show through (Photoshop's Gradient Map ignores them).
 */
const gradientMap: EffectManifest = {
  id: 'gradient-map',
  name: 'Gradient Map',
  category: 'Colour & Light',
  description: 'Maps the picture’s tones to the colours of a gradient, as Photoshop’s Gradient Map does.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  params: [
    { id: 'gradient', label: 'Gradient', type: 'gradient', default: DEFAULT_GRADIENT_TEXT, methodParam: 'method', help: 'Shadows take the colours on the left, highlights those on the right. Click to edit; the menu picks one from the library.' },
    { id: 'method', label: 'Method', type: 'choice', default: 'classic', options: GRADIENT_METHODS, help: 'How colours blend between stops. Classic is Photoshop’s original (and what older presets were made for); Perceptual and Smooth blend in OKLab; Linear in linear light.' },
    { id: 'reverse', label: 'Reverse', type: 'toggle', default: false },
    { id: 'dither', label: 'Dither', type: 'toggle', default: false, help: 'Adds a faint fixed noise (±1 level) to hide banding in smooth gradients.' },
    { id: 'inputBlack', label: 'Input Black', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Input Range', help: 'Tones at or below this take the gradient’s left end.' },
    { id: 'inputWhite', label: 'Input White', type: 'number', default: 100, min: 0, max: 100, unit: '%', decimals: 1, group: 'Input Range', help: 'Tones at or above this take the gradient’s right end. Below Input Black, the gradient runs backwards.' },
    { id: 'offset', label: 'Offset', type: 'number', default: 0, min: -100, max: 100, unit: '%', decimals: 1, group: 'Cycle', help: 'Slides the gradient along the tones. Link it to the bass with Edges on Wrap for palette cycling.' },
    { id: 'repeat', label: 'Repeat', type: 'number', default: 1, min: 1, max: 16, decimals: 2, group: 'Cycle', help: 'Runs the gradient this many times across the tones, for contour bands.' },
    {
      id: 'edges',
      label: 'Edges',
      type: 'choice',
      default: 'wrap',
      group: 'Cycle',
      options: [
        { id: 'wrap', label: 'Wrap' },
        { id: 'mirror', label: 'Mirror' },
        { id: 'clamp', label: 'Clamp' }
      ],
      help: 'What happens past the gradient’s ends when Offset or Repeat push the tones there: start again, run back, or hold the end colour.'
    },
    { id: 'gradientB', label: 'Gradient B', type: 'gradient', default: formatGradient(starterGradients()[2]!), methodParam: 'method', group: 'Morph' },
    { id: 'morph', label: 'Morph', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Morph', help: 'Blends from Gradient (0%) to Gradient B (100%). Keyframe or link it to animate between them.' },
    { id: 'opacityStops', label: 'Use Opacity Stops', type: 'toggle', default: false, help: 'Photoshop’s Gradient Map ignores opacity stops. Turn this on to let the picture show through where the gradient is transparent.' }
  ],
  closedGroups: ['Cycle', 'Morph'],
  shader
}

export default gradientMap
