import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { secondsToTicks } from '../time'
import { addMarker, placeMedia, setClipProperties, type TimelineCommand } from '../timeline/edits'
import { addAdjustmentLayer, addEffect, setEffectValues } from '../timeline/effect-edits'
import { videoLayersAt } from '../timeline/render-plan'
import { frameKeys } from '../render/frame-keys'
import { bakeMoments, bakeSettings, bakeSize, bakeSpan, planBake, type Moment } from './bake-plan'
import { bakeInputSequence, bakeKey, bakeStore, motionSourceSequence, withBakes } from './bakes'
import { frameKind, joinM4v, splitM4v } from './m4v'

const s = secondsToTicks
let counter = 0
const ids = () => `bk-${++counter}`

function media(name: string, seconds = 20): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: seconds,
    bitRate: null,
    video: { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: seconds * 25, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 },
    audio: null
  }
  return { id: `m-${name}`, name, kind: 'video', path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-11-01T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

/** A at 0–4 s and B at 4–8 s on V1, an adjustment layer on V2 over 2–6 s with Datamosh Bake, and C on V3. */
function setup() {
  const history = new History(createProject({ name: 'Bake', createId: ids }))
  history.dispatch(importMedia([media('a'), media('b'), media('c')]))
  const [V1, V2, V3] = history.state.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: s(4), at: 0, videoTrackId: V1!, audioTrackId: null, mode: 'overwrite' }, ids))
  run(placeMedia({ mediaId: 'm-b', sourceIn: 0, sourceOut: s(4), at: s(4), videoTrackId: V1!, audioTrackId: null, mode: 'overwrite' }, ids))
  run(addAdjustmentLayer({ trackId: V2!, start: s(2), duration: s(4) }, ids))
  run(placeMedia({ mediaId: 'm-c', sourceIn: 0, sourceOut: s(2), at: s(10), videoTrackId: V3!, audioTrackId: null, mode: 'overwrite' }, ids))
  const layer = () => history.state.sequence.clips.find((c) => c.adjustment)!
  run(addEffect([layer().id], 'datamosh-bake', null, ids))
  const effect = () => layer().effects[0]!
  return { history, run, layer, effect, V1: V1!, V3: V3! }
}

