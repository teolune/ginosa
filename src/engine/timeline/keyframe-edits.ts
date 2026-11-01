import type { ParamValue } from '../effects/types'
import { CommandError } from '../project/commands'
import { defaultId, type BlendMode, type Clip, type IdFactory, type Sequence } from '../project/model'
import type { Ticks } from '../time'
import { applyPreset, cloneKeyframe, components, sortKeyframes, type Handle, type InterpolationPreset, type Keyframe } from '../keyframes/keyframes'
import {
  MAX_SPEED_PERCENT,
  clampValue,
  findEffect,
  keyframeTime,
  keyframesOf,
  propertySpec,
  refKey,
  speedKeyframeProblem,
  staticValue,
  trackFor,
  valueAt,
  writeStatic,
  writeValueAt,
  type PropertyRef
} from '../keyframes/properties'
import { timelineCommand, type TimelineCommand } from './edits'
import { assertUnlocked, findClip, findTrack, frameTicks, mediaLength, sourceSpan } from './timeline'
import type { MediaItem } from '../project/media'

/**
 * Keyframe edits, as undoable commands. As with clip edits, each has a pure `apply…`
 * function the Keyframe Editor uses for its live drag preview, so a drag is shown
 * exactly as it will be committed, as one undo step.
 */

export interface KeyframeRef extends PropertyRef {
  keyframeId: string
}

export function keyframeKey(ref: KeyframeRef): string {
  return `${ref.clipId}|${refKey(ref)}|${ref.keyframeId}`
}

const MIN_SPEED = 0.01

function editableClip(sequence: Sequence, clipId: string): Clip {
  const clip = findClip(sequence, clipId)
  assertUnlocked(findTrack(sequence, clip.trackId))
  return clip
}

function spec(clip: Clip, ref: PropertyRef) {
  const found = propertySpec(clip, ref.effectId, ref.param)
  if (!found) throw new CommandError(ref.effectId && !findEffect(clip, ref.effectId) ? 'That effect is no longer on the clip' : `“${clip.name}” has no ${ref.param}`)
  return found
}

/** Removes an emptied keyframe list; the value stays at what the last keyframe said. */
function dropIfEmpty(clip: Clip, ref: PropertyRef, lastValue: ParamValue | null): void {
  const map = ref.effectId === null ? clip.keyframes : findEffect(clip, ref.effectId)?.keyframes
  if (!map || (map[ref.param]?.length ?? 0) > 0) return
  delete map[ref.param]
  if (lastValue === null) return
  if (ref.effectId === null && ref.param === 'speed') clip.speed = Math.max(MIN_SPEED, Number(lastValue) / 100)
  else writeStatic(clip, ref.effectId, ref.param, lastValue)
}

function groupByProperty(refs: KeyframeRef[]): Map<string, { ref: PropertyRef; ids: Set<string> }> {
  const groups = new Map<string, { ref: PropertyRef; ids: Set<string> }>()
  for (const r of refs) {
    const key = `${r.clipId}|${refKey(r)}`
    const group = groups.get(key) ?? { ref: { clipId: r.clipId, effectId: r.effectId, param: r.param }, ids: new Set<string>() }
    group.ids.add(r.keyframeId)
    groups.set(key, group)
  }
  return groups
}

/** A note when speed keyframes go on a clip whose sound is linked (it keeps its own speed). */
function speedNote(sequence: Sequence, clip: Clip): string | undefined {
  if (!clip.linkId || !sequence.clips.some((c) => c.id !== clip.id && c.linkId === clip.linkId && c.kind === 'audio')) return undefined
  return 'The linked sound follows the speed ramp: it speeds up and slows down with the picture, and its pitch changes like tape.'
}

