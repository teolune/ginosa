import { BANDS } from '../audio/analysis'
import { evaluate, putKeyframe } from '../keyframes/keyframes'
import { findEffect, modulatable, propertySpec, valueAt, type PropertyRef, type PropertySpec } from '../keyframes/properties'
import { components } from '../keyframes/keyframes'
import { CommandError } from '../project/commands'
import { defaultId, type Clip, type IdFactory, type Sequence } from '../project/model'
import type { Ticks } from '../time'
import { MODULATOR_PARAMS, type AudioSignal, type BandRef, type ModLink, type ModSource, type Modulator, type ModulatorParam } from '../modulation/types'
import { timelineCommand, type TimelineCommand } from './edits'
import { assertUnlocked, findClip, findTrack, frameTicks } from './timeline'

/** Modulators and the links from them to values (M8), as undoable commands. */

export const AUDIO_SIGNAL_LABELS: Record<AudioSignal, string> = {
  level: 'Level',
  transient: 'Transients',
  hits: 'Hits',
  loudness: 'Loudness',
  peak: 'Peak'
}

export function bandLabel(band: BandRef): string {
  return typeof band === 'string' ? (BANDS.find((b) => b.id === band)?.label ?? band) : `${Math.round(band.low)}–${Math.round(band.high)} Hz`
}

/** "Song · Bass", "Song · Hits (Sub)", "Beat phase", "LFO 1/4 sine"… */
export function describeSource(source: ModSource, sourceName: (id: string) => string): string {
  switch (source.kind) {
    case 'audio': {
      const name = sourceName(source.sourceId)
      if (source.signal === 'loudness' || source.signal === 'peak') return `${name} · ${AUDIO_SIGNAL_LABELS[source.signal]}`
      if (source.signal === 'level') return `${name} · ${bandLabel(source.band)}`
      return `${name} · ${AUDIO_SIGNAL_LABELS[source.signal]} (${bandLabel(source.band)})`
    }
    case 'tempo':
      return { 'beat-phase': 'Beat phase', 'bar-phase': 'Bar phase', 'beat-trigger': 'Every beat', 'bar-trigger': 'Every bar' }[source.signal]
    case 'lfo':
      return `LFO ${source.rate} ${source.shape}`
    case 'random':
      return `Random ${source.rate} Hz`
  }
}

/**
 * Defaults by source (decision 46): audio levels follow quickly and fall back over
 * 150 ms (the plan's Link to Audio defaults); triggers and hits flash and fade; phases,
 * LFOs and noise pass straight through.
 */
export function newModulator(id: string, name: string, source: ModSource): Modulator {
  const audioLevel = source.kind === 'audio' && source.signal !== 'hits'
  const trigger = (source.kind === 'audio' && source.signal === 'hits') || (source.kind === 'tempo' && source.signal.endsWith('trigger'))
  return {
    id,
    name,
    source,
    gain: 0,
    threshold: 0,
    knee: 0,
    attack: audioLevel ? 5 : 0,
    release: audioLevel || trigger ? 150 : 0,
    curve: 'linear',
    points: [0, 0.25, 0.5, 0.75, 1],
    phase: 0,
    keyframes: {}
  }
}

export function sameSource(a: ModSource, b: ModSource): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function editableClip(sequence: Sequence, clipId: string): Clip {
  const clip = findClip(sequence, clipId)
  assertUnlocked(findTrack(sequence, clip.trackId))
  return clip
}

function linkMap(clip: Clip, ref: PropertyRef) {
  if (ref.effectId === null) return clip.modulation
  const effect = findEffect(clip, ref.effectId)
  if (!effect) throw new CommandError('That effect is no longer on the clip')
  return effect.modulation
}

/**
 * Where a new link's range starts (decision 46): from the value as it is (adding 0) to a
 * step towards the far end of its range, so turning it up is always visible.
 */
export function defaultRange(spec: PropertySpec, param: string, current: number[]): { min: number[]; max: number[] } {
  const zero = current.map(() => 0)
  const step = (v: number): number => {
    if (param === 'scale' || param === 'scaleWidth') return 25
    if (param === 'rotation' || spec.unit === '°') return 15
    if (param === 'volume') return -12
    const lo = spec.min ?? -Infinity
    const hi = spec.max ?? Infinity
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 50
    return hi - v >= v - lo ? (hi - v) * 0.5 : -(v - lo) * 0.5
  }
  if (spec.kind === 'point') return { min: zero, max: [0, -50] }
  return { min: zero, max: current.map(step) }
}

export function addModulator(source: ModSource, name: string, newId: IdFactory = defaultId): TimelineCommand & { modulatorId: string } {
  const id = newId()
  const command = timelineCommand('New Modulator', (draft) => {
    draft.sequence.modulators.push(newModulator(id, name.trim() || 'Modulator', source))
  }) as TimelineCommand & { modulatorId: string }
  command.modulatorId = id
  return command
}

