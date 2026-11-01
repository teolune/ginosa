import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { copyClips, pasteClips, placeMedia, splitClips, type TimelineCommand } from '../timeline/edits'
import { addAdjustmentLayer, addEffect } from '../timeline/effect-edits'
import {
  addMask,
  addMaskLink,
  addShape,
  addShapeKeyframe,
  duplicateMask,
  linkMaskToAudio,
  maskLinksTo,
  maskUsers,
  moveShape,
  removeMask,
  removeShape,
  removeShapeKeyframes,
  setClipMask,
  setEffectMask,
  setPathPoints,
  setShapeAnimated,
  setShapeInverted,
  setShapeMode,
  setShapeValues
} from '../timeline/mask-edits'
import { addAudioSource } from '../timeline/audio-edits'
import { addModulator, removeModulator } from '../timeline/modulation-edits'
import { videoLayersAt } from '../timeline/render-plan'
import type { ModulationContext } from '../modulation/types'
import { flattenPath, maskAlpha, newShape, packMask, PART_VEC4S, resolveMask, resolveShape, shapeValueAt, type ResolvedShape } from './masks'
import type { Mask, MaskShape } from './types'

const s = secondsToTicks
let counter = 0
const ids = () => `mk-${++counter}`
const frame = { width: 1920, height: 1080 }

function shape(kind: MaskShape['kind'], changes: Partial<MaskShape> = {}): MaskShape {
  return { ...newShape(ids(), kind, frame), feather: 0, ...changes }
}
const resolved = (...shapes: MaskShape[]): ResolvedShape[] => resolveMask({ id: 'm', name: 'M', shapes }, 0)
const alpha = (shapes: ResolvedShape[], x: number, y: number, luma = 0.5, aa = 1) => maskAlpha(shapes, x, y, luma, frame, aa)

