import type { EffectManifest } from '../../engine/effects/types'
import shader from './shader.wgsl?raw'
import { migrateFromV1 } from './maths'

/**
 * Basic Correction (M10): white balance and exposure as gains on linear light, then tone
 * (brightness, contrast, highlights, shadows, whites, blacks) on OKLab lightness, then
 * saturation, vibrance and hue on OKLab chroma. The maths is in reference.ts and maths.ts.
 * Version 2 (4 Nov 2026) gave White Balance and the tone controls more reach: Temperature
 * ±100 is now a full blue or orange gel; version 1 values are converted so projects look the same.
 */
const basicCorrection: EffectManifest = {
  id: 'basic-correction',
  name: 'Basic Correction',
  category: 'Colour & Light',
  description: 'White balance, exposure, tone and colour: the everyday grading controls.',
  version: 2,
  colourSpace: 'linear',
  time: 'per-frame',
  params: [
    { id: 'temperature', label: 'Temperature', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'White Balance', help: 'Warmer (+) or cooler (−), along the colour of real light: +100 is a full orange (CTO) gel, about 3,500 K; −100 a full blue (CTB) gel. Brightness stays the same.' },
    { id: 'tint', label: 'Tint', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'White Balance', help: 'Towards magenta (+) or green (−): ±100 is one stop of green, a full minus-green or plus-green gel. Brightness stays the same.' },
    { id: 'exposure', label: 'Exposure', type: 'number', default: 0, min: -5, max: 5, unit: ' stops', decimals: 2, group: 'Tone', help: 'Light in stops: +1 doubles it, −1 halves it, as opening the lens would.' },
    { id: 'brightness', label: 'Brightness', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'Tone', help: 'Lifts or lowers the midtones; black and white stay put.' },
    { id: 'contrast', label: 'Contrast', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'Tone', help: 'Pushes tones away from middle grey (+) or towards it (−).' },
    { id: 'highlights', label: 'Highlights', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'Tone', help: 'The brighter tones, most around two thirds up; black and white stay put.' },
    { id: 'shadows', label: 'Shadows', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'Tone', help: 'The darker tones, most around a third up; black and white stay put.' },
    { id: 'whites', label: 'Whites', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'Tone', help: 'The very brightest tones: above 0 they go past white and clip; below 0 white turns grey.' },
    { id: 'blacks', label: 'Blacks', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'Tone', help: 'The very darkest tones: above 0 black lifts to grey; below 0 the darks crush to black.' },
    { id: 'saturation', label: 'Saturation', type: 'number', default: 100, min: 0, max: 200, unit: '%', decimals: 1, group: 'Colour', help: '0% is black and white; 200% doubles every colour.' },
    { id: 'vibrance', label: 'Vibrance', type: 'number', default: 0, min: -100, max: 100, decimals: 1, group: 'Colour', help: 'Saturation that works most on dull colours and spares skin tones.' },
    { id: 'hue', label: 'Hue', type: 'angle', default: 0, group: 'Colour', help: 'Turns every colour around the colour wheel (red towards yellow for +).' }
  ],
  shader,
  migrateValue: (param, value, from) => (from < 2 ? migrateFromV1(param, value) : value)
}

export default basicCorrection
