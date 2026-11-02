import { describe, expect, it } from 'vitest'
import { ANALYSIS_RATE, analyseAudio } from '../audio/analysis'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject, type BeatGrid } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { addAudioSource } from '../timeline/audio-edits'
import { placeMedia, splitClips, type TimelineCommand } from '../timeline/edits'
import { addEffect } from '../timeline/effect-edits'
import { setAnimated, setValue } from '../timeline/keyframe-edits'
import { addLink, addModulator, linkToAudio, linksTo, removeLinks, removeModulator, setModulatorAnimated, setModulatorValue, updateLink, updateModulator } from '../timeline/modulation-edits'
import { gainAt, videoLayersAt } from '../timeline/render-plan'
import { resolveClip, valueAt } from '../keyframes/properties'
import { applyLinks } from './apply'
import { CURVE_RATE, curveValue, modulatorCurve, responseCurve, sourceSignal, thresholdKnee, type CurveInputs } from './curve'
import type { ModLink, Modulator, ModulationContext } from './types'
import { newModulator } from '../timeline/modulation-edits'
import { applyBuiltinPreset } from '../timeline/builtin-presets'

const s = secondsToTicks
let counter = 0
const ids = () => `md-${++counter}`
const none: CurveInputs = { analysis: null, analysisStart: 0, customBand: null, grid: null }

describe('the modulator chain', () => {
  it('threshold with a soft knee: nothing below, smooth through the knee, 1 at full', () => {
    expect(thresholdKnee(0.2, 0.3, 0)).toBe(0)
    expect(thresholdKnee(0.65, 0.3, 0)).toBeCloseTo(0.5, 9)
    expect(thresholdKnee(1, 0.3, 0.2)).toBeCloseTo(1, 9)
    expect(thresholdKnee(0.2, 0.3, 0.2)).toBeCloseTo(0, 12)
    // Continuous at both edges of the knee.
    expect(thresholdKnee(0.4 - 1e-9, 0.3, 0.2)).toBeCloseTo(thresholdKnee(0.4 + 1e-9, 0.3, 0.2), 6)
  })

  it('response curves keep 0 and 1 and bend in between', () => {
    for (const c of ['linear', 'exponential', 'logarithmic', 's-curve'] as const) {
      expect(responseCurve(0, c, [])).toBeCloseTo(0, 9)
      expect(responseCurve(1, c, [])).toBeCloseTo(1, 9)
    }
    expect(responseCurve(0.5, 'exponential', [])).toBeLessThan(0.5)
    expect(responseCurve(0.5, 'logarithmic', [])).toBeGreaterThan(0.5)
    expect(responseCurve(0.375, 'custom', [0, 1, 0.5, 0.5, 1])).toBeCloseTo(0.75, 9)
  })

  it('attack and release follow the signal over the whole curve', () => {
    const m: Modulator = { ...newModulator('m', 'Beats', { kind: 'tempo', signal: 'beat-trigger' }), release: 100 }
    const grid: BeatGrid = { bpm: 120, downbeat: s(0.5), beatsPerBar: 4, sourceId: null }
    const curve = modulatorCurve(m, { ...none, grid }, CURVE_RATE * 2)
    // A beat at 0.5 s: 1 there, then e^-1 after 100 ms.
    expect(curve[Math.round(CURVE_RATE * 0.5)]).toBe(1)
    expect(curve[Math.round(CURVE_RATE * 0.6)]).toBeCloseTo(Math.exp(-1), 2)
    expect(curve[Math.round(CURVE_RATE * 0.5) - 1]).toBeLessThan(0.01)
    expect(curveValue(curve, s(1))).toBe(1)
  })

  it('tempo phases and LFOs lock to the beat grid', () => {
    const grid: BeatGrid = { bpm: 120, downbeat: s(1), beatsPerBar: 4, sourceId: null }
    const phase = sourceSignal({ kind: 'tempo', signal: 'beat-phase' }, { ...none, grid }, CURVE_RATE * 3)
    expect(phase[Math.round(CURVE_RATE * 1.25)]).toBeCloseTo(0.5, 6)
    const bar = sourceSignal({ kind: 'tempo', signal: 'bar-phase' }, { ...none, grid }, CURVE_RATE * 4)
    expect(bar[Math.round(CURVE_RATE * 2)]).toBeCloseTo(0.5, 6)
    const square = sourceSignal({ kind: 'lfo', shape: 'square', rate: '1/8', seed: 1 }, { ...none, grid }, CURVE_RATE * 3)
    expect(square[Math.round(CURVE_RATE * 1.1)]).toBe(1)
    expect(square[Math.round(CURVE_RATE * 1.2)]).toBe(0)
    // Phase shifts the cycle by half: the square flips.
    const shifted = modulatorCurve({ ...newModulator('l', 'LFO', { kind: 'lfo', shape: 'square', rate: '1/8', seed: 1 }), phase: 0.5 }, { ...none, grid }, CURVE_RATE * 3)
    expect(shifted[Math.round(CURVE_RATE * 1.1)]).toBe(0)
    // Random noise is the same every time for a seed, and differs between seeds.
    const a = sourceSignal({ kind: 'random', seed: 3, rate: 4 }, none, 400)
    expect(Array.from(sourceSignal({ kind: 'random', seed: 3, rate: 4 }, none, 400))).toEqual(Array.from(a))
    expect(sourceSignal({ kind: 'random', seed: 4, rate: 4 }, none, 400)[100]).not.toBe(a[100])
  })

  it('an audio level is scaled to its loudest moment and placed where the source starts', () => {
    const pcm = new Float32Array(48_000 * 2)
    for (let i = 48_000; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 100 * i) / 48_000)
    const analysis = analyseAudio(pcm)
    const signal = sourceSignal({ kind: 'audio', sourceId: 's', signal: 'level', band: 'bass' }, { ...none, analysis, analysisStart: s(3) }, CURVE_RATE * 6)
    expect(signal[Math.round(CURVE_RATE * 3.5)]).toBeLessThan(0.02)
    expect(signal[Math.round(CURVE_RATE * 4.5)]).toBeGreaterThan(0.9)
    expect(Math.max(...signal)).toBeLessThanOrEqual(1)
    expect(ANALYSIS_RATE).toBe(CURVE_RATE)
  })
})

