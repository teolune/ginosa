import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { setTrackFlag } from '../project/commands'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { placeMedia, resetMotion, setClipProperties, splitClips, type TimelineCommand } from './edits'
import { applyAffine, defaultMotion, inverseMotion, motionMatrix } from './motion'
import { audioSegments, dbToGain, videoLayersAt } from './render-plan'

let counter = 0
const ids = () => `p-${++counter}`
const s = (n: number) => secondsToTicks(n)

function media(name: string, kind: MediaItem['kind'], width: number, height: number, audio = true): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: 30,
    bitRate: null,
    video:
      kind === 'audio'
        ? null
        : {
            codec: 'hevc',
            profile: null,
            width,
            height,
            rotation: 0,
            frameRate: { num: 30, den: 1 },
            frameCount: 900,
            pixelFormat: 'yuv420p',
            bitDepth: 8,
            colour: { primaries: null, transfer: null, matrix: null, range: 'tv' },
            hdr: null,
            variableFrameRate: false,
            keyframeInterval: 1
          },
    audio: audio && kind !== 'image' ? { codec: 'aac', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' } : null
  }
  return { id: `m-${name}`, name, kind, path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-10-31T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

const UHD = media('iphone4k', 'video', 3840, 2160)
const PORTRAIT = media('portrait', 'video', 1080, 1920)
const SONG = media('song', 'audio', 0, 0)

function setup() {
  const history = new History(createProject({ name: 'Playback', createId: ids }))
  history.dispatch(importMedia([UHD, PORTRAIT, SONG]))
  const tracks = history.state.sequence.tracks
  const [V1, V2] = tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const [A1, A2] = tracks.filter((t) => t.kind === 'audio').map((t) => t.id) as [string, string]
  const run = (command: TimelineCommand) => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
  }
  const place = (item: MediaItem, at: number, v: string | null, a: string | null, outS = 10) =>
    run(placeMedia({ mediaId: item.id, sourceIn: 0, sourceOut: s(outS), at: s(at), videoTrackId: v, audioTrackId: a, mode: 'overwrite' }, ids))
  return { history, run, place, V1, V2, A1, A2 }
}

describe('Motion', () => {
  it('sets new clips to frame size: 4K at 50%, a portrait clip fitted to the height', () => {
    const t = setup()
    t.place(UHD, 0, t.V1, t.A1)
    t.place(PORTRAIT, 0, t.V2, null)
    const [uhd, portrait] = [t.history.state.sequence.clips.find((c) => c.mediaId === UHD.id && c.kind === 'video')!, t.history.state.sequence.clips.find((c) => c.mediaId === PORTRAIT.id)!]
    expect(uhd.motion).toEqual({ positionX: 960, positionY: 540, scale: 50, scaleWidth: 100, rotation: 0, anchorX: 1920, anchorY: 1080 })
    expect(portrait.motion.scale).toBeCloseTo(56.25, 3)
    expect(uhd.opacity).toBe(100)
    expect(uhd.blendMode).toBe('normal')
  })

  it('maps source pixels to the frame and back, including rotation and Scale Width', () => {
    const motion = { ...defaultMotion(UHD, createProject({ name: 'x', createId: ids }).sequence.settings), rotation: 30, scaleWidth: 150 }
    const forward = motionMatrix(motion)
    const centre = applyAffine(forward, 1920, 1080)
    expect(centre.x).toBeCloseTo(960)
    expect(centre.y).toBeCloseTo(540)
    const inverse = inverseMotion(motion)!
    for (const [x, y] of [[0, 0], [3840, 2160], [100, 1700]] as const) {
      const p = applyAffine(forward, x, y)
      const back = applyAffine(inverse, p.x, p.y)
      expect(back.x).toBeCloseTo(x, 6)
      expect(back.y).toBeCloseTo(y, 6)
    }
    // Scale Width stretches horizontally only: the source's right edge lands 1.5× further out.
    const flat = motionMatrix({ ...motion, rotation: 0 })
    expect(applyAffine(flat, 3840, 1080).x - 960).toBeCloseTo(1.5 * 960)
    expect(inverseMotion({ ...motion, scale: 0 })).toBeNull()
  })

  it('changes properties as one undo step per drag, and keeps them through splits', () => {
    const t = setup()
    t.place(UHD, 0, t.V1, null)
    const id = t.history.state.sequence.clips[0]!.id
    for (const scale of [60, 70, 80]) t.run(setClipProperties([id], { motion: { scale } }))
    t.run(setClipProperties([id], { opacity: 140, blendMode: 'screen' }))
    const clip = t.history.state.sequence.clips[0]!
    expect(clip.motion.scale).toBe(80)
    expect(clip.opacity).toBe(100) // clamped
    expect(clip.blendMode).toBe('screen')
    expect(t.history.undoLabel).toBe('Change Clip Properties')
    t.history.undo()
    expect(t.history.undoLabel).toBe('Change Scale')
    t.history.undo()
    expect(t.history.state.sequence.clips[0]!.motion.scale).toBe(50)
    t.run(setClipProperties([id], { motion: { scale: 75 } }))
    t.run(splitClips([id], s(4), ids))
    const [left, right] = t.history.state.sequence.clips
    expect(right!.motion.scale).toBe(75)
    expect(right!.motion).not.toBe(left!.motion)
    t.run(resetMotion([left!.id], 'frame-size'))
    expect(t.history.state.sequence.clips.find((c) => c.id === left!.id)!.motion.scale).toBe(50)
    expect(t.history.state.sequence.clips.find((c) => c.id === right!.id)!.motion.scale).toBe(75)
  })
})

