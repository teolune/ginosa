import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { secondsToTicks } from '../time'
import { placeMedia, setClipProperties, type TimelineCommand } from '../timeline/edits'
import { addAdjustmentLayer, addEffect, setEffectValues } from '../timeline/effect-edits'
import { setAnimated, setValue } from '../timeline/keyframe-edits'
import { addMaskTo, setShapeValues } from '../timeline/mask-edits'
import { FrameKeyJob, frameKeys } from './frame-keys'

const s = secondsToTicks
let counter = 0
const ids = () => `fk-${++counter}`

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

/** A at 0–4 s on V1, B at 4–8 s on V1, an adjustment layer 2–6 s on V2. */
function setup() {
  const history = new History(createProject({ name: 'Keys', createId: ids }))
  history.dispatch(importMedia([media('a'), media('b')]))
  const [V1, V2] = history.state.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: s(4), at: 0, videoTrackId: V1!, audioTrackId: null, mode: 'overwrite' }, ids))
  run(placeMedia({ mediaId: 'm-b', sourceIn: 0, sourceOut: s(4), at: s(4), videoTrackId: V1!, audioTrackId: null, mode: 'overwrite' }, ids))
  run(addAdjustmentLayer({ trackId: V2!, start: s(2), duration: s(4) }, ids))
  const clip = (name: 'a' | 'b') => history.state.sequence.clips.find((c) => c.mediaId === `m-${name}`)!
  const layer = () => history.state.sequence.clips.find((c) => c.adjustment)!
  const keys = () => frameKeys(history.state.sequence, history.state.media, null)
  return { history, run, clip, layer, keys }
}

/** Frame numbers whose keys differ. */
function changed(a: string[], b: string[]): number[] {
  return a.flatMap((k, i) => (k !== b[i] ? [i] : []))
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

describe('render cache keys', () => {
  it('are the same for the same edit, and different on every frame of different pictures', () => {
    const { keys, run, layer } = setup()
    run(addEffect([layer().id], 'invert', null, ids))
    const first = keys()
    expect(first.keys).toHaveLength(200)
    expect(keys().keys).toEqual(first.keys)
    // Every frame of a video shows a different picture.
    expect(new Set(first.keys).size).toBe(200)
    // Effects (the adjustment layer's Invert) only from 2 s to 6 s.
    expect(range(0, 200).filter((j) => first.effects[j])).toEqual(range(50, 150))
  })

  it('an edit changes only the frames it changes', () => {
    const { keys, run, clip, layer, history } = setup()
    run(addEffect([layer().id], 'invert', null, ids))
    const before = keys().keys
    run(setClipProperties([clip('b').id], { opacity: 50 }))
    expect(changed(before, keys().keys)).toEqual(range(100, 200))
    history.undo()
    expect(keys().keys).toEqual(before)
    // A keyframe on the adjustment layer's effect at 3–4 s.
    const fx = layer().effects[0]!.id
    run(setAnimated({ clipId: layer().id, effectId: fx, param: 'amount' }, true, s(3)))
    run(setValue({ clipId: layer().id, effectId: fx, param: 'amount' }, 40, s(4)))
    // Before 3 s it holds the old value (100); after 4 s it holds 40.
    expect(changed(before, keys().keys)).toEqual(range(76, 150))
  })

  it('a mask edit changes the frames whose effect uses it, and nothing else', () => {
    const { keys, run, layer } = setup()
    run(addEffect([layer().id], 'invert', null, ids))
    const made = run(addMaskTo(layer().id, layer().effects[0]!.id, 'ellipse', ids))
    const before = keys().keys
    run(setShapeValues(made.maskId, made.shapeId, { feather: 80 }, 0))
    expect(changed(before, keys().keys)).toEqual(range(50, 150))
  })

  it('stateful effects: an edit changes every frame from there to the end of the effect', () => {
    const { keys, run, layer, clip } = setup()
    run(addEffect([layer().id], 'feedback', null, ids))
    const fx = layer().effects[0]!.id
    const before = keys().keys
    // A change to clip A at 3–4 s (beneath the layer) reaches its later frames through the feedback.
    run(setAnimated({ clipId: clip('a').id, effectId: null, param: 'opacity' }, true, s(3)))
    run(setValue({ clipId: clip('a').id, effectId: null, param: 'opacity' }, 50, s(3.6)))
    // Clip A changes from 3 s (75) to its end (100); through the feedback, the layer's later frames change too.
    expect(changed(before, keys().keys)).toEqual(range(76, 150))
    // The feedback's own amount from 5 s on.
    const second = keys().keys
    run(setAnimated({ clipId: layer().id, effectId: fx, param: 'amount' }, true, s(5)))
    run(setValue({ clipId: layer().id, effectId: fx, param: 'amount' }, 20, s(5.2)))
    expect(changed(second, keys().keys)).toEqual(range(126, 150))
    // A non-stateful edit before the layer doesn't reach after it ends.
    expect(changed(second, keys().keys).every((j) => j < 150)).toBe(true)
  })

  it('works out in slices with the same result', () => {
    const { history, run, layer, keys } = setup()
    run(addEffect([layer().id], 'feedback', null, ids))
    const job = new FrameKeyJob(history.state.sequence, history.state.media, null, 'test')
    let slices = 0
    while (!job.step(37)) slices++
    expect(slices).toBe(5)
    expect(job.keys).toEqual(keys().keys)
    // A different renderer version changes every key.
    expect(changed(frameKeys(history.state.sequence, history.state.media, null, 'other').keys, job.keys)).toHaveLength(200)
  })
})
