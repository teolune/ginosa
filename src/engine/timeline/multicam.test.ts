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

describe('favourites and Automatic (W5.4–W5.5)', () => {
  /** Takes A, B, C synced over 0–20 s on V1–V3, and D (B-roll) on a fourth track; a group of all four. 120 BPM: a bar is 2 s. */
  async function auto() {
    const { addFavourite, removeFavourites, setBRoll, setFavourite } = await import('./multicam-edits')
    const { addTrack } = await import('../project/commands')
    const { applyAutomatic, planAutomatic } = await import('./multicam-auto')
    const history = new History(createProject({ name: 'Auto', createId: ids }))
    history.dispatch(importMedia([media('a', 30), media('b', 30), media('c', 30), media('d', 30)]))
    history.dispatch(addTrack('video', ids))
    const video = history.state.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
    const run = <T extends TimelineCommand>(command: T): T => {
      if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
      return command
    }
    ;['a', 'b', 'c', 'd'].forEach((m, i) => run(placeMedia({ mediaId: `m-${m}`, sourceIn: 0, sourceOut: s(20), at: 0, videoTrackId: video[i]!, audioTrackId: null, mode: 'overwrite' }, ids)))
    const take = (m: string) => history.state.sequence.clips.find((c) => c.mediaId === `m-${m}` && !c.multicam)!
    const made = run(newMulticamGroup(['a', 'b', 'c', 'd'].map((m) => take(m).id), ids))
    const group = () => history.state.sequence.multicam[0]!
    const angle = (key: string) => group().angles.find((a) => a.key === key)!.id
    return { history, run, take, made, group, angle, addFavourite, removeFavourites, setBRoll, setFavourite, applyAutomatic, planAutomatic }
  }

  it('marks favourites on whole frames inside the take, moves and deletes them', async () => {
    const { history, run, take, made, angle, addFavourite, setFavourite, removeFavourites, group } = await auto()
    const fav = run(addFavourite(made.groupId, angle('1'), take('a').id, s(5.011), s(1)))
    expect(group().angles[0]!.favourites).toEqual([{ id: fav.favouriteId, clipId: take('a').id, from: s(1), to: s(5) }])
    run(setFavourite(made.groupId, angle('1'), fav.favouriteId, s(2), s(40)))
    // Kept inside the take (it ends at 20 s).
    expect(group().angles[0]!.favourites[0]).toMatchObject({ from: s(2), to: s(20) })
    run(removeFavourites(made.groupId, angle('1'), [fav.favouriteId]))
    expect(group().angles[0]!.favourites).toEqual([])
    expect(history.state.sequence.multicam).toHaveLength(1)
  })

  it('a synced take’s favourites fall on its frames as they are on the timeline', async () => {
    const { history, made, angle, addFavourite } = await auto()
    const { produce } = await import('immer')
    // The take's file starts a little between frames (as a sync by sound puts it).
    const a = history.state.sequence.clips.find((c) => c.mediaId === 'm-a' && !c.multicam)!
    const project = produce(history.state, (draft) => {
      draft.sequence.clips.find((c) => c.id === a.id)!.sourceIn = 1234
    })
    const next = produce(project, (draft) => addFavourite(made.groupId, angle('1'), a.id, 1234 + s(1.01), 1234 + s(2)).apply(draft))
    const f = next.sequence.multicam[0]!.angles.find((x) => x.key === '1')!.favourites[0]!
    expect([f.from - 1234, f.to - 1234]).toEqual([s(1), s(2)])
  })

  it('cuts every bar between the favourites, never the same angle twice when there’s another, and lists what nothing covers', async () => {
    const { history, run, take, made, angle, addFavourite, setBRoll, applyAutomatic, planAutomatic, group } = await auto()
    run(addFavourite(made.groupId, angle('1'), take('a').id, 0, s(5)))
    run(addFavourite(made.groupId, angle('2'), take('b').id, s(3), s(9)))
    run(addFavourite(made.groupId, angle('3'), take('c').id, s(8), s(14)))
    const plan = planAutomatic(history.state.sequence, made.groupId, { from: 0, to: s(16), everyBeats: 4, bRoll: false })
    const keyOf = (id: string | null) => group().angles.find((a) => a.id === id)?.key ?? null
    expect(plan.map((p) => [p.kind, p.from / s(1), p.to / s(1), p.kind === 'gap' ? keyOf(p.holdAngleId) : keyOf(p.angleId)])).toEqual([
      ['synced', 0, 4, '1'],
      ['synced', 4, 8, '2'],
      ['synced', 8, 14, '3'],
      ['gap', 14, 16, '3']
    ])
    // B-roll on: D's favourite (its own 2–6 s) fills the gap, from its start.
    run(setBRoll(made.groupId, angle('4'), true))
    run(addFavourite(made.groupId, angle('4'), take('d').id, s(2), s(6)))
    const withBRoll = planAutomatic(history.state.sequence, made.groupId, { from: 0, to: s(16), everyBeats: 4, bRoll: true })
    expect(withBRoll[3]).toMatchObject({ kind: 'broll', from: s(14), to: s(16), sourceIn: s(2) })
    run(applyAutomatic(made.groupId, withBRoll, ids))
    const pieces = history.state.sequence.clips.filter((c) => c.trackId === group().programTrackId).sort((a, b) => a.start - b.start)
    expect(pieces.map((p) => [p.mediaId, p.start / s(1), (p.start + p.duration) / s(1), p.sourceIn / s(1)])).toEqual([
      ['m-a', 0, 4, 0],
      ['m-b', 4, 8, 4],
      ['m-c', 8, 14, 8],
      ['m-d', 14, 16, 2]
    ])
  })

  it('a favourite that ends partway cuts on the beat before it ends', async () => {
    const { history, run, take, made, angle, addFavourite, planAutomatic } = await auto()
    run(addFavourite(made.groupId, angle('1'), take('a').id, 0, s(3.3)))
    run(addFavourite(made.groupId, angle('2'), take('b').id, s(2), s(8)))
    const plan = planAutomatic(history.state.sequence, made.groupId, { from: 0, to: s(8), everyBeats: 8, bRoll: false })
    // A to the beat at 3 s (it ends at 3.3), then B; at 120 BPM a beat is 0.5 s.
    expect(plan.map((p) => [p.kind, p.from / s(1), p.to / s(1)])).toEqual([
      ['synced', 0, 3],
      ['synced', 3, 8]
    ])
  })

  it('B-roll fills only what nothing synced covers, runs on from where it was left, and the last synced angle holds after it', async () => {
    const { history, run, take, made, angle, addFavourite, setBRoll, setFavourite, planAutomatic, group } = await auto()
    run(addFavourite(made.groupId, angle('1'), take('a').id, 0, s(6.3)))
    run(addFavourite(made.groupId, angle('2'), take('b').id, s(6), s(13.2)))
    // C's starts off the beat (13.6 s): it comes in on the next beat, 14 s.
    run(addFavourite(made.groupId, angle('3'), take('c').id, s(13.6), s(17)))
    run(setBRoll(made.groupId, angle('4'), true))
    const d = run(addFavourite(made.groupId, angle('4'), take('d').id, s(2), s(5.5)))
    const keyOf = (id: string | null) => group().angles.find((a) => a.id === id)?.key ?? null
    const show = () =>
      planAutomatic(history.state.sequence, made.groupId, { from: 0, to: s(20), everyBeats: 4, bRoll: true }).map((p) =>
        p.kind === 'broll' ? ['broll', p.from / s(1), p.to / s(1), p.sourceIn / s(1)] : [p.kind, p.from / s(1), p.to / s(1), p.kind === 'gap' ? keyOf(p.holdAngleId) : keyOf(p.angleId)]
      )
    // D's 3.5 s: 1 s at 13 s, then on from 3 s at 17 s, trimmed to the beat at 19.5 s (on a frame at 25 fps: 19.52); C holds the rest.
    expect(show()).toEqual([
      ['synced', 0, 6, '1'],
      ['synced', 6, 13, '2'],
      ['broll', 13, 14, 2],
      ['synced', 14, 17, '3'],
      ['broll', 17, 19.52, 3],
      ['gap', 19.52, 20, '3']
    ])
    // Less B-roll: it runs out at 18 s.
    run(setFavourite(made.groupId, angle('4'), d.favouriteId, s(2), s(4)))
    expect(show()).toEqual([
      ['synced', 0, 6, '1'],
      ['synced', 6, 13, '2'],
      ['broll', 13, 14, 2],
      ['synced', 14, 17, '3'],
      ['broll', 17, 18, 3],
      ['gap', 18, 20, '3']
    ])
  })

  it('a drag that marks a favourite and changes it is one undo step', async () => {
    const { history, run, take, made, angle, addFavourite, setFavourite, group } = await auto()
    const fav = run(addFavourite(made.groupId, angle('1'), take('a').id, s(1), s(2), ids, 'drag-1'))
    run(setFavourite(made.groupId, angle('1'), fav.favouriteId, s(1), s(3), 'drag-1'))
    run(setFavourite(made.groupId, angle('1'), fav.favouriteId, s(1), s(4), 'drag-1'))
    expect(group().angles[0]!.favourites[0]).toMatchObject({ from: s(1), to: s(4) })
    history.undo()
    expect(group().angles[0]!.favourites).toEqual([])
  })
})