describe('render plan', () => {
  it('stacks visible layers from V1 up, honouring the eye, solo and zero opacity', () => {
    const t = setup()
    t.place(UHD, 0, t.V1, t.A1)
    t.place(PORTRAIT, 2, t.V2, null, 3)
    const at = (seconds: number) => videoLayersAt(t.history.state.sequence, t.history.state.media, s(seconds)).map((l) => l.item.name)
    expect(at(1)).toEqual(['iphone4k'])
    expect(at(3)).toEqual(['iphone4k', 'portrait'])
    const layer = videoLayersAt(t.history.state.sequence, t.history.state.media, s(3))[1]!
    expect(layer.sourceTime).toBe(s(1))
    t.run(setTrackFlag(t.V1, 'solo', true))
    expect(at(3)).toEqual(['iphone4k'])
    t.run(setTrackFlag(t.V1, 'solo', false))
    t.run(setTrackFlag(t.V2, 'visible', false))
    expect(at(3)).toEqual(['iphone4k'])
    t.run(setTrackFlag(t.V2, 'visible', true))
    const portrait = t.history.state.sequence.clips.find((c) => c.mediaId === PORTRAIT.id)!
    t.run(setClipProperties([portrait.id], { opacity: 0 }))
    expect(at(3)).toEqual(['iphone4k'])
  })

  it('mixes audio from audible tracks with each clip’s volume', () => {
    const t = setup()
    t.place(UHD, 0, t.V1, t.A1)
    t.place(SONG, 0, null, t.A2, 30)
    const song = t.history.state.sequence.clips.find((c) => c.mediaId === SONG.id)!
    t.run(setClipProperties([song.id], { volume: -6 }))
    const names = () => audioSegments(t.history.state.sequence, t.history.state.media, 0, s(5)).map((a) => a.item.name)
    expect(names()).toEqual(['iphone4k', 'song'])
    expect(audioSegments(t.history.state.sequence, t.history.state.media, 0, s(5))[1]!.gain).toBeCloseTo(0.501, 3)
    t.run(setTrackFlag(t.A1, 'muted', true))
    expect(names()).toEqual(['song'])
    t.run(setTrackFlag(t.A1, 'muted', false))
    t.run(setTrackFlag(t.A1, 'solo', true))
    expect(names()).toEqual(['iphone4k'])
    expect(audioSegments(t.history.state.sequence, t.history.state.media, s(11), s(12)).map((a) => a.item.name)).toEqual([])
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-96)).toBe(0)
  })

  it('upgrades M3 projects: existing clips keep their fitted look', () => {
    const t = setup()
    t.place(UHD, 0, t.V1, t.A1)
    const v3 = JSON.parse(serializeProject(t.history.state))
    v3.schemaVersion = 3
    for (const clip of v3.sequence.clips) {
      delete clip.motion
      delete clip.opacity
      delete clip.blendMode
      delete clip.volume
    }
    const upgraded = parseProject(v3)
    expect(upgraded.sequence.clips.find((c) => c.kind === 'video')!.motion.scale).toBe(50)
    expect(upgraded).toEqual(t.history.state)
  })
})
