import type { Draft } from 'immer'
import type { ParamValue } from '../effects/types'
import { applyPreset, cloneKeyframe, cloneKeyframeMap, components, evaluate, putKeyframe, type InterpolationPreset } from '../keyframes/keyframes'
import { findEffect } from '../keyframes/properties'
import { cloneModulationMap } from '../modulation/apply'
import { CommandError } from '../project/commands'
import { defaultId, type IdFactory, type Project, type Sequence } from '../project/model'
import type { Ticks } from '../time'
import type { AudioSignal, BandRef, ModLink, ModSource } from '../modulation/types'
import { clampMaskValue, hasParam, newShape, shapeStatic, shapeValueAt, writeShapeStatic } from '../masks/masks'
import { MASK_KIND_LABELS, MASK_PARAMS, type Mask, type MaskMode, type MaskParam, type MaskRef, type MaskShape, type MaskShapeKind, type PathPoint } from '../masks/types'
import { timelineCommand, type TimelineCommand } from './edits'
import { defaultRange, describeSource, newModulator, sameSource, type LinkSettings } from './modulation-edits'
import { assertUnlocked, findClip, findTrack, frameTicks } from './timeline'

/**
 * Shared masks (M9), as undoable commands. Masks belong to the sequence, so their
 * keyframes are in sequence time (like modulators'), not clip time.
 */

/** One mask setting: which mask, which shape, which value. */
export interface MaskValueRef {
  maskId: string
  shapeId: string
  param: MaskParam
}

type DraftSequence = Draft<Project>['sequence']

function findMask(sequence: Sequence | DraftSequence, id: string): Mask {
  const mask = sequence.masks.find((m) => m.id === id)
  if (!mask) throw new CommandError('That mask is gone')
  return mask as Mask
}

function findShape(sequence: Sequence | DraftSequence, maskId: string, shapeId: string): MaskShape {
  const shape = findMask(sequence, maskId).shapes.find((s) => s.id === shapeId)
  if (!shape) throw new CommandError('That shape is gone')
  return shape
}

function onFrame(sequence: Sequence | DraftSequence, at: Ticks): Ticks {
  const frame = frameTicks(sequence as Sequence)
  return Math.max(0, Math.round(at / frame) * frame)
}

/** "Mask 1", "Mask 2"… the first free number. */
export function nextMaskName(sequence: Sequence): string {
  const names = new Set(sequence.masks.map((m) => m.name))
  for (let n = 1; ; n++) if (!names.has(`Mask ${n}`)) return `Mask ${n}`
}

/** Effects and adjustment layers using a mask: where they are, for the Masks window. */
export function maskUsers(sequence: Sequence, maskId: string): Array<{ clipId: string; effectId: string | null }> {
  const out: Array<{ clipId: string; effectId: string | null }> = []
  for (const clip of sequence.clips) {
    if (clip.mask?.id === maskId) out.push({ clipId: clip.id, effectId: null })
    for (const effect of clip.effects) if (effect.mask?.id === maskId) out.push({ clipId: clip.id, effectId: effect.id })
  }
  return out
}

export function addMask(kind: MaskShapeKind, name: string | null = null, newId: IdFactory = defaultId): TimelineCommand & { maskId: string; shapeId: string } {
  const maskId = newId()
  const shapeId = newId()
  const command = timelineCommand('New Mask', (draft) => {
    const sequence = draft.sequence
    sequence.masks.push({ id: maskId, name: name?.trim() || nextMaskName(sequence as Sequence), shapes: [newShape(shapeId, kind, sequence.settings)] })
  }) as TimelineCommand & { maskId: string; shapeId: string }
  command.maskId = maskId
  command.shapeId = shapeId
  return command
}

