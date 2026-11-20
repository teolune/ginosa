import { beatAt, beatTime, MAX_BPM, MIN_BPM, tempoAt } from '../audio/beat-grid'
import { tempoGrid } from '../audio/tempo-map'
import { components } from '../keyframes/keyframes'
import { modulatable, propertySpec, valueAt, type PropertyRef } from '../keyframes/properties'
import { CommandError } from '../project/commands'
import { createTrack, defaultId, type AutomationPoint, type Clip, type IdFactory, type Sequence } from '../project/model'
import { secondsToTicks, type Ticks } from '../time'
import { timelineCommand, type TimelineCommand } from './edits'
import { applyLink, defaultRange, newModulator } from './modulation-edits'
import { clipEnd, frameTicks, toFrame } from './timeline'

/**
 * Automation clips (W2, decision 127): clips on automation tracks, each with a curve that sets
 * the values linked to its modulator while it plays (and holds its last point after). Clips
 * split or copied from one share its modulator, so they control the same values.
 */

/** A new clip is 4 bars long (8 s with no beat grid). */
export const NEW_AUTOMATION_BARS = 4

export interface NewAutomationRequest {
  at: Ticks
  duration?: Ticks
  /** Right-click › Create Automation Clip: the value to link, starting from where it is now. */
  target?: PropertyRef
  /** Automate BPM (W2.3): a tempo clip, starting from the tempo there (a 120 BPM grid is made if there's none). */
  tempo?: boolean
  name?: string
}

/** A tempo clip's range: 60 BPM either side of the tempo it starts from (within 20–999.999). */
export function tempoRangeAround(bpm: number): { min: number; max: number } {
  const min = Math.max(MIN_BPM, Math.round(bpm - 60))
  return { min, max: Math.min(MAX_BPM, Math.max(min + 1, Math.round(bpm + 60))) }
}

/** The range a clip sweeps a value over: its own range when it has one, else around where it is. */
export function automationRange(clip: Clip, ref: PropertyRef, at: Ticks): { min: number[]; max: number[]; start: number } {
  const spec = propertySpec(clip, ref.effectId, ref.param)
  if (!spec) throw new CommandError('That value is gone')
  const current = components(valueAt(clip, ref.effectId, ref.param, Math.min(Math.max(0, at - clip.start), clip.duration - 1))) ?? [0]
  if (spec.kind === 'number' && Number.isFinite(spec.min) && Number.isFinite(spec.max) && spec.max! > spec.min!) {
    const lo = spec.min!
    const hi = spec.max!
    // A huge range (Scale's 0–10,000%) would make the curve useless: from its bottom to twice the value as it is.
    if (hi - lo > 1000 && current[0]! > lo) {
      const top = Math.min(hi, lo + 2 * (current[0]! - lo))
      return { min: [lo], max: [top], start: (current[0]! - lo) / (top - lo) }
    }
    return { min: [lo], max: [hi], start: Math.min(1, Math.max(0, (current[0]! - lo) / (hi - lo))) }
  }
  // No range (a position, say): around where it is, the size of a Link to Audio's swing either way.
  const swing = defaultRange(spec, ref.param, current).max.map((v) => Math.abs(v) || 50)
  return { min: current.map((v, i) => v - swing[i]!), max: current.map((v, i) => v + swing[i]!), start: 0.5 }
}

function freeTrack(sequence: Sequence, from: Ticks, to: Ticks): string | null {
  for (const track of sequence.tracks) {
    if (track.kind !== 'automation' || track.locked) continue
    if (!sequence.clips.some((c) => c.trackId === track.id && c.start < to && clipEnd(c) > from)) return track.id
  }
  return null
}

