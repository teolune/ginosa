import type { EffectManifest, ParamValue } from '../../engine/effects/types'
import shader from './shader.wgsl?raw'

/**
 * Datamosh Bake (M15, Engine B, decision 133): a real codec mosh. The picture the effect sees
 * over its whole span (a clip's own picture after the effects above it, or everything beneath an
 * adjustment layer) is rendered, encoded by FFglitch to MPEG-4 Part 2 (no B-frames, no fresh
 * blocks inside P-frames), broken at the moments chosen here (keyframes removed, frames
 * repeated), its motion vectors rewritten by an ffedit script, decoded back with errors
 * tolerated, and kept as a bake in the project's cache. The plan is engine/datamosh/bake-plan.ts.
 *
 * It bakes in the background and plays the bake in place. Until the bake for its current
 * settings is ready (and when FFglitch isn't set up) it's drawn as Datamosh, Engine A, with
 * these settings carried over as near as they go: the live look.
 */

const EVERY = [
  { id: 'off', label: 'Off' },
  { id: 'beat', label: '1 beat' },
  { id: '2beats', label: '2 beats' },
  { id: 'bar', label: '1 bar' },
  { id: '2bars', label: '2 bars' },
  { id: '4bars', label: '4 bars' },
  { id: '8bars', label: '8 bars' }
] as const

const ACTIONS = [
  { id: 'bloom', label: 'Bloom' },
  { id: 'heal', label: 'Heal' }
] as const

/** Engine A's settings for the live look: the same moments and vectors, as near as they go. */
function liveParams(p: Record<string, ParamValue>): Record<string, ParamValue> {
  const num = (id: string, fallback: number) => (typeof p[id] === 'number' ? (p[id] as number) : fallback)
  const every = String(p['every'] ?? 'off')
  const block = String(p['blockSize'] ?? '16')
  return {
    strength: 100,
    speed: Math.max(0, Math.min(400, num('scale', 100))),
    blockSize: block === '16' ? '16' : '32',
    momentum: Math.min(99, num('fluid', 0) * 0.9),
    smoothing: num('fluid', 0) * 0.5,
    pushX: num('pushX', 0),
    pushY: num('pushY', 0),
    swirl: num('swirl', 0),
    motionSource: String(p['motionSource'] ?? ''),
    freeze: 0,
    leak: 0,
    leakStyle: 'blocks',
    melt: 0,
    onCuts: String(p['cuts'] ?? 'melt') === 'clean',
    every: String(p['everyAction'] ?? 'bloom') === 'heal' ? every : 'off',
    resetTrigger: 0,
    repeatMotion: 0,
    bloomTrigger: 0,
    bloomFrames: num('bloomFrames', 8),
    rounding: 'whole',
    wrongMatches: num('wrongGuesses', 0),
    // A codec mosh carries the new shot's residual (its moving edges) onto the old picture.
    residual: 50,
    intra: 0,
    colourDrift: 0,
    view: 'mosh'
  }
}