/** Effect Controls › Mask › New Mask: a new mask, used by an effect (or, with `effectId` null, an adjustment layer) straight away. One undo step. */
export function addMaskTo(clipId: string, effectId: string | null, kind: MaskShapeKind, newId: IdFactory = defaultId): TimelineCommand & { maskId: string; shapeId: string } {
  const made = addMask(kind, null, newId)
  const use = effectId === null ? setAdjustmentMask(clipId, { id: made.maskId, invert: false }) : setEffectMask(clipId, effectId, { id: made.maskId, invert: false })
  const command = timelineCommand('New Mask', (draft, self) => {
    made.apply(draft)
    use.apply(draft)
    self.notice = undefined
  }) as TimelineCommand & { maskId: string; shapeId: string }
  command.maskId = made.maskId
  command.shapeId = made.shapeId
  return command
}

export function renameMask(id: string, name: string): TimelineCommand {
  return timelineCommand('Rename Mask', (draft) => {
    const clean = name.trim()
    if (!clean) throw new CommandError('A mask needs a name')
    findMask(draft.sequence, id).name = clean
  })
}

function copyShape(shape: MaskShape, id: string): MaskShape {
  return {
    ...shape,
    id,
    position: [...shape.position],
    size: [...shape.size],
    points: shape.points.map((p) => ({ ...p })),
    keyframes: cloneKeyframeMap(shape.keyframes),
    modulation: cloneModulationMap(shape.modulation)
  }
}

export function duplicateMask(id: string, newId: IdFactory = defaultId): TimelineCommand & { maskId: string } {
  const maskId = newId()
  const command = timelineCommand('Duplicate Mask', (draft) => {
    const sequence = draft.sequence
    const mask = findMask(sequence, id)
    const names = new Set(sequence.masks.map((m) => m.name))
    let name = `${mask.name} copy`
    for (let n = 2; names.has(name); n++) name = `${mask.name} copy ${n}`
    const index = sequence.masks.findIndex((m) => m.id === id)
    sequence.masks.splice(index + 1, 0, { id: maskId, name, shapes: mask.shapes.map((s) => copyShape(s as MaskShape, newId())) })
  }) as TimelineCommand & { maskId: string }
  command.maskId = maskId
  return command
}

/** Removes a mask; whatever used it shows everywhere again. */
export function removeMask(id: string): TimelineCommand {
  return timelineCommand('Delete Mask', (draft, command) => {
    const sequence = draft.sequence
    findMask(sequence, id)
    const users = maskUsers(sequence as Sequence, id).length
    sequence.masks = sequence.masks.filter((m) => m.id !== id)
    for (const clip of sequence.clips) {
      if (clip.mask?.id === id) clip.mask = null
      for (const effect of clip.effects) if (effect.mask?.id === id) effect.mask = null
    }
    if (users > 0) command.notice = `It was used ${users === 1 ? 'once' : `${users} times`}; those now apply everywhere.`
  })
}

export function addShape(maskId: string, kind: MaskShapeKind, newId: IdFactory = defaultId): TimelineCommand & { shapeId: string } {
  const shapeId = newId()
  const command = timelineCommand(`Add ${MASK_KIND_LABELS[kind]}`, (draft) => {
    const sequence = draft.sequence
    findMask(sequence, maskId).shapes.push(newShape(shapeId, kind, sequence.settings))
  }) as TimelineCommand & { shapeId: string }
  command.shapeId = shapeId
  return command
}

export function removeShape(maskId: string, shapeId: string): TimelineCommand {
  return timelineCommand('Remove Shape', (draft) => {
    const mask = findMask(draft.sequence, maskId)
    const before = mask.shapes.length
    mask.shapes = mask.shapes.filter((s) => s.id !== shapeId)
    if (mask.shapes.length === before) throw new CommandError('That shape is gone')
  })
}

/** Moves a shape in the order they combine. */
export function moveShape(maskId: string, shapeId: string, index: number): TimelineCommand {
  return timelineCommand('Reorder Shapes', (draft) => {
    const mask = findMask(draft.sequence, maskId)
    const from = mask.shapes.findIndex((s) => s.id === shapeId)
    if (from < 0) throw new CommandError('That shape is gone')
    const to = Math.max(0, Math.min(mask.shapes.length - 1, index))
    if (from === to) return
    const [shape] = mask.shapes.splice(from, 1)
    mask.shapes.splice(to, 0, shape!)
  })
}