/** New Automation Clip: at `at` on the first automation track free there (a new one if none is), with its own modulator. */
export function newAutomationClip(request: NewAutomationRequest, newId: IdFactory = defaultId): TimelineCommand & { clipId: string; modulatorId: string } {
  const clipId = newId()
  const modulatorId = newId()
  const command = timelineCommand(request.target ? 'Create Automation Clip' : 'New Automation Clip', (draft) => {
    const sequence = draft.sequence
    const frame = frameTicks(sequence)
    if (request.tempo && !sequence.beatGrid) sequence.beatGrid = { bpm: 120, downbeat: 0, beatsPerBar: 4, sourceId: null }
    // On the tempo map (W2.3): 4 bars from here, however the tempo moves.
    const grid = tempoGrid(sequence)
    const start = Math.max(0, toFrame(request.at, frame))
    const fourBars = grid ? beatTime(grid, beatAt(grid, start) + grid.beatsPerBar * NEW_AUTOMATION_BARS) - start : secondsToTicks(8)
    const duration = Math.max(frame, toFrame(request.duration ?? fourBars, frame))
    let trackId = freeTrack(sequence, start, start + duration)
    if (!trackId) {
      const count = sequence.tracks.filter((t) => t.kind === 'automation').length
      if (count >= 99) throw new CommandError('A sequence can have at most 99 automation tracks')
      const track = createTrack('automation', count, newId)
      sequence.tracks.push(track)
      trackId = track.id
    }
    const count = sequence.modulators.filter((m) => m.source.kind === 'automation').length
    let name = request.name ?? `Automation ${count + 1}`
    let first = 0.5
    const target = request.target ? sequence.clips.find((c) => c.id === request.target!.clipId) : null
    if (request.target) {
      if (!target) throw new CommandError('That clip is gone')
      if (!modulatable(target, request.target.effectId, request.target.param)) throw new CommandError(`${propertySpec(target, request.target.effectId, request.target.param)?.label ?? 'That value'} can't be automated`)
      const range = automationRange(target, request.target, start)
      first = range.start
      if (!request.name) name = `${propertySpec(target, request.target.effectId, request.target.param)!.label} (${target.name})`
    }
    let tempo: { min: number; max: number } | undefined
    if (request.tempo && grid) {
      const bpm = tempoAt(grid, start)
      tempo = tempoRangeAround(bpm)
      first = (bpm - tempo.min) / (tempo.max - tempo.min)
      if (!request.name) name = 'Tempo'
    }
    sequence.modulators.push(newModulator(modulatorId, name, { kind: 'automation' }))
    const points: AutomationPoint[] = [{ time: 0, value: first, shape: 'single', tension: 0 }]
    sequence.clips.push({
      id: clipId,
      trackId,
      mediaId: '',
      kind: 'automation',
      name,
      start,
      duration,
      sourceIn: 0,
      linkId: null,
      motion: { positionX: 0, positionY: 0, scale: 100, scaleWidth: 100, rotation: 0, anchorX: 0, anchorY: 0 },
      opacity: 100,
      blendMode: 'normal',
      volume: 0,
      speed: 1,
      reverse: false,
      transitionIn: null,
      transitionOut: null,
      effects: [],
      adjustment: false,
      keyframes: {},
      modulation: {},
      mask: null,
      automation: tempo ? { modulatorId, points, tempo } : { modulatorId, points }
    })
    if (target && request.target) linkAutomation(target, request.target, modulatorId, start, newId)
  })
  return Object.assign(command, { clipId, modulatorId })
}

/** Links a value to an automation clip's modulator: it sets the value across its range (FL's way). */
function linkAutomation(clip: Clip, ref: PropertyRef, modulatorId: string, at: Ticks, newId: IdFactory): void {
  const range = automationRange(clip, ref, at)
  applyLink(clip, ref, modulatorId, at, { mode: 'replace', min: range.min, max: range.max, amount: 100 }, newId)
}