export type ModulatorChanges = Partial<Omit<Modulator, 'id' | 'keyframes'>>

/** Changes a modulator (its source, shaping or name). A drag on one setting is one undo step. */
export function updateModulator(id: string, changes: ModulatorChanges): TimelineCommand {
  const command = timelineCommand('Change Modulator', (draft) => {
    const m = draft.sequence.modulators.find((x) => x.id === id)
    if (!m) throw new CommandError('That modulator is gone')
    for (const [key, value] of Object.entries(changes) as Array<[keyof ModulatorChanges, unknown]>) {
      if (key in MODULATOR_PARAMS) {
        const spec = MODULATOR_PARAMS[key as ModulatorParam]
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new CommandError(`${spec.label} needs a number`)
        ;(m as unknown as Record<string, number>)[key] = Math.min(spec.max, Math.max(spec.min, value))
      } else if (key === 'name') {
        const name = String(value).trim()
        if (!name) throw new CommandError('A modulator needs a name')
        m.name = name
      } else if (key === 'points') {
        const points = value as number[]
        if (!Array.isArray(points) || points.length !== 5) throw new CommandError('A drawn curve has five points')
        m.points = points.map((p) => Math.min(1, Math.max(0, Number(p) || 0)))
      } else (m as unknown as Record<string, unknown>)[key] = structuredClone(value)
    }
  })
  command.coalesceKey = `modulator:${id}:${Object.keys(changes).sort().join(',')}`
  return command
}

/** Removes a modulator and every link to it. */
export function removeModulator(id: string): TimelineCommand {
  return timelineCommand('Remove Modulator', (draft, command) => {
    const sequence = draft.sequence
    const before = sequence.modulators.length
    sequence.modulators = sequence.modulators.filter((m) => m.id !== id)
    if (sequence.modulators.length === before) throw new CommandError('That modulator is gone')
    let links = 0
    const strip = (map: Record<string, ModLink[]>) => {
      for (const key of Object.keys(map)) {
        const kept = map[key]!.filter((l) => l.modulatorId !== id)
        links += map[key]!.length - kept.length
        if (kept.length > 0) map[key] = kept
        else delete map[key]
      }
    }
    for (const clip of sequence.clips) {
      strip(clip.modulation)
      for (const effect of clip.effects) strip(effect.modulation)
    }
    for (const mask of sequence.masks) for (const shape of mask.shapes) strip(shape.modulation)
    if (links > 0) command.notice = `Removed it from the ${links} value${links === 1 ? '' : 's'} it drove.`
  })
}

/** Keyframes a modulator setting (absolute time: modulators belong to the sequence, not a clip). */
export function setModulatorValue(id: string, param: ModulatorParam, value: number, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  const command = timelineCommand(`Change ${MODULATOR_PARAMS[param].label}`, (draft) => {
    const m = draft.sequence.modulators.find((x) => x.id === id)
    if (!m) throw new CommandError('That modulator is gone')
    const spec = MODULATOR_PARAMS[param]
    if (!Number.isFinite(value)) throw new CommandError(`${spec.label} needs a number`)
    const clean = Math.min(spec.max, Math.max(spec.min, value))
    const track = m.keyframes[param]
    if (track?.length) {
      const frame = frameTicks(draft.sequence)
      putKeyframe(track, Math.max(0, Math.round(at / frame) * frame), clean, newId(), false)
    } else m[param] = clean
  })
  command.coalesceKey = `modulator-value:${id}:${param}:${at}`
  return command
}

/** The stopwatch on a modulator setting: on makes a keyframe at `at`; off keeps the value there. */
export function setModulatorAnimated(id: string, param: ModulatorParam, on: boolean, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand(on ? 'Create Keyframes' : 'Remove Keyframes', (draft) => {
    const m = draft.sequence.modulators.find((x) => x.id === id)
    if (!m) throw new CommandError('That modulator is gone')
    const frame = frameTicks(draft.sequence)
    const time = Math.max(0, Math.round(at / frame) * frame)
    if (on) {
      if (m.keyframes[param]?.length) return
      m.keyframes[param] = []
      putKeyframe(m.keyframes[param]!, time, m[param], newId(), false)
    } else {
      const track = m.keyframes[param]
      if (!track?.length) return
      // Keep the value at the playhead.
      const v = Number(evaluate(track, time, m[param]))
      delete m.keyframes[param]
      m[param] = v
    }
  })
}

export interface LinkSettings {
  mode?: ModLink['mode']
  min?: number[]
  max?: number[]
  invert?: boolean
  amount?: number
}

