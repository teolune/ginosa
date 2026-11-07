import type { EffectManifest, ImageSize, ParamValue } from '../../engine/effects/types'
import common from './common.wgsl?raw'
import pyramid from './pyramid.wgsl?raw'
import coarse from './coarse.wgsl?raw'
import refine from './refine.wgsl?raw'
import refineHalf from './refine-half.wgsl?raw'
import refineFull from './refine-full.wgsl?raw'
import shape from './shape.wgsl?raw'
import shader from './shader.wgsl?raw'

/**
 * Datamosh (M14, Engine A): a live GPU datamosh. The effect keeps a mosh buffer, its own
 * last output, and each frame moves the buffer's blocks by the motion of the real footage,
 * as a video decoder moves a reference frame's blocks by a P-frame's motion vectors, but with
 * the reference never refreshed. So the old picture is pushed around by the new one's motion.
 *
 * Each frame, in passes:
 *  1. a luma pyramid of this frame (full, half, quarter size) beside the frame before's, kept
 *     (with a Motion Source track, of that track's picture instead: motion transfer);
 *  2. coarse motion: a 24-pixel patch per 16-pixel block, at quarter size, searched 16 px
 *     around no motion and 4 px around the block's motion on the frame before;
 *  3–4. refined at half and full size for the chosen block size (codec-style block matching);
 *  5. shaped: Speed, Smoothing, Swirl, Push, Momentum, Repeat Motion / Bloom, Freeze, Strength,
 *     wrong matches, rounding and intra blocks; kept for the next frame (momentum, triggers);
 *  6. the buffer moved by it, plus the Residual (the footage's own change, as a P-frame adds),
 *     with intra blocks and Leak letting the real frame back in.
 * A reset (the start, a cut, every n beats, the Reset Trigger) starts the buffer again from
 * the real frame, as a codec keyframe does. Block sizes are in pixels of a 1080-high picture.
 */

const BLOCKS = [4, 8, 16, 32]

function blockPx(input: ImageSize, params: Record<string, ParamValue>): number {
  const size = BLOCKS[Math.max(0, BLOCKS.indexOf(Number(params['blockSize'] ?? 16)))] ?? 16
  return Math.max(2, Math.round((size * input.height) / 1080))
}

const grid = (input: ImageSize, b: number) => ({ width: Math.ceil(input.width / b), height: Math.ceil(input.height / b) })

