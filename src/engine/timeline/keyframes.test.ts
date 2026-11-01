import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { CommandError } from '../project/commands'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject, type Clip } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { applyPreset, evaluate, normaliseTrack, putKeyframe, speedIntegral, timelineForMedia, type Keyframe } from '../keyframes/keyframes'
import { animatedRefs, resolveClip, valueAt } from '../keyframes/properties'
import { rescaleEffects } from '../effects/presets'
import { addEffect } from './effect-edits'
import { placeMedia, setClipSpeed, splitClips, trimClips, addFrameHold, unlinkClips, linkClips, type TimelineCommand } from './edits'
import {
  addKeyframe,
  applyMoveKeyframes,
  changeKeyframe,
  copyKeyframes,
  moveKeyframes,
  pasteKeyframes,
  removeKeyframes,
  scaleKeyframes,
  setAnimated,
  setKeyframeInterpolation,
  setValue,
  type KeyframeRef
} from './keyframe-edits'
import { gainAt, videoLayersAt } from './render-plan'
import { frameTicks, handles, sourceSpan, sourceTimeAt, timeForMedia } from './timeline'
import { produce } from 'immer'

let counter = 0
const ids = () => `kf-${++counter}`
const s = (n: number) => secondsToTicks(n)
const T = s(1)

function key(time: number, value: Keyframe['value'], interpolation: Keyframe['interpolation'] = 'linear', extra: Partial<Keyframe> = {}): Keyframe {
  const n = Array.isArray(value) ? 2 : 1
  return { id: `k${time}`, time, value, interpolation, in: { t: 1 / 3, v: Array(n).fill(0) }, out: { t: 1 / 3, v: Array(n).fill(0) }, ...extra }
}

function media(name: string, seconds = 30): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: seconds,
    bitRate: null,
    video: {
      codec: 'h264',
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
const SHORT = media('short', 6)

function setup(item: MediaItem = A, at = 2, inS = 1, outS = 11) {
  const history = new History(createProject({ name: 'Keys', createId: ids }))
  history.dispatch(importMedia([A, SHORT]))
  const tracks = history.state.sequence.tracks
  const V1 = tracks.find((t) => t.kind === 'video')!.id
  const A1 = tracks.find((t) => t.kind === 'audio')!.id
  const run = (command: TimelineCommand) => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: item.id, sourceIn: s(inS), sourceOut: s(outS), at: s(at), videoTrackId: V1, audioTrackId: A1, mode: 'overwrite' }, ids))
  const clips = () => history.state.sequence.clips
  const video = () => clips().filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start)[0]!
  const audio = () => clips().find((c) => c.kind === 'audio')!
  const frame = frameTicks(history.state.sequence)
  return { history, run, clips, video, audio, frame, V1, A1 }
}