describe('Datamosh Bake: the plan', () => {
  it('reads its settings', () => {
    const st = bakeSettings({ cuts: 'meltBloom', every: 'bar', everyAction: 'heal', markers: 'bloom', blockSize: '32', quality: 'rough', bloomFrames: 300 }, 3)
    expect(st).toMatchObject({ cuts: 'meltBloom', everyBeats: 3, everyAction: 'heal', markers: 'bloom', blockSize: 32, quantiser: 12, bloomFrames: 120 })
    expect(bakeSettings({}).cuts).toBe('melt')
  })

  it('encodes at the size a block size asks for, even', () => {
    expect(bakeSize({ width: 1920, height: 1080 }, 16)).toEqual({ width: 1920, height: 1080, scale: 1 })
    expect(bakeSize({ width: 1920, height: 1080 }, 32)).toMatchObject({ width: 960, height: 540 })
    expect(bakeSize({ width: 3840, height: 2160 }, 16)).toMatchObject({ width: 1920, height: 1080 })
    expect(bakeSize({ width: 1000, height: 562 }, 64)).toMatchObject({ width: 480, height: 270 })
  })

  it('finds the cuts beneath an adjustment layer, markers and the beat grid in its span', () => {
    const { history, run, layer, effect } = setup()
    const sequence = () => history.state.sequence
    const span = bakeSpan(sequence(), layer())
    expect(span).toMatchObject({ first: 50, frames: 100 })
    // The cut between A and B at 4 s is frame 50 of the span (2 s in).
    expect(bakeMoments(sequence(), layer(), bakeSettings(effect().params), span)).toEqual([{ frame: 50, kind: 'cut', action: 'melt' }])
    run(addMarker(s(3), ids))
    run(addMarker(s(9), ids))
    run(setEffectValues(layer().id, effect().id, { params: { markers: 'heal', every: '2bars', everyAction: 'bloom' } }))
    // 120 BPM without a grid: 2 bars = 4 s, so beat 8 (4 s) is in; 3 s is marker 1; 9 s is outside.
    const moments = bakeMoments(sequence(), layer(), bakeSettings(effect().params), span)
    expect(moments).toEqual([
      { frame: 25, kind: 'marker', action: 'heal' },
      { frame: 50, kind: 'beat', action: 'bloom' },
      { frame: 50, kind: 'cut', action: 'melt' }
    ])
  })

  it('melts by showing the frame before in place of the cut’s keyframe, and keeps the length', () => {
    const plan = planBake(10, [{ frame: 4, kind: 'cut', action: 'melt' }], { bloomFrames: 3, healAfter: 0 })
    expect(plan.keyframes).toEqual([0, 4])
    expect(plan.order).toEqual([0, 1, 2, 3, 3, 5, 6, 7, 8, 9])
    expect(plan.melts).toEqual([4])
  })

  it('blooms by repeating a frame, stops a bloom at a keyframe, and heals', () => {
    const moments: Moment[] = [
      { frame: 2, kind: 'beat', action: 'bloom' },
      { frame: 7, kind: 'cut', action: 'clean' }
    ]
    const plan = planBake(12, moments, { bloomFrames: 8, healAfter: 0 })
    expect(plan.keyframes).toEqual([0, 7])
    expect(plan.order).toEqual([0, 1, 2, 2, 2, 2, 2, 7, 8, 9, 10, 11])
    expect(plan.blooms).toEqual([{ frame: 2, length: 5 }])
  })

  it('melts and blooms the new shot’s first motion, and heals after', () => {
    const plan = planBake(14, [{ frame: 4, kind: 'cut', action: 'meltBloom' }], { bloomFrames: 3, healAfter: 6 })
    expect(plan.keyframes).toEqual([0, 4, 10])
    expect(plan.order).toEqual([0, 1, 2, 3, 3, 5, 5, 5, 8, 9, 10, 11, 12, 13])
    expect(plan.heals).toEqual([10])
  })

  it('a heal beats a melt on the same frame; moments outside the span are left out', () => {
    const plan = planBake(6, [
      { frame: 3, kind: 'cut', action: 'melt' },
      { frame: 3, kind: 'channel', action: 'heal' },
      { frame: 0, kind: 'beat', action: 'bloom' },
      { frame: 9, kind: 'beat', action: 'bloom' }
    ], { bloomFrames: 2, healAfter: 0 })
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5])
    expect(plan.melts).toEqual([])
  })
})

describe('Datamosh Bake: MPEG-4 frames', () => {
  const vop = (type: number, body: number[]) => [0, 0, 1, 0xb6, type << 6, ...body]
  const stream = new Uint8Array([0, 0, 1, 0xb0, 1, 0, 0, 1, 0xb5, 9, 0, 0, 1, 0xb3, 7, ...vop(0, [1, 2]), ...vop(1, [3]), ...vop(1, [4, 5]), 0, 0, 1, 0xb3, 8, ...vop(0, [6])])

  it('splits a stream into its frames, a GOV header going with the frame after it', () => {
    const { head, frames } = splitM4v(stream)
    expect(Array.from(head)).toEqual([0, 0, 1, 0xb0, 1, 0, 0, 1, 0xb5, 9])
    expect(frames.map(frameKind)).toEqual(['I', 'P', 'P', 'I'])
    expect(Array.from(frames[3]!)).toEqual([0, 0, 1, 0xb3, 8, ...vop(0, [6])])
  })

  it('joins frames back in any order', () => {
    const parts = splitM4v(stream)
    expect(Array.from(joinM4v(parts, [0, 1, 2, 3]))).toEqual(Array.from(stream))
    const melted = joinM4v(parts, [0, 1, 2, 2])
    expect(splitM4v(melted).frames.map(frameKind)).toEqual(['I', 'P', 'P', 'P'])
  })
})

