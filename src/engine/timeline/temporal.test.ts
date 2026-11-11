import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { setTrackFlag } from '../project/commands'
import { frameKeys } from '../render/frame-keys'
import { secondsToTicks } from '../time'
import { placeMedia, setClipProperties, splitClips, type TimelineCommand } from './edits'
import { addAdjustmentLayer, addEffect, removeEffects, setEffectValues } from './effect-edits'
import { addMaskTo, setShapeValues } from './mask-edits'
import { videoLayersAt } from './render-plan'
import { checkpointEvery, hasStatefulEffect, stateKey, stateLayers } from './temporal'

const s = secondsToTicks
let counter = 0
const ids = () => `tp-${++counter}`

function media(name: string): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: 20,
    bitRate: null,
    video: { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: 500, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 },
    audio: null
  }
  return { id: `m-${name}`, name, kind: 'video', path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-11-01T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

function setup() {
  const history = new History(createProject({ name: 'Time', createId: ids }))
  history.dispatch(importMedia([media('a'), media('b')]))
  const [V1, V2, V3] = history.state.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: s(10), at: s(2), videoTrackId: V1!, audioTrackId: null, mode: 'overwrite' }, ids))
  run(placeMedia({ mediaId: 'm-b', sourceIn: 0, sourceOut: s(4), at: s(20), videoTrackId: V3!, audioTrackId: null, mode: 'overwrite' }, ids))
  const clip = () => history.state.sequence.clips.find((c) => c.mediaId === 'm-a')!
  const other = () => history.state.sequence.clips.find((c) => c.mediaId === 'm-b')!
  return { history, run, clip, other, V2: V2! }
}

