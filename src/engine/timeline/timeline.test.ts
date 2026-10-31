import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { setSequenceSettings, setTrackFlag, removeTrack, CommandError } from '../project/commands'
import { importMedia, removeMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject, type Clip } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '../time'
import {
  addMarker,
  copyClips,
  deleteClips,
  limitRippleTrim,
  limitTrim,
  linkClips,
  moveClips,
  moveMarker,
  pasteClips,
  placeMedia,
  removeMarkers,
  renameMarker,
  rippleDeleteClips,
  rippleDeleteGap,
  rippleTrimClips,
  rollEdit,
  splitAllTracks,
  splitClips,
  trimClips,
  unlinkClips,
  type EditMode,
  type TimelineCommand
} from './edits'
import { clipEnd, clipsOnTrack, editPoints, gapAt, topVideoClipAt, withLinked } from './timeline'
import { snapDelta, snapTime, snapTargets } from './snapping'

let counter = 0
const ids = () => `id-${++counter}`
const F = ticksPerFrame(FRAME_RATES['25'])
const s = (seconds: number) => secondsToTicks(seconds)

const cameraInfo: MediaInfo = {
  container: 'mov',
  durationSeconds: 10,
  bitRate: null,
  video: {
    codec: 'hevc',
    profile: null,
    width: 1920,
    height: 1080,
    rotation: 0,
    frameRate: { num: 25, den: 1 },
    frameCount: 250,
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    colour: { primaries: null, transfer: null, matrix: null, range: 'tv' },
    hdr: null,
    variableFrameRate: false,
    keyframeInterval: 1
  },
  audio: { codec: 'aac', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' }
}

function media(name: string, kind: MediaItem['kind'], seconds: number): MediaItem {
  const info = structuredClone(cameraInfo)
  info.durationSeconds = seconds
  if (kind === 'audio') info.video = null
  if (kind === 'image') info.audio = null
  return {
    id: `m-${name}`,
    name,
    kind,
    path: `/footage/${name}`,
    fingerprint: { size: 1, mtimeMs: 1, sample: name },
    info,
    binId: null,
    importedAt: '2026-10-31T00:00:00.000Z',
    marks: { in: null, out: null }
  }
}

const CAMERA = media('camera', 'video', 10)
const SONG = media('song', 'audio', 60)
const STILL = media('still', 'image', 0)

function setup() {
  const history = new History(createProject({ name: 'Timeline test', createId: ids }))
  history.dispatch(importMedia([CAMERA, SONG, STILL]))
  const tracks = history.state.sequence.tracks
  const [V1, V2, V3] = tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string, string]
  const [A1, A2, A3] = tracks.filter((t) => t.kind === 'audio').map((t) => t.id) as [string, string, string]
  return { history, V1, V2, V3, A1, A2, A3 }
}

type Setup = ReturnType<typeof setup>

function run(history: History, command: TimelineCommand): TimelineCommand {
  const change = history.dispatch(command)
  if (!change) throw new Error(`${command.label} changed nothing`)
  return command
}

function place(t: Setup, mediaId: string, at: number, opts: { v?: string | null; a?: string | null; mode?: EditMode; inS?: number; outS?: number } = {}) {
  return run(
    t.history,
    placeMedia(
      {
        mediaId,
        sourceIn: s(opts.inS ?? 0),
        sourceOut: opts.outS === undefined ? null : s(opts.outS),
        at: s(at),
        videoTrackId: opts.v === undefined ? t.V1 : opts.v,
        audioTrackId: opts.a === undefined ? t.A1 : opts.a,
        mode: opts.mode ?? 'overwrite'
      },
      ids
    )
  )
}

const clips = (t: Setup, trackId: string) => clipsOnTrack(t.history.state.sequence, trackId)
/** [start, end] in seconds for each clip on a track, in order. */
const layout = (t: Setup, trackId: string) => clips(t, trackId).map((c) => [c.start / s(1), clipEnd(c) / s(1)])
const sourceInS = (c: Clip) => c.sourceIn / s(1)