describe('mask shapes', () => {
  it('a rectangle: 1 inside, 0 outside, half on its edge; feather spreads evenly across it', () => {
    const r = resolved(shape('rectangle', { position: [500, 400], size: [200, 100] }))
    expect(alpha(r, 500, 400)).toBe(1)
    expect(alpha(r, 700, 400)).toBe(0)
    expect(alpha(r, 600, 400)).toBeCloseTo(0.5, 9)
    const soft = resolved(shape('rectangle', { position: [500, 400], size: [200, 100], feather: 40 }))
    expect(alpha(soft, 580, 400)).toBe(1)
    expect(alpha(soft, 620, 400)).toBe(0)
    expect(alpha(soft, 610, 400) + alpha(soft, 590, 400)).toBeCloseTo(1, 9)
    // Expansion grows it; rotation turns it (90°: now 100 wide, 200 tall).
    expect(alpha(resolved(shape('rectangle', { position: [500, 400], size: [200, 100], expansion: 20 })), 620, 400)).toBeCloseTo(0.5, 9)
    const turned = resolved(shape('rectangle', { position: [500, 400], size: [200, 100], rotation: 90 }))
    expect(alpha(turned, 500, 490)).toBe(1)
    expect(alpha(turned, 560, 400)).toBe(0)
  })

  it('an ellipse: half on its edge along both axes', () => {
    const e = resolved(shape('ellipse', { position: [960, 540], size: [400, 200] }))
    expect(alpha(e, 960, 540)).toBe(1)
    expect(alpha(e, 1160, 540)).toBeCloseTo(0.5, 6)
    expect(alpha(e, 960, 640)).toBeCloseTo(0.5, 6)
    expect(alpha(e, 1100, 620)).toBe(0)
  })

  it('a straight pen path is the same as the rectangle it draws', () => {
    const corners = [
      [-100, -50],
      [100, -50],
      [100, 50],
      [-100, 50]
    ].map(([x, y]) => ({ x: x!, y: y!, inX: 0, inY: 0, outX: 0, outY: 0 }))
    const path = resolved(shape('path', { position: [500, 400], points: corners, feather: 12 }))
    const rect = resolved(shape('rectangle', { position: [500, 400], size: [200, 100], feather: 12 }))
    for (const [x, y] of [[500, 400], [598, 400], [603, 410], [500, 449], [650, 470], [380, 300]]) expect(alpha(path, x!, y!)).toBeCloseTo(alpha(rect, x!, y!), 9)
  })

  it('a bezier pen path follows its curve (four points with circle handles make a circle)', () => {
    const k = 0.5523 * 100
    const points = [
      { x: 100, y: 0, inX: 0, inY: -k, outX: 0, outY: k },
      { x: 0, y: 100, inX: k, inY: 0, outX: -k, outY: 0 },
      { x: -100, y: 0, inX: 0, inY: k, outX: 0, outY: -k },
      { x: 0, y: -100, inX: -k, inY: 0, outX: k, outY: 0 }
    ]
    const polygon = flattenPath(points)
    expect(polygon.length / 2).toBeGreaterThan(40)
    for (let i = 0; i < polygon.length; i += 2) expect(Math.hypot(polygon[i]!, polygon[i + 1]!)).toBeCloseTo(100, -0.5)
    const circle = resolved(shape('path', { position: [960, 540], points, scale: 150 }))
    expect(alpha(circle, 960 + 149, 540)).toBeGreaterThan(0.9)
    expect(alpha(circle, 960 + 151, 540)).toBeLessThan(0.1)
  })

  it('edge mask: from the frame edges inwards; luminance range: by the brightness underneath', () => {
    const edge = resolved(shape('edge', { width: 100, feather: 20 }))
    expect(alpha(edge, 0.5, 540)).toBe(1)
    expect(alpha(edge, 100, 540)).toBeCloseTo(0.5, 9)
    expect(alpha(edge, 1820, 540)).toBeCloseTo(0.5, 9)
    expect(alpha(edge, 960, 540)).toBe(0)
    const lum = resolved(shape('luminance', { low: 40, high: 80, softness: 10 }))
    expect(alpha(lum, 0, 0, 0.6)).toBe(1)
    expect(alpha(lum, 0, 0, 0.2)).toBe(0)
    expect(alpha(lum, 0, 0, 0.35)).toBeCloseTo(0.5, 9)
    expect(alpha(lum, 0, 0, 0.85)).toBeCloseTo(0.5, 9)
  })

  it('shapes combine in order: add, subtract, intersect; invert and opacity per shape', () => {
    const left = shape('rectangle', { position: [400, 540], size: [400, 400] })
    const right = shape('rectangle', { position: [700, 540], size: [400, 400] })
    const both = resolved(left, right)
    expect([alpha(both, 300, 540), alpha(both, 550, 540), alpha(both, 800, 540), alpha(both, 1000, 540)]).toEqual([1, 1, 1, 0])
    const cut = resolved(left, { ...right, mode: 'subtract' })
    expect([alpha(cut, 300, 540), alpha(cut, 550, 540), alpha(cut, 800, 540)]).toEqual([1, 0, 0])
    const overlap = resolved(left, { ...right, mode: 'intersect' })
    expect([alpha(overlap, 300, 540), alpha(overlap, 550, 540), alpha(overlap, 800, 540)]).toEqual([0, 1, 0])
    // Subtracting first takes away from the whole frame.
    const hole = resolved({ ...left, mode: 'subtract' })
    expect([alpha(hole, 400, 540), alpha(hole, 1500, 540)]).toEqual([0, 1])
    expect(alpha(resolved({ ...left, invert: true }), 400, 540)).toBe(0)
    expect(alpha(resolved({ ...left, opacity: 40 }), 400, 540)).toBeCloseTo(0.4, 9)
    // No shapes: everywhere.
    expect(alpha([], 5, 5)).toBe(1)
  })

  it('values come from keyframes (sequence time) then modulation, clamped', () => {
    const sh = shape('edge', {
      keyframes: {
        width: [
          { id: 'a', time: s(1), value: 100, interpolation: 'linear', in: { t: 1 / 3, v: [0] }, out: { t: 1 / 3, v: [0] } },
          { id: 'b', time: s(3), value: 300, interpolation: 'linear', in: { t: 1 / 3, v: [0] }, out: { t: 1 / 3, v: [0] } }
        ]
      },
      modulation: { opacity: [{ id: 'l', modulatorId: 'mod', mode: 'add', min: [0], max: [-80], invert: false, amount: 100 }] }
    })
    expect(shapeValueAt(sh, 'width', s(2))).toBeCloseTo(200, 9)
    const ctx: ModulationContext = { value: () => 1 }
    expect(shapeValueAt(sh, 'opacity', s(2), ctx)).toBe(20)
    expect(shapeValueAt(sh, 'opacity', s(2), { value: () => null })).toBe(100)
    expect(resolveShape(sh, s(2), ctx).opacity).toBeCloseTo(0.2, 9)
    // An edge that widens on every bass hit: modulated far past its range, clamped.
    const wide = { ...sh, modulation: { width: [{ id: 'w', modulatorId: 'mod', mode: 'add' as const, min: [0], max: [1e9], invert: false, amount: 100 }] } }
    expect(shapeValueAt(wide, 'width', s(2), ctx)).toBe(10_000)
  })

  it('packs shapes and pen-path edges for the GPU', () => {
    const r = resolved(shape('rectangle', { rotation: 30 }), shape('path'), shape('luminance'))
    const { data, parts } = packMask(r)
    expect(parts).toBe(3)
    const edges = r[1]!.polygon!.length / 2
    expect(data.length).toBe((3 * PART_VEC4S + edges) * 4)
    expect(Array.from(data.slice(0, 4))).toEqual([0, 0, 0, 1])
    expect(data[12]).toBeCloseTo(Math.cos(Math.PI / 6), 6)
    // The path's edges start after the shapes; each holds the previous point and this one.
    const pathAt = PART_VEC4S * 4
    expect([data[pathAt + 8], data[pathAt + 9]]).toEqual([3 * PART_VEC4S, edges])
    const first = 3 * PART_VEC4S * 4
    const p = r[1]!.polygon!
    expect(Array.from(data.slice(first, first + 4))).toEqual([p[p.length - 2], p[p.length - 1], p[0], p[1]])
  })
})