/** A note when a speed ramp now needs more media than the file has (the last frame holds). */
export function mediaNote(media: MediaItem[], clip: Clip): string | undefined {
  if (!clip.keyframes['speed']?.length) return undefined
  const item = media.find((m) => m.id === clip.mediaId)
  const length = item ? mediaLength(item) : null
  if (length === null || clip.sourceIn + sourceSpan(clip) <= length) return undefined
  return `“${clip.name}” runs out of media before its end at these speeds; its last frame holds from there.`
}

// ---- Turning animation on and off -----------------------------------------------------

/**
 * The stopwatch: turning it on makes a keyframe at the playhead holding the current
 * value (Premiere's "Toggle animation"); turning it off removes every keyframe and keeps
 * the value at the playhead.
 */
export function setAnimated(ref: PropertyRef, on: boolean, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand(on ? 'Create Keyframes' : 'Remove Keyframes', (draft, command) => {
    const sequence = draft.sequence
    const clip = editableClip(sequence, ref.clipId)
    const s = spec(clip, ref)
    const frame = frameTicks(sequence)
    const t = at - clip.start
    if (on) {
      if (keyframesOf(clip, ref.effectId, ref.param).length > 0) return
      if (ref.effectId === null && ref.param === 'speed') {
        const problem = speedKeyframeProblem(clip)
        if (problem) throw new CommandError(problem)
        command.notice = speedNote(sequence, clip)
      }
      const time = keyframeTime(clip, t, frame)
      const value = staticValue(clip, ref.effectId, ref.param)
      trackFor(clip, ref.effectId, ref.param).push({
        id: newId(),
        time,
        value: Array.isArray(value) ? [value[0], value[1]] : value,
        interpolation: s.kind === 'stepped' ? 'hold' : 'linear',
        in: { t: 1 / 3, v: (components(value) ?? [0]).map(() => 0) },
        out: { t: 1 / 3, v: (components(value) ?? [0]).map(() => 0) }
      })
    } else {
      const track = keyframesOf(clip, ref.effectId, ref.param)
      if (track.length === 0) return
      const value = valueAt(clip, ref.effectId, ref.param, Math.min(Math.max(0, t), clip.duration - 1))
      const count = track.length
      track.length = 0
      dropIfEmpty(clip, ref, value)
      command.notice = `Removed ${count} ${s.label} keyframe${count === 1 ? '' : 's'}, keeping the value at the playhead (⌘Z brings them back).`
    }
  })
}

/** The ◆ button: a keyframe at the playhead with the value there (turns animation on if needed). */
export function addKeyframe(ref: PropertyRef, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Add Keyframe', (draft, command) => {
    const sequence = draft.sequence
    const clip = editableClip(sequence, ref.clipId)
    const s = spec(clip, ref)
    if (ref.effectId === null && ref.param === 'speed') {
      const problem = speedKeyframeProblem(clip)
      if (problem) throw new CommandError(problem)
      if (!clip.keyframes['speed']?.length) command.notice = speedNote(sequence, clip)
    }
    const time = keyframeTime(clip, at - clip.start, frameTicks(sequence))
    const value = valueAt(clip, ref.effectId, ref.param, time)
    const track = trackFor(clip, ref.effectId, ref.param)
    if (track.some((k) => k.time === time)) return
    const before = [...track].reverse().find((k) => k.time < time)
    track.push({
      id: newId(),
      time,
      value: Array.isArray(value) ? [value[0], value[1]] : value,
      interpolation: s.kind === 'stepped' ? 'hold' : (before?.interpolation ?? 'linear'),
      in: { t: 1 / 3, v: (components(value) ?? [0]).map(() => 0) },
      out: { t: 1 / 3, v: (components(value) ?? [0]).map(() => 0) }
    })
    sortKeyframes(track)
  })
}

/**
 * Sets a value as shown at the playhead `at`: a keyframe there if it's animated,
 * otherwise the stored value. A drag on one control is one undo step.
 */