describe('placing media', () => {
  it('puts a camera clip and its sound on V1/A1, linked, as one undo step', () => {
    const t = setup()
    place(t, CAMERA.id, 2)
    const [video] = clips(t, t.V1)
    const [audio] = clips(t, t.A1)
    expect(video).toMatchObject({ kind: 'video', start: s(2), duration: s(10), sourceIn: 0, name: 'camera' })
    expect(audio).toMatchObject({ kind: 'audio', start: s(2), duration: s(10) })
    expect(video!.linkId).not.toBeNull()
    expect(video!.linkId).toBe(audio!.linkId)
    expect(t.history.undoLabel).toBe('Overwrite')
    t.history.undo()
    expect(t.history.state.sequence.clips).toEqual([])
  })

  it('uses Source Monitor marks and lands on whole frames', () => {
    const t = setup()
    place(t, CAMERA.id, 1.013, { inS: 2, outS: 5.03 })
    const [video] = clips(t, t.V1)
    expect(video!.sourceIn).toBe(s(2))
    expect(video!.duration).toBe(s(3)) // 3.03 s floors to 75 frames
    expect(video!.start % F).toBe(0)
  })

  it('places stills for 5 seconds and songs as audio only', () => {
    const t = setup()
    place(t, STILL.id, 0)
    place(t, SONG.id, 0, { v: null })
    expect(layout(t, t.V1)).toEqual([[0, 5]])
    expect(layout(t, t.A1)).toEqual([[0, 60]])
    expect(clips(t, t.A1)[0]!.linkId).toBeNull()
    expect(() => t.history.dispatch(placeMedia({ mediaId: SONG.id, sourceIn: 0, sourceOut: null, at: 0, videoTrackId: t.V1, audioTrackId: null, mode: 'overwrite' }, ids))).toThrow(CommandError)
  })

  it('overwrites: trims, splits or removes whatever is underneath', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null }) // 0-10
    place(t, CAMERA.id, 3, { a: null, outS: 2 }) // 3-5 over the middle
    expect(layout(t, t.V1)).toEqual([[0, 3], [3, 5], [5, 10]])
    const after = clips(t, t.V1)[2]!
    expect(sourceInS(after)).toBe(5) // the right half continues where it was
    place(t, CAMERA.id, 2, { a: null, outS: 4 }) // 2-6 swallows the 3-5 clip
    expect(layout(t, t.V1)).toEqual([[0, 2], [2, 6], [6, 10]])
  })

  it('inserts: pushes later clips and splits clips on sync-locked tracks', () => {
    const t = setup()
    place(t, SONG.id, 0, { v: null, a: t.A2 }) // song on A2, sync-locked by default
    place(t, CAMERA.id, 0, { a: null }) // 0-10
    const command = place(t, CAMERA.id, 4, { a: null, outS: 2, mode: 'insert' })
    expect(layout(t, t.V1)).toEqual([[0, 4], [4, 6], [6, 12]])
    expect(layout(t, t.A2)).toEqual([[0, 4], [6, 62]])
    expect(command.notice).toMatch(/Sync Lock split 1 clip on A2/)
  })

  it('leaves tracks alone when Sync Lock is off or they are locked', () => {
    const t = setup()
    place(t, SONG.id, 0, { v: null, a: t.A2 })
    place(t, SONG.id, 0, { v: null, a: t.A3 })
    run(t.history, setTrackFlag(t.A2, 'syncLock', false))
    run(t.history, setTrackFlag(t.A3, 'locked', true))
    place(t, CAMERA.id, 0, { a: null })
    place(t, CAMERA.id, 4, { a: null, outS: 2, mode: 'insert' })
    expect(layout(t, t.A2)).toEqual([[0, 60]])
    expect(layout(t, t.A3)).toEqual([[0, 60]])
  })

  it('refuses locked destination tracks', () => {
    const t = setup()
    run(t.history, setTrackFlag(t.V1, 'locked', true))
    expect(() => place(t, CAMERA.id, 0)).toThrow(/V1 is locked/)
  })
})

