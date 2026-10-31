import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { CommandError } from '../project/commands'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject, type Clip } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import {
  addCrossDissolveAt,
  addCrossDissolves,
  addFrameHold,
  placeMedia,
  removeTransition,
  setClipSpeed,
  setTransitionDuration,
  splitClips,
  trimClips,
  type TimelineCommand
} from './edits'
import { audioSegments, sourceTimeAt, videoLayersAt } from './render-plan'
import { clipEnd, frameTicks } from './timeline'

let counter = 0
const ids = () => `st-${++counter}`
const s = (n: number) => secondsToTicks(n)

function media(name: string, seconds = 30): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: seconds,
    bitRate: null,
    video: {
      codec: 'hevc',
      profile: null,
      width: 1920,
      height: 1080,
      rotation: 0,
      frameRate: { num: 25, den: 1 },
      frameCount: seconds * 25,
      pixelFormat: 'yuv420p',
      bitDepth: 8,
      colour: { primaries: null, transfer: null, matrix: null, range: 'tv' },
      hdr: null,
      variableFrameRate: false,
      keyframeInterval: 1
    },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' }
  }
  return { id: `m-${name}`, name, kind: 'video', path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-10-31T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

const A = media('a')
const B = media('b')
const SHORT = media('short', 4)

function setup() {
  const history = new History(createProject({ name: 'Speed', createId: ids }))
  history.dispatch(importMedia([A, B, SHORT]))
  const tracks = history.state.sequence.tracks
  const [V1, V2] = tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const [A1, A2] = tracks.filter((t) => t.kind === 'audio').map((t) => t.id) as [string, string]
  const run = (command: TimelineCommand) => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  const place = (item: MediaItem, at: number, inS: number, outS: number, v: string | null = V1, a: string | null = A1) =>
    run(placeMedia({ mediaId: item.id, sourceIn: s(inS), sourceOut: s(outS), at: s(at), videoTrackId: v, audioTrackId: a, mode: 'overwrite' }, ids))
  const clips = () => history.state.sequence.clips
  const video = (mediaId: string, n = 0) => clips().filter((c) => c.mediaId === mediaId && c.kind === 'video').sort((x, y) => x.start - y.start)[n]!
  const audio = (mediaId: string, n = 0) => clips().filter((c) => c.mediaId === mediaId && c.kind === 'audio').sort((x, y) => x.start - y.start)[n]!
  const layers = (at: number) => videoLayersAt(history.state.sequence, history.state.media, s(at))
  const frame = frameTicks(history.state.sequence)
  return { history, run, place, clips, video, audio, layers, frame, V1, V2, A1, A2 }
}

const pair = (clip: Clip, t: ReturnType<typeof setup>) => t.clips().filter((c) => c.id === clip.id || (clip.linkId && c.linkId === clip.linkId)).map((c) => c.id)

describe('source time with speed, reverse and holds', () => {
  const base = { id: 'c', kind: 'video', trackId: 't', mediaId: 'm', start: s(10), duration: s(4), sourceIn: s(2), speed: 1, reverse: false } as Clip
  const frame = s(1) / 25

  it('plays forwards at 100%, twice as fast at 200%', () => {
    expect(sourceTimeAt(base, s(11), frame)).toBe(s(3))
    expect(sourceTimeAt({ ...base, speed: 2 }, s(11), frame)).toBe(s(4))
  })

  it('reversed, shows the forward frames in the opposite order', () => {
    for (const speed of [1, 2, 0.5]) {
      const forward = { ...base, speed, duration: Math.round(s(4) / speed) }
      const reversed = { ...forward, reverse: true }
      const frames = Math.round(forward.duration / frame)
      const ahead = Array.from({ length: frames }, (_, k) => sourceTimeAt(forward, forward.start + k * frame, frame))
      const back = Array.from({ length: frames }, (_, k) => sourceTimeAt(reversed, reversed.start + k * frame, frame))
      expect(back).toEqual([...ahead].reverse())
    }
  })

  it('holds one frame at 0%', () => {
    expect(sourceTimeAt({ ...base, speed: 0 }, s(13), frame)).toBe(s(2))
  })

  it('holds the edge frame when asked for time outside the media', () => {
    expect(sourceTimeAt(base, s(40), frame, s(20))).toBe(s(20) - 1)
    expect(sourceTimeAt({ ...base, sourceIn: 0 }, s(5), frame, s(20))).toBe(0)
  })
})

describe('Speed/Duration', () => {
  it('200% halves the length of picture and linked sound, keeping the same media', () => {
    const t = setup()
    t.place(A, 0, 2, 10)
    const before = t.video(A.id)
    t.run(setClipSpeed({ clipIds: pair(before, t), speed: 2, reverse: false, ripple: false }, t.history.state.media, ids))
    for (const clip of [t.video(A.id), t.audio(A.id)]) {
      expect(clip.duration).toBe(s(4))
      expect(clip.sourceIn).toBe(s(2))
      expect(clip.speed).toBe(2)
    }
    expect(t.layers(3)[0]!.sourceTime).toBe(s(8))
  })

  it('without ripple, leaves a gap when shorter and stops at the next clip when longer', () => {
    const t = setup()
    t.place(A, 0, 0, 8)
    t.place(B, 8, 0, 4)
    t.run(setClipSpeed({ clipIds: pair(t.video(A.id), t), speed: 2, reverse: false, ripple: false }, t.history.state.media, ids))
    expect(clipEnd(t.video(A.id))).toBe(s(4))
    expect(t.video(B.id).start).toBe(s(8))
    t.run(setClipSpeed({ clipIds: pair(t.video(A.id), t), speed: 0.5, reverse: false, ripple: false }, t.history.state.media, ids))
    expect(clipEnd(t.video(A.id))).toBe(s(8))
    expect(clipEnd(t.audio(A.id))).toBe(s(8))
  })

  it('with ripple, later clips and sync-locked tracks follow the new length', () => {
    const t = setup()
    t.place(A, 0, 0, 8)
    t.place(B, 8, 0, 4)
    t.place(B, 8, 10, 14, t.V2, null)
    t.run(setClipSpeed({ clipIds: pair(t.video(A.id), t), speed: 0.5, reverse: false, ripple: true }, t.history.state.media, ids))
    expect(t.video(A.id).duration).toBe(s(16))
    expect(t.video(B.id).start).toBe(s(16))
    expect(t.audio(B.id).start).toBe(s(16))
    // V2 is sync-locked, so its clip moves too, by the same amount, once.
    expect(t.clips().find((c) => c.trackId === t.V2)!.start).toBe(s(16))
    t.run(setClipSpeed({ clipIds: pair(t.video(A.id), t), speed: 1, reverse: false, ripple: true }, t.history.state.media, ids))
    expect(t.video(B.id).start).toBe(s(8))
    expect(t.clips().find((c) => c.trackId === t.V2)!.start).toBe(s(8))
  })

  it('rounds the new length down to whole frames, so it never runs past its media', () => {
    const t = setup()
    t.place(A, 0, 0, 1)
    t.run(setClipSpeed({ clipIds: [t.video(A.id).id], speed: 3, reverse: false, ripple: false }, t.history.state.media, ids))
    const clip = t.video(A.id)
    expect(clip.duration % t.frame).toBe(0)
    expect(clip.duration * clip.speed).toBeLessThanOrEqual(s(1))
  })

  it('reverses, and says reversed sound is silent for now', () => {
    const t = setup()
    t.place(A, 0, 2, 6)
    const command = t.run(setClipSpeed({ clipIds: pair(t.video(A.id), t), speed: 1, reverse: true, ripple: false }, t.history.state.media, ids))
    expect(t.layers(0)[0]!.sourceTime).toBe(s(6) - t.frame)
    expect(command.notice).toMatch(/Reversed sound is silent/)
    expect(audioSegments(t.history.state.sequence, t.history.state.media, 0, s(4))).toHaveLength(0)
  })

  it('refuses speeds outside 1%–10000%', () => {
    const t = setup()
    t.place(A, 0, 0, 4)
    expect(() => t.history.dispatch(setClipSpeed({ clipIds: [t.video(A.id).id], speed: 0, reverse: false, ripple: false }, t.history.state.media, ids))).toThrow(CommandError)
  })

  it('keeps speed and reverse through a split, with each half showing the right frames', () => {
    const t = setup()
    t.place(A, 0, 0, 8)
    t.run(setClipSpeed({ clipIds: pair(t.video(A.id), t), speed: 2, reverse: true, ripple: false }, t.history.state.media, ids))
    const before = [0.5, 1.5, 2.5, 3.5].map((x) => t.layers(x)[0]!.sourceTime)
    t.run(splitClips(pair(t.video(A.id), t), s(2), ids))
    expect([0.5, 1.5, 2.5, 3.5].map((x) => t.layers(x)[0]!.sourceTime)).toEqual(before)
    expect(t.clips().filter((c) => c.kind === 'video').every((c) => c.speed === 2 && c.reverse)).toBe(true)
  })

  it('trims a fast clip by its media: a 200% clip has half as much spare time on the timeline', () => {
    const t = setup()
    t.place(A, 5, 2, 10)
    t.run(setClipSpeed({ clipIds: [t.video(A.id).id], speed: 2, reverse: false, ripple: false }, t.history.state.media, ids))
    // 2 s of media before the in point = 1 s on the timeline at 200%.
    t.run(trimClips({ clipIds: [t.video(A.id).id], edge: 'in', delta: -s(5) }))
    expect(t.video(A.id).sourceIn).toBe(0)
    expect(t.video(A.id).start).toBe(s(4))
  })
})

describe('Add Frame Hold', () => {
  it('splits at the playhead and holds that frame for the rest of the clip, sound playing on', () => {
    const t = setup()
    t.place(A, 0, 2, 10)
    t.run(addFrameHold(pair(t.video(A.id), t), s(3), ids))
    const [first, hold] = [t.video(A.id, 0), t.video(A.id, 1)]
    expect(clipEnd(first)).toBe(s(3))
    expect(hold.speed).toBe(0)
    expect(hold.sourceIn).toBe(s(5))
    expect(t.layers(7)[0]!.sourceTime).toBe(s(5))
    // The sound was split with it and stays linked to the hold.
    expect(t.audio(A.id, 1).linkId).toBe(hold.linkId)
    expect(audioSegments(t.history.state.sequence, t.history.state.media, s(3), s(8)).map((x) => x.clip.speed)).toEqual([1])
  })

  it('can be stretched as long as you like', () => {
    const t = setup()
    t.place(A, 0, 0, 2)
    t.run(addFrameHold([t.video(A.id).id], 0, ids))
    t.run(trimClips({ clipIds: [t.video(A.id).id], edge: 'out', delta: s(60) }))
    expect(t.video(A.id).duration).toBe(s(62))
  })

  it('needs the playhead over a selected video clip', () => {
    const t = setup()
    t.place(A, 0, 0, 2)
    expect(() => t.history.dispatch(addFrameHold([t.video(A.id).id], s(5), ids))).toThrow(/playhead/)
  })
})

describe('cross-dissolves', () => {
  it('a dissolve between two clips is centred on the cut, blending half-way at the cut', () => {
    const t = setup()
    t.place(A, 0, 0, 4)
    t.place(B, 4, 0, 4)
    t.run(addCrossDissolveAt(t.V1, s(4), s(1)))
    expect(t.video(B.id).transitionIn).toEqual({ kind: 'cross-dissolve', duration: s(1) })
    expect(t.layers(3.4).map((l) => l.weight)).toEqual([1])
    const atCut = t.layers(4)
    expect(atCut.map((l) => [l.clip.mediaId, l.weight])).toEqual([
      [A.id, 1],
      [B.id, 0.5]
    ])
    // The outgoing clip runs on into its media past its out point.
    expect(atCut[0]!.sourceTime).toBe(s(4))
    expect(t.layers(4.25)[1]!.weight).toBeCloseTo(0.75)
    expect(t.layers(4.5).map((l) => l.clip.mediaId)).toEqual([B.id])
  })

  it('holds the last frame when the outgoing clip has no media left', () => {
    const t = setup()
    t.place(SHORT, 0, 0, 4)
    t.place(B, 4, 0, 4)
    t.run(addCrossDissolveAt(t.V1, s(4), s(1)))
    expect(t.layers(4.25)[0]!.sourceTime).toBe(s(4) - 1)
  })

  it('a free end fades from or to transparent', () => {
    const t = setup()
    t.place(A, 2, 0, 4)
    t.run(addCrossDissolves([t.video(A.id).id], s(1)))
    const clip = t.video(A.id)
    expect(clip.transitionIn?.duration).toBe(s(1))
    expect(clip.transitionOut?.duration).toBe(s(1))
    expect(t.layers(2.5)[0]!.weight).toBeCloseTo(0.5)
    expect(t.layers(4)[0]!.weight).toBe(1)
    expect(t.layers(5.5)[0]!.weight).toBeCloseTo(0.5)
  })

  it('Cmd+D on a selected clip joins it to a neighbour with one dissolve', () => {
    const t = setup()
    t.place(A, 0, 0, 4)
    t.place(B, 4, 0, 4)
    t.run(addCrossDissolves(pair(t.video(A.id), t), s(1)))
    expect(t.video(A.id).transitionOut).toBeNull()
    expect(t.video(A.id).transitionIn?.duration).toBe(s(1))
    expect(t.video(B.id).transitionIn?.duration).toBe(s(1))
  })

  it('is kept within the clips it joins', () => {
    const t = setup()
    t.place(A, 0, 0, 0.4)
    t.place(B, 0.4, 0, 4)
    t.run(addCrossDissolveAt(t.V1, s(0.4), s(2)))
    // 0.4 s long, so it runs 0.2 s either side of the cut.
    expect(t.layers(0.2).map((l) => l.clip.mediaId)).toEqual([A.id])
    expect(t.layers(0.4)[1]!.weight).toBeCloseTo(0.5)
    expect(t.layers(0.6).map((l) => l.clip.mediaId)).toEqual([B.id])
  })

  it('changes length as one undo step while dragging, and deletes', () => {
    const t = setup()
    t.place(A, 0, 0, 4)
    t.place(B, 4, 0, 4)
    t.run(addCrossDissolveAt(t.V1, s(4), s(1)))
    const id = t.video(B.id).id
    t.run(setTransitionDuration(id, 'in', s(1.5)))
    t.run(setTransitionDuration(id, 'in', s(2)))
    expect(t.video(B.id).transitionIn?.duration).toBe(s(2))
    t.history.undo()
    expect(t.video(B.id).transitionIn?.duration).toBe(s(1))
    t.run(removeTransition(id, 'in'))
    expect(t.video(B.id).transitionIn).toBeNull()
    expect(t.layers(3.8).map((l) => l.weight)).toEqual([1])
  })

  it('splitting a clip keeps its fade in on the left half and fade out on the right', () => {
    const t = setup()
    t.place(A, 0, 0, 4)
    t.run(addCrossDissolves([t.video(A.id).id], s(1)))
    t.run(splitClips([t.video(A.id).id], s(2), ids))
    expect(t.video(A.id, 0).transitionIn).not.toBeNull()
    expect(t.video(A.id, 0).transitionOut).toBeNull()
    expect(t.video(A.id, 1).transitionIn).toBeNull()
    expect(t.video(A.id, 1).transitionOut).not.toBeNull()
  })

  it('goes on video only', () => {
    const t = setup()
    t.place(A, 0, 0, 4)
    expect(() => t.history.dispatch(addCrossDissolves([t.audio(A.id).id], s(1)))).toThrow(/video clip/)
  })
})

describe('saving', () => {
  it('keeps speed, reverse, holds and transitions', () => {
    const t = setup()
    t.place(A, 0, 0, 8)
    t.run(setClipSpeed({ clipIds: [t.video(A.id).id], speed: 1.5, reverse: true, ripple: false }, t.history.state.media, ids))
    t.run(addCrossDissolves([t.video(A.id).id], s(0.5)))
    t.run(addFrameHold([t.video(A.id).id], s(1), ids))
    const restored = parseProject(serializeProject(t.history.state))
    expect(restored.sequence.clips).toEqual(t.history.state.sequence.clips)
  })
})