export function setValue(ref: PropertyRef, value: ParamValue, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  const command = timelineCommand('Change Value', (draft, c) => {
    const sequence = draft.sequence
    const clip = editableClip(sequence, ref.clipId)
    const s = spec(clip, ref)
    c.label = `Change ${s.label}`
    writeValueAt(clip, ref.effectId, ref.param, value, at - clip.start, frameTicks(sequence), newId)
    c.notice = notesFor(sequence, draft.media, [ref])
  })
  command.coalesceKey = `value:${ref.clipId}|${refKey(ref)}:${at}`
  return command
}

/** Reset: values back to these, their keyframes removed. */
export function resetValues(clipId: string, values: Array<{ effectId: string | null; param: string; value: ParamValue }>, label = 'Reset', blendMode: BlendMode | null = null): TimelineCommand {
  return timelineCommand(label, (draft) => {
    const clip = editableClip(draft.sequence, clipId)
    if (blendMode) clip.blendMode = blendMode
    for (const { effectId, param, value } of values) {
      const ref = { clipId, effectId, param }
      const s = spec(clip, ref)
      const map = effectId === null ? clip.keyframes : findEffect(clip, effectId)?.keyframes
      if (map) delete map[param]
      const clean = clampValue(s, value)
      if (clean !== null && !(effectId === null && param === 'speed')) writeStatic(clip, effectId, param, clean)
    }
  })
}

/**
 * A keyframe dragged in the graph: moved in time (snapped to frames) and given a new
 * value, as one step.
 */
export function applyDragKeyframe(sequence: Sequence, ref: KeyframeRef, delta: Ticks, change: KeyframeChange): void {
  applyKeyframeChange(sequence, ref, change)
  applyMoveKeyframes(sequence, [ref], delta)
}

export function dragKeyframe(ref: KeyframeRef, delta: Ticks, change: KeyframeChange): TimelineCommand {
  return timelineCommand('Move Keyframe', (draft, command) => {
    applyDragKeyframe(draft.sequence, ref, delta, change)
    command.notice = notesFor(draft.sequence, draft.media, [ref])
  })
}

// ---- Editing keyframes ----------------------------------------------------------------

export function applyRemoveKeyframes(sequence: Sequence, refs: KeyframeRef[]): number {
  let removed = 0
  for (const { ref, ids } of groupByProperty(refs).values()) {
    const clip = editableClip(sequence, ref.clipId)
    const track = keyframesOf(clip, ref.effectId, ref.param)
    const last = track.length > 0 ? track[track.length - 1]! : null
    const remaining = track.filter((k) => !ids.has(k.id))
    removed += track.length - remaining.length
    track.splice(0, track.length, ...remaining)
    dropIfEmpty(clip, ref, last ? last.value : null)
  }
  return removed
}

export function removeKeyframes(refs: KeyframeRef[]): TimelineCommand {
  return timelineCommand(refs.length === 1 ? 'Delete Keyframe' : 'Delete Keyframes', (draft) => {
    if (applyRemoveKeyframes(draft.sequence, refs) === 0) throw new CommandError('Those keyframes are already gone')
  })
}

/** Puts the moved keyframes back in order; a moved keyframe landing on another's frame replaces it. */
function settle(track: Keyframe[], moved: Set<string>): void {
  const byTime = new Map<Ticks, Keyframe>()
  for (const k of track) {
    const existing = byTime.get(k.time)
    if (!existing || moved.has(k.id)) byTime.set(k.time, k)
  }
  const kept = [...byTime.values()]
  sortKeyframes(kept)
  track.splice(0, track.length, ...kept)
}

/** Moves keyframes by `delta` ticks (snapped to frames). */
export function applyMoveKeyframes(sequence: Sequence, refs: KeyframeRef[], delta: Ticks): void {
  const frame = frameTicks(sequence)
  const step = Math.round(delta / frame) * frame
  if (step === 0) return
  for (const { ref, ids } of groupByProperty(refs).values()) {
    const clip = editableClip(sequence, ref.clipId)
    const track = keyframesOf(clip, ref.effectId, ref.param)
    for (const k of track) if (ids.has(k.id)) k.time += step
    settle(track, ids)
  }
}