describe('moving clips', () => {
  it('moves linked clips together and overwrites at the destination', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { outS: 4 }) // 0-4
    place(t, CAMERA.id, 6, { outS: 4 }) // 6-10
    const first = clips(t, t.V1)[0]!
    run(t.history, moveClips({ clipIds: withLinked(t.history.state.sequence, [first.id]), delta: s(4), trackOffset: 0, mode: 'overwrite', copy: false }))
    expect(layout(t, t.V1)).toEqual([[4, 8], [8, 10]])
    expect(layout(t, t.A1)).toEqual([[4, 8], [8, 10]])
  })

  it('moves picture up and sound down together (Premiere mirrors around the middle)', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    const all = t.history.state.sequence.clips.map((c) => c.id)
    run(t.history, moveClips({ clipIds: all, delta: 0, trackOffset: 1, mode: 'overwrite', copy: false }))
    expect(layout(t, t.V2)).toEqual([[0, 10]])
    expect(layout(t, t.A2)).toEqual([[0, 10]])
    expect(() => t.history.dispatch(moveClips({ clipIds: all, delta: 0, trackOffset: 5, mode: 'overwrite', copy: false }))).toThrow(/no track/)
    expect(() => t.history.dispatch(moveClips({ clipIds: all, delta: -s(1), trackOffset: 0, mode: 'overwrite', copy: false }))).toThrow(/before the start/)
  })

  it('insert-moves (Cmd-drag), pushing later clips on sync-locked tracks', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, outS: 2 }) // 0-2
    place(t, CAMERA.id, 5, { a: null }) // 5-15
    place(t, SONG.id, 10, { v: null, a: t.A2 }) // 10-70
    const first = clips(t, t.V1)[0]!
    run(t.history, moveClips({ clipIds: [first.id], delta: s(5), trackOffset: 0, mode: 'insert', copy: false }))
    expect(layout(t, t.V1)).toEqual([[5, 7], [7, 17]])
    expect(layout(t, t.A2)).toEqual([[12, 72]])
  })

  it('copies with Option-drag, keeping the originals and linking the copies to each other', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { outS: 2 })
    const both = t.history.state.sequence.clips.map((c) => c.id)
    run(t.history, moveClips({ clipIds: both, delta: s(3), trackOffset: 0, mode: 'overwrite', copy: true }, ids))
    expect(layout(t, t.V1)).toEqual([[0, 2], [3, 5]])
    const [original, copy] = clips(t, t.V1)
    const copyAudio = clips(t, t.A1)[1]!
    expect(copy!.id).not.toBe(original!.id)
    expect(copy!.linkId).toBe(copyAudio.linkId)
    expect(copy!.linkId).not.toBe(original!.linkId)
    expect(t.history.undoLabel).toBe('Copy 2 Clips')
  })
})

