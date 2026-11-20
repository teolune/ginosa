import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { secondsToTicks } from '../time'
import { placeMedia, type TimelineCommand } from './edits'
import { placeInSync, syncPlacement } from './sync-edits'

const s = secondsToTicks
let counter = 0
const ids = () => `sy-${++counter}`

function media(name: string, seconds: number, video: boolean): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: seconds,
    bitRate: null,
    video: video ? { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: seconds * 25, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 } : null,
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo' }
  }
  return { id: `m-${name}`, name, kind: video ? 'video' : 'audio', path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-11-01T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

function setup(songAt = 0, songIn = 0) {
  const history = new History(createProject({ name: 'Sync', createId: ids }))
  history.dispatch(importMedia([media('song', 60, false), media('take', 20, true)]))
  const video = history.state.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const audio = history.state.sequence.tracks.filter((t) => t.kind === 'audio').map((t) => t.id)
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: 'm-song', sourceIn: s(songIn), sourceOut: s(60), at: s(songAt), videoTrackId: null, audioTrackId: audio[0]!, mode: 'overwrite' }, ids))
  run(placeMedia({ mediaId: 'm-take', sourceIn: 0, sourceOut: s(20), at: s(30), videoTrackId: video[1]!, audioTrackId: audio[1]!, mode: 'overwrite' }, ids))
  const song = () => history.state.sequence.clips.find((c) => c.mediaId === 'm-song')!
  const take = () => history.state.sequence.clips.find((c) => c.mediaId === 'm-take' && c.kind === 'video')!
  const takeSound = () => history.state.sequence.clips.find((c) => c.mediaId === 'm-take' && c.kind === 'audio')!
  return { history, run, song, take, takeSound }
}

describe('putting takes in sync with the song (W5.1)', () => {
  it('puts a take where the song is in it, on a frame, with sourceIn taking up the rest', () => {
    const { history, song, take } = setup()
    const at = (offset: number) => syncPlacement(history.state.sequence, history.state.media, song(), take(), offset)
    expect(at(5.2)).toEqual({ start: s(5.2), sourceIn: 0, duration: s(20) })
    // 5.217 s isn't on a frame: the next frame (5.24 s), 23 ms into the take.
    expect(at(5.217)).toMatchObject({ start: s(5.24), sourceIn: s(5.24) - s(5.217) })
    // The take started 1.5 s before the song: it starts with the sequence, 1.5 s in, and shorter
    // (18.48 s: the whole frames left in its 20 s from 1.5 s on).
    expect(at(-1.5)).toEqual({ start: 0, sourceIn: s(1.5), duration: s(18.48) })
  })

  it('follows the song clip’s own place and trim', () => {
    const { history, song, take } = setup(2, 1)
    // Song-file time 5.2 s plays at 2 − 1 + 5.2 = 6.2 s.
    expect(syncPlacement(history.state.sequence, history.state.media, song(), take(), 5.2)).toMatchObject({ start: s(6.2), sourceIn: 0 })
  })

  it('moves the take with its own sound, in one undo step', () => {
    const { history, run, song, take, takeSound } = setup()
    const place = syncPlacement(history.state.sequence, history.state.media, song(), take(), 5.217)
    if ('problem' in place) throw new Error(place.problem)
    run(placeInSync([{ clipId: take().id, ...place }]))
    expect(take()).toMatchObject({ start: s(5.24), sourceIn: s(5.24) - s(5.217) })
    expect(takeSound()).toMatchObject({ start: s(5.24), sourceIn: s(5.24) - s(5.217) })
    history.undo()
    expect(take().start).toBe(s(30))
  })

  it('won’t sync a sped-up or reversed take', () => {
    const { history, song, take } = setup()
    expect(syncPlacement(history.state.sequence, history.state.media, song(), { ...take(), speed: 2 }, 3)).toEqual({ problem: 'it isn’t at 100% speed forwards' })
  })
})
