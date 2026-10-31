import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { secondsToTicks } from '../time'
import { CommandError } from './commands'
import { createBin, deleteBin, importMedia, moveToBin, relinkMedia, removeMedia, setMarks, setMediaColour } from './media-commands'
import { detectColour, effectiveColour, optimiseReasons, type MediaInfo, type MediaItem } from './media'
import { PROJECT_SCHEMA_VERSION, createProject } from './model'
import { parseProject, serializeProject } from './serialize'

let counter = 0
const ids = () => `id-${++counter}`

const videoInfo: MediaInfo = {
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSeconds: 10,
  bitRate: 20_000_000,
  video: {
    codec: 'h264',
    profile: 'High',
    width: 1920,
    height: 1080,
    rotation: 0,
    frameRate: { num: 25, den: 1 },
    frameCount: 250,
    pixelFormat: 'yuv420p',
    bitDepth: 8,
    colour: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
    hdr: null,
    variableFrameRate: false,
    keyframeInterval: 0.5
  },
  audio: { codec: 'aac', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' }
}

function item(name: string, binId: string | null = null): MediaItem {
  return {
    id: ids(),
    name,
    kind: 'video',
    path: `/Users/teo/Footage/${name}.mp4`,
    fingerprint: { size: 1000, mtimeMs: 1, sample: 'abc' },
    info: structuredClone(videoInfo),
    binId,
    importedAt: '2026-10-31T00:00:00.000Z',
    marks: { in: null, out: null },
    colour: { input: 'auto', lut: null }
  }
}

function fresh() {
  return new History(createProject({ name: 'Media test', createId: ids }))
}

describe('media library', () => {
  it('imports several files as one undo step', () => {
    const history = fresh()
    history.dispatch(importMedia([item('A'), item('B'), item('C')]))
    expect(history.state.media).toHaveLength(3)
    expect(history.undoLabel).toBe('Import 3 Items')
    history.undo()
    expect(history.state.media).toHaveLength(0)
  })

  it('deleting a bin removes its nested bins and media from the project', () => {
    const history = fresh()
    const outer = createBin('Shoot day 1', null, ids)
    history.dispatch(outer)
    const inner = createBin('B-roll', outer.binId, ids)
    history.dispatch(inner)
    history.dispatch(importMedia([item('Keep'), item('In outer', outer.binId), item('In inner', inner.binId)]))
    history.dispatch(deleteBin(outer.binId))
    expect(history.state.bins).toHaveLength(0)
    expect(history.state.media.map((m) => m.name)).toEqual(['Keep'])
    history.undo()
    expect(history.state.media).toHaveLength(3)
  })

  it("refuses to move a bin into its own sub-bin", () => {
    const history = fresh()
    const outer = createBin('Outer', null, ids)
    history.dispatch(outer)
    const inner = createBin('Inner', outer.binId, ids)
    history.dispatch(inner)
    expect(() => history.dispatch(moveToBin([], [outer.binId], inner.binId))).toThrow(CommandError)
    expect(() => history.dispatch(moveToBin([], [outer.binId], outer.binId))).toThrow(CommandError)
  })

  it('moves media between bins', () => {
    const history = fresh()
    const bin = createBin('Selects', null, ids)
    history.dispatch(bin)
    const a = item('A')
    history.dispatch(importMedia([a]))
    history.dispatch(moveToBin([a.id], [], bin.binId))
    expect(history.state.media[0]?.binId).toBe(bin.binId)
  })

  it('removing media from the project is undoable', () => {
    const history = fresh()
    const a = item('A')
    history.dispatch(importMedia([a]))
    history.dispatch(removeMedia([a.id]))
    expect(history.state.media).toHaveLength(0)
    history.undo()
    expect(history.state.media[0]?.name).toBe('A')
  })

  it('relinks a moved file', () => {
    const history = fresh()
    const a = item('A')
    history.dispatch(importMedia([a]))
    history.dispatch(relinkMedia(a.id, '/Volumes/SSD/A.mp4', { size: 1000, mtimeMs: 2, sample: 'abc' }, videoInfo))
    expect(history.state.media[0]?.path).toBe('/Volumes/SSD/A.mp4')
  })

  it('clears the opposite mark when In passes Out, as Premiere does', () => {
    const history = fresh()
    const a = item('A')
    history.dispatch(importMedia([a]))
    history.dispatch(setMarks(a.id, { in: secondsToTicks(2) }))
    history.dispatch(setMarks(a.id, { out: secondsToTicks(5) }))
    expect(history.state.media[0]?.marks).toEqual({ in: secondsToTicks(2), out: secondsToTicks(5) })
    history.dispatch(setMarks(a.id, { in: secondsToTicks(6) }))
    expect(history.state.media[0]?.marks).toEqual({ in: secondsToTicks(6), out: null })
  })
})

describe('optimised copies', () => {
  it('requires a copy for undecodable or variable-rate video', () => {
    expect(optimiseReasons(videoInfo, false).required).toEqual(['codec'])
    const vfr = structuredClone(videoInfo)
    vfr.video!.variableFrameRate = true
    expect(optimiseReasons(vfr, true).required).toEqual(['vfr'])
  })

  it('keeps HDR clips as they are: HDR alone never needs a copy', () => {
    const hlg = structuredClone(videoInfo)
    hlg.video!.hdr = 'hlg'
    hlg.video!.bitDepth = 10
    expect(optimiseReasons(hlg, true)).toEqual({ required: [], suggested: [] })
  })

  it('only suggests a copy for long keyframe intervals', () => {
    const longGop = structuredClone(videoInfo)
    longGop.video!.keyframeInterval = 10
    expect(optimiseReasons(longGop, true)).toEqual({ required: [], suggested: ['long-gop'] })
  })

  it('needs nothing for audio files', () => {
    expect(optimiseReasons({ ...videoInfo, video: null }, false).required).toEqual([])
  })
})

describe('project format v2', () => {
  it('upgrades M1 projects (format 1) by adding an empty library', () => {
    const v2 = JSON.parse(serializeProject(createProject({ name: 'Old', createId: ids })))
    const v1 = { ...v2, schemaVersion: 1 }
    delete v1.media
    delete v1.bins
    const upgraded = parseProject(v1)
    expect(upgraded.schemaVersion).toBe(PROJECT_SCHEMA_VERSION)
    expect(upgraded.media).toEqual([])
    expect(upgraded.bins).toEqual([])
  })

  it('round-trips media and bins', () => {
    const history = fresh()
    const bin = createBin('Selects', null, ids)
    history.dispatch(bin)
    history.dispatch(importMedia([item('A', bin.binId), { ...item('Song'), kind: 'audio', info: { ...videoInfo, video: null } }]))
    expect(parseProject(serializeProject(history.state))).toEqual(history.state)
  })

  it('moves items whose bin is missing to the top level instead of failing', () => {
    const history = fresh()
    history.dispatch(importMedia([item('Orphan')]))
    const data = JSON.parse(serializeProject(history.state))
    data.media[0].binId = 'missing-bin'
    expect(parseProject(data).media[0]?.binId).toBeNull()
  })
})

describe('colour interpretation', () => {
  const tagged = (primaries: string | null, transfer: string | null, matrix: string | null, bitDepth = 10, hdr: 'hlg' | 'pq' | null = null): MediaInfo => {
    const info = structuredClone(videoInfo)
    info.video!.colour = { primaries, transfer, matrix, range: 'tv' }
    info.video!.bitDepth = bitDepth
    info.video!.hdr = hdr
    return info
  }

  it('detects Apple Log, Apple Log 2, HDR and Rec.709 from the tags', () => {
    expect(detectColour(tagged('bt2020', null, 'bt2020nc'))).toBe('apple-log')
    expect(detectColour(tagged(null, null, 'bt2020nc'))).toBe('apple-log-2')
    expect(detectColour(tagged('bt2020', 'arib-std-b67', 'bt2020nc', 10, 'hlg'))).toBe('hlg')
    expect(detectColour(tagged('bt709', 'bt709', 'bt709', 8))).toBe('rec709')
    expect(detectColour(tagged(null, null, null, 8))).toBe('rec709')
    // 8-bit BT.2020 without a transfer isn't log footage from an iPhone.
    expect(detectColour(tagged('bt2020', null, 'bt2020nc', 8))).toBe('rec709')
  })

  it('detects your Apple Log and Apple Log 2 clips (iPhone, HEVC 4:2:2 10-bit) from their real tags', () => {
    // As probed from AppleLog1.mov / AppleLog2.mov: colr nclc 9/2/9 and 2/2/9, matching the SPS VUI.
    const clip = (primaries: string | null): MediaInfo => {
      const info = tagged(primaries, null, 'bt2020nc')
      info.video = { ...info.video!, codec: 'hevc', profile: 'Rext', width: 3840, height: 2160, pixelFormat: 'yuv422p10le', frameRate: { num: 25, den: 1 } }
      return info
    }
    expect(detectColour(clip('bt2020'))).toBe('apple-log')
    expect(detectColour(clip(null))).toBe('apple-log-2')
  })

  it('lets you override the detection and set an input LUT, undoably', () => {
    const history = fresh()
    const clip = { ...item('Log clip'), info: tagged('bt2020', null, 'bt2020nc') }
    history.dispatch(importMedia([clip]))
    expect(effectiveColour(history.state.media[0]!)).toBe('apple-log')
    history.dispatch(setMediaColour([clip.id], { input: 'apple-log-2' }))
    expect(effectiveColour(history.state.media[0]!)).toBe('apple-log-2')
    history.dispatch(setMediaColour([clip.id], { lut: { name: 'AppleLogToRec709', file: 'luts/AppleLogToRec709.cube' } }))
    expect(history.undoLabel).toBe('Set Input LUT')
    expect(parseProject(serializeProject(history.state)).media[0]!.colour.lut?.name).toBe('AppleLogToRec709')
    history.undo()
    expect(history.state.media[0]!.colour.lut).toBeNull()
  })
})