const datamoshBake: EffectManifest = {
  id: 'datamosh-bake',
  name: 'Datamosh Bake',
  category: 'Time',
  description: 'A real codec datamosh, baked in the background with FFglitch: keyframes removed at cuts, frames repeated on the beat, motion vectors pushed and turned. Plays the live Datamosh look while it bakes.',
  version: 1,
  colourSpace: 'display',
  time: 'per-frame',
  bake: { live: 'datamosh', liveParams },
  mainParam: 'scale',
  params: [
    {
      id: 'cuts',
      label: 'Cuts',
      type: 'choice',
      default: 'melt',
      group: 'Moments',
      options: [
        { id: 'melt', label: 'Melt' },
        { id: 'meltBloom', label: 'Melt and Bloom' },
        { id: 'clean', label: 'Clean' }
      ],
      help: 'On an adjustment layer, each cut beneath it. Melt: the cut’s keyframe is removed, so the new shot’s motion smears the old picture. Melt and Bloom: the new shot’s first motion also repeats for Bloom Frames. Clean: the keyframe stays, so the cut is clean and the mosh heals.'
    },
    { id: 'channel', label: 'Channel', type: 'channel', default: '', group: 'Moments', help: 'A Channel Rack channel (the kick, say): each of its cubes sets off a moment.' },
    { id: 'channelAction', label: 'On Its Cubes', type: 'choice', default: 'bloom', group: 'Moments', options: ACTIONS, help: 'Bloom: that frame repeats for Bloom Frames, so its motion keeps pushing the picture. Heal: a keyframe, so the picture clears.' },
    { id: 'every', label: 'Every', type: 'choice', default: 'off', group: 'Moments', options: EVERY, help: 'A moment on the beat grid.' },
    { id: 'everyAction', label: 'On the Beat', type: 'choice', default: 'bloom', group: 'Moments', options: ACTIONS, showIf: { param: 'every', is: ['beat', '2beats', 'bar', '2bars', '4bars', '8bars'] } },
    {
      id: 'markers',
      label: 'Markers',
      type: 'choice',
      default: 'off',
      group: 'Moments',
      options: [{ id: 'off', label: 'Off' }, ...ACTIONS],
      help: 'A moment at each timeline marker in the span.'
    },
    { id: 'bloomFrames', label: 'Bloom Frames', type: 'number', default: 8, min: 1, max: 120, decimals: 0, unit: ' frames', group: 'Moments', keyframable: false, modulatable: false, help: 'How long a bloom repeats its frame.' },
    { id: 'healAfter', label: 'Heal After', type: 'number', default: 0, min: 0, max: 600, decimals: 0, unit: ' frames', group: 'Moments', keyframable: false, modulatable: false, help: 'A keyframe this many frames after each melt or bloom, so the picture clears again (0: never).' },
    { id: 'pushX', label: 'Push X', type: 'number', default: 0, min: -50, max: 50, unit: ' px', decimals: 1, group: 'Vectors', help: 'Every block moves this far right (−: left) each frame, on top of its own motion (pixels of a 1080-high picture).' },
    { id: 'pushY', label: 'Push Y', type: 'number', default: 0, min: -50, max: 50, unit: ' px', decimals: 1, group: 'Vectors', help: 'Every block moves this far down (−: up) each frame.' },
    { id: 'scale', label: 'Scale', type: 'number', default: 100, min: -200, max: 400, unit: '%', decimals: 1, group: 'Vectors', help: 'The motion, bigger or smaller: 0% stops it, below 0% runs it backwards.' },
    { id: 'rotate', label: 'Rotate', type: 'angle', default: 0, group: 'Vectors', help: 'Turns every block’s motion by this angle: at 90° the picture moves sideways to the way the footage moves.' },
    { id: 'swirl', label: 'Swirl', type: 'number', default: 0, min: -100, max: 100, unit: '%', decimals: 1, group: 'Vectors', help: 'Adds motion around the centre of the picture: at 100% the edge turns 20 px a frame (−: the other way).' },
    { id: 'fluid', label: 'Fluid', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Vectors', help: 'Each block’s motion averaged with its last frames, so movement flows on like liquid.' },
    {
      id: 'motionSource',
      label: 'Motion Source',
      type: 'track',
      default: '',
      group: 'Vectors',
      help: 'Motion transfer: the clips on this track (water, smoke, a dancer) are encoded too, and their real motion vectors move this picture’s blocks instead of its own. Read as shot, without their effects, even while the track is hidden.'
    },
    { id: 'wrongGuesses', label: 'Wrong Guesses', type: 'number', default: 0, min: 0, max: 100, unit: '%', decimals: 1, group: 'Vectors', help: 'Blocks that take a neighbour’s motion, a little off, as a bad encoder guesses: chaos and blockiness.' },
    {
      id: 'blockSize',
      label: 'Block Size',
      type: 'choice',
      default: '16',
      group: 'Codec',
      options: [
        { id: '16', label: '16 px' },
        { id: '32', label: '32 px' },
        { id: '64', label: '64 px' }
      ],
      help: 'The codec’s blocks, in pixels of a 1080-high picture: the picture is encoded smaller for bigger blocks (and bakes faster).'
    },
    {
      id: 'quality',
      label: 'Quality',
      type: 'choice',
      default: 'normal',
      group: 'Codec',
      options: [
        { id: 'fine', label: 'Fine' },
        { id: 'normal', label: 'Normal' },
        { id: 'rough', label: 'Rough' },
        { id: 'crushed', label: 'Crushed' }
      ],
      help: 'How coarsely the encoder rounds: rougher is blockier, with more ringing round edges.'
    },
    { id: 'seed', label: 'Seed', type: 'number', default: 1, min: 0, max: 999, decimals: 0, group: 'Codec', keyframable: false, modulatable: false, help: 'Which wrong guesses: the same seed gives the same bake.' }
  ],
  closedGroups: ['Codec'],
  shader
}

export default datamoshBake