export function moveKeyframes(refs: KeyframeRef[], delta: Ticks): TimelineCommand {
  return timelineCommand(refs.length === 1 ? 'Move Keyframe' : 'Move Keyframes', (draft, command) => {
    applyMoveKeyframes(draft.sequence, refs, delta)
    command.notice = notesFor(draft.sequence, draft.media, refs)
  })
}

/** Stretches the keyframes' timing around `pivot` (sequence time) by `factor`, snapped to frames. */
export function applyScaleKeyframes(sequence: Sequence, refs: KeyframeRef[], pivot: Ticks, factor: number): void {
  if (!(factor >= 0) || !Number.isFinite(factor)) throw new CommandError('Keyframe timing can only be stretched by a positive amount')
  const frame = frameTicks(sequence)
  for (const { ref, ids } of groupByProperty(refs).values()) {
    const clip = editableClip(sequence, ref.clipId)
    const track = keyframesOf(clip, ref.effectId, ref.param)
    const p = pivot - clip.start
    for (const k of track) if (ids.has(k.id)) k.time = Math.round((p + (k.time - p) * factor) / frame) * frame
    settle(track, ids)
  }
}

export function scaleKeyframes(refs: KeyframeRef[], pivot: Ticks, factor: number): TimelineCommand {
  return timelineCommand('Stretch Keyframes', (draft, command) => {
    applyScaleKeyframes(draft.sequence, refs, pivot, factor)
    command.notice = notesFor(draft.sequence, draft.media, refs)
  })
}

const PRESET_LABELS: Record<InterpolationPreset, string> = {
  linear: 'Linear',
  hold: 'Hold',
  bezier: 'Bezier',
  'ease-in': 'Ease In',
  'ease-out': 'Ease Out',
  'ease-in-out': 'Ease In and Out'
}

export function setKeyframeInterpolation(refs: KeyframeRef[], preset: InterpolationPreset): TimelineCommand {
  return timelineCommand(`Keyframe Interpolation: ${PRESET_LABELS[preset]}`, (draft) => {
    let changed = 0
    for (const { ref, ids } of groupByProperty(refs).values()) {
      const clip = editableClip(draft.sequence, ref.clipId)
      // Choices and toggles always hold.
      if (spec(clip, ref).kind === 'stepped') continue
      const track = keyframesOf(clip, ref.effectId, ref.param)
      track.forEach((k, index) => {
        if (!ids.has(k.id)) return
        applyPreset(track, index, preset)
        changed++
      })
    }
    if (changed === 0) throw new CommandError('Choices and on/off values always hold; their interpolation can’t change')
  })
}

export interface KeyframeChange {
  /** New value (clamped to the property's range). */
  value?: ParamValue
  in?: Handle
  out?: Handle
}

/** Changes one keyframe's value or bezier handles (dragging in the graph). */
export function applyKeyframeChange(sequence: Sequence, ref: KeyframeRef, change: KeyframeChange): void {
  const clip = editableClip(sequence, ref.clipId)
  const s = spec(clip, ref)
  const k = keyframesOf(clip, ref.effectId, ref.param).find((key) => key.id === ref.keyframeId)
  if (!k) throw new CommandError('That keyframe is gone')
  if (change.value !== undefined) {
    const value = clampValue(s, change.value)
    if (value === null) throw new CommandError(`${s.label} can’t be set to that`)
    k.value = value
  }
  const n = components(k.value)?.length ?? 1
  const handle = (h: Handle): Handle => ({ t: Math.min(1, Math.max(0, h.t)), v: Array.from({ length: n }, (_, i) => (Number.isFinite(h.v[i]) ? h.v[i]! : 0)) })
  if (change.in) k.in = handle(change.in)
  if (change.out) k.out = handle(change.out)
}