/** Drag an automation clip onto a value, or pick it in the clip's editor: that value follows the clip too. */
export function linkToAutomation(ref: PropertyRef, automationClipId: string, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Link to Automation Clip', (draft) => {
    const sequence = draft.sequence
    const source = sequence.clips.find((c) => c.id === automationClipId)
    if (!source?.automation) throw new CommandError('That automation clip is gone')
    const clip = sequence.clips.find((c) => c.id === ref.clipId)
    if (!clip) throw new CommandError('That clip is gone')
    if (sequence.tracks.find((t) => t.id === clip.trackId)?.locked) throw new CommandError('That clip’s track is locked')
    linkAutomation(clip, ref, source.automation.modulatorId, Math.max(clip.start, source.start), newId)
  })
}

/** An automation clip's points (the editor's every change): at least one, kept in time order, values 0–1. */
export function setAutomationPoints(clipId: string, points: readonly AutomationPoint[], stroke: string | null = null): TimelineCommand {
  const command = timelineCommand('Edit Automation', (draft) => {
    const clip = draft.sequence.clips.find((c) => c.id === clipId)
    if (!clip?.automation) throw new CommandError('That automation clip is gone')
    if (points.length === 0) throw new CommandError('An automation clip needs at least one point')
    clip.automation.points = [...points]
      .map((p) => ({ time: Math.max(0, Math.round(p.time)), value: Math.min(1, Math.max(0, p.value)), shape: p.shape, tension: Math.min(1, Math.max(-1, p.tension)) }))
      .sort((a, b) => a.time - b.time)
  })
  if (stroke) command.coalesceKey = `automation:${clipId}:${stroke}`
  return command
}

/**
 * A tempo clip's BPM range (W2.3), for it and the clips sharing its modulator: each point keeps
 * its tempo where the new range allows it.
 */
export function setTempoRange(clipId: string, min: number, max: number): TimelineCommand {
  const command = timelineCommand('Change Tempo Range', (draft) => {
    const sequence = draft.sequence
    const source = sequence.clips.find((c) => c.id === clipId)
    if (!source?.automation?.tempo) throw new CommandError('That isn’t a tempo clip')
    if (!(Number.isFinite(min) && Number.isFinite(max) && min >= MIN_BPM && max <= MAX_BPM && max > min)) throw new CommandError(`A tempo range runs from ${MIN_BPM} to ${MAX_BPM} BPM, its top above its bottom`)
    for (const clip of sequence.clips) {
      const a = clip.automation
      if (!a?.tempo || a.modulatorId !== source.automation.modulatorId) continue
      const { min: lo, max: hi } = a.tempo
      a.points = a.points.map((p) => ({ ...p, value: Math.min(1, Math.max(0, (lo + (hi - lo) * p.value - min) / (max - min))) }))
      a.tempo = { min, max }
    }
  })
  command.coalesceKey = `tempo-range:${clipId}`
  return command
}

/**
 * An automation clip (and those sharing its modulator) sets the tempo too, or stops: in its
 * editor, Control the Tempo, or the tempo's ×. Its range starts 60 BPM either side of the tempo
 * where it starts.
 */
export function setControlsTempo(clipId: string, on: boolean): TimelineCommand {
  return timelineCommand(on ? 'Automate Tempo' : 'Stop Automating Tempo', (draft) => {
    const sequence = draft.sequence
    const source = sequence.clips.find((c) => c.id === clipId)
    if (!source?.automation) throw new CommandError('That automation clip is gone')
    if (on && !sequence.beatGrid) sequence.beatGrid = { bpm: 120, downbeat: 0, beatsPerBar: 4, sourceId: null }
    const range = on ? tempoRangeAround(tempoAt(tempoGrid(sequence)!, source.start)) : null
    for (const clip of sequence.clips) {
      if (clip.automation?.modulatorId !== source.automation.modulatorId) continue
      if (range) clip.automation.tempo ??= { ...range }
      else delete clip.automation.tempo
    }
  })
}

export { pruneAutomation } from './automation-prune'
