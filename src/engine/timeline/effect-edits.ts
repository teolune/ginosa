import type { Draft } from 'immer'
import { effectById } from '../../effects/registry'
import { cloneEffect, defaultParams, sanitiseValue } from '../effects/params'
import { rescaleEffects } from '../effects/presets'
import type { EffectInstance, ImageSize, ParamValue } from '../effects/types'
import { CommandError } from '../project/commands'
import type { MediaItem } from '../project/media'
import { defaultId, type BlendMode, type Clip, type IdFactory, type Project, type Sequence } from '../project/model'
import { type Ticks } from '../time'
import { timelineCommand, type TimelineCommand } from './edits'
import { sourceSize } from './motion'
import { EditContext, assertUnlocked, clearRange, findClip, findTrack, frameTicks, toFrame } from './timeline'

/**
 * Effect stacks and adjustment layers, as undoable commands. A clip's effects run on
 * its own pixels before Motion; an adjustment layer's run on everything beneath it.
 */

/** The image an effect on this clip sees: the clip's source, or the whole frame for an adjustment layer. */
export function effectImageSize(clip: Clip, media: MediaItem[], sequence: Sequence): ImageSize {
  if (clip.adjustment) return { width: sequence.settings.width, height: sequence.settings.height }
  return sourceSize(media.find((m) => m.id === clip.mediaId), sequence.settings)
}

function videoClip(sequence: Sequence, id: string): Clip {
  const clip = findClip(sequence, id)
  if (clip.kind !== 'video') throw new CommandError('Video effects go on video clips and adjustment layers')
  assertUnlocked(findTrack(sequence, clip.trackId))
  return clip
}

function effectOn(clip: Clip, effectId: string): EffectInstance {
  const effect = clip.effects.find((e) => e.id === effectId)
  if (!effect) throw new CommandError('That effect is no longer on the clip')
  return effect
}

/** Apply an effect to clips (from the Effects Library): at the bottom of each stack, or at `index`. */
export function addEffect(clipIds: string[], effectId: string, index: number | null = null, newId: IdFactory = defaultId): TimelineCommand {
  const manifest = effectById(effectId)
  return timelineCommand(`Apply ${manifest?.name ?? 'Effect'}`, (draft) => {
    if (!manifest) throw new CommandError(`ginosa doesn't have an effect called "${effectId}"`)
    const sequence = draft.sequence
    const clips = [...new Set(clipIds)].map((id) => findClip(sequence, id)).filter((c) => c.kind === 'video')
    if (clips.length === 0) throw new CommandError('Select a video clip or adjustment layer to apply an effect to')
    for (const clip of clips) {
      assertUnlocked(findTrack(sequence, clip.trackId))
      const instance: EffectInstance = {
        id: newId(),
        effectId,
        version: manifest.version,
        enabled: true,
        mix: 100,
        blendMode: 'normal',
        params: defaultParams(manifest, effectImageSize(clip, draft.media, sequence))
      }
      const at = index === null ? clip.effects.length : Math.max(0, Math.min(clip.effects.length, index))
      clip.effects.splice(at, 0, instance)
    }
  })
}

export function removeEffects(clipId: string, effectIds: string[]): TimelineCommand {
  return timelineCommand(effectIds.length === 1 ? 'Remove Effect' : 'Remove Effects', (draft) => {
    const clip = videoClip(draft.sequence, clipId)
    const before = clip.effects.length
    clip.effects = clip.effects.filter((e) => !effectIds.includes(e.id))
    if (clip.effects.length === before) throw new CommandError('Those effects are no longer on the clip')
  })
}

/** Drag to reorder: moves an effect to `index` in the stack (0 = top, runs first). */
export function moveEffect(clipId: string, effectId: string, index: number): TimelineCommand {
  return timelineCommand('Reorder Effects', (draft) => {
    const clip = videoClip(draft.sequence, clipId)
    const from = clip.effects.findIndex((e) => e.id === effectId)
    if (from < 0) throw new CommandError('That effect is no longer on the clip')
    const [effect] = clip.effects.splice(from, 1)
    clip.effects.splice(Math.max(0, Math.min(clip.effects.length, index)), 0, effect!)
  })
}

export function setEffectEnabled(clipId: string, effectId: string, enabled: boolean): TimelineCommand {
  return timelineCommand(enabled ? 'Turn Effect On' : 'Turn Effect Off', (draft) => {
    effectOn(videoClip(draft.sequence, clipId), effectId).enabled = enabled
  })
}

