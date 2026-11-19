import { describe, expect, it } from 'vitest'
import { effectById } from '../../effects/registry'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { secondsToTicks } from '../time'
import { placeMedia, type TimelineCommand } from './edits'
import { addAdjustmentLayer, addEffect } from './effect-edits'
import { addRackRows, STARTER_ROWS } from './rack-edits'
import { addChannelEffect, channelEffects, linkableValues, linkToChannel, mainParam, unlinkFromChannel } from './rack-links'
import { sequenceEnd } from './timeline'

let counter = 0
const ids = () => `rl-${++counter}`
const s = (n: number) => secondsToTicks(n)

const info = {
  container: 'mov',
  durationSeconds: 30,
  bitRate: null,
  video: { codec: 'hevc', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: 750, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: null }, hdr: null, variableFrameRate: false },
  audio: null
} as unknown as MediaInfo
const A: MediaItem = { id: 'm-a', name: 'a', kind: 'video', path: '/f/a', fingerprint: { size: 1, mtimeMs: 1, sample: 'a' }, info, binId: null, importedAt: '2026-11-20T00:00:00Z', marks: { in: null, out: null }, colour: { input: null } } as unknown as MediaItem

function setup() {
  const history = new History(createProject({ name: 'Links', createId: ids }))
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  history.dispatch(importMedia([A]))
  const tracks = history.state.sequence.tracks
  const [V1, V2, V3] = tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string, string]
  const A1 = tracks.find((t) => t.kind === 'audio')!.id
  run(placeMedia({ mediaId: A.id, sourceIn: 0, sourceOut: s(12), at: 0, videoTrackId: V1, audioTrackId: A1, mode: 'overwrite' }, ids))
  run(addRackRows([STARTER_ROWS[0]!], ids))
  const kick = history.state.sequence.rack.rows[0]!.id
  const clip = () => history.state.sequence.clips.find((c) => c.kind === 'video' && !c.adjustment)!
  return { history, run, V1, V2, V3, kick, clip }
}

describe('a Channel Rack channel’s effects (decision 129)', () => {
  it('lists the values linked to a channel by effect, links one already there, and unlinks in one step', () => {
    const { history, run, kick, clip } = setup()
    run(addEffect([clip().id], 'mosaic', null, ids))
    const mosaic = clip().effects[0]!.id
    expect(channelEffects(history.state.sequence, kick)).toEqual([])
    expect(linkableValues(clip(), mosaic).map((v) => v.param)).toEqual(['cellSize', 'aspect', 'softness', 'mix'])
    expect(linkableValues(clip(), null).map((v) => v.label)).toEqual(['Position', 'Scale', 'Scale Width', 'Rotation', 'Anchor Point', 'Opacity'])
    const link = run(linkToChannel(kick, { clipId: clip().id, effectId: mosaic, param: 'cellSize' }, 0, ids))
    expect(link.label).toBe('Link to Kick')
    run(linkToChannel(kick, { clipId: clip().id, effectId: mosaic, param: 'softness' }, 0, ids))
    run(linkToChannel(kick, { clipId: clip().id, effectId: null, param: 'scale' }, 0, ids))
    const groups = channelEffects(history.state.sequence, kick)
    expect(groups.map((g) => [g.name, g.values.map((v) => v.label)])).toEqual([
      ['Motion', ['Scale']],
      ['Mosaic', ['Cell Size', 'Edge Softness']]
    ])
    // Linking the same value twice is refused.
    expect(() => history.dispatch(linkToChannel(kick, { clipId: clip().id, effectId: mosaic, param: 'cellSize' }, 0, ids))).toThrow(/already linked/)
    // The whole of Mosaic's links go in one undo step.
    run(unlinkFromChannel(groups[1]!.values.map((v) => ({ ref: v.ref, linkId: v.link.id }))))
    expect(channelEffects(history.state.sequence, kick).map((g) => g.name)).toEqual(['Motion'])
    history.undo()
    expect(channelEffects(history.state.sequence, kick).map((g) => g.name)).toEqual(['Motion', 'Mosaic'])
  })

  it('adds a new effect to the selected clip with its main value linked', () => {
    const { history, run, kick, clip } = setup()
    expect(mainParam(effectById('basic-correction')!)).toBe('exposure')
    expect(mainParam(effectById('mosaic')!)).toBe('cellSize')
    expect(mainParam(effectById('transform')!)).toBe('scale')
    const added = run(addChannelEffect({ rowId: kick, effectId: 'basic-correction', clipIds: [clip().id], at: 0 }, ids))
    expect(added.label).toBe('Add Basic Correction to Kick')
    expect(added.clipIds).toEqual([clip().id])
    expect(clip().effects.map((e) => e.effectId)).toEqual(['basic-correction'])
    expect(channelEffects(history.state.sequence, kick).map((g) => [g.name, g.values.map((v) => v.ref.param)])).toEqual([['Basic Correction', ['exposure']]])
    // Another value chosen in the window.
    run(addChannelEffect({ rowId: kick, effectId: 'grain', param: 'size', clipIds: [clip().id], at: 0 }, ids))
    expect(channelEffects(history.state.sequence, kick)[1]!.values[0]!.ref.param).toBe('size')
    history.undo()
    history.undo()
    expect(clip().effects).toEqual([])
  })

  it('with nothing selected, puts the effect on a new adjustment layer over the whole song, above everything', () => {
    const { history, run, kick, V2, V3 } = setup()
    // V2 is free, but V3, the top track, is busy at 3 s: the layer goes on a new V4.
    run(addAdjustmentLayer({ trackId: V3, start: s(3), duration: s(1) }, ids))
    expect(V2).toBeTruthy()
    const before = history.state.sequence.tracks.length
    const added = run(addChannelEffect({ rowId: kick, effectId: 'mosaic', clipIds: [], at: 0 }, ids))
    const sequence = history.state.sequence
    expect(sequence.tracks.length).toBe(before + 1)
    const layer = sequence.clips.find((c) => c.id === added.clipIds[0])!
    expect(layer).toMatchObject({ adjustment: true, start: 0, name: 'Kick: Mosaic', trackId: sequence.tracks.filter((t) => t.kind === 'video').at(-1)!.id })
    expect(layer.duration).toBe(sequenceEnd({ ...sequence, clips: sequence.clips.filter((c) => c.id !== layer.id) }))
    expect(channelEffects(sequence, kick).map((g) => [g.clip.id, g.name])).toEqual([[layer.id, 'Mosaic']])
    history.undo()
    expect(history.state.sequence.tracks.length).toBe(before)
  })
})