describe('stateful effects in the render plan', () => {
  it('counts frames from the clip’s first frame, keeps running while invisible, and checkpoints every second', () => {
    const { history, run, clip } = setup()
    expect(hasStatefulEffect(clip())).toBe(false)
    expect(videoLayersAt(history.state.sequence, history.state.media, s(3))[0]!.temporal).toBeNull()
    run(addEffect([clip().id], 'feedback', null, ids))
    expect(hasStatefulEffect(clip())).toBe(true)
    const at = (t: number) => videoLayersAt(history.state.sequence, history.state.media, s(t))
    expect(at(2)[0]!.temporal).toMatchObject({ frame: 0, resetAt: s(2) })
    expect(at(3.2)[0]!.temporal!.frame).toBe(30)
    expect(checkpointEvery(history.state.sequence)).toBe(25)
    // At 0% opacity the layer still renders (its state has to keep going).
    run(setClipProperties([clip().id], { opacity: 0 }))
    expect(at(3)).toHaveLength(1)
  })

  it('a split starts the right half from its own reset', () => {
    const { history, run, clip } = setup()
    run(addEffect([clip().id], 'feedback', null, ids))
    run(splitClips([clip().id], s(6), ids))
    const [layer] = videoLayersAt(history.state.sequence, history.state.media, s(6.4))
    expect(layer!.temporal).toMatchObject({ frame: 10, resetAt: s(6) })
  })

  it('a clip’s state key changes with the clip, its masks and modulators, not with other clips', () => {
    const { history, run, clip, other } = setup()
    run(addEffect([clip().id], 'feedback', null, ids))
    const key = () => stateKey(history.state.sequence, history.state.media, clip(), clip().start)
    const first = key()
    run(setClipProperties([other().id], { opacity: 50 }))
    expect(key()).toBe(first)
    run(setEffectValues(clip().id, clip().effects[0]!.id, { params: { amount: 40 } }))
    const second = key()
    expect(second).not.toBe(first)
    const made = run(addMaskTo(clip().id, clip().effects[0]!.id, 'ellipse', ids))
    const third = key()
    expect(third).not.toBe(second)
    run(setShapeValues(made.maskId, made.shapeId, { feather: 50 }, 0))
    expect(key()).not.toBe(third)
  })

  it('an adjustment layer’s state key changes with anything beneath it', () => {
    const { history, run, other, V2 } = setup()
    run(addAdjustmentLayer({ trackId: V2, start: 0, duration: s(30) }, ids))
    const layer = () => history.state.sequence.clips.find((c) => c.adjustment)!
    run(addEffect([layer().id], 'feedback', null, ids))
    const key = () => stateKey(history.state.sequence, history.state.media, layer(), 0)
    const first = key()
    run(setClipProperties([other().id], { opacity: 50 }))
    expect(key()).not.toBe(first)
    // The same edit gives the same key (it's content, not identity).
    history.undo()
    expect(key()).toBe(first)
  })

  it('motion transfer: the source track’s clips go in just before the layer, as shot, even while hidden (M14)', () => {
    const { history, run, clip, other } = setup()
    const V3 = history.state.sequence.tracks.filter((t) => t.kind === 'video')[2]!.id
    run(placeMedia({ mediaId: 'm-b', sourceIn: s(1), sourceOut: s(5), at: s(3), videoTrackId: V3, audioTrackId: null, mode: 'overwrite' }, ids))
    const source = () => history.state.sequence.clips.find((c) => c.trackId === V3 && c.start === s(3))!
    run(addEffect([clip().id], 'datamosh', null, ids))
    const effect = () => clip().effects[0]!
    run(setClipProperties([source().id], { opacity: 40 }))
    const at = (t: number) => videoLayersAt(history.state.sequence, history.state.media, s(t))
    // No source yet: just the clip and V3's own clip.
    expect(at(4).map((l) => l.motionFor ?? null)).toEqual([null, null])
    expect(at(4)[0]!.motion).toBeUndefined()
    const before = stateKey(history.state.sequence, history.state.media, clip(), clip().start)
    run(setEffectValues(clip().id, effect().id, { params: { motionSource: V3 } }))
    const key = `${clip().id}:${effect().id}`
    const layers = at(4)
    expect(layers.map((l) => l.motionFor ?? null)).toEqual([key, null, null])
    expect(layers[1]!.motion).toEqual({ [effect().id]: key })
    // As shot: no effects or mask, full opacity, normal blend; at the source clip's own time.
    expect(layers[0]!.clip).toMatchObject({ id: source().id, effects: [], mask: null, opacity: 100, blendMode: 'normal' })
    expect(layers[0]!.sourceTime).toBe(s(2))
    // Hiding V3 hides its own clip, not the motion source.
    run(setTrackFlag(V3, 'visible', false))
    expect(at(4).map((l) => l.motionFor ?? null)).toEqual([key, null])
    // Where V3 is empty the effect still reads it (nothing there: no motion).
    expect(at(8).map((l) => l.motionFor ?? null)).toEqual([null])
    expect(at(8)[0]!.motion).toEqual({ [effect().id]: key })
    // The state depends on the source track's clips…
    const withSource = stateKey(history.state.sequence, history.state.media, clip(), clip().start)
    expect(withSource).not.toBe(before)
    run(setClipProperties([source().id], { opacity: 60 }))
    expect(stateKey(history.state.sequence, history.state.media, clip(), clip().start)).not.toBe(withSource)
    // … and so does the render cache key of every frame from the source onwards.
    const keys = () => frameKeys(history.state.sequence, history.state.media, null).keys
    const first = keys()
    run(splitClips([source().id], s(5), ids))
    history.undo()
    expect(keys()).toEqual(first)
    run(setClipProperties([source().id], { motion: { positionX: 100 } }))
    const moved = keys()
    expect(moved[Math.round(4 * 25)]).not.toBe(first[Math.round(4 * 25)])
    expect(moved[Math.round(2.5 * 25)]).toBe(first[Math.round(2.5 * 25)])
    // A track that isn't in the sequence counts as none.
    run(setEffectValues(clip().id, effect().id, { params: { motionSource: 'gone' } }))
    expect(at(4).every((l) => !l.motionFor && !l.motion)).toBe(true)
    expect(other()).toBeDefined()
  })

  it('catching up renders only what feeds a state: layers beneath an adjustment layer whole, nothing above, no effects after the last stateful one', () => {
    const { history, run, clip, other, V2 } = setup()
    const V3 = history.state.sequence.tracks.filter((t) => t.kind === 'video')[2]!.id
    run(placeMedia({ mediaId: 'm-b', sourceIn: 0, sourceOut: s(4), at: s(3), videoTrackId: V3, audioTrackId: null, mode: 'overwrite' }, ids))
    const top = () => history.state.sequence.clips.find((c) => c.trackId === V3 && c.start === s(3))!
    run(addEffect([clip().id], 'grain', null, ids))
    run(addEffect([top().id], 'grain', null, ids))
    run(addAdjustmentLayer({ trackId: V2, start: 0, duration: s(30) }, ids))
    const layer = () => history.state.sequence.clips.find((c) => c.adjustment)!
    for (const id of ['curves', 'feedback', 'invert']) run(addEffect([layer().id], id, null, ids))
    const at = (t: number) => stateLayers(videoLayersAt(history.state.sequence, history.state.media, s(t)))
    // V1 whole (with its Grain), the adjustment layer up to Feedback; V3 above is skipped.
    const kept = at(4)
    expect(kept.map((l) => l.clip.id)).toEqual([clip().id, layer().id])
    expect(kept[0]!.clip.effects.map((e) => e.effectId)).toEqual(['grain'])
    expect(kept[1]!.clip.effects.map((e) => e.effectId)).toEqual(['curves', 'feedback'])
    // With Feedback on a clip instead, only that clip counts (its input is its own picture).
    run(removeEffects(layer().id, layer().effects.map((e) => e.id)))
    run(addEffect([top().id], 'feedback', null, ids))
    run(addEffect([top().id], 'invert', null, ids))
    const only = at(4)
    expect(only.map((l) => l.clip.id)).toEqual([top().id])
    expect(only[0]!.clip.effects.map((e) => e.effectId)).toEqual(['grain', 'feedback'])
    // Nothing stateful: nothing to render.
    expect(at(25)).toEqual([])
    expect(other()).toBeDefined()
  })
})