describe('links', () => {
  const ctx = (v: number): ModulationContext => ({ value: () => v })
  const link = (over: Partial<ModLink>): ModLink => ({ id: 'l', modulatorId: 'm', mode: 'add', min: [0], max: [10], invert: false, amount: 100, ...over })
  it('add, multiply and replace, inverted, by amount', () => {
    expect(applyLinks([5], [link({})], ctx(0.5), 0)).toEqual([10])
    expect(applyLinks([5], [link({ mode: 'multiply', min: [1], max: [3] })], ctx(0.5), 0)).toEqual([10])
    expect(applyLinks([5], [link({ mode: 'replace', min: [20], max: [40] })], ctx(0.25), 0)).toEqual([25])
    expect(applyLinks([5], [link({ invert: true })], ctx(1), 0)).toEqual([5])
    expect(applyLinks([5], [link({ amount: 50 })], ctx(1), 0)).toEqual([10])
    expect(applyLinks([1, 2], [link({ min: [0, 0], max: [10, -10] })], ctx(0.5), 0)).toEqual([6, -3])
    expect(applyLinks([5], [link({})], { value: () => null }, 0)).toEqual([5])
  })
})

function media(name: string, kind: 'video' | 'audio', seconds = 20): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: seconds,
    bitRate: null,
    video: kind === 'video' ? { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: seconds * 25, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 } : null,
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' }
  }
  return { id: `m-${name}`, name, kind, path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-11-01T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

function setup() {
  const history = new History(createProject({ name: 'Mod', createId: ids }))
  history.dispatch(importMedia([media('clip', 'video'), media('song', 'audio')]))
  const tracks = history.state.sequence.tracks
  const V1 = tracks.find((t) => t.kind === 'video')!.id
  const A = tracks.filter((t) => t.kind === 'audio').map((t) => t.id)
  const run = (command: TimelineCommand) => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: 'm-clip', sourceIn: 0, sourceOut: s(10), at: s(1), videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
  run(placeMedia({ mediaId: 'm-song', sourceIn: 0, sourceOut: s(20), at: 0, videoTrackId: null, audioTrackId: A[1]!, mode: 'overwrite' }, ids))
  const video = () => history.state.sequence.clips.find((c) => c.kind === 'video')!
  const song = run(addAudioSource('track', A[1]!, 'Song', ids)) as ReturnType<typeof addAudioSource>
  return { history, run, video, songId: song.sourceId }
}

describe('modulation commands and the render plan', () => {
  it('Link to Audio makes "Song · Bass" once and reuses it: one source drives three values', () => {
    const { history, run, video, songId } = setup()
    const clip = video()
    run(addEffect([clip.id], 'invert', null, ids))
    const invert = video().effects[0]!.id
    run(linkToAudio({ clipId: clip.id, effectId: null, param: 'scale' }, songId, 'level', 'bass', s(2), ids))
    const second = run(linkToAudio({ clipId: clip.id, effectId: null, param: 'opacity' }, songId, 'level', 'bass', s(2), ids))
    expect(second.notice).toMatch(/already drives/)
    run(linkToAudio({ clipId: clip.id, effectId: invert, param: 'amount' }, songId, 'loudness', 'bass', s(2), ids))
    const mods = history.state.sequence.modulators
    expect(mods.map((m) => m.name)).toEqual(['Song · Bass', 'Song · Loudness'])
    expect(mods[0]).toMatchObject({ attack: 5, release: 150, threshold: 0 })
    expect(linksTo(history.state.sequence, mods[0]!.id).map((l) => l.ref.param)).toEqual(['scale', 'opacity'])
    // Defaults: from the value as it is (+0) to a visible step.
    const scaleLink = video().modulation['scale']![0]!
    expect(scaleLink).toMatchObject({ mode: 'add', min: [0], max: [25], amount: 100 })
    expect(video().modulation['opacity']![0]!.max).toEqual([-50])
    expect(() => history.dispatch(linkToAudio({ clipId: clip.id, effectId: invert, param: 'channel' }, songId, 'level', 'bass', s(2), ids))).toThrow(/can't be modulated/)
    expect(() => history.dispatch(addLink({ clipId: clip.id, effectId: null, param: 'scale' }, mods[0]!.id, s(2)))).toThrow(/already linked/)
  })

  it('resolves modulated values on top of keyframes, clamped to their ranges', () => {
    const { run, video, songId, history } = setup()
    const clip = video()
    run(setAnimated({ clipId: clip.id, effectId: null, param: 'scale' }, true, clip.start))
    run(setValue({ clipId: clip.id, effectId: null, param: 'scale' }, 200, clip.start + s(4)))
    run(linkToAudio({ clipId: clip.id, effectId: null, param: 'scale' }, songId, 'level', 'bass', s(2), ids))
    run(linkToAudio({ clipId: clip.id, effectId: null, param: 'opacity' }, songId, 'level', 'bass', s(2), ids))
    const ctx: ModulationContext = { value: () => 1 }
    const at = clip.start + s(2)
    const base = Number(valueAt(video(), null, 'scale', s(2)))
    expect(resolveClip(video(), at, ctx).motion.scale).toBeCloseTo(base + 25, 9)
    expect(resolveClip(video(), at, ctx).opacity).toBe(50)
    run(updateLink({ clipId: clip.id, effectId: null, param: 'opacity' }, video().modulation['opacity']![0]!.id, { mode: 'add', max: [500] }))
    expect(resolveClip(video(), at, ctx).opacity).toBe(100)
    // Without modulation (no context) the values are just the keyframes.
    expect(resolveClip(video(), at).motion.scale).toBeCloseTo(base, 9)
    const [layer] = videoLayersAt(history.state.sequence, history.state.media, at, ctx)
    expect(layer!.clip.motion.scale).toBeCloseTo(base + 25, 9)
  })

  it('volume modulation reaches the gain; removing a modulator removes its links', () => {
    const { run, songId, history } = setup()
    const song = history.state.sequence.clips.find((c) => c.kind === 'audio')!
    run(linkToAudio({ clipId: song.id, effectId: null, param: 'volume' }, songId, 'level', 'sub', s(2), ids))
    expect(gainAt(history.state.sequence.clips.find((c) => c.kind === 'audio')!, s(2), { value: () => 1 })).toBeCloseTo(10 ** (-12 / 20), 9)
    const removed = run(removeModulator(history.state.sequence.modulators[0]!.id))
    expect(removed.notice).toMatch(/1 value/)
    expect(history.state.sequence.clips.find((c) => c.kind === 'audio')!.modulation).toEqual({})
  })

  it('links travel with clips through splits, save, and older projects', () => {
    const { run, video, songId, history } = setup()
    const clip = video()
    run(linkToAudio({ clipId: clip.id, effectId: null, param: 'rotation' }, songId, 'transient', 'high', s(2), ids))
    run(splitClips([clip.id], s(5), ids))
    const halves = history.state.sequence.clips.filter((c) => c.kind === 'video')
    expect(halves.every((c) => c.modulation['rotation']?.length === 1)).toBe(true)
    const reopened = parseProject(serializeProject(history.state))
    expect(reopened.sequence.modulators).toEqual(history.state.sequence.modulators)
    expect(reopened.sequence.clips).toEqual(history.state.sequence.clips)
    // A link to a modulator that isn't there is dropped when opening.
    const raw = JSON.parse(serializeProject(history.state)) as { sequence: { modulators: unknown[] } }
    raw.sequence.modulators = []
    expect(parseProject(JSON.stringify(raw)).sequence.clips.every((c) => Object.keys(c.modulation).length === 0)).toBe(true)
    const v8 = JSON.parse(serializeProject(history.state)) as { schemaVersion: number; sequence: Record<string, unknown> & { clips: Array<Record<string, unknown>> } }
    v8.schemaVersion = 8
    delete v8.sequence['modulators']
    for (const c of v8.sequence.clips) delete c['modulation']
    const migrated = parseProject(JSON.stringify(v8))
    expect(migrated.sequence.modulators).toEqual([])
    run(removeLinks({ clipId: halves[0]!.id, effectId: null, param: 'rotation' }))
    expect(history.state.sequence.clips.find((c) => c.id === halves[0]!.id)!.modulation).toEqual({})
  })

  it('modulator settings change and keyframe at sequence time', () => {
    const { run, history } = setup()
    const made = run(addModulator({ kind: 'lfo', shape: 'sine', rate: '1/4', seed: 1 }, 'Wobble', ids)) as ReturnType<typeof addModulator>
    run(updateModulator(made.modulatorId, { threshold: 2, curve: 's-curve' }))
    const mod = () => history.state.sequence.modulators[0]!
    expect(mod().threshold).toBe(1)
    run(setModulatorAnimated(made.modulatorId, 'gain', true, s(1)))
    run(setModulatorValue(made.modulatorId, 'gain', 12, s(3)))
    expect(mod().keyframes['gain']!.map((k) => [k.time, k.value])).toEqual([
      [s(1), 0],
      [s(3), 12]
    ])
    run(setModulatorAnimated(made.modulatorId, 'gain', false, s(2)))
    expect(mod().gain).toBeCloseTo(6, 9)
  })
})

describe('built-in presets (M10)', () => {
  it('Kick Flash adds Basic Correction with Exposure linked to the first source’s bass hits', () => {
    const { history, run, video, songId } = setup()
    const clip = video()
    const command = run(applyBuiltinPreset([clip.id], 'builtin:kick-flash', s(2), ids))
    expect(command.notice).toMatch(/follows “Song”/)
    const effect = video().effects[0]!
    expect(effect.effectId).toBe('basic-correction')
    expect(effect.params['exposure']).toBe(0)
    const [link] = effect.modulation['exposure']!
    expect(link).toMatchObject({ mode: 'add', min: [0], max: [2], amount: 100, invert: false })
    const mod = history.state.sequence.modulators.find((m) => m.id === link!.modulatorId)!
    expect(mod.source).toEqual({ kind: 'audio', sourceId: songId, signal: 'hits', band: 'bass' })
    expect([mod.attack, mod.release]).toEqual([0, 200])
    // Exposure goes 0 → 2 stops with the modulator, 0 → 1.
    const at = (v: number): ModulationContext => ({ value: () => v })
    const resolved = (v: number) => resolveClip(video(), s(2), at(v)).effects[0]!.params['exposure']
    expect(resolved(0)).toBe(0)
    expect(resolved(1)).toBe(2)
    expect(resolved(0.25)).toBe(0.5)
    // Applying it again (here, or on another clip) reuses the same modulator; one undo removes it all.
    run(applyBuiltinPreset([clip.id], 'builtin:kick-flash', s(2), ids))
    expect(history.state.sequence.modulators).toHaveLength(1)
    history.undo()
    history.undo()
    expect(video().effects).toHaveLength(0)
    expect(history.state.sequence.modulators).toHaveLength(0)
  })

  it('Bass Mosaic links Cell Size to the bass level, off while quiet', () => {
    const { history, run, video } = setup()
    run(applyBuiltinPreset([video().id], 'builtin:bass-mosaic', s(2), ids))
    const effect = video().effects[0]!
    expect(effect.effectId).toBe('mosaic')
    expect(effect.params['cellSize']).toBe(0)
    const mod = history.state.sequence.modulators[0]!
    expect(mod.source).toMatchObject({ signal: 'level', band: 'bass' })
    expect(mod.threshold).toBe(0.2)
    expect(effect.modulation['cellSize']![0]).toMatchObject({ mode: 'add', min: [0], max: [6] })
  })

  it('adds the effect alone, and says why, when there’s no audio source', () => {
    const history = new History(createProject({ name: 'Mute', createId: ids }))
    history.dispatch(importMedia([media('clip', 'video')]))
    const V1 = history.state.sequence.tracks.find((t) => t.kind === 'video')!.id
    history.dispatch(placeMedia({ mediaId: 'm-clip', sourceIn: 0, sourceOut: s(4), at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    const clip = history.state.sequence.clips.find((c) => c.kind === 'video')!
    const command = applyBuiltinPreset([clip.id], 'builtin:kick-flash', 0, ids)
    expect(history.dispatch(command)).toBeTruthy()
    expect(command.notice).toMatch(/no audio to follow/)
    const effect = history.state.sequence.clips.find((c) => c.id === clip.id)!.effects[0]!
    expect(effect.effectId).toBe('basic-correction')
    expect(effect.modulation).toEqual({})
    expect(history.state.sequence.modulators).toHaveLength(0)
  })
})
