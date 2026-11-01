import type { EffectManifest } from '../../engine/effects/types'
import shader from './shader.wgsl?raw'

/**
 * Feedback (M9's test of stateful effects): each frame is laid over the effect's own
 * previous frame, zoomed and turned a little, so movement leaves trails and tunnels.
 * Every frame depends on all the frames since the clip appeared.
 */
const feedback: EffectManifest = {
  id: 'feedback',
  name: 'Feedback',
  category: 'Time',
  description: 'Lays each frame over the one before, zoomed and turned a little: trails, tunnels and smears.',
  version: 1,
  colourSpace: 'display',
  time: 'stateful',
  params: [
    { id: 'amount', label: 'Feedback', type: 'number', default: 80, min: 0, max: 100, unit: '%', decimals: 1, help: 'How much of the previous frame stays each frame.' },
    { id: 'zoom', label: 'Zoom', type: 'number', default: 102, min: 50, max: 200, unit: '%', decimals: 2, help: 'The previous frame is scaled by this each frame, around Centre: over 100% it streams outwards.' },
    { id: 'rotation', label: 'Rotation', type: 'angle', default: 0, help: 'The previous frame turns by this each frame.' },
    { id: 'centre', label: 'Centre', type: 'point', default: [0.5, 0.5] },
    {
      id: 'mode',
      label: 'Mode',
      type: 'choice',
      default: 'over',
      options: [
        { id: 'over', label: 'Over (trails)' },
        { id: 'add', label: 'Add (glow)' },
        { id: 'screen', label: 'Screen' },
        { id: 'lighten', label: 'Lighten' }
      ],
      help: 'How the previous frame combines with this one.'
    }
  ],
  shader
}

export default feedback