export interface EffectChanges {
  params?: Record<string, ParamValue>
  mix?: number
  blendMode?: BlendMode
}

/** Changes an effect's values. A whole drag on one control is one undo step. */
export function setEffectValues(clipId: string, effectId: string, changes: EffectChanges): TimelineCommand {
  const command = timelineCommand('Change Effect', (draft) => {
    const clip = videoClip(draft.sequence, clipId)
    const effect = effectOn(clip, effectId)
    const manifest = effectById(effect.effectId)
    if (changes.params) {
      if (!manifest) throw new CommandError('This effect is missing from this version of ginosa, so it can’t be changed')
      const size = effectImageSize(clip, draft.media, draft.sequence)
      for (const [key, value] of Object.entries(changes.params)) {
        const spec = manifest.params.find((p) => p.id === key)
        if (!spec) throw new CommandError(`${manifest.name} has no "${key}"`)
        effect.params[key] = sanitiseValue(spec, value, size)
      }
    }
    if (changes.mix !== undefined) effect.mix = Math.min(100, Math.max(0, changes.mix))
    if (changes.blendMode !== undefined) effect.blendMode = changes.blendMode
  })
  command.coalesceKey = `effect:${clipId}:${effectId}:${Object.keys(changes.params ?? {}).join(',')}:${changes.mix !== undefined}:${changes.blendMode !== undefined}`
  return command
}

/** Reset: every parameter back to its default (Mix and blend mode too). */
export function resetEffect(clipId: string, effectId: string): TimelineCommand {
  return timelineCommand('Reset Effect', (draft) => {
    const clip = videoClip(draft.sequence, clipId)
    const effect = effectOn(clip, effectId)
    const manifest = effectById(effect.effectId)
    if (!manifest) throw new CommandError('This effect is missing from this version of ginosa')
    effect.params = defaultParams(manifest, effectImageSize(clip, draft.media, draft.sequence))
    effect.mix = 100
    effect.blendMode = 'normal'
  })
}

/**
 * Paste copied effects (or apply a preset) onto clips, below their existing effects.
 * With `madeOn` (the image size they were made on), positions scale to each clip.
 */
export function pasteEffects(clipIds: string[], effects: EffectInstance[], label = 'Paste Effects', newId: IdFactory = defaultId, madeOn: ImageSize | null = null): TimelineCommand {
  return timelineCommand(label, (draft) => {
    if (effects.length === 0) throw new CommandError('There are no effects to paste')
    const clips = [...new Set(clipIds)].map((id) => findClip(draft.sequence, id)).filter((c) => c.kind === 'video')
    if (clips.length === 0) throw new CommandError('Select a video clip or adjustment layer to paste effects onto')
    for (const clip of clips) {
      assertUnlocked(findTrack(draft.sequence, clip.trackId))
      const fitted = madeOn ? rescaleEffects(effects, madeOn, effectImageSize(clip, draft.media, draft.sequence)) : effects
      clip.effects.push(...fitted.map((e) => cloneEffect(e, newId())))
    }
  })
}

export interface AdjustmentRequest {
  trackId: string
  start: Ticks
  duration: Ticks
}

/** A new adjustment layer on a video track (overwriting what's there, like any placed clip). */
export function addAdjustmentLayer(request: AdjustmentRequest, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('New Adjustment Layer', (draft: Draft<Project>, command) => {
    const sequence = draft.sequence
    const track = findTrack(sequence, request.trackId)
    if (track.kind !== 'video') throw new CommandError('Adjustment layers go on video tracks')
    assertUnlocked(track)
    const frame = frameTicks(sequence)
    const start = Math.max(0, toFrame(request.start, frame))
    const duration = Math.max(frame, toFrame(request.duration, frame))
    clearRange(sequence, track.id, start, start + duration, new EditContext(newId))
    sequence.clips.push({
      id: newId(),
      trackId: track.id,
      mediaId: '',
      kind: 'video',
      name: 'Adjustment Layer',
      start,
      duration,
      sourceIn: 0,
      linkId: null,
      motion: { positionX: sequence.settings.width / 2, positionY: sequence.settings.height / 2, scale: 100, scaleWidth: 100, rotation: 0, anchorX: sequence.settings.width / 2, anchorY: sequence.settings.height / 2 },
      opacity: 100,
      blendMode: 'normal',
      volume: 0,
      speed: 1,
      reverse: false,
      transitionIn: null,
      transitionOut: null,
      effects: [],
      adjustment: true
    })
    command.notice = undefined
  })
}