describe('keyframe evaluation', () => {
  it('holds before the first keyframe and after the last, and steps on hold', () => {
    const track = [key(T, 10, 'hold'), key(3 * T, 30, 'linear')]
    expect(evaluate(track, 0, 0)).toBe(10)
    expect(evaluate(track, 2 * T, 0)).toBe(10)
    expect(evaluate(track, 3 * T - 1, 0)).toBe(10)
    expect(evaluate(track, 3 * T, 0)).toBe(30)
    expect(evaluate(track, 9 * T, 0)).toBe(30)
    expect(evaluate([], 5, 42)).toBe(42)
  })

  it('interpolates numbers and points linearly, component by component', () => {
    const track = [key(0, [0, 100]), key(4 * T, [400, -100])]
    expect(evaluate(track, T, [0, 0])).toEqual([100, 50])
    expect(evaluate([key(0, 0), key(2 * T, 10)], T / 2, 0)).toBeCloseTo(2.5, 12)
  })

  it('always holds choices and toggles', () => {
    const track = [key(0, 'red', 'linear'), key(T, 'blue')]
    expect(evaluate(track, T - 1, 'x')).toBe('red')
    expect(evaluate(track, T, 'x')).toBe('blue')
    expect(evaluate([key(0, false), key(T, true)], T / 2, false)).toBe(false)
  })

  it('a bezier with straight handles is the same as linear', () => {
    const track = [key(0, 0), key(3 * T, 90)]
    applyPreset(track, 0, 'bezier')
    expect(track[0]!.interpolation).toBe('bezier')
    for (const f of [0.1, 0.25, 0.5, 0.9]) expect(Number(evaluate(track, f * 3 * T, 0))).toBeCloseTo(90 * f, 9)
  })

  it('eases: Ease In and Out is slow at both ends and symmetric', () => {
    const track = [key(0, 0), key(2 * T, 100)]
    applyPreset(track, 0, 'ease-in-out')
    applyPreset(track, 1, 'ease-in-out')
    const at = (f: number) => Number(evaluate(track, f * 2 * T, 0))
    expect(at(0.5)).toBeCloseTo(50, 9)
    expect(at(0.05)).toBeLessThan(5 * 0.5)
    expect(at(0.25) + at(0.75)).toBeCloseTo(100, 9)
    // Monotonic.
    let last = -1
    for (let f = 0; f <= 1; f += 0.01) {
      expect(at(f)).toBeGreaterThanOrEqual(last - 1e-9)
      last = at(f)
    }
  })

  it('Ease Out eases only the leaving end; the arriving end stays straight', () => {
    const track = [key(0, 0), key(T, 100)]
    applyPreset(track, 0, 'ease-out')
    const slope = (a: number, b: number) => (Number(evaluate(track, b * T, 0)) - Number(evaluate(track, a * T, 0))) / (b - a)
    expect(slope(0, 0.01)).toBeLessThan(20)
    expect(slope(0.99, 1)).toBeGreaterThan(100)
  })

  it('a new keyframe carries on the interpolation before it; stepped values hold', () => {
    const track = [key(0, 0, 'bezier'), key(4 * T, 10)]
    const k = putKeyframe(track, 2 * T, 5, 'new', false)
    expect(k.interpolation).toBe('bezier')
    expect(track.map((x) => x.time)).toEqual([0, 2 * T, 4 * T])
    expect(putKeyframe(track, 2 * T, 7, 'other', false)).toBe(k)
    expect(k.value).toBe(7)
    expect(putKeyframe([], 0, 'a', 'c', true).interpolation).toBe('hold')
  })
})