/** Links a value to a modulator, with the default range unless given. */
export function addLink(ref: PropertyRef, modulatorId: string, at: Ticks, settings: LinkSettings = {}, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Modulate Parameter', (draft) => {
    const sequence = draft.sequence
    if (!sequence.modulators.some((m) => m.id === modulatorId)) throw new CommandError('That modulator is gone')
    const clip = editableClip(sequence, ref.clipId)
    applyLink(clip, ref, modulatorId, at, settings, newId)
  })
}

/** Links a value to a modulator, inside a command (ranges default to the value's own, as Link to Audio's). */
export function applyLink(clip: Clip, ref: PropertyRef, modulatorId: string, at: Ticks, settings: LinkSettings, newId: IdFactory): void {
  const spec = propertySpec(clip, ref.effectId, ref.param)
  if (!spec || !modulatable(clip, ref.effectId, ref.param)) throw new CommandError(spec ? `${spec.label} can't be modulated` : 'That value is gone')
  const current = components(valueAt(clip, ref.effectId, ref.param, Math.min(Math.max(0, at - clip.start), clip.duration - 1))) ?? [0]
  const range = defaultRange(spec, ref.param, current)
  const map = linkMap(clip, ref)
  const links = (map[ref.param] ??= [])
  if (links.some((l) => l.modulatorId === modulatorId)) throw new CommandError(`${spec.label} is already linked to that modulator`)
  links.push({ id: newId(), modulatorId, mode: settings.mode ?? 'add', min: settings.min ?? range.min, max: settings.max ?? range.max, invert: settings.invert ?? false, amount: settings.amount ?? 100 })
}

/**
 * Right-click › Link to Audio: one source and band drives the value. An existing modulator
 * for the same signal is reused (one source drives many values); otherwise one is made
 * with the defaults.
 */
export function linkToAudio(ref: PropertyRef, sourceId: string, signal: AudioSignal, band: BandRef, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Link to Audio', (draft, command) => {
    const sequence = draft.sequence
    const audio = sequence.audioSources.find((s) => s.id === sourceId)
    if (!audio) throw new CommandError('That analysis source is gone')
    const source: ModSource = { kind: 'audio', sourceId, signal, band }
    let modulator = sequence.modulators.find((m) => sameSource(m.source, source))
    if (!modulator) {
      modulator = newModulator(newId(), describeSource(source, () => audio.name), source)
      sequence.modulators.push(modulator)
    } else command.notice = `Linked to “${modulator.name}”, which already drives other values.`
    applyLink(editableClip(sequence, ref.clipId), ref, modulator.id, at, {}, newId)
  })
}

export function updateLink(ref: PropertyRef, linkId: string, changes: LinkSettings): TimelineCommand {
  const command = timelineCommand('Change Modulation', (draft) => {
    const clip = editableClip(draft.sequence, ref.clipId)
    const link = linkMap(clip, ref)[ref.param]?.find((l) => l.id === linkId)
    if (!link) throw new CommandError('That link is gone')
    if (changes.mode) link.mode = changes.mode
    if (changes.invert !== undefined) link.invert = changes.invert
    if (changes.amount !== undefined) link.amount = Math.min(100, Math.max(0, changes.amount))
    const check = (v: number[]) => {
      if (!v.every((x) => Number.isFinite(x))) throw new CommandError('The range needs numbers')
      return [...v]
    }
    if (changes.min) link.min = check(changes.min)
    if (changes.max) link.max = check(changes.max)
  })
  command.coalesceKey = `link:${ref.clipId}:${ref.effectId}:${ref.param}:${linkId}:${Object.keys(changes).sort().join(',')}`
  return command
}

/** Removes one link (or, without `linkId`, all the value's modulation). */
export function removeLinks(ref: PropertyRef, linkId: string | null = null): TimelineCommand {
  return timelineCommand('Remove Modulation', (draft) => {
    const clip = editableClip(draft.sequence, ref.clipId)
    const map = linkMap(clip, ref)
    const links = map[ref.param] ?? []
    const kept = linkId ? links.filter((l) => l.id !== linkId) : []
    if (kept.length === links.length) throw new CommandError('There is no modulation there to remove')
    if (kept.length > 0) map[ref.param] = kept
    else delete map[ref.param]
  })
}

/** Every value a modulator drives: where it is, and the link. */
export function linksTo(sequence: Sequence, modulatorId: string): Array<{ ref: PropertyRef; link: ModLink; clip: Clip }> {
  const out: Array<{ ref: PropertyRef; link: ModLink; clip: Clip }> = []
  for (const clip of sequence.clips) {
    for (const [param, links] of Object.entries(clip.modulation)) for (const link of links) if (link.modulatorId === modulatorId) out.push({ ref: { clipId: clip.id, effectId: null, param }, link, clip })
    for (const effect of clip.effects)
      for (const [param, links] of Object.entries(effect.modulation)) for (const link of links) if (link.modulatorId === modulatorId) out.push({ ref: { clipId: clip.id, effectId: effect.id, param }, link, clip })
  }
  return out
}