export function setShapeMode(maskId: string, shapeId: string, mode: MaskMode): TimelineCommand {
  return timelineCommand('Change Mask Mode', (draft) => {
    findShape(draft.sequence, maskId, shapeId).mode = mode
  })
}

export function setShapeInverted(maskId: string, shapeId: string, invert: boolean): TimelineCommand {
  return timelineCommand(invert ? 'Invert Shape' : 'Uninvert Shape', (draft) => {
    findShape(draft.sequence, maskId, shapeId).invert = invert
  })
}

/**
 * Sets mask settings as seen at `at` (sequence time): animated ones get a keyframe on that
 * frame; others change their stored value. One drag (same settings) is one undo step.
 */
export function setShapeValues(maskId: string, shapeId: string, values: Partial<Record<MaskParam, ParamValue>>, at: Ticks, newId: IdFactory = defaultId, label: string | null = null): TimelineCommand {
  const params = Object.keys(values) as MaskParam[]
  const command = timelineCommand(label ?? (params.length === 1 ? `Change ${MASK_PARAMS[params[0]!].label}` : 'Change Mask'), (draft) => {
    const sequence = draft.sequence
    const shape = findShape(sequence, maskId, shapeId)
    for (const param of params) {
      if (!hasParam(shape, param)) throw new CommandError(`A ${MASK_KIND_LABELS[shape.kind].toLowerCase()} has no ${MASK_PARAMS[param].label}`)
      const clean = clampMaskValue(param, values[param]!)
      if (clean === null) throw new CommandError(`${MASK_PARAMS[param].label} can’t be set to that`)
      const track = shape.keyframes[param]
      if (track?.length) putKeyframe(track, onFrame(sequence, at), clean, newId(), false)
      else writeShapeStatic(shape, param, clean)
    }
  })
  command.coalesceKey = `mask-values:${maskId}:${shapeId}:${params.sort().join(',')}`
  return command
}

/** The stopwatch on a mask setting: on makes a keyframe at `at`; off keeps the value there and drops the keyframes. */
export function setShapeAnimated(ref: MaskValueRef, on: boolean, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand(on ? 'Create Keyframes' : 'Remove Keyframes', (draft) => {
    const sequence = draft.sequence
    const shape = findShape(sequence, ref.maskId, ref.shapeId)
    if (!hasParam(shape, ref.param)) throw new CommandError(`That shape has no ${MASK_PARAMS[ref.param].label}`)
    const time = onFrame(sequence, at)
    if (on) {
      if (shape.keyframes[ref.param]?.length) return
      shape.keyframes[ref.param] = []
      putKeyframe(shape.keyframes[ref.param]!, time, shapeStatic(shape, ref.param), newId(), false)
    } else {
      const track = shape.keyframes[ref.param]
      if (!track?.length) return
      const value = evaluate(track, time, shapeStatic(shape, ref.param))
      delete shape.keyframes[ref.param]
      writeShapeStatic(shape, ref.param, value)
    }
  })
}

/** Adds a keyframe at `at` holding the value there (the diamond between the arrows). */
export function addShapeKeyframe(ref: MaskValueRef, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Add Keyframe', (draft) => {
    const sequence = draft.sequence
    const shape = findShape(sequence, ref.maskId, ref.shapeId)
    const track = (shape.keyframes[ref.param] ??= [])
    const time = onFrame(sequence, at)
    if (track.some((k) => k.time === time)) return
    putKeyframe(track, time, shapeValueAt(shape as MaskShape, ref.param, time), newId(), false)
  })
}

/** Removes keyframes; removing the last turns the stopwatch off, keeping its value. */
export function removeShapeKeyframes(ref: MaskValueRef, keyframeIds: string[]): TimelineCommand {
  return timelineCommand(keyframeIds.length === 1 ? 'Delete Keyframe' : 'Delete Keyframes', (draft) => {
    const shape = findShape(draft.sequence, ref.maskId, ref.shapeId)
    const track = shape.keyframes[ref.param] ?? []
    const kept = track.filter((k) => !keyframeIds.includes(k.id))
    if (kept.length === track.length) throw new CommandError('Those keyframes are gone')
    if (kept.length === 0) {
      writeShapeStatic(shape, ref.param, track[0]!.value)
      delete shape.keyframes[ref.param]
    } else shape.keyframes[ref.param] = kept
  })
}