describe('speed ramps', () => {
  /** Simpson's rule on the evaluated curve, as an independent check of the exact integral. */
  function numeric(track: Keyframe[], t: number): number {
    const n = 20_000
    const h = t / n
    let sum = 0
    for (let i = 0; i <= n; i++) sum += (Number(evaluate(track, i * h, 100)) / 100) * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2)
    return (sum * h) / 3
  }

  it('integrates hold, linear and bezier segments exactly', () => {
    expect(speedIntegral([key(0, 100)], 5 * T)).toBeCloseTo(5 * T, 3)
    expect(speedIntegral([key(0, 100), key(2 * T, 300)], 2 * T)).toBeCloseTo(4 * T, 3)
    expect(speedIntegral([key(0, 200, 'hold'), key(T, 50)], 3 * T)).toBeCloseTo(2 * T + T, 3)
    const eased = [key(0, 100), key(2 * T, 400), key(3 * T, 0)]
    applyPreset(eased, 1, 'ease-in-out')
    applyPreset(eased, 0, 'ease-out')
    for (const t of [T / 3, T, 1.7 * T, 2.5 * T, 4 * T]) expect(speedIntegral(eased, t) / T).toBeCloseTo(numeric(eased, t) / T, 6)
  })

  it('runs backwards before the clip start and finds how much timeline media lasts', () => {
    const track = [key(T, 100), key(2 * T, 200)]
    expect(speedIntegral(track, -T)).toBeCloseTo(-T, 3)
    const d = timelineForMedia(track, 0, 2.5 * T, 1)
    expect(speedIntegral(track, d) / T).toBeCloseTo(2.5, 6)
    expect(timelineForMedia([key(0, 0)], 0, T, 1)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('moves the picture through the media by the ramp, and trims keep the same frames', () => {
    const { run, video, frame, history } = setup()
    const clip = video()
    run(setAnimated({ clipId: clip.id, effectId: null, param: 'speed' }, true, clip.start))
    run(setValue({ clipId: clip.id, effectId: null, param: 'speed' }, 300, clip.start + 2 * T))
    const ramped = video()
    expect(ramped.keyframes['speed']!.map((k) => k.value)).toEqual([100, 300])
    // 0–2 s: 100% → 300% linear = 4 s of media; then 300%.
    expect(sourceTimeAt(ramped, ramped.start + 2 * T, frame)).toBe(ramped.sourceIn + 4 * T)
    expect(sourceSpan(ramped)).toBe(4 * T + 8 * 3 * T)
    const before = [0, 1, 2.4, 3].map((x) => sourceTimeAt(ramped, ramped.start + s(x) + frame * 25, frame))
    run(trimClips({ clipIds: [ramped.id], edge: 'in', delta: 25 * frame }))
    const trimmed = video()
    expect(trimmed.keyframes['speed']![0]!.time).toBe(-25 * frame)
    const after = [0, 1, 2.4, 3].map((x) => sourceTimeAt(trimmed, ramped.start + s(x) + frame * 25, frame))
    after.forEach((t, i) => expect(Math.abs(t - before[i]!)).toBeLessThanOrEqual(1))
    expect(history.state.sequence.clips.length).toBe(2)
  })

  it('limits trims by the media a ramp has left', () => {
    const { run, video } = setup(SHORT, 0, 1, 5)
    const clip = video()
    run(setAnimated({ clipId: clip.id, effectId: null, param: 'speed' }, true, clip.start))
    // 1 s of media before; at 50% that is 2 s of timeline.
    run(setValue({ clipId: clip.id, effectId: null, param: 'speed' }, 50, clip.start))
    const h = handles(video(), s(6))
    expect(h.head / T).toBeCloseTo(2, 6)
    // 4 s clip at 50% uses 2 s; 3 s left after (from 3 s), = 6 s of timeline.
    expect(h.tail / T).toBeCloseTo(6, 6)
  })

  it('refuses ramps on reversed clips and holds, and Speed/Duration on ramped clips', () => {
    const { run, video, history } = setup()
    const clip = video()
    run(setClipSpeed({ clipIds: [clip.id], speed: 1, reverse: true, ripple: false }, history.state.media))
    expect(() => history.dispatch(setAnimated({ clipId: clip.id, effectId: null, param: 'speed' }, true, clip.start))).toThrow(/forwards only/)
    run(setClipSpeed({ clipIds: [clip.id], speed: 1, reverse: false, ripple: false }, history.state.media))
    run(setAnimated({ clipId: clip.id, effectId: null, param: 'speed' }, true, clip.start))
    expect(() => history.dispatch(setClipSpeed({ clipIds: [clip.id], speed: 2, reverse: false, ripple: false }, history.state.media))).toThrow(/Speed keyframes/)
    run(addFrameHold([clip.id], clip.start + T, ids))
    const hold = history.state.sequence.clips.filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start)[1]!
    expect(hold.speed).toBe(0)
    expect(hold.keyframes['speed']).toBeUndefined()
  })

  it("linked sound follows its picture's ramp; unlinked sound is left alone (decision 41)", () => {
    const { run, video, audio, frame, history } = setup()
    const clip = video()
    const ref = { clipId: clip.id, effectId: null, param: 'speed' }
    run(setAnimated(ref, true, clip.start))
    run(setValue(ref, 250, clip.start + 2 * T))
    expect(audio().keyframes['speed']).toEqual(video().keyframes['speed'])
    for (const x of [0.5, 1.7, 3, 6]) expect(sourceTimeAt(audio(), clip.start + s(x), frame)).toBe(sourceTimeAt(video(), clip.start + s(x), frame))
    // The inverse: where a media time plays.
    const media = sourceTimeAt(video(), clip.start + s(1.7), frame)
    expect(Math.abs(timeForMedia(audio(), media) - (clip.start + s(1.7)))).toBeLessThanOrEqual(1)
    // Trimming both keeps them together.
    run(trimClips({ clipIds: [clip.id, audio().id], edge: 'in', delta: 10 * frame }))
    expect(audio().sourceIn).toBe(video().sourceIn)
    expect(audio().keyframes['speed']).toEqual(video().keyframes['speed'])
    // Unlinked: the sound goes back to playing as it is.
    run(unlinkClips([clip.id]))
    expect(audio().keyframes['speed']).toBeUndefined()
    run(linkClips([clip.id, audio().id], ids))
    expect(audio().keyframes['speed']).toEqual(video().keyframes['speed'])
    // Reopening rebuilds the sound's copy from the picture.
    const reopened = parseProject(serializeProject(history.state))
    expect(reopened.sequence.clips.find((c) => c.kind === 'audio')!.keyframes['speed']).toEqual(video().keyframes['speed'])
    // Turning the ramp off turns it off for the sound too.
    run(setAnimated(ref, false, clip.start))
    expect(audio().keyframes['speed']).toBeUndefined()
  })

  it('notes that linked sound follows the ramp, and when media runs out', () => {
    const { run, video } = setup(SHORT, 0, 0, 6)
    const clip = video()
    const on = run(setAnimated({ clipId: clip.id, effectId: null, param: 'speed' }, true, clip.start))
    expect(on.notice).toMatch(/linked sound follows/)
    const fast = run(setValue({ clipId: clip.id, effectId: null, param: 'speed' }, 200, clip.start))
    expect(fast.notice).toMatch(/runs out of media/)
  })
})

describe('keyframe commands', () => {
  it('the stopwatch makes a keyframe at the playhead; edits there change it; off keeps the value', () => {
    const { run, video, history } = setup()
    const clip = video()
    const ref = { clipId: clip.id, effectId: null, param: 'opacity' }
    expect(() => history.dispatch(setAnimated(ref, true, 0))).toThrow(CommandError)
    run(setAnimated(ref, true, clip.start + T))
    run(setValue(ref, 20, clip.start + 3 * T))
    expect(video().keyframes['opacity']!.map((k) => [k.time, k.value])).toEqual([[T, 100], [3 * T, 20]])
    expect(valueAt(video(), null, 'opacity', 2 * T)).toBeCloseTo(60, 9)
    expect(() => history.dispatch(setValue(ref, 50, clip.start + clip.duration + T))).toThrow(/playhead/)
    run(setAnimated(ref, false, clip.start + 2 * T))
    expect(video().keyframes['opacity']).toBeUndefined()
    expect(video().opacity).toBeCloseTo(60, 9)
  })

  it('a drag on a value at one playhead is one undo step', () => {
    const { run, video, history } = setup()
    const clip = video()
    const ref = { clipId: clip.id, effectId: null, param: 'position' }
    run(setAnimated(ref, true, clip.start))
    const steps = history.undoLabel
    for (let x = 0; x < 5; x++) run(setValue(ref, [100 + x, 200], clip.start + T))
    expect(video().keyframes['position']!.length).toBe(2)
    history.undo()
    expect(video().keyframes['position']!.length).toBe(1)
    expect(history.undoLabel).toBe(steps)
  })

  it('moves, stretches, re-interpolates, removes and changes keyframes', () => {
    const { run, video, frame } = setup()
    const clip = video()
    const ref = { clipId: clip.id, effectId: null, param: 'rotation' }
    run(setAnimated(ref, true, clip.start))
    run(setValue(ref, 90, clip.start + 2 * T))
    run(setValue(ref, 180, clip.start + 4 * T))
    const [k0, k1, k2] = video().keyframes['rotation']!
    const refOf = (k: Keyframe): KeyframeRef => ({ ...ref, keyframeId: k.id })
    run(moveKeyframes([refOf(k1!)], T + 0.4 * frame))
    expect(video().keyframes['rotation']!.map((k) => k.time)).toEqual([0, 3 * T, 4 * T])
    // Moving onto another keyframe replaces it.
    run(moveKeyframes([refOf(k1!)], T))
    expect(video().keyframes['rotation']!.map((k) => k.value)).toEqual([0, 90])
    run(scaleKeyframes([refOf(k0!), refOf(k1!)], clip.start, 0.5))
    expect(video().keyframes['rotation']!.map((k) => k.time)).toEqual([0, 2 * T])
    run(setKeyframeInterpolation([refOf(k0!)], 'hold'))
    expect(valueAt(video(), null, 'rotation', T)).toBe(0)
    run(changeKeyframe(refOf(k1!), { value: 45 }))
    expect(valueAt(video(), null, 'rotation', 3 * T)).toBe(45)
    run(removeKeyframes([refOf(k0!), refOf(k1!)]))
    expect(video().keyframes['rotation']).toBeUndefined()
    expect(video().motion.rotation).toBe(45)
    expect(k2).toBeDefined()
  })

  it('the ◆ button adds a keyframe with the current value', () => {
    const { run, video } = setup()
    const clip = video()
    const ref = { clipId: clip.id, effectId: null, param: 'scale' }
    run(setAnimated(ref, true, clip.start))
    run(setValue(ref, 200, clip.start + 4 * T))
    run(addKeyframe(ref, clip.start + 2 * T))
    const track = video().keyframes['scale']!
    expect(track.length).toBe(3)
    expect(Number(track[1]!.value)).toBeCloseTo((Number(track[0]!.value) + 200) / 2, 9)
  })

  it('copies and pastes keyframes between properties and clips of the same kind', () => {
    const { run, video, audio, history } = setup()
    const clip = video()
    const pos = { clipId: clip.id, effectId: null, param: 'position' }
    run(setAnimated(pos, true, clip.start))
    run(setValue(pos, [10, 20], clip.start + T))
    const track = video().keyframes['position']!
    const board = copyKeyframes(history.state.sequence, track.map((k) => ({ ...pos, keyframeId: k.id })))!
    expect(board.keyframes.map((k) => k.time)).toEqual([0, T])
    run(pasteKeyframes({ clipId: clip.id, effectId: null, param: 'anchor' }, board, clip.start + 2 * T, ids))
    expect(video().keyframes['anchor']!.map((k) => [k.time, k.value])).toEqual([
      [2 * T, [960, 540]],
      [3 * T, [10, 20]]
    ])
    expect(() => history.dispatch(pasteKeyframes({ clipId: audio().id, effectId: null, param: 'volume' }, board, audio().start))).toThrow(/can’t go on Volume/)
  })

  it('keeps keyframes with the picture through splits and speed changes', () => {
    const { run, video, clips, frame, history } = setup()
    const clip = video()
    const ref = { clipId: clip.id, effectId: null, param: 'opacity' }
    run(setAnimated(ref, true, clip.start))
    run(setValue(ref, 0, clip.start + 4 * T))
    const at = clip.start + 2 * T + 10 * frame
    const value = valueAt(clip, null, 'opacity', at - clip.start)
    const seen = valueAt(video(), null, 'opacity', at - clip.start)
    run(splitClips([clip.id], clip.start + 2 * T, ids))
    const right = clips().filter((c) => c.kind === 'video').sort((a, b) => a.start - b.start)[1]!
    expect(valueAt(right, null, 'opacity', at - right.start)).toBeCloseTo(Number(seen), 9)
    expect(value).toBe(100)
    const left = video()
    run(setClipSpeed({ clipIds: [left.id], speed: 2, reverse: false, ripple: false }, history.state.media))
    expect(video().keyframes['opacity']!.map((k) => k.time)).toEqual([0, 2 * T])
  })

  it('animates effect parameters, Mix and choices, and copies them with the effect', () => {
    const { run, video, history } = setup()
    const clip = video()
    run(addEffect([clip.id], 'invert', null, ids))
    const effect = video().effects[0]!
    const amount = { clipId: clip.id, effectId: effect.id, param: 'amount' }
    run(setAnimated(amount, true, clip.start))
    run(setValue(amount, 0, clip.start + 2 * T))
    run(setAnimated({ clipId: clip.id, effectId: effect.id, param: 'mix' }, true, clip.start))
    run(setAnimated({ clipId: clip.id, effectId: effect.id, param: 'channel' }, true, clip.start))
    run(setValue({ clipId: clip.id, effectId: effect.id, param: 'channel' }, 'red', clip.start + T))
    expect(() => history.dispatch(setKeyframeInterpolation(video().effects[0]!.keyframes['channel']!.map((k) => ({ clipId: clip.id, effectId: effect.id, param: 'channel', keyframeId: k.id })), 'linear'))).toThrow(/always hold/)
    const resolved = resolveClip(video(), clip.start + T / 2)
    expect(resolved.effects[0]!.params['amount']).toBeCloseTo(75, 9)
    expect(resolved.effects[0]!.params['channel']).toBe('rgb')
    expect(resolveClip(video(), clip.start + T).effects[0]!.params['channel']).toBe('red')
    expect(animatedRefs(video()).map((r) => r.param)).toEqual(['mix', 'amount', 'channel'])
    // Presets: positions scale; keyframes travel with the effect.
    run(addEffect([clip.id], 'transform', null, ids))
    const transform = video().effects[1]!
    const position = { clipId: clip.id, effectId: transform.id, param: 'position' }
    run(setAnimated(position, true, clip.start))
    run(setValue(position, [1920, 1080], clip.start + T))
    const scaled = rescaleEffects([video().effects[1]!], { width: 1920, height: 1080 }, { width: 3840, height: 2160 })[0]!
    expect(scaled.keyframes['position']!.map((k) => k.value)).toEqual([
      [1920, 1080],
      [3840, 2160]
    ])
  })
})

describe('the render plan and saving', () => {
  it('layers show animated Motion, Opacity and effects; unanimated clips are untouched', () => {
    const { run, video, history } = setup()
    const clip = video()
    expect(resolveClip(clip, clip.start + T)).toBe(clip)
    run(setAnimated({ clipId: clip.id, effectId: null, param: 'position' }, true, clip.start))
    run(setValue({ clipId: clip.id, effectId: null, param: 'position' }, [0, 0], clip.start + 2 * T))
    run(setAnimated({ clipId: clip.id, effectId: null, param: 'opacity' }, true, clip.start))
    run(setValue({ clipId: clip.id, effectId: null, param: 'opacity' }, 0, clip.start + 2 * T))
    const [layer] = videoLayersAt(history.state.sequence, history.state.media, clip.start + T)
    expect(layer!.clip.motion.positionX).toBeCloseTo(480, 9)
    expect(layer!.clip.motion.positionY).toBeCloseTo(270, 9)
    expect(layer!.clip.opacity).toBeCloseTo(50, 9)
    // Fully transparent at the last keyframe: nothing to draw.
    expect(videoLayersAt(history.state.sequence, history.state.media, clip.start + 3 * T)).toEqual([])
  })

  it('volume keyframes give a gain curve; overshoot is clamped to the range', () => {
    const { run, audio } = setup()
    const clip = audio()
    const ref = { clipId: clip.id, effectId: null, param: 'volume' }
    run(setAnimated(ref, true, clip.start))
    run(setValue(ref, -96, clip.start + 2 * T))
    expect(gainAt(audio(), clip.start)).toBe(1)
    expect(gainAt(audio(), clip.start + T)).toBeCloseTo(10 ** (-48 / 20), 9)
    expect(gainAt(audio(), clip.start + 5 * T)).toBe(0)
    const overshoot = produce(audio(), (c) => {
      c.keyframes['volume']![0]!.interpolation = 'bezier'
      c.keyframes['volume']![0]!.out = { t: 0.5, v: [200] }
    })
    expect(resolveClip(overshoot, clip.start + T / 2).volume).toBe(15)
  })

  it('saves and reopens keyframes, and migrates version 6 projects', () => {
    const { run, video, history } = setup()
    const clip = video()
    run(addEffect([clip.id], 'invert', null, ids))
    run(setAnimated({ clipId: clip.id, effectId: null, param: 'rotation' }, true, clip.start))
    run(setAnimated({ clipId: clip.id, effectId: video().effects[0]!.id, param: 'amount' }, true, clip.start))
    run(setKeyframeInterpolation([{ clipId: clip.id, effectId: null, param: 'rotation', keyframeId: video().keyframes['rotation']![0]!.id }], 'ease-out'))
    const reopened = parseProject(serializeProject(history.state))
    expect(reopened.sequence.clips).toEqual(history.state.sequence.clips)
    const v6 = JSON.parse(serializeProject(history.state)) as { schemaVersion: number; sequence: { clips: Array<Record<string, unknown> & { effects: Array<Record<string, unknown>> }> } }
    v6.schemaVersion = 6
    for (const c of v6.sequence.clips) {
      delete c['keyframes']
      for (const e of c.effects) delete e['keyframes']
    }
    const migrated = parseProject(JSON.stringify(v6))
    expect(migrated.sequence.clips.every((c) => Object.keys(c.keyframes).length === 0 && c.effects.every((e) => Object.keys(e.keyframes).length === 0))).toBe(true)
  })

  it('repairs damaged keyframes when opening: values clamped, choices held, one per frame', () => {
    const { run, video, history } = setup()
    const clip = video()
    run(setAnimated({ clipId: clip.id, effectId: null, param: 'opacity' }, true, clip.start))
    const raw = JSON.parse(serializeProject(history.state)) as { sequence: { clips: Clip[] } }
    const target = raw.sequence.clips.find((c) => c.id === clip.id)!
    target.keyframes['opacity']!.push({ ...target.keyframes['opacity']![0]!, id: 'dup', value: 400 })
    target.keyframes['nonsense'] = [key(0, 1)]
    const opened = parseProject(JSON.stringify(raw)).sequence.clips.find((c) => c.id === clip.id)!
    expect(opened.keyframes['opacity']!.map((k) => k.value)).toEqual([100])
    expect(opened.keyframes['nonsense']).toBeUndefined()
    expect(normaliseTrack([key(0, 'a', 'bezier')], (v) => v, true)[0]!.interpolation).toBe('hold')
  })

  it('live drag previews apply the same move as the command', () => {
    const { run, video, history } = setup()
    const clip = video()
    const ref = { clipId: clip.id, effectId: null, param: 'scale' }
    run(setAnimated(ref, true, clip.start))
    const k = video().keyframes['scale']![0]!
    const preview = produce(history.state.sequence, (d) => applyMoveKeyframes(d, [{ ...ref, keyframeId: k.id }], 2 * T))
    run(moveKeyframes([{ ...ref, keyframeId: k.id }], 2 * T))
    expect(history.state.sequence.clips).toEqual(preview.clips)
  })
})