describe('Datamosh Bake: keys and the live look', () => {
  it('a key changes with the bake’s settings and what’s beneath it, not with what’s above or after it', () => {
    const { history, run, layer, effect, V3 } = setup()
    const key = () => bakeKey(history.state.sequence, history.state.media, null, layer(), effect().id)
    const first = key()
    expect(key()).toBe(first)
    run(setEffectValues(layer().id, effect().id, { params: { pushX: 4 } }))
    const pushed = key()
    expect(pushed).not.toBe(first)
    // C, on V3 above the layer, doesn't feed the bake.
    const c = history.state.sequence.clips.find((x) => x.mediaId === 'm-c')!
    run(setClipProperties([c.id], { opacity: 50 }))
    expect(key()).toBe(pushed)
    // An effect after the bake doesn't change it either; A beneath does.
    run(addEffect([layer().id], 'invert', null, ids))
    expect(key()).toBe(pushed)
    const a = history.state.sequence.clips.find((x) => x.mediaId === 'm-a')!
    run(setClipProperties([a.id], { opacity: 70 }))
    expect(key()).not.toBe(pushed)
    expect(V3).toBeTruthy()
  })

  it('draws the live look (Datamosh) until a bake is ready, then the bake’s frames through its effect', () => {
    const { history, layer, effect } = setup()
    const sequence = () => history.state.sequence
    const at = (t: number) => videoLayersAt(sequence(), history.state.media, s(t))
    bakeStore.clear()
    const live = at(3).find((l) => l.clip.adjustment)!
    expect(live.clip.effects[0]!.effectId).toBe('datamosh')
    expect(live.temporal).not.toBeNull()
    const keysBefore = frameKeys(sequence(), history.state.media, null).keys
    const key = bakeKey(sequence(), history.state.media, null, layer(), effect().id)
    const item = { ...media('bake'), id: `bake:${key}`, path: '/cache/bakes/x.mp4' }
    bakeStore.set({ key, path: item.path, item, frames: 100 })
    const layers = at(3)
    const baked = layers.find((l) => l.clip.adjustment)!
    expect(baked.clip.effects[0]!.effectId).toBe('datamosh-bake')
    expect(baked.clip.effects[0]!.params['bakeKey']).toBe(key)
    expect(baked.temporal).toBeNull()
    const source = layers.find((l) => l.motionFor)!
    expect(source.item!.id).toBe(item.id)
    expect(baked.motion?.[effect().id]).toBe(source.motionFor)
    // 3 s is 1 s into the span (it starts at 2 s).
    expect(source.sourceTime).toBe(s(1))
    // Cached frames know which bake they show.
    expect(frameKeys(sequence(), history.state.media, null).keys[75]).not.toBe(keysBefore[75])
    bakeStore.clear()
    expect(withBakes(sequence(), history.state.media, null, layer(), layer()).baked).toHaveLength(0)
  })

  it('renders what an adjustment layer’s bake sees: the tracks beneath alone', () => {
    const { history, layer, effect } = setup()
    const input = bakeInputSequence(history.state.sequence, layer(), effect().id, { width: 1920, height: 1080 })!
    expect(input.clips.filter((c) => c.kind === 'video').map((c) => c.mediaId).sort()).toEqual(['m-a', 'm-b'])
  })

  it('renders what a clip’s bake sees: the clip upright on its own frame with the effects above the bake', () => {
    const { history, run, V1 } = setup()
    const a = () => history.state.sequence.clips.find((x) => x.mediaId === 'm-a')!
    run(addEffect([a().id], 'invert', null, ids))
    run(addEffect([a().id], 'datamosh-bake', null, ids))
    run(addEffect([a().id], 'grain', null, ids))
    run(setClipProperties([a().id], { opacity: 40 }))
    const bake = a().effects[1]!
    const input = bakeInputSequence(history.state.sequence, a(), bake.id, { width: 1280, height: 720 })!
    expect(input.settings).toMatchObject({ width: 1280, height: 720 })
    const own = input.clips.find((c) => c.id === a().id)!
    expect(own.effects.map((e) => e.effectId)).toEqual(['invert'])
    expect(own).toMatchObject({ opacity: 100, motion: { positionX: 640, positionY: 360, scale: 100, rotation: 0 } })
    expect(input.clips.filter((c) => c.kind === 'video')).toHaveLength(1)
    const source = motionSourceSequence(history.state.sequence, a(), V1, { width: 1280, height: 720 })!
    expect(source.clips.every((c) => c.effects.length === 0 && c.opacity === 100)).toBe(true)
    expect(source.tracks.find((t) => t.id === V1)!.visible).toBe(true)
  })
})