describe('trimming', () => {
  it('stops a regular trim at neighbours, the media and one frame', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, inS: 1, outS: 4 }) // 0-3, source 1-4
    place(t, CAMERA.id, 5, { a: null, inS: 3, outS: 5 }) // 5-7, source 3-5
    const seq = () => t.history.state.sequence
    const [first] = clips(t, t.V1)
    expect(limitTrim(seq(), t.history.state.media, [first!.id], 'out', s(10))).toBe(s(2)) // stops at the next clip
    expect(limitTrim(seq(), t.history.state.media, [first!.id], 'in', -s(10))).toBe(0) // already at the sequence start
    expect(limitTrim(seq(), t.history.state.media, [first!.id], 'in', s(10))).toBe(s(3) - F) // keeps one frame
    const second = clips(t, t.V1)[1]!
    expect(limitTrim(seq(), t.history.state.media, [second.id], 'out', s(20))).toBe(s(5)) // media ends at 10 s
    expect(limitTrim(seq(), t.history.state.media, [second.id], 'in', -s(20))).toBe(-s(2)) // previous clip ends at 3
    run(t.history, trimClips({ clipIds: [first!.id], edge: 'in', delta: s(1) }))
    expect(layout(t, t.V1)[0]).toEqual([1, 3])
    expect(sourceInS(clips(t, t.V1)[0]!)).toBe(2)
  })

  it('trims linked picture and sound together', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    const all = t.history.state.sequence.clips.map((c) => c.id)
    run(t.history, trimClips({ clipIds: all, edge: 'out', delta: -s(4) }))
    expect(layout(t, t.V1)).toEqual([[0, 6]])
    expect(layout(t, t.A1)).toEqual([[0, 6]])
  })

  it('ripple trims a tail: later clips follow, on sync-locked tracks too', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, outS: 4 }) // 0-4
    place(t, CAMERA.id, 4, { a: null, outS: 3 }) // 4-7
    place(t, CAMERA.id, 6, { v: t.V2, a: null, outS: 2 }) // V2 6-8
    const [first] = clips(t, t.V1)
    run(t.history, rippleTrimClips({ clipIds: [first!.id], edge: 'out', delta: -s(1) }, ids))
    expect(layout(t, t.V1)).toEqual([[0, 3], [3, 6]])
    expect(layout(t, t.V2)).toEqual([[5, 7]])
    run(t.history, rippleTrimClips({ clipIds: [first!.id], edge: 'out', delta: s(2) }, ids))
    expect(layout(t, t.V1)).toEqual([[0, 5], [5, 8]])
    expect(layout(t, t.V2)).toEqual([[7, 9]])
  })

  it('ripple trims a head: the clip stays put and its content slides', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, outS: 4 }) // 0-4
    place(t, CAMERA.id, 4, { a: null, outS: 3 }) // 4-7
    const [first] = clips(t, t.V1)
    run(t.history, rippleTrimClips({ clipIds: [first!.id], edge: 'in', delta: s(1) }, ids))
    expect(layout(t, t.V1)).toEqual([[0, 3], [3, 6]])
    expect(sourceInS(clips(t, t.V1)[0]!)).toBe(1)
  })

  it('limits a shortening ripple when a sync-locked track has a clip in the way', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, outS: 4 })
    place(t, SONG.id, 0, { v: null, a: t.A1 }) // the song spans the edit point
    const [first] = clips(t, t.V1)
    expect(limitRippleTrim(t.history.state.sequence, t.history.state.media, [first!.id], 'out', -s(2))).toBe(0)
    run(t.history, setTrackFlag(t.A1, 'syncLock', false))
    expect(limitRippleTrim(t.history.state.sequence, t.history.state.media, [first!.id], 'out', -s(2))).toBe(-s(2))
  })

  it('rolls the cut between touching clips without moving anything else', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { inS: 2, outS: 6 }) // 0-4, source 2-6, with sound
    place(t, CAMERA.id, 4, { inS: 3, outS: 6 }) // 4-7, source 3-6
    const [left] = clips(t, t.V1)
    run(t.history, rollEdit({ clipId: left!.id, edge: 'out', delta: s(1) }))
    expect(layout(t, t.V1)).toEqual([[0, 5], [5, 7]])
    expect(layout(t, t.A1)).toEqual([[0, 5], [5, 7]]) // linked sound rolled too
    expect(sourceInS(clips(t, t.V1)[1]!)).toBe(4)
    // The right clip can only reveal 4 s more of its media, so the cut stops at 1 s.
    run(t.history, rollEdit({ clipId: left!.id, edge: 'out', delta: -s(20) }))
    expect(layout(t, t.V1)).toEqual([[0, 1], [1, 7]])
    expect(sourceInS(clips(t, t.V1)[1]!)).toBe(0)
    // And forward, the left clip's media (source 2-10) allows 8 s, but the right clip keeps one frame.
    run(t.history, rollEdit({ clipId: left!.id, edge: 'out', delta: s(20) }))
    expect(clips(t, t.V1)[1]!.duration).toBe(F)
  })
})

