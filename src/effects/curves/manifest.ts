import { IDENTITY_CURVE } from '../../engine/effects/curves'
import type { EffectManifest } from '../../engine/effects/types'
import shader from './shader.wgsl?raw'

/**
 * Curves (M10): a curve for all three channels together (RGB) and one for each channel,
 * on display values as in Photoshop. Each channel goes through its own curve first, then
 * the RGB curve. Curves hold between keyframes (they don't morph).
 */
const curves: EffectManifest = {
  id: 'curves',
  name: 'Curves',
  category: 'Colour & Light',
  description: 'Reshapes the tones with curves: one for all channels and one for each.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  params: [
    { id: 'master', label: 'RGB', type: 'curve', default: IDENTITY_CURVE, group: 'Curves', help: 'All three channels together, after the channel curves.' },
    { id: 'red', label: 'Red', type: 'curve', default: IDENTITY_CURVE, group: 'Curves' },
    { id: 'green', label: 'Green', type: 'curve', default: IDENTITY_CURVE, group: 'Curves' },
    { id: 'blue', label: 'Blue', type: 'curve', default: IDENTITY_CURVE, group: 'Curves' }
  ],
  shader
}

export default curves
