import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { placeMedia, type TimelineCommand } from './edits'
import { addEffect } from './effect-edits'
import { anglePieces, newMulticamGroup, recordMulticam, removeMulticamGroup, setAngleKey, switchAngle } from './multicam-edits'
import { clipEnd } from './timeline'

const s = secondsToTicks
let counter = 0
const ids = () => `mc-${++counter}`

function media(name: string, seconds: number): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: seconds,
    bitRate: null,
    video: { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: seconds * 25, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' }
  }
  return { id: `m-${name}`, name, kind: 'video', path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-11-01T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

/** Three takes, synced: A on V1 from 0 (its file from 1 s), B on V2 from 0.4 s, C on V3 from 2 s to 5 s; each with its sound on A1–A3. */
function setup() {
  const history = new History(createProject({ name: 'Multi', createId: ids }))
  history.dispatch(importMedia([media('a', 20), media('b', 20), media('c', 20)]))
  const video = history.state.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const audio = history.state.sequence.tracks.filter((t) => t.kind === 'audio').map((t) => t.id)
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: 'm-a', sourceIn: s(1), sourceOut: s(11), at: 0, videoTrackId: video[0]!, audioTrackId: audio[0]!, mode: 'overwrite' }, ids))
  run(placeMedia({ mediaId: 'm-b', sourceIn: 0, sourceOut: s(10), at: s(0.4), videoTrackId: video[1]!, audioTrackId: audio[1]!, mode: 'overwrite' }, ids))
  run(placeMedia({ mediaId: 'm-c', sourceIn: 0, sourceOut: s(3), at: s(2), videoTrackId: video[2]!, audioTrackId: audio[2]!, mode: 'overwrite' }, ids))
  const take = (m: string) => history.state.sequence.clips.find((c) => c.mediaId === `m-${m}` && c.kind === 'video')!
  return { history, run, take, video, audio }
}