describe('splitting and deleting', () => {
  it('splits at the playhead, keeping linked halves linked in pairs', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    const all = t.history.state.sequence.clips.map((c) => c.id)
    run(t.history, splitClips(all, s(4), ids))
    const [vLeft, vRight] = clips(t, t.V1)
    const [aLeft, aRight] = clips(t, t.A1)
    expect(layout(t, t.V1)).toEqual([[0, 4], [4, 10]])
    expect(sourceInS(vRight!)).toBe(4)
    expect(vLeft!.linkId).toBe(aLeft!.linkId)
    expect(vRight!.linkId).toBe(aRight!.linkId)
    expect(vRight!.linkId).not.toBe(vLeft!.linkId)
    expect(() => t.history.dispatch(splitClips(all, s(4), ids))).toThrow(/no clip to split/)
  })

  it('adds an edit on every unlocked track', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    place(t, SONG.id, 0, { v: null, a: t.A2 })
    run(t.history, setTrackFlag(t.A2, 'locked', true))
    run(t.history, splitAllTracks(s(3), ids))
    expect(clips(t, t.V1)).toHaveLength(2)
    expect(clips(t, t.A1)).toHaveLength(2)
    expect(clips(t, t.A2)).toHaveLength(1)
  })

  it('deletes leaving a gap, or ripple deletes closing it', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, outS: 2 })
    place(t, CAMERA.id, 2, { a: null, outS: 3 })
    place(t, CAMERA.id, 5, { a: null, outS: 1 })
    const [, middle, last] = clips(t, t.V1)
    run(t.history, deleteClips([last!.id]))
    expect(layout(t, t.V1)).toEqual([[0, 2], [2, 5]])
    t.history.undo()
    run(t.history, rippleDeleteClips([middle!.id]))
    expect(layout(t, t.V1)).toEqual([[0, 2], [2, 3]])
  })

  it('refuses a ripple delete that would knock a sync-locked song out of sync, until its Sync Lock is off', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, outS: 2 })
    place(t, CAMERA.id, 2, { a: null, outS: 3 })
    place(t, SONG.id, 0, { v: null, a: t.A1 })
    const first = clips(t, t.V1)[0]!
    expect(() => t.history.dispatch(rippleDeleteClips([first.id]))).toThrow(/A1 has a clip in that time/)
    expect(clips(t, t.V1)).toHaveLength(2) // nothing changed
    run(t.history, setTrackFlag(t.A1, 'syncLock', false))
    run(t.history, rippleDeleteClips([first.id]))
    expect(layout(t, t.V1)).toEqual([[0, 3]])
    expect(layout(t, t.A1)).toEqual([[0, 60]])
  })

  it('ripple deletes linked picture and sound as one range', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { outS: 2 })
    place(t, CAMERA.id, 2, { outS: 2 })
    const first = withLinked(t.history.state.sequence, [clips(t, t.V1)[0]!.id])
    run(t.history, rippleDeleteClips(first))
    expect(layout(t, t.V1)).toEqual([[0, 2]])
    expect(layout(t, t.A1)).toEqual([[0, 2]])
  })

  it('finds and ripple deletes gaps', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, outS: 2 })
    place(t, CAMERA.id, 5, { a: null, outS: 2 })
    const gap = gapAt(t.history.state.sequence, t.V1, s(3))
    expect(gap).toEqual({ start: s(2), end: s(5) })
    expect(gapAt(t.history.state.sequence, t.V1, s(1))).toBeNull()
    expect(gapAt(t.history.state.sequence, t.V1, s(9))).toBeNull()
    run(t.history, rippleDeleteGap(t.V1, gap!.start, gap!.end))
    expect(layout(t, t.V1)).toEqual([[0, 2], [2, 4]])
  })
})

describe('links, clipboard and markers', () => {
  it('unlinks and relinks', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    const all = t.history.state.sequence.clips.map((c) => c.id)
    run(t.history, unlinkClips(all))
    expect(withLinked(t.history.state.sequence, [all[0]!])).toEqual([all[0]])
    run(t.history, linkClips(all, ids))
    expect(withLinked(t.history.state.sequence, [all[0]!]).sort()).toEqual([...all].sort())
  })

  it('pastes at the playhead, overwriting or inserting', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { outS: 2 })
    place(t, CAMERA.id, 2, { outS: 3 })
    const first = withLinked(t.history.state.sequence, [clips(t, t.V1)[0]!.id])
    const board = copyClips(t.history.state.sequence, first)
    run(t.history, pasteClips(board, s(1), 'overwrite', ids))
    expect(layout(t, t.V1)).toEqual([[0, 1], [1, 3], [3, 5]])
    const pasted = clips(t, t.V1)[1]!
    expect(pasted.linkId).toBe(clips(t, t.A1)[1]!.linkId)
    run(t.history, pasteClips(board, 0, 'insert', ids))
    expect(layout(t, t.V1)).toEqual([[0, 2], [2, 3], [3, 5], [5, 7]])
  })

  it('adds, moves, renames and deletes markers on frames', () => {
    const t = setup()
    const add = addMarker(s(1.01), ids)
    run(t.history, add)
    const marker = t.history.state.sequence.markers[0]!
    expect(marker.time % F).toBe(0)
    expect(() => t.history.dispatch(addMarker(s(1.01), ids))).toThrow(/already a marker/)
    run(t.history, moveMarker(marker.id, s(3)))
    run(t.history, renameMarker(marker.id, '  Drop  '))
    expect(t.history.state.sequence.markers[0]).toMatchObject({ time: s(3), name: 'Drop' })
    run(t.history, removeMarkers([marker.id]))
    expect(t.history.state.sequence.markers).toEqual([])
  })
})