export function setShapeInterpolation(ref: MaskValueRef, keyframeId: string, preset: InterpolationPreset): TimelineCommand {
  return timelineCommand('Change Interpolation', (draft) => {
    const track = findShape(draft.sequence, ref.maskId, ref.shapeId).keyframes[ref.param] ?? []
    const index = track.findIndex((k) => k.id === keyframeId)
    if (index < 0) throw new CommandError('That keyframe is gone')
    applyPreset(track, index, preset)
  })
}

/** Moves a mask keyframe to another frame (dropping any keyframe already there). */
export function moveShapeKeyframe(ref: MaskValueRef, keyframeId: string, to: Ticks): TimelineCommand {
  const command = timelineCommand('Move Keyframe', (draft) => {
    const sequence = draft.sequence
    const track = findShape(sequence, ref.maskId, ref.shapeId).keyframes[ref.param] ?? []
    const keyframe = track.find((k) => k.id === keyframeId)
    if (!keyframe) throw new CommandError('That keyframe is gone')
    const time = onFrame(sequence, to)
    const moved = cloneKeyframe(keyframe)
    moved.time = time
    const kept = track.filter((k) => k.id !== keyframeId && k.time !== time)
    kept.push(moved)
    kept.sort((a, b) => a.time - b.time)
    track.splice(0, track.length, ...kept)
  })
  command.coalesceKey = `mask-keyframe-move:${ref.maskId}:${ref.shapeId}:${ref.param}:${keyframeId}`
  return command
}

/** Replaces a pen path's points (a drag on the monitor is one undo step). */
export function setPathPoints(maskId: string, shapeId: string, points: PathPoint[], label = 'Edit Path'): TimelineCommand {
  const command = timelineCommand(label, (draft) => {
    const shape = findShape(draft.sequence, maskId, shapeId)
    if (shape.kind !== 'path') throw new CommandError('Only pen paths have points')
    if (points.length < 3) throw new CommandError('A path needs at least three points')
    if (!points.every((p) => [p.x, p.y, p.inX, p.inY, p.outX, p.outY].every((v) => Number.isFinite(v)))) throw new CommandError('Path points need numbers')
    shape.points = points.map((p) => ({ ...p }))
  })
  command.coalesceKey = `mask-path:${maskId}:${shapeId}:${label}`
  return command
}

// ---- Where masks are used ---------------------------------------------------------------------

/** Sets (or, with null, clears) the mask an effect uses. */
export function setEffectMask(clipId: string, effectId: string, mask: MaskRef | null): TimelineCommand {
  return timelineCommand(mask ? 'Set Effect Mask' : 'Clear Effect Mask', (draft) => {
    const sequence = draft.sequence
    const clip = findClip(sequence, clipId)
    assertUnlocked(findTrack(sequence, clip.trackId))
    const effect = findEffect(clip, effectId)
    if (!effect) throw new CommandError('That effect is no longer on the clip')
    if (mask) findMask(sequence, mask.id)
    // Follow clip needs the clip's Motion: adjustment layers have none.
    effect.mask = mask ? (mask.followClip && !clip.adjustment ? { id: mask.id, invert: mask.invert, followClip: true } : { id: mask.id, invert: mask.invert }) : null
  })
}

/** Sets (or clears) an adjustment layer's mask: where its effects apply. */
export function setAdjustmentMask(clipId: string, mask: MaskRef | null): TimelineCommand {
  return timelineCommand(mask ? 'Set Adjustment Mask' : 'Clear Adjustment Mask', (draft) => {
    const sequence = draft.sequence
    const clip = findClip(sequence, clipId)
    if (!clip.adjustment) throw new CommandError('Only adjustment layers have a mask of their own; effects each have one')
    assertUnlocked(findTrack(sequence, clip.trackId))
    if (mask) findMask(sequence, mask.id)
    clip.mask = mask ? { id: mask.id, invert: mask.invert } : null
  })
}

// ---- Modulation of mask settings ----------------------------------------------------------

