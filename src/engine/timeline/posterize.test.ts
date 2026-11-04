import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject, type BeatGrid } from '../project/model'
import { frameKeys } from '../render/frame-keys'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '../time'
import { placeMedia, setClipProperties, type TimelineCommand } from './edits'
import { addAdjustmentLayer, addEffect, setEffectValues } from './effect-edits'
import { setAnimated, setValue } from './keyframe-edits'
import { holdAt, POSTERIZE_RATES, posterizeSettings, updateFrame, updatesPerSecond } from './posterize'
import { videoLayersAt } from './render-plan'
import { resolveClip } from '../keyframes/properties'

const s = secondsToTicks
let counter = 0
const ids = () => `pt-${++counter}`
const rate = (id: string) => POSTERIZE_RATES.findIndex((r) => r.id === id)
const grid = (bpm: number): BeatGrid => ({ bpm, downbeat: 0, beatsPerBar: 4, sourceId: null })
const F24 = ticksPerFrame(FRAME_RATES['24'])
const F25 = ticksPerFrame(FRAME_RATES['25'])
const settings = (p: Record<string, string | number> = {}) => posterizeSettings({ timing: 'beat', rate: rate('1/16'), tempo: 'grid', phase: 0, swing: 0, sample: 'start', cuts: 'hold', ...p })
const holdLengths = (st: ReturnType<typeof settings>, g: BeatGrid, frame: number, count: number) => Array.from({ length: count }, (_, k) => updateFrame(st, g, frame, k + 1) - updateFrame(st, g, frame, k))

describe('Posterize Time timing', () => {
  it('lands every update on the frame nearest its beat, so holds never drift (128 BPM, 24 fps, 1/16)', () => {
    const st = settings()
    const lengths = holdLengths(st, grid(128), F24, 1600)
    expect(new Set(lengths)).toEqual(new Set([2, 3]))
    // 1/16 at 128 BPM is 2.8125 frames at 24 fps: 16 holds are exactly 45 frames.
    expect(lengths.slice(0, 16).reduce((a, b) => a + b, 0)).toBe(45)
    for (let k = 0; k <= 1600; k += 37) expect(Math.abs(updateFrame(st, grid(128), F24, k) - 2.8125 * k)).toBeLessThanOrEqual(0.5)
    expect(lengths.slice(0, 8)).toEqual([3, 3, 2, 3, 3, 3, 3, 3])
  })

  it('finds the hold of any frame, before and after the downbeat', () => {
    const st = settings({ rate: rate('1/4') })
    const g: BeatGrid = { bpm: 120, downbeat: s(1.3), beatsPerBar: 4, sourceId: null }
    for (let f = -40; f < 300; f++) {
      const h = holdAt(st, g, F25, f)!
      expect(h.start).toBeLessThanOrEqual(f)
      expect(h.end).toBeGreaterThan(f)
      expect(h.sample).toBe(h.start)
    }
    // Beats at 1.3 s + 0.5 s × k: frames 32.5 → 33, 45, 57.5 → 58.
    expect(holdAt(st, g, F25, 40)).toEqual({ start: 33, end: 45, sample: 33 })
    expect(holdAt(st, g, F25, 50)).toEqual({ start: 45, end: 58, sample: 45 })
  })

  it('moves updates by Phase, delays every second one by Swing, and can sample the middle', () => {
    const g = grid(120)
    // 1/4 at 120 BPM = 12.5 frames at 25 fps; half a beat of phase = 6.25 frames.
    expect([0, 1, 2].map((k) => updateFrame(settings({ rate: rate('1/4'), phase: 0.5 }), g, F25, k))).toEqual([6, 19, 31])
    // Swing 50%: updates at 0, 1.5, 2, 3.5 beats… (odd ones half a step late).
    expect([0, 1, 2, 3].map((k) => updateFrame(settings({ rate: rate('1/4'), swing: 50 }), g, F25, k))).toEqual([0, 19, 25, 44])
    expect(holdAt(settings({ rate: rate('1/4'), sample: 'middle' }), g, F25, 3)).toEqual({ start: 0, end: 13, sample: 6 })
  })

  it('runs at a frame rate in Free mode, does nothing when Off, and reads out its rate', () => {
    const free = posterizeSettings({ timing: 'free', fps: 8, phase: 0, swing: 0, sample: 'start' })
    expect([0, 1, 2, 3, 4].map((k) => updateFrame(free, grid(120), F25, k))).toEqual([0, 3, 6, 9, 13])
    expect(holdAt(settings({ rate: 0 }), grid(120), F25, 10)).toBeNull()
    expect(updatesPerSecond(settings(), grid(128))).toBeCloseTo(8.5333, 4)
    expect(updatesPerSecond(free, grid(128))).toBe(8)
    // The knob goes from slowest to fastest.
    const beats = POSTERIZE_RATES.slice(1).map((r) => r.beats)
    expect(beats).toEqual([...beats].sort((a, b) => b - a))
  })
})