describe('the rest of the project follows', () => {
  it('removes clips with their media or track, and keeps the frame rate fixed once clips exist', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    place(t, SONG.id, 20, { v: null, a: t.A2 })
    expect(() => t.history.dispatch(setSequenceSettings({ frameRate: '30' }))).toThrow(/frame rate can’t change/)
    run(t.history, removeTrack(t.A2))
    expect(t.history.state.sequence.clips).toHaveLength(2)
    run(t.history, removeMedia([CAMERA.id]))
    expect(t.history.state.sequence.clips).toHaveLength(0)
  })

  it('undoes a ripple delete back to exactly the previous state', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { outS: 2 })
    place(t, CAMERA.id, 2, { outS: 3 })
    const before = structuredClone(t.history.state)
    run(t.history, rippleDeleteClips(withLinked(t.history.state.sequence, [clips(t, t.V1)[0]!.id])))
    t.history.undo()
    expect(t.history.state).toEqual(before)
  })

  it('saves and loads clips and markers; older projects gain sync lock and solo', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    run(t.history, addMarker(s(2), ids))
    expect(parseProject(serializeProject(t.history.state))).toEqual(t.history.state)
    const v2 = JSON.parse(serializeProject(createProject({ name: 'Old', createId: ids })))
    v2.schemaVersion = 2
    for (const track of v2.sequence.tracks) {
      delete track.syncLock
      delete track.solo
    }
    delete v2.sequence.clips
    delete v2.sequence.markers
    const upgraded = parseProject(v2)
    expect(upgraded.sequence.tracks.every((tr) => tr.syncLock && !tr.solo)).toBe(true)
    expect(upgraded.sequence.clips).toEqual([])
  })

  it('rejects clips that point at missing media', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    const broken = JSON.parse(serializeProject(t.history.state))
    broken.media = broken.media.filter((m: MediaItem) => m.id !== CAMERA.id)
    expect(() => parseProject(broken)).toThrow(/media that isn't in the project/)
  })
})

describe('what the program monitor shows', () => {
  it('picks the highest visible video track, honouring solo', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null })
    place(t, STILL.id, 2, { v: t.V2, a: null })
    const at = (seconds: number) => topVideoClipAt(t.history.state.sequence, s(seconds))?.mediaId ?? null
    expect(at(1)).toBe(CAMERA.id)
    expect(at(3)).toBe(STILL.id)
    expect(at(12)).toBeNull()
    run(t.history, setTrackFlag(t.V2, 'visible', false))
    expect(at(3)).toBe(CAMERA.id)
    run(t.history, setTrackFlag(t.V2, 'visible', true))
    run(t.history, setTrackFlag(t.V1, 'solo', true))
    expect(at(3)).toBe(CAMERA.id)
  })

  it('tells you when removing media also removes its clips', () => {
    const t = setup()
    place(t, CAMERA.id, 0)
    const command = removeMedia([CAMERA.id])
    run(t.history, command)
    expect(command.notice).toMatch(/Also removed 2 clips/)
  })
})

describe('snapping and edit points', () => {
  it('lists edit points and snaps times and drags to the nearest target', () => {
    const t = setup()
    place(t, CAMERA.id, 0, { a: null, outS: 2 })
    place(t, CAMERA.id, 5, { a: null, outS: 2 })
    const seq = t.history.state.sequence
    expect(editPoints(seq)).toEqual([0, s(2), s(5), s(7)])
    const targets = snapTargets(seq, { playhead: s(3.5), exclude: new Set() })
    expect(targets).toEqual([0, s(2), s(3.5), s(5), s(7)])
    expect(snapTime(s(2.1), targets, s(0.2))).toEqual({ time: s(2), target: s(2) })
    expect(snapTime(s(4), targets, s(0.2))).toEqual({ time: s(4), target: null })
    // Dragging a 0-2 clip by 2.9 s: its end (4.9) is closest to 5.
    expect(snapDelta([0, s(2)], s(2.9), targets, s(0.2))).toEqual({ delta: s(3), target: s(5) })
  })
})