function applyMaskLink(sequence: DraftSequence, ref: MaskValueRef, modulatorId: string, at: Ticks, settings: LinkSettings, newId: IdFactory): void {
  const shape = findShape(sequence, ref.maskId, ref.shapeId)
  if (!hasParam(shape, ref.param)) throw new CommandError(`That shape has no ${MASK_PARAMS[ref.param].label}`)
  const spec = MASK_PARAMS[ref.param]
  const current = components(shapeValueAt(shape as MaskShape, ref.param, at)) ?? [0]
  const range = defaultRange({ label: spec.label, kind: spec.kind, min: spec.min, max: spec.max, unit: spec.unit }, ref.param, current)
  const links = (shape.modulation[ref.param] ??= [])
  if (links.some((l) => l.modulatorId === modulatorId)) throw new CommandError(`${spec.label} is already linked to that modulator`)
  links.push({ id: newId(), modulatorId, mode: settings.mode ?? 'add', min: settings.min ?? range.min, max: settings.max ?? range.max, invert: settings.invert ?? false, amount: settings.amount ?? 100 })
}

export function addMaskLink(ref: MaskValueRef, modulatorId: string, at: Ticks, settings: LinkSettings = {}, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Modulate Parameter', (draft) => {
    if (!draft.sequence.modulators.some((m) => m.id === modulatorId)) throw new CommandError('That modulator is gone')
    applyMaskLink(draft.sequence, ref, modulatorId, at, settings, newId)
  })
}

/** Link to Audio for a mask setting: reuses a modulator for the same signal, as for clip values. */
export function linkMaskToAudio(ref: MaskValueRef, sourceId: string, signal: AudioSignal, band: BandRef, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Link to Audio', (draft, command) => {
    const sequence = draft.sequence
    const audio = sequence.audioSources.find((s) => s.id === sourceId)
    if (!audio) throw new CommandError('That analysis source is gone')
    const source: ModSource = { kind: 'audio', sourceId, signal, band }
    let modulator = sequence.modulators.find((m) => sameSource(m.source as ModSource, source))
    if (!modulator) {
      modulator = newModulator(newId(), describeSource(source, () => audio.name), source)
      sequence.modulators.push(modulator)
    } else command.notice = `Linked to “${modulator.name}”, which already drives other values.`
    applyMaskLink(sequence, ref, modulator.id, at, {}, newId)
  })
}

export function updateMaskLink(ref: MaskValueRef, linkId: string, changes: LinkSettings): TimelineCommand {
  const command = timelineCommand('Change Modulation', (draft) => {
    const link = findShape(draft.sequence, ref.maskId, ref.shapeId).modulation[ref.param]?.find((l) => l.id === linkId)
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
  command.coalesceKey = `mask-link:${ref.maskId}:${ref.shapeId}:${ref.param}:${linkId}:${Object.keys(changes).sort().join(',')}`
  return command
}

export function removeMaskLinks(ref: MaskValueRef, linkId: string | null = null): TimelineCommand {
  return timelineCommand('Remove Modulation', (draft) => {
    const map = findShape(draft.sequence, ref.maskId, ref.shapeId).modulation
    const links = map[ref.param] ?? []
    const kept = linkId ? links.filter((l) => l.id !== linkId) : []
    if (kept.length === links.length) throw new CommandError('There is no modulation there to remove')
    if (kept.length > 0) map[ref.param] = kept
    else delete map[ref.param]
  })
}

/** Every mask setting a modulator drives. */
export function maskLinksTo(sequence: Sequence, modulatorId: string): Array<{ ref: MaskValueRef; link: ModLink; mask: Mask; shape: MaskShape }> {
  const out: Array<{ ref: MaskValueRef; link: ModLink; mask: Mask; shape: MaskShape }> = []
  for (const mask of sequence.masks)
    for (const shape of mask.shapes)
      for (const [param, links] of Object.entries(shape.modulation))
        for (const link of links) if (link.modulatorId === modulatorId) out.push({ ref: { maskId: mask.id, shapeId: shape.id, param: param as MaskParam }, link, mask, shape })
  return out
}