function media(name: string): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: 20,
    bitRate: null,
    video: { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: 500, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 },
    audio: null
  }
  return { id: `m-${name}`, name, kind: 'video', path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-11-04T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

function setup() {
  const history = new History(createProject({ name: 'Posterize', createId: ids }))
  history.dispatch(importMedia([media('a'), media('b')]))
  const [V1, V2] = history.state.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  const layers = (frame: number) => videoLayersAt(history.state.sequence, history.state.media, frame * F25)
  return { history, run, V1, V2, layers }
}

describe('Posterize Time in the render plan', () => {
  it('holds a clip’s picture and the effects above it; Motion and the effects below keep moving', () => {
    const { history, run, V1, layers } = setup()
    run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    const clip = () => history.state.sequence.clips[0]!
    run(addEffect([clip().id], 'invert', null, ids))
    run(addEffect([clip().id], 'posterize-time', null, ids))
    run(addEffect([clip().id], 'invert', null, ids))
    const [above, posterize, below] = clip().effects.map((e) => e.id) as [string, string, string]
    run(setEffectValues(clip().id, posterize, { params: { rate: rate('1/4') } }))
    // Animate the effects either side, and Scale.
    for (const ref of [{ effectId: above, param: 'amount' }, { effectId: below, param: 'amount' }, { effectId: null, param: 'scale' }]) {
      const r = { clipId: clip().id, ...ref }
      run(setAnimated(r, true, 0, ids))
      run(setValue(r, ref.param === 'scale' ? 200 : 0, s(4), ids))
    }
    // 1/4 at 120 BPM (no beat grid) = every 12.5 frames: updates on 0, 13, 25, 38.
    const at = (f: number) => layers(f)[0]!
    for (const f of [0, 5, 12]) expect(at(f).sourceTime).toBe(0)
    expect(at(13).sourceTime).toBe(13 * F25)
    expect(at(20).sourceTime).toBe(13 * F25)
    expect(at(20).clip.effects[0]!.params['amount']).toBeCloseTo(resolveClip(clip(), 13 * F25).effects[0]!.params['amount'] as number, 9)
    expect(at(20).clip.effects[2]!.params['amount']).toBeCloseTo(resolveClip(clip(), 20 * F25).effects[2]!.params['amount'] as number, 9)
    expect(at(20).clip.motion.scale).toBeCloseTo(resolveClip(clip(), 20 * F25).motion.scale, 9)
    expect(at(20).held).toMatchObject({ effects: 1 })
    // Off shows every frame.
    run(setEffectValues(clip().id, posterize, { params: { rate: 0 } }))
    expect(at(20).sourceTime).toBe(20 * F25)
  })

  it('starts a clip on its own first frame, even mid-hold', () => {
    const { history, run, V1, layers } = setup()
    run(placeMedia({ mediaId: 'm-a', sourceIn: s(2), sourceOut: s(6), at: 5 * F25, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    const clip = history.state.sequence.clips[0]!
    run(addEffect([clip.id], 'posterize-time', null, ids))
    run(setEffectValues(clip.id, history.state.sequence.clips[0]!.effects[0]!.id, { params: { rate: rate('1/4') } }))
    for (const f of [5, 9, 12]) expect(layers(f)[0]!.sourceTime).toBe(s(2))
    expect(layers(13)[0]!.sourceTime).toBe(s(2) + 8 * F25)
  })

  it('holds everything beneath an adjustment layer; at a cut, keeps the old shot or switches', () => {
    const { history, run, V1, V2, layers } = setup()
    run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: 30 * F25, at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    run(placeMedia({ mediaId: 'm-b', sourceIn: 0, sourceOut: s(4), at: 30 * F25, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    run(addAdjustmentLayer({ trackId: V2, start: 0, duration: s(4) }, ids))
    const layer = () => history.state.sequence.clips.find((c) => c.adjustment)!
    run(addEffect([layer().id], 'posterize-time', null, ids))
    const effect = layer().effects[0]!.id
    run(setEffectValues(layer().id, effect, { params: { rate: rate('1/4') } }))
    // Frame 32 is in the hold from 25 to 38; the cut to B is at 30.
    const beneath = (f: number) => layers(f).filter((l) => !l.clip.adjustment)
    expect(beneath(32).map((l) => [l.item!.id, l.sourceTime])).toEqual([['m-a', 25 * F25]])
    run(setEffectValues(layer().id, effect, { params: { cuts: 'switch' } }))
    expect(beneath(32).map((l) => [l.item!.id, l.sourceTime])).toEqual([['m-b', 0]])
    expect(beneath(29).map((l) => [l.item!.id, l.sourceTime])).toEqual([['m-a', 25 * F25]])
    // Moving the clip beneath (Motion) is held too: the composite underneath is the held one.
    run(setClipProperties([history.state.sequence.clips.find((c) => c.mediaId === 'm-a')!.id], { motion: { positionX: 700 } }))
    expect(beneath(20)[0]!.clip.motion.positionX).toBe(700)
  })

  it('moves the Rate knob by whole steps when modulated, and holds it between keyframes', () => {
    const { history, run, V1 } = setup()
    run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    const clip = () => history.state.sequence.clips[0]!
    run(addEffect([clip().id], 'posterize-time', null, ids))
    const ref = { clipId: clip().id, effectId: clip().effects[0]!.id, param: 'rate' }
    run(setAnimated(ref, true, 0, ids))
    run(setValue(ref, rate('1/16'), s(2), ids))
    const value = (t: number) => resolveClip(clip(), t).effects[0]!.params['rate']
    expect(value(s(1))).toBe(rate('1/8'))
    expect(value(s(2))).toBe(rate('1/16'))
    expect(clip().effects[0]!.keyframes['rate']!.every((k) => k.interpolation === 'hold')).toBe(true)
    const modulated = structuredClone(clip())
    modulated.effects[0]!.keyframes = {}
    modulated.effects[0]!.modulation = { rate: [{ id: 'l', modulatorId: 'm', mode: 'add', min: [0], max: [4], invert: false, amount: 100 }] }
    expect(resolveClip(modulated, s(1), { value: () => 0.4 }).effects[0]!.params['rate']).toBe(rate('1/8') + 2)
    expect(resolveClip(modulated, s(1), { value: () => 1 }).effects[0]!.params['rate']).toBe(POSTERIZE_RATES.length - 1)
  })

  it('gives held frames the same render cache key', () => {
    const { history, run, V1 } = setup()
    run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: s(4), at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    const clip = history.state.sequence.clips[0]!
    run(addEffect([clip.id], 'posterize-time', null, ids))
    run(setEffectValues(clip.id, history.state.sequence.clips[0]!.effects[0]!.id, { params: { rate: rate('1/4') } }))
    const keys = frameKeys(history.state.sequence, history.state.media, null).keys
    expect(new Set(keys.slice(0, 13)).size).toBe(1)
    expect(keys[13]).not.toBe(keys[12])
    expect(new Set(keys.slice(0, 100)).size).toBe(8)
  })
})
