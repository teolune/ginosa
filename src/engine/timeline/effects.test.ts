import { describe, expect, it } from 'vitest'
import { EFFECTS, effectById } from '../../effects/registry'
import { invertReference } from '../../effects/invert/reference'
import blendWgsl from '../../renderer/src/playback/blend.wgsl?raw'
import { blendRgb } from '../effects/blend'
import { fromOklab, toDisplay, toLinear, toOklab } from '../effects/colour-spaces'
import { defaultParams, sanitiseParams, upgradeInstance } from '../effects/params'
import { parsePresets, rescaleEffects } from '../effects/presets'
import type { EffectManifest } from '../effects/types'
import { History } from '../history'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { BLEND_MODES, createProject } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { addAdjustmentLayer, addEffect, moveEffect, pasteEffects, removeEffects, resetEffect, setEffectEnabled, setEffectValues } from './effect-edits'
import { copyClips, pasteClips, placeMedia, setClipSpeed, splitClips, trimClips, type TimelineCommand } from './edits'
import { videoLayersAt } from './render-plan'

let counter = 0
const ids = () => `fx-${++counter}`
const s = (n: number) => secondsToTicks(n)

function media(name: string, width = 3840, height = 2160): MediaItem {
  const info: MediaInfo = {
    container: 'mov',
    durationSeconds: 30,
    bitRate: null,
    video: { codec: 'hevc', profile: null, width, height, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: 750, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' }
  }
  return { id: `m-${name}`, name, kind: 'video', path: `/f/${name}`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-10-31T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

const A = media('a')

function setup() {
  const history = new History(createProject({ name: 'Effects', createId: ids }))
  history.dispatch(importMedia([A]))
  const tracks = history.state.sequence.tracks
  const [V1, V2] = tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const A1 = tracks.find((t) => t.kind === 'audio')!.id
  const run = (command: TimelineCommand) => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
  }
  run(placeMedia({ mediaId: A.id, sourceIn: 0, sourceOut: s(4), at: 0, videoTrackId: V1, audioTrackId: A1, mode: 'overwrite' }, ids))
  const clip = () => history.state.sequence.clips.find((c) => c.kind === 'video' && !c.adjustment)!
  return { history, run, V1, V2, clip }
}

describe('effect registry', () => {
  it('finds every effect folder, with valid manifests', () => {
    expect(EFFECTS.map((e) => e.id)).toEqual(expect.arrayContaining(['invert', 'transform']))
    for (const effect of EFFECTS) {
      expect(new Set(effect.params.map((p) => p.id)).size, effect.id).toBe(effect.params.length)
      for (const p of effect.params) {
        expect(p.id, `${effect.id}.${p.id}`).toMatch(/^[a-z][A-Za-z0-9]*$/)
        if (p.type === 'number') expect(p.default).toBeGreaterThanOrEqual(p.min)
        if (p.type === 'choice') expect(p.options.some((o) => o.id === p.default)).toBe(true)
      }
      expect(effect.shader).toMatch(/fn effect\(px: vec2f\) -> vec4f/)
    }
  })

  it('keeps blend mode numbers in step with the shader', () => {
    const wgsl = blendWgsl
    const cases = [...wgsl.matchAll(/case (\d+)u: \{.*\/\/ ([a-z-]+)/g)].map((m) => [Number(m[1]), m[2]] as const)
    for (const [n, id] of cases) expect(BLEND_MODES[n]?.id, `case ${n}`).toBe(id)
    expect(cases.map(([n]) => n).sort((a, b) => a - b)).toEqual(Array.from({ length: BLEND_MODES.length - 1 }, (_, i) => i + 1))
  })
})

describe('effect parameters', () => {
  const transform = effectById('transform')!

  it('defaults points to the middle of the image the effect sees', () => {
    expect(defaultParams(transform, { width: 3840, height: 2160 })['position']).toEqual([1920, 1080])
  })

  it('clamps numbers, refuses unknown choices and fills missing values', () => {
    const params = sanitiseParams(transform, { scale: 99999, edges: 'wobble', rotation: 'x' }, { width: 100, height: 50 })
    expect(params['scale']).toBe(10000)
    expect(params['edges']).toBe('transparent')
    expect(params['rotation']).toBe(0)
    expect(params['anchor']).toEqual([50, 25])
  })

  it('upgrades instances made with an older version of their effect', () => {
    const v2: EffectManifest = { ...transform, version: 2, migrate: (p, from) => (from === 1 ? { ...p, scale: Number(p['zoom'] ?? 100) } : p) }
    const old = { id: 'e', effectId: 'transform', version: 1, enabled: true, mix: 100, blendMode: 'normal' as const, params: { zoom: 250 }, keyframes: {}, modulation: {}, mask: null }
    const upgraded = upgradeInstance(v2, old, { width: 100, height: 100 })
    expect(upgraded.version).toBe(2)
    expect(upgraded.params['scale']).toBe(250)
  })
})

describe('effect stacks', () => {
  it('applies, reorders, toggles, changes, resets and removes, each undoable', () => {
    const t = setup()
    const id = t.clip().id
    t.run(addEffect([id], 'invert', null, ids))
    t.run(addEffect([id], 'transform', null, ids))
    expect(t.clip().effects.map((e) => e.effectId)).toEqual(['invert', 'transform'])
    // Transform on a 4K clip starts at the clip's own middle (source pixels).
    expect(t.clip().effects[1]!.params['position']).toEqual([1920, 1080])
    const [inv, tr] = t.clip().effects.map((e) => e.id) as [string, string]
    t.run(moveEffect(id, tr, 0))
    expect(t.clip().effects.map((e) => e.effectId)).toEqual(['transform', 'invert'])
    t.run(setEffectEnabled(id, inv, false))
    expect(t.clip().effects[1]!.enabled).toBe(false)
    t.run(setEffectValues(id, inv, { params: { amount: 40 }, mix: 50, blendMode: 'screen' }))
    expect(t.clip().effects[1]).toMatchObject({ mix: 50, blendMode: 'screen', params: { amount: 40 } })
    t.run(resetEffect(id, inv))
    expect(t.clip().effects[1]).toMatchObject({ mix: 100, blendMode: 'normal', params: { amount: 100 } })
    t.run(removeEffects(id, [tr]))
    expect(t.clip().effects.map((e) => e.effectId)).toEqual(['invert'])
    for (let i = 0; i < 7; i++) t.history.undo()
    expect(t.clip().effects).toEqual([])
  })

  it('makes a whole drag one undo step', () => {
    const t = setup()
    const id = t.clip().id
    t.run(addEffect([id], 'invert', null, ids))
    const fx = t.clip().effects[0]!.id
    for (const amount of [90, 70, 50]) t.run(setEffectValues(id, fx, { params: { amount } }))
    t.history.undo()
    expect(t.clip().effects[0]!.params['amount']).toBe(100)
  })

  it('refuses audio clips and values an effect doesn’t have', () => {
    const t = setup()
    const audio = t.history.state.sequence.clips.find((c) => c.kind === 'audio')!
    expect(() => t.history.dispatch(addEffect([audio.id], 'invert', null, ids))).toThrow(/video clip/)
    t.run(addEffect([t.clip().id], 'invert', null, ids))
    expect(() => t.history.dispatch(setEffectValues(t.clip().id, t.clip().effects[0]!.id, { params: { wobble: 1 } }))).toThrow(/no "wobble"/)
  })

  it('carries effects through split, copy and paste, and pastes copied effects onto other clips', () => {
    const t = setup()
    const id = t.clip().id
    t.run(addEffect([id], 'invert', null, ids))
    t.run(setEffectValues(id, t.clip().effects[0]!.id, { params: { channel: 'hue' } }))
    t.run(splitClips([id], s(2), ids))
    const halves = t.history.state.sequence.clips.filter((c) => c.kind === 'video')
    expect(halves.map((c) => c.effects[0]?.params['channel'])).toEqual(['hue', 'hue'])
    t.run(pasteClips(copyClips(t.history.state.sequence, [halves[0]!.id]), s(10), 'overwrite', ids))
    const pasted = t.history.state.sequence.clips.find((c) => c.kind === 'video' && c.start === s(10))!
    expect(pasted.effects[0]!.params['channel']).toBe('hue')
    t.run(pasteEffects([halves[1]!.id], pasted.effects, 'Paste Effects', ids))
    expect(t.history.state.sequence.clips.find((c) => c.id === halves[1]!.id)!.effects).toHaveLength(2)
  })
})

describe('adjustment layers', () => {
  it('sit on a video track, take effects on the whole frame, and affect what is beneath', () => {
    const t = setup()
    t.run(addAdjustmentLayer({ trackId: t.V2, start: s(1), duration: s(2) }, ids))
    const layer = t.history.state.sequence.clips.find((c) => c.adjustment)!
    expect(layer).toMatchObject({ kind: 'video', mediaId: '', name: 'Adjustment Layer', start: s(1), duration: s(2) })
    // Nothing switched on yet: it changes nothing, so it isn't drawn.
    expect(videoLayersAt(t.history.state.sequence, t.history.state.media, s(1.5)).map((l) => l.item?.name ?? 'adjustment')).toEqual(['a'])
    t.run(addEffect([layer.id], 'transform', null, ids))
    // Its Transform works in sequence pixels.
    expect(t.history.state.sequence.clips.find((c) => c.adjustment)!.effects[0]!.params['position']).toEqual([960, 540])
    expect(videoLayersAt(t.history.state.sequence, t.history.state.media, s(1.5)).map((l) => l.item?.name ?? 'adjustment')).toEqual(['a', 'adjustment'])
    expect(videoLayersAt(t.history.state.sequence, t.history.state.media, s(3.5)).map((l) => l.item?.name ?? 'adjustment')).toEqual(['a'])
  })

  it('trims, splits and moves like a still (no media limits), but has no speed', () => {
    const t = setup()
    t.run(addAdjustmentLayer({ trackId: t.V2, start: 0, duration: s(2) }, ids))
    const id = t.history.state.sequence.clips.find((c) => c.adjustment)!.id
    t.run(trimClips({ clipIds: [id], edge: 'out', delta: s(100) }))
    expect(t.history.state.sequence.clips.find((c) => c.id === id)!.duration).toBe(s(102))
    t.run(splitClips([id], s(50), ids))
    expect(t.history.state.sequence.clips.filter((c) => c.adjustment)).toHaveLength(2)
    expect(() => t.history.dispatch(setClipSpeed({ clipIds: [id], speed: 2, reverse: false, ripple: false }, t.history.state.media, ids))).toThrow(/no speed/)
  })

  it('refuses audio tracks', () => {
    const t = setup()
    const audio = t.history.state.sequence.tracks.find((tr) => tr.kind === 'audio')!.id
    expect(() => t.history.dispatch(addAdjustmentLayer({ trackId: audio, start: 0, duration: s(1) }, ids))).toThrow(/video tracks/)
  })
})

describe('saving', () => {
  it('keeps stacks and adjustment layers; keeps an effect this version doesn’t know', () => {
    const t = setup()
    t.run(addEffect([t.clip().id], 'invert', null, ids))
    t.run(addAdjustmentLayer({ trackId: t.V2, start: 0, duration: s(2) }, ids))
    t.run(addEffect([t.history.state.sequence.clips.find((c) => c.adjustment)!.id], 'transform', null, ids))
    const restored = parseProject(serializeProject(t.history.state))
    expect(restored.sequence.clips).toEqual(t.history.state.sequence.clips)
    const data = JSON.parse(serializeProject(t.history.state))
    data.sequence.clips[0].effects.push({ id: 'z', effectId: 'from-the-future', version: 3, enabled: true, mix: 100, blendMode: 'normal', params: { glow: 2, pos: [1, 2] }, keyframes: {} })
    expect(parseProject(data).sequence.clips[0]!.effects.at(-1)).toMatchObject({ effectId: 'from-the-future', params: { glow: 2, pos: [1, 2] } })
  })

  it('upgrades M5 projects: no effects, no adjustment layers', () => {
    const t = setup()
    const data = JSON.parse(serializeProject(t.history.state))
    data.schemaVersion = 5
    for (const c of data.sequence.clips) {
      delete c.effects
      delete c.adjustment
    }
    expect(parseProject(data).sequence.clips.every((c) => c.effects.length === 0 && !c.adjustment)).toBe(true)
  })
})

describe('reference maths', () => {
  it('converts to and from linear light and OKLab losslessly', () => {
    const c: [number, number, number] = [0.8, 0.3, 0.55]
    toDisplay(toLinear(c)).forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 9))
    fromOklab(toOklab(toLinear(c))).forEach((v, i) => expect(v).toBeCloseTo(toLinear(c)[i]!, 6))
    expect(toOklab([1, 1, 1])[0]).toBeCloseTo(1, 4)
  })

  it('inverts as described: RGB, one channel, luminance, hue, chroma, amount', () => {
    const c: [number, number, number] = [0.8, 0.3, 0.2]
    expect(invertReference(c, { amount: 100, channel: 'rgb', space: 'display' }).map((v) => +v.toFixed(6))).toEqual([0.2, 0.7, 0.8])
    expect(invertReference(c, { amount: 100, channel: 'green', space: 'display' }).map((v) => +v.toFixed(6))).toEqual([0.8, 0.7, 0.2])
    expect(invertReference(c, { amount: 50, channel: 'rgb', space: 'display' }).map((v) => +v.toFixed(6))).toEqual([0.5, 0.5, 0.5])
    // Linear light: a harsher negative than display.
    expect(invertReference([0.5, 0.5, 0.5], { amount: 100, channel: 'rgb', space: 'linear' })[0]).toBeCloseTo(Math.pow(1 - Math.pow(0.5, 2.4), 1 / 2.4), 9)
    // Luminance only keeps the colour's direction; chroma only keeps lightness.
    const lum = invertReference([0.2, 0.2, 0.2], { amount: 100, channel: 'luminance', space: 'display' })
    expect(lum[0]).toBeGreaterThan(0.6)
    // (A muted colour, whose opposite is still inside Rec.709, so nothing is clipped.)
    const muted: [number, number, number] = [0.6, 0.45, 0.4]
    const chroma = invertReference(muted, { amount: 100, channel: 'chroma', space: 'display' })
    expect(toOklab(toLinear(chroma))[0]).toBeCloseTo(toOklab(toLinear(muted))[0], 4)
    expect(chroma[2]).toBeGreaterThan(chroma[0])
    // Hue only turns red towards cyan, keeping HSL lightness.
    const hue = invertReference([0.9, 0.1, 0.1], { amount: 100, channel: 'hue', space: 'display' })
    expect(hue.map((v) => +v.toFixed(6))).toEqual([0.1, 0.9, 0.9])
  })

  it('blends with Photoshop’s formulas', () => {
    const d: [number, number, number] = [0.6, 0.4, 0.2]
    const s2: [number, number, number] = [0.5, 0.5, 0.5]
    expect(blendRgb(d, s2, 'multiply')).toEqual([0.3, 0.2, 0.1])
    expect(blendRgb(d, s2, 'screen').map((v) => +v.toFixed(6))).toEqual([0.8, 0.7, 0.6])
    expect(blendRgb(d, s2, 'difference').map((v) => +v.toFixed(6))).toEqual([0.1, 0.1, 0.3])
    expect(blendRgb(d, s2, 'hard-mix')).toEqual([1, 0, 0])
    // Luminosity keeps the colour of what's beneath and takes the lightness of what's blended.
    const lumMode = blendRgb(d, s2, 'luminosity')
    expect(0.3 * lumMode[0] + 0.59 * lumMode[1] + 0.11 * lumMode[2]).toBeCloseTo(0.5, 6)
  })
})

describe('presets', () => {
  it('round-trip through the library format, skipping damaged entries', () => {
    const t = setup()
    t.run(addEffect([t.clip().id], 'transform', null, ids))
    const preset = { id: 'p1', name: 'Tilt', effects: t.clip().effects, size: { width: 3840, height: 2160 }, createdAt: '2026-10-31' }
    const parsed = parsePresets(JSON.parse(JSON.stringify({ version: 1, presets: [preset, { id: 'bad' }, { id: 'p2', name: 'Empty', effects: [], size: { width: 1, height: 1 } }] })))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(preset)
    expect(parsePresets(null)).toEqual([])
  })

  it('scale positions to the clip they are applied to', () => {
    const t = setup()
    // A 1080p clip next to the 4K one.
    const hd = media('hd', 1920, 1080)
    t.history.dispatch(importMedia([hd]))
    t.run(placeMedia({ mediaId: hd.id, sourceIn: 0, sourceOut: s(2), at: s(10), videoTrackId: t.V1, audioTrackId: null, mode: 'overwrite' }, ids))
    t.run(addEffect([t.clip().id], 'transform', null, ids))
    t.run(setEffectValues(t.clip().id, t.clip().effects[0]!.id, { params: { position: [2880, 540] } }))
    const hdClip = () => t.history.state.sequence.clips.find((c) => c.mediaId === hd.id)!
    t.run(pasteEffects([hdClip().id], t.clip().effects, 'Apply Preset', ids, { width: 3840, height: 2160 }))
    expect(hdClip().effects[0]!.params['position']).toEqual([1440, 270])
    expect(rescaleEffects(t.clip().effects, { width: 100, height: 100 }, { width: 100, height: 100 })[0]!.params['position']).toEqual([2880, 540])
  })
})