export function changeKeyframe(ref: KeyframeRef, change: KeyframeChange): TimelineCommand {
  const command = timelineCommand(change.value !== undefined ? 'Change Keyframe' : 'Adjust Keyframe Handles', (draft, c) => {
    applyKeyframeChange(draft.sequence, ref, change)
    c.notice = notesFor(draft.sequence, draft.media, [ref])
  })
  command.coalesceKey = `keyframe:${keyframeKey(ref)}:${change.value !== undefined}:${Boolean(change.in)}:${Boolean(change.out)}`
  return command
}

// ---- Copy and paste ---------------------------------------------------------------------

/** Copied keyframes: one property's worth, times relative to the earliest. */
export interface KeyframeClipboard {
  kind: 'number' | 'point' | 'stepped'
  /** What they were copied from, for labels and for pasting onto the same property. */
  label: string
  param: string
  keyframes: Keyframe[]
}

/** Copies keyframes of one property (the first one among `refs`, if several). */
export function copyKeyframes(sequence: Sequence, refs: KeyframeRef[]): KeyframeClipboard | null {
  const group = [...groupByProperty(refs).values()][0]
  if (!group) return null
  const clip = findClip(sequence, group.ref.clipId)
  const s = propertySpec(clip, group.ref.effectId, group.ref.param)
  if (!s) return null
  const chosen = keyframesOf(clip, group.ref.effectId, group.ref.param).filter((k) => group.ids.has(k.id))
  if (chosen.length === 0) return null
  const first = chosen[0]!.time
  return { kind: s.kind, label: s.label, param: group.ref.param, keyframes: chosen.map((k) => ({ ...cloneKeyframe(k), time: k.time - first })) }
}

/** Pastes keyframes onto a property, the first at `at` (sequence time); keyframes there are replaced. */
export function pasteKeyframes(target: PropertyRef, clipboard: KeyframeClipboard, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Paste Keyframes', (draft, command) => {
    const sequence = draft.sequence
    const clip = editableClip(sequence, target.clipId)
    const s = spec(clip, target)
    if (s.kind !== clipboard.kind) throw new CommandError(`${clipboard.label} keyframes can’t go on ${s.label}: one is ${clipboard.kind === 'point' ? 'a point' : clipboard.kind === 'number' ? 'a number' : 'a choice'}, the other isn’t`)
    if (target.effectId === null && target.param === 'speed') {
      const problem = speedKeyframeProblem(clip)
      if (problem) throw new CommandError(problem)
      command.notice = speedNote(sequence, clip)
    }
    const frame = frameTicks(sequence)
    const start = keyframeTime(clip, at - clip.start, frame)
    const track = trackFor(clip, target.effectId, target.param)
    const pasted = new Set<string>()
    for (const k of clipboard.keyframes) {
      const value = clampValue(s, k.value)
      if (value === null) throw new CommandError(`Those keyframes don’t fit ${s.label} (a value isn’t one of its choices)`)
      const copy = { ...cloneKeyframe(k, newId()), time: start + Math.round(k.time / frame) * frame, value }
      if (s.kind === 'stepped') copy.interpolation = 'hold'
      track.push(copy)
      pasted.add(copy.id)
    }
    settle(track, pasted)
    command.notice = [command.notice, mediaNote(draft.media, clip)].filter(Boolean).join(' ') || undefined
  })
}

function notesFor(sequence: Sequence, media: MediaItem[], refs: PropertyRef[]): string | undefined {
  const clipIds = new Set(refs.filter((r) => r.effectId === null && r.param === 'speed').map((r) => r.clipId))
  for (const id of clipIds) {
    const clip = sequence.clips.find((c) => c.id === id)
    const note = clip ? mediaNote(media, clip) : undefined
    if (note) return note
  }
  return undefined
}

export { MAX_SPEED_PERCENT }