function media(name: string): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: 20,
    bitRate: null,
    video: { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: 500, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' }
  }
  return { id: `m-${name}`, name, kind: 'video', path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-11-01T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

function setup() {
  const history = new History(createProject({ name: 'Masks', createId: ids }))
  history.dispatch(importMedia([media('clip')]))
  const tracks = history.state.sequence.tracks
  const [V1, V2] = tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const A1 = tracks.find((t) => t.kind === 'audio')!.id
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: 'm-clip', sourceIn: 0, sourceOut: s(10), at: 0, videoTrackId: V1!, audioTrackId: A1, mode: 'overwrite' }, ids))
  run(addAdjustmentLayer({ trackId: V2!, start: 0, duration: s(10) }, ids))
  const video = () => history.state.sequence.clips.find((c) => c.kind === 'video' && !c.adjustment)!
  const adjustment = () => history.state.sequence.clips.find((c) => c.adjustment)!
  run(addEffect([video().id, adjustment().id], 'invert', null, ids))
  const masks = () => history.state.sequence.masks
  return { history, run, video, adjustment, masks }
}

describe('mask commands', () => {
  it('one mask drives several effects and an adjustment layer; deleting it frees them', () => {
    const { history, run, video, adjustment, masks } = setup()
    const made = run(addMask('ellipse', null, ids))
    expect(masks()[0]).toMatchObject({ name: 'Mask 1', shapes: [{ kind: 'ellipse', position: [960, 540], size: [540, 540] }] })
    run(setEffectMask(video().id, video().effects[0]!.id, { id: made.maskId, invert: false }))
    run(setEffectMask(adjustment().id, adjustment().effects[0]!.id, { id: made.maskId, invert: true }))
    run(setClipMask(adjustment().id, { id: made.maskId, invert: false }))
    const audio = history.state.sequence.clips.find((c) => c.kind === 'audio')!
    expect(() => history.dispatch(setClipMask(audio.id, { id: made.maskId, invert: false }))).toThrow(/Only video clips/)
    expect(maskUsers(history.state.sequence, made.maskId)).toHaveLength(3)
    // A plain clip's own mask (where it shows) can follow the clip; an adjustment layer's can't.
    run(setClipMask(video().id, { id: made.maskId, invert: false, followClip: true }))
    expect(video().mask).toEqual({ id: made.maskId, invert: false, followClip: true })
    expect(maskUsers(history.state.sequence, made.maskId)).toHaveLength(4)
    history.undo()
    // The render plan works each used mask out once per frame.
    const layers = videoLayersAt(history.state.sequence, history.state.media, s(1))
    expect(layers).toHaveLength(2)
    expect(layers[0]!.masks).toBe(layers[1]!.masks)
    expect([...layers[0]!.masks.byId.keys()]).toEqual([made.maskId])
    const removed = run(removeMask(made.maskId))
    expect(removed.notice).toMatch(/3 times/)
    expect(video().effects[0]!.mask).toBeNull()
    expect(adjustment().mask).toBeNull()
    history.undo()
    expect(adjustment().mask).toEqual({ id: made.maskId, invert: false })
  })

  it('Follow clip is kept on a clip’s effect, dropped where there’s no Motion, and saved', () => {
    const { history, run, video, adjustment } = setup()
    const { maskId } = run(addMask('ellipse', null, ids))
    run(setEffectMask(video().id, video().effects[0]!.id, { id: maskId, invert: false, followClip: true }))
    run(setEffectMask(adjustment().id, adjustment().effects[0]!.id, { id: maskId, invert: false, followClip: true }))
    run(setClipMask(adjustment().id, { id: maskId, invert: true, followClip: true }))
    expect(video().effects[0]!.mask).toEqual({ id: maskId, invert: false, followClip: true })
    expect(adjustment().effects[0]!.mask).toEqual({ id: maskId, invert: false })
    expect(adjustment().mask).toEqual({ id: maskId, invert: true })
    expect(parseProject(serializeProject(history.state)).sequence.clips).toEqual(history.state.sequence.clips)
  })

  it('shapes are added, ordered, combined, inverted and removed', () => {
    const { run, masks } = setup()
    const { maskId, shapeId } = run(addMask('rectangle', 'Frame', ids))
    const second = run(addShape(maskId, 'edge', ids))
    run(setShapeMode(maskId, second.shapeId, 'subtract'))
    run(setShapeInverted(maskId, shapeId, true))
    run(moveShape(maskId, second.shapeId, 0))
    expect(masks()[0]!.shapes.map((x) => [x.kind, x.mode, x.invert])).toEqual([
      ['edge', 'subtract', false],
      ['rectangle', 'add', true]
    ])
    run(removeShape(maskId, shapeId))
    expect(masks()[0]!.shapes).toHaveLength(1)
  })

  it('settings change in place, or keyframe at sequence time once the stopwatch is on', () => {
    const { history, run, masks } = setup()
    const { maskId, shapeId } = run(addMask('rectangle', null, ids))
    const sh = () => masks()[0]!.shapes[0]!
    run(setShapeValues(maskId, shapeId, { position: [100, 200], size: [50, 60] }, s(1), ids))
    expect([sh().position, sh().size]).toEqual([[100, 200], [50, 60]])
    expect(() => history.dispatch(setShapeValues(maskId, shapeId, { width: 5 }, 0))).toThrow(/no Width/)
    run(setShapeValues(maskId, shapeId, { feather: 1e9 }, 0))
    expect(sh().feather).toBe(2000)
    run(setShapeAnimated({ maskId, shapeId, param: 'rotation' }, true, s(1), ids))
    run(setShapeValues(maskId, shapeId, { rotation: 90 }, s(3), ids))
    run(addShapeKeyframe({ maskId, shapeId, param: 'rotation' }, s(2), ids))
    expect(sh().keyframes['rotation']!.map((k) => [k.time, k.value])).toEqual([
      [s(1), 0],
      [s(2), 45],
      [s(3), 90]
    ])
    run(removeShapeKeyframes({ maskId, shapeId, param: 'rotation' }, [sh().keyframes['rotation']![1]!.id]))
    run(setShapeAnimated({ maskId, shapeId, param: 'rotation' }, false, s(2.4)))
    expect(sh().keyframes['rotation']).toBeUndefined()
    expect(sh().rotation).toBeCloseTo(63, 9)
  })

  it('pen paths need three points; duplicates are deep copies', () => {
    const { history, run, masks } = setup()
    const { maskId, shapeId } = run(addMask('path', null, ids))
    expect(() => history.dispatch(setPathPoints(maskId, shapeId, masks()[0]!.shapes[0]!.points.slice(0, 2)))).toThrow(/three points/)
    const points = masks()[0]!.shapes[0]!.points.map((p) => ({ ...p, outX: 10 }))
    run(setPathPoints(maskId, shapeId, points))
    const copy = run(duplicateMask(maskId, ids))
    expect(masks().map((m) => m.name)).toEqual(['Mask 1', 'Mask 1 copy'])
    const copied = masks().find((m) => m.id === copy.maskId)!
    expect(copied.shapes[0]!.points).toEqual(points)
    expect(copied.shapes[0]!.id).not.toBe(shapeId)
  })

  it('mask settings link to audio and modulators; removing a modulator unlinks them', () => {
    const { history, run, masks } = setup()
    const A1 = history.state.sequence.tracks.find((t) => t.kind === 'audio')!.id
    const song = run(addAudioSource('track', A1, 'Song', ids))
    const { maskId, shapeId } = run(addMask('edge', null, ids))
    run(linkMaskToAudio({ maskId, shapeId, param: 'width' }, song.sourceId, 'level', 'bass', s(1), ids))
    const mod = history.state.sequence.modulators[0]!
    expect(mod.name).toBe('Song · Bass')
    const link = masks()[0]!.shapes[0]!.modulation['width']![0]!
    expect(link).toMatchObject({ mode: 'add', min: [0] })
    expect(link.max[0]).toBeGreaterThan(0)
    const lfo = run(addModulator({ kind: 'lfo', shape: 'sine', rate: '1/4', seed: 1 }, 'Wobble', ids))
    run(addMaskLink({ maskId, shapeId, param: 'feather' }, lfo.modulatorId, s(1), {}, ids))
    expect(maskLinksTo(history.state.sequence, mod.id).map((l) => l.ref.param)).toEqual(['width'])
    run(removeModulator(mod.id))
    expect(Object.keys(masks()[0]!.shapes[0]!.modulation)).toEqual(['feather'])
  })

  it('masks and references survive splits, copy and paste, saving, and older projects', () => {
    const { history, run, video, adjustment, masks } = setup()
    const { maskId } = run(addMask('rectangle', null, ids))
    run(setEffectMask(video().id, video().effects[0]!.id, { id: maskId, invert: true }))
    run(setClipMask(adjustment().id, { id: maskId, invert: false }))
    run(splitClips([video().id], s(5), ids))
    const halves = history.state.sequence.clips.filter((c) => c.kind === 'video' && !c.adjustment)
    expect(halves.every((c) => c.effects[0]!.mask?.id === maskId && c.effects[0]!.mask.invert)).toBe(true)
    const reopened = parseProject(serializeProject(history.state))
    expect(reopened.sequence.masks).toEqual(masks())
    expect(reopened.sequence.clips).toEqual(history.state.sequence.clips)
    // A reference to a mask that isn't there is dropped when opening.
    const raw = JSON.parse(serializeProject(history.state)) as { sequence: { masks: Mask[] } }
    raw.sequence.masks = []
    const orphaned = parseProject(JSON.stringify(raw))
    expect(orphaned.sequence.clips.every((c) => c.mask === null && c.effects.every((e) => e.mask === null))).toBe(true)
    // Copy, delete the mask, paste: the pasted clip lets go of it.
    const clipboard = copyClips(history.state.sequence, [adjustment().id])
    run(removeMask(maskId))
    run(pasteClips(clipboard, s(12), 'overwrite', ids))
    expect(history.state.sequence.clips.filter((c) => c.adjustment).every((c) => c.mask === null)).toBe(true)
    // Projects from before masks open with none.
    const v9 = JSON.parse(serializeProject(history.state)) as { schemaVersion: number; sequence: Record<string, unknown> & { clips: Array<Record<string, unknown> & { effects: Array<Record<string, unknown>> }> } }
    v9.schemaVersion = 9
    delete v9.sequence['masks']
    for (const c of v9.sequence.clips) {
      delete c['mask']
      for (const e of c.effects) delete e['mask']
    }
    const migrated = parseProject(JSON.stringify(v9))
    expect(migrated.sequence.masks).toEqual([])
    expect(migrated.sequence.clips.every((c) => c.mask === null)).toBe(true)
  })
})