describe('multi-camera groups (W5.2)', () => {
  it('makes a group of the takes’ tracks, on 1, 2, 3, with a track for its pieces; the angles are hidden and their sound muted', () => {
    const { history, run, take, video, audio } = setup()
    const made = run(newMulticamGroup([take('a').id, take('b').id, take('c').id], ids))
    const group = history.state.sequence.multicam.find((g) => g.id === made.groupId)!
    expect(group.angles.map((a) => [a.trackId, a.key])).toEqual([
      [video[0], '1'],
      [video[1], '2'],
      [video[2], '3']
    ])
    const tracks = history.state.sequence.tracks
    expect(tracks.filter((t) => t.kind === 'video').map((t) => t.id).at(-1)).toBe(group.programTrackId)
    expect(tracks.filter((t) => video.includes(t.id)).every((t) => !t.visible)).toBe(true)
    expect(tracks.filter((t) => audio.includes(t.id)).every((t) => t.muted)).toBe(true)
  })

  it('records switches as pieces in sync with their takes, with the takes’ effects on them', () => {
    const { history, run, take } = setup()
    run(addEffect([take('c').id], 'invert', null, ids))
    const made = run(newMulticamGroup([take('a').id, take('b').id, take('c').id], ids))
    const group = () => history.state.sequence.multicam[0]!
    const angle = (key: string) => group().angles.find((a) => a.key === key)!.id
    run(recordMulticam(made.groupId, 0, s(6), [
      { at: 0, angleId: angle('1') },
      { at: s(2.4), angleId: angle('3') },
      { at: s(4), angleId: angle('2') }
    ], ids))
    const pieces = history.state.sequence.clips.filter((c) => c.trackId === group().programTrackId).sort((a, b) => a.start - b.start)
    expect(pieces.map((p) => [p.mediaId, p.start, clipEnd(p)])).toEqual([
      ['m-a', 0, s(2.4)],
      ['m-c', s(2.4), s(4)],
      ['m-b', s(4), s(6)]
    ])
    // The same frame at the same moment: A's file from 1 s at 0; C's from 0.4 s at 2.4 s (it starts at 2 s); B's from 3.6 s at 4 s.
    expect(pieces.map((p) => p.sourceIn)).toEqual([s(1), s(0.4), s(3.6)])
    expect(pieces[1]!.effects.map((e) => e.effectId)).toEqual(['invert'])
    expect(pieces.every((p) => p.multicam?.groupId === made.groupId)).toBe(true)
  })

  it('a stretch an angle has no take in stays empty', () => {
    const { history, run, take } = setup()
    const made = run(newMulticamGroup([take('a').id, take('c').id], ids))
    const group = history.state.sequence.multicam[0]!
    const c = group.angles.find((a) => a.key === '2')!
    expect(anglePieces(history.state.sequence, group, c, 0, s(6), ids).map((p) => [p.start, clipEnd(p)])).toEqual([[s(2), s(5)]])
    expect(made.groupId).toBe(group.id)
  })

  it('switches a piece’s angle, keeping effects added to the piece, in one undo step', () => {
    const { history, run, take } = setup()
    run(addEffect([take('a').id], 'mosaic', null, ids))
    const made = run(newMulticamGroup([take('a').id, take('b').id], ids))
    const group = () => history.state.sequence.multicam[0]!
    const angle = (key: string) => group().angles.find((a) => a.key === key)!.id
    run(recordMulticam(made.groupId, 0, s(4), [{ at: 0, angleId: angle('1') }], ids))
    const piece = () => history.state.sequence.clips.find((c) => c.trackId === group().programTrackId)!
    run(addEffect([piece().id], 'invert', null, ids))
    expect(piece().effects.map((e) => e.effectId)).toEqual(['mosaic', 'invert'])
    run(switchAngle([piece().id], angle('2'), ids))
    // B starts at 0.4 s: the piece shows it from there (before that, B has nothing).
    expect(piece()).toMatchObject({ mediaId: 'm-b', start: s(0.4), sourceIn: 0 })
    expect(piece().effects.map((e) => e.effectId)).toEqual(['invert'])
    history.undo()
    expect(piece().mediaId).toBe('m-a')
  })

  it('moves an angle to another key, swapping with the angle there; removing the group leaves the pieces', () => {
    const { history, run, take } = setup()
    const made = run(newMulticamGroup([take('a').id, take('b').id], ids))
    const group = () => history.state.sequence.multicam[0]!
    const a = group().angles[0]!.id
    run(setAngleKey(made.groupId, a, '2'))
    expect(group().angles.map((x) => x.key)).toEqual(['2', '1'])
    run(recordMulticam(made.groupId, 0, s(2), [{ at: 0, angleId: a }], ids))
    run(removeMulticamGroup(made.groupId))
    expect(history.state.sequence.multicam).toEqual([])
    expect(history.state.sequence.clips.filter((c) => c.mediaId === 'm-a' && c.kind === 'video').length).toBe(2)
    expect(history.state.sequence.clips.some((c) => c.multicam)).toBe(false)
  })

  it('saves and reads back groups and pieces; older projects get none', () => {
    const { history, run, take } = setup()
    const made = run(newMulticamGroup([take('a').id, take('b').id], ids))
    const angle = history.state.sequence.multicam[0]!.angles[1]!.id
    run(recordMulticam(made.groupId, s(1), s(3), [{ at: s(1), angleId: angle }], ids))
    const back = parseProject(serializeProject(history.state))
    expect(back.sequence.multicam).toEqual(history.state.sequence.multicam)
    expect(back.sequence.clips.find((c) => c.multicam)?.multicam).toEqual(history.state.sequence.clips.find((c) => c.multicam)?.multicam)
    const old = JSON.parse(serializeProject(history.state)) as { schemaVersion: number; sequence: Record<string, unknown> }
    old.schemaVersion = 14
    delete old.sequence['multicam']
    for (const c of old.sequence['clips'] as Array<Record<string, unknown>>) delete c['multicam']
    expect(parseProject(JSON.stringify(old)).sequence.multicam).toEqual([])
  })
})

describe('the multi-camera view (W5.3)', () => {
  it('shows each angle fitted in its cell, everything else hidden', async () => {
    const { multicamGrid, gridShape } = await import('./multicam-grid')
    const { history, run, take, video } = setup()
    run(newMulticamGroup([take('a').id, take('b').id, take('c').id], ids))
    const group = history.state.sequence.multicam[0]!
    expect([1, 4, 5, 9, 10, 11].map((n) => gridShape(n))).toEqual([
      { cols: 1, rows: 1 },
      { cols: 2, rows: 2 },
      { cols: 3, rows: 2 },
      { cols: 3, rows: 3 },
      { cols: 4, rows: 3 },
      { cols: 4, rows: 3 }
    ])
    const grid = multicamGrid(history.state.sequence, history.state.media, group)
    // The angles' tracks shown, the group's own track hidden.
    expect(grid.tracks.filter((t) => t.kind === 'video').map((t) => t.visible)).toEqual([true, true, true, false])
    // 3 angles: 2 × 2 cells of 960 × 540; a 1920 × 1080 take at 50%, centred in its cell.
    const c = grid.clips.find((x) => x.id === take('c').id)!
    expect(c.motion).toMatchObject({ positionX: 480, positionY: 810, scale: 50 })
    expect(video).toHaveLength(3)
  })
})