const datamosh: EffectManifest = {
  id: 'datamosh',
  name: 'Datamosh',
  category: 'Time',
  description: 'Live datamosh: the picture freezes and is pushed around by the footage’s own motion, as when a video loses its keyframes.',
  version: 1,
  colourSpace: 'display',
  time: 'stateful',
  readsClock: true,
  params: [
    { id: 'strength', label: 'Strength', type: 'number', default: 100, min: 0, max: 300, unit: '%', decimals: 1, group: 'Motion', help: 'How far the motion pushes the picture: the one to link to the bass.' },
    { id: 'speed', label: 'Speed', type: 'number', default: 100, min: 0, max: 400, unit: '%', decimals: 1, group: 'Motion', help: 'The footage’s motion per frame, scaled: below 100% the picture drifts slowly.' },
    {
      id: 'blockSize',
      label: 'Block Size',
      type: 'choice',
      default: '16',
      group: 'Motion',
      options: BLOCKS.map((b) => ({ id: String(b), label: `${b} px` })),
      help: 'Whole blocks move as one, as in a codec (pixels of a 1080-high picture).'
    },
    { id: 'momentum', label: 'Momentum', type: 'number', default: 0, min: 0, max: 99, unit: '%', decimals: 1, group: 'Motion', help: 'How much of the motion so far carries on: swirls and glides.' },
    { id: 'smoothing', label: 'Smoothing', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Motion', help: 'Averages each block’s motion with its neighbours’, for a liquid flow.' },
    { id: 'pushX', label: 'Push X', type: 'number', default: 0, min: -50, max: 50, unit: ' px', decimals: 1, group: 'Motion', help: 'Pixels slide this far right (−: left) every frame, on top of the real motion.' },
    { id: 'pushY', label: 'Push Y', type: 'number', default: 0, min: -50, max: 50, unit: ' px', decimals: 1, group: 'Motion', help: 'Pixels slide this far down (−: up) every frame.' },
    { id: 'swirl', label: 'Swirl', type: 'number', default: 0, min: -100, max: 100, unit: '%', decimals: 1, group: 'Motion', help: 'Turns the motion around the centre of the picture.' },
    {
      id: 'motionSource',
      label: 'Motion Source',
      type: 'track',
      default: '',
      group: 'Motion',
      help: 'Motion transfer: the clips on this track (water, smoke, a dancer) move this picture instead of its own motion. They’re read as shot, without their effects, even while the track is hidden.'
    },
    { id: 'freeze', label: 'Freeze', type: 'number', default: 0, min: 0, max: 250, unit: ' frames', decimals: 0, group: 'Hold', help: 'After each reset, the picture holds still this many frames before the motion starts pushing it.' },
    { id: 'leak', label: 'Leak', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Hold', help: 'How much of the real frame comes back through each frame.' },
    {
      id: 'leakStyle',
      label: 'Leak Style',
      type: 'choice',
      default: 'even',
      group: 'Hold',
      options: [
        { id: 'even', label: 'Even' },
        { id: 'blocks', label: 'Blocks' }
      ],
      help: 'Even: a little everywhere. Blocks: whole blocks refreshed at random, as an encoder’s intra blocks.'
    },
    { id: 'melt', label: 'Melt', type: 'number', default: 0, min: 0, max: 250, unit: ' frames', decimals: 0, group: 'Hold', help: 'Transition melt: after each cut the new shot’s motion smears the old one, and Leak rises to 100% over this many frames. Turn Reset on Cuts off.' },
    { id: 'onCuts', label: 'Reset on Cuts', type: 'toggle', default: true, group: 'Resets', help: 'On an adjustment layer, start again at each cut beneath it.' },
    {
      id: 'every',
      label: 'Reset Every',
      type: 'choice',
      default: 'off',
      group: 'Resets',
      options: [
        { id: 'off', label: 'Off' },
        { id: 'beat', label: '1 beat' },
        { id: '2beats', label: '2 beats' },
        { id: 'bar', label: '1 bar' },
        { id: '2bars', label: '2 bars' },
        { id: '4bars', label: '4 bars' },
        { id: '8bars', label: '8 bars' }
      ],
      help: 'Start again on the beat grid.'
    },
    { id: 'resetTrigger', label: 'Reset Trigger', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 0, group: 'Resets', help: 'Starts again each time this rises past 50%. Link it to the audio (hits) or a Channel Rack row, or keyframe it.' },
    { id: 'repeatMotion', label: 'Repeat Motion', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Bloom', help: 'Keeps re-using the last motion: pixels smear outward (bloom).' },
    { id: 'bloomTrigger', label: 'Bloom Trigger', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 0, group: 'Bloom', help: 'Each time this rises past 50%, the motion of that frame repeats for Bloom Frames. Link it to the kick.' },
    { id: 'bloomFrames', label: 'Bloom Frames', type: 'number', default: 8, min: 1, max: 120, decimals: 0, group: 'Bloom' },
    {
      id: 'rounding',
      label: 'Vector Rounding',
      type: 'choice',
      default: 'whole',
      group: 'Codec Character',
      options: [
        { id: 'off', label: 'Off (smooth)' },
        { id: 'half', label: 'Half pixel' },
        { id: 'whole', label: 'Whole pixel' },
        { id: 'two', label: '2 pixels' }
      ],
      help: 'Codecs move blocks by whole or half pixels. Off moves them smoothly (softer over time).'
    },
    { id: 'wrongMatches', label: 'Wrong Matches', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Codec Character', help: 'Blocks that take a neighbour’s motion, a little off, as an encoder’s bad guesses.' },
    {
      id: 'residual',
      label: 'Residual',
      type: 'number',
      default: 0,
      min: 0,
      max: 100,
      unit: '%',
      decimals: 1,
      group: 'Codec Character',
      help: 'The footage’s own change from frame to frame (a P-frame’s correction), added to the moved picture: ghosts of the new shot’s moving edges build up over the old one, as in a real mosh. 100% is all of it.'
    },
    {
      id: 'intra',
      label: 'Intra Blocks',
      type: 'number',
      default: 0,
      min: 0,
      max: 100,
      unit: '%',
      decimals: 1,
      group: 'Codec Character',
      help: 'Blocks the motion can’t explain are coded afresh, as an encoder does: the real frame breaks through in blocks, and the mosh heals. At 50% a block is refreshed when matching it costs more than its own detail (the usual encoder rule); higher refreshes more readily, lower keeps more of the mosh.'
    },
    { id: 'colourDrift', label: 'Colour Drift', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Codec Character', help: 'Red and blue follow slightly different motion: colour bleeds off edges.' },
    {
      id: 'view',
      label: 'Show',
      type: 'choice',
      default: 'mosh',
      options: [
        { id: 'mosh', label: 'Datamosh' },
        { id: 'motion', label: 'Motion' }
      ],
      help: 'Motion shows how far each block moves this frame: red to the right, green down (grey is still), brighter for bigger moves; black blocks are intra blocks (the real frame).'
    }
  ],
  closedGroups: ['Bloom', 'Codec Character'],
  passes: [
    { shader: common + pyramid, keep: 0, size: (input) => ({ width: input.width, height: input.height + Math.ceil(input.height / 2) + Math.ceil(input.height / 4) }) },
    { shader: common + coarse, size: (input) => grid(input, Math.max(4, Math.round((16 * input.height) / 1080))) },
    { shader: common + refine + refineHalf, size: (input, params) => grid(input, blockPx(input, params)) },
    { shader: common + refine + refineFull, size: (input, params) => grid(input, blockPx(input, params)) },
    {
      shader: common + shape,
      keep: 1,
      size: (input, params) => {
        const g = grid(input, blockPx(input, params))
        return { width: g.width, height: g.height + 1 }
      }
    }
  ],
  shader: common + shader
}

export default datamosh
