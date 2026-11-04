import type { EffectManifest } from '../../engine/effects/types'
import { POSTERIZE_RATES, posterizeGrid, posterizeSettings, updatesPerSecond } from '../../engine/timeline/posterize'

/**
 * Posterize Time (M12): updates the picture only on musical time (or a set rate), holding
 * it in between. It's worked out by the render plan, not the GPU (`holdsTime`): on a clip,
 * its picture and the effects above Posterize Time come from the held frame, while Motion,
 * Opacity and the effects below it keep moving; on an adjustment layer, everything beneath
 * is held. The timing is in src/engine/timeline/posterize.ts.
 */
const posterizeTime: EffectManifest = {
  id: 'posterize-time',
  name: 'Posterize Time',
  category: 'Time',
  description: 'Holds the picture between beats (or at a set frame rate): stutter in time with the music.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  holdsTime: true,
  params: [
    {
      id: 'timing',
      label: 'Timing',
      type: 'choice',
      default: 'beat',
      options: [
        { id: 'beat', label: 'Note value (beat grid)' },
        { id: 'free', label: 'Free (frames a second)' }
      ],
      group: 'Rate'
    },
    { id: 'rate', label: 'Rate', type: 'steps', default: 8, steps: POSTERIZE_RATES.map((r) => ({ id: r.id, label: r.label })), group: 'Rate', showIf: { param: 'timing', is: ['beat'] }, help: 'How often the picture updates, as a note value. Off shows every frame. Link it to the music and it moves by whole steps: louder, faster.' },
    { id: 'fps', label: 'Rate (fps)', type: 'number', default: 8, min: 0.5, max: 60, unit: ' fps', decimals: 2, group: 'Rate', showIf: { param: 'timing', is: ['free'] } },
    {
      id: 'tempo',
      label: 'Tempo',
      type: 'choice',
      default: 'grid',
      options: [
        { id: 'grid', label: 'Beat grid (Audio Analysis)' },
        { id: 'manual', label: 'This BPM' }
      ],
      group: 'Rate',
      showIf: { param: 'timing', is: ['beat'] },
      help: 'The sequence’s beat grid (from Audio Analysis; 120 BPM from the start if there isn’t one), or a BPM of its own from the sequence start.'
    },
    { id: 'bpm', label: 'BPM', type: 'number', default: 120, min: 20, max: 400, decimals: 2, group: 'Rate', showIf: { param: 'tempo', is: ['manual'] } },
    { id: 'phase', label: 'Phase', type: 'number', default: 0, min: -1, max: 1, decimals: 3, group: 'Timing', help: 'Moves every update later (or earlier): in beats with a note value, in updates in Free.' },
    { id: 'swing', label: 'Swing', type: 'number', default: 0, min: 0, max: 75, unit: '%', decimals: 1, group: 'Timing', help: 'Delays every second update by this share of an update, like a swung hi-hat. 33% is a triplet shuffle.' },
    {
      id: 'sample',
      label: 'Sample',
      type: 'choice',
      default: 'start',
      options: [
        { id: 'start', label: 'Start of each hold' },
        { id: 'middle', label: 'Middle of each hold' }
      ],
      group: 'Timing',
      help: 'Which frame each hold shows: the one at its start (classic), or the one in its middle (centred on the movement).'
    },
    {
      id: 'cuts',
      label: 'Reset on Cuts',
      type: 'choice',
      default: 'hold',
      options: [
        { id: 'hold', label: 'Keep the old shot until the next update' },
        { id: 'switch', label: 'Switch at the cut' }
      ],
      group: 'Timing',
      help: 'On an adjustment layer, when a cut underneath falls inside a hold. (A clip always starts on its own first frame.)'
    }
  ],
  readout(param, params, context) {
    if (param !== 'rate') return null
    const s = posterizeSettings(params)
    const perSecond = updatesPerSecond(s, posterizeGrid(s, context.beatGrid))
    const label = POSTERIZE_RATES[s.rate]!.label
    return perSecond === null ? 'Off (every frame)' : `${label} · ${perSecond.toFixed(2)} fps`
  },
  shader: 'fn effect(px: vec2f) -> vec4f { return inputAt(px); }'
}

export default posterizeTime
