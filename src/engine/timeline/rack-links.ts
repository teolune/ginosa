import { effectById } from '../../effects/registry'
import type { EffectManifest } from '../effects/types'
import { clipProperties, modulatable, propertySpec, type PropertyRef } from '../keyframes/properties'
import type { ModLink } from '../modulation/types'
import { CommandError } from '../project/commands'
import { createTrack, defaultId, type Clip, type IdFactory, type Sequence } from '../project/model'
import { secondsToTicks, type Ticks } from '../time'
import { adjustmentLayerClip, effectImageSize, newEffectInstance } from './effect-edits'
import { timelineCommand, type TimelineCommand } from './edits'
import { applyLink, linksTo } from './modulation-edits'
import { channelModulatorIds } from './rack'
import { assertUnlocked, clipEnd, findClip, findTrack, frameTicks, sequenceEnd, toFrame } from './timeline'

/**
 * A Channel Rack channel's effects (decision 129): the values linked to it, grouped by the
 * effect they belong to, and the commands its window uses to link a value already there, add a
 * new effect with its main value linked, and unlink.
 */

export interface ChannelLinkedValue {
  ref: PropertyRef
  link: ModLink
  label: string
}

/** One effect (or a clip's own Motion and Opacity) with the values of it linked to the channel. */
export interface ChannelEffectGroup {
  clip: Clip
  /** null: the clip's own properties. */
  effectId: string | null
  name: string
  values: ChannelLinkedValue[]
}

/** The name of an effect on a clip, or "Motion" (Opacity, Volume) for the clip's own values. */
export function effectLabel(clip: Clip, effectId: string | null): string {
  if (effectId === null) return clip.kind === 'audio' ? 'Volume' : clip.adjustment ? 'Opacity' : 'Motion'
  const effect = clip.effects.find((e) => e.id === effectId)
  return effectById(effect?.effectId ?? '')?.name ?? 'Effect'
}

/** Every value linked to the channel (through its own modulator or any other listening to it), by effect. */
export function channelEffects(sequence: Sequence, rowId: string): ChannelEffectGroup[] {
  const groups = new Map<string, ChannelEffectGroup>()
  for (const modulatorId of channelModulatorIds(sequence, rowId)) {
    for (const { ref, link, clip } of linksTo(sequence, modulatorId)) {
      const key = `${clip.id}:${ref.effectId ?? ''}`
      let group = groups.get(key)
      if (!group) {
        group = { clip, effectId: ref.effectId, name: effectLabel(clip, ref.effectId), values: [] }
        groups.set(key, group)
      }
      group.values.push({ ref, link, label: propertySpec(clip, ref.effectId, ref.param)?.label ?? ref.param })
    }
  }
  return [...groups.values()]
}

/** The values of an effect (or the clip's own) that can follow a channel, in Effect Controls order, Mix last. */
export function linkableValues(clip: Clip, effectId: string | null): Array<{ param: string; label: string }> {
  const params =
    effectId === null
      ? (clipProperties(clip) as string[])
      : [...(effectById(clip.effects.find((e) => e.id === effectId)?.effectId ?? '')?.params.map((p) => p.id) ?? []), 'mix']
  return params.filter((param) => modulatable(clip, effectId, param)).map((param) => ({ param, label: propertySpec(clip, effectId, param)?.label ?? param }))
}

/** The value a channel moves when an effect is added from its window: the manifest's, else its first number that can be modulated. */
export function mainParam(manifest: EffectManifest): string | null {
  if (manifest.mainParam) return manifest.mainParam
  const first = manifest.params.find((p) => (p.type === 'number' || p.type === 'angle' || p.type === 'steps') && p.modulatable !== false)
  return first?.id ?? null
}

function channelModulator(sequence: Sequence, rowId: string): { name: string; modulatorId: string } {
  const row = sequence.rack.rows.find((r) => r.id === rowId)
  if (!row) throw new CommandError('That Channel Rack channel is gone')
  if (!row.modulatorId || !sequence.modulators.some((m) => m.id === row.modulatorId)) throw new CommandError(`${row.name} has no modulator to link values to`)
  return { name: row.name, modulatorId: row.modulatorId }
}

/** Links a value already on a clip to the channel ("Link a value…" in its window). */
export function linkToChannel(rowId: string, ref: PropertyRef, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Link to Channel', (draft, command) => {
    const { name, modulatorId } = channelModulator(draft.sequence, rowId)
    command.label = `Link to ${name}`
    const clip = findClip(draft.sequence, ref.clipId)
    assertUnlocked(findTrack(draft.sequence, clip.trackId))
    applyLink(clip, ref, modulatorId, at, {}, newId)
  })
}

/** Unlinks values from the channel (a value's ×, or a whole effect's): one undo step. */
export function unlinkFromChannel(values: ReadonlyArray<{ ref: PropertyRef; linkId: string }>): TimelineCommand {
  return timelineCommand(values.length === 1 ? 'Unlink Value' : 'Unlink Values', (draft) => {
    let removed = 0
    for (const { ref, linkId } of values) {
      const clip = findClip(draft.sequence, ref.clipId)
      assertUnlocked(findTrack(draft.sequence, clip.trackId))
      const map = ref.effectId === null ? clip.modulation : clip.effects.find((e) => e.id === ref.effectId)?.modulation
      const links = map?.[ref.param]
      if (!map || !links) continue
      const kept = links.filter((l) => l.id !== linkId)
      if (kept.length === links.length) continue
      removed++
      if (kept.length > 0) map[ref.param] = kept
      else delete map[ref.param]
    }
    if (removed === 0) throw new CommandError('Those values are no longer linked')
  })
}

export interface ChannelEffectRequest {
  rowId: string
  effectId: string
  /** Which of its values follows the channel (default: its main one). */
  param?: string
  /** Video clips or adjustment layers to put it on; none: a new adjustment layer over the whole song. */
  clipIds: readonly string[]
  /** Where the link's range starts from (the playhead). */
  at: Ticks
}

/** With nothing on the timeline yet, the new layer covers this long. */
const EMPTY_SONG_SECONDS = 10

/**
 * "New effect…" in a channel's window: the effect goes on the given clips (or a new adjustment
 * layer over the whole song, on the first video track free above everything there, else a new
 * one), with one of its values linked to the channel. One undo step.
 */
export function addChannelEffect(request: ChannelEffectRequest, newId: IdFactory = defaultId): TimelineCommand & { clipIds: string[] } {
  const manifest = effectById(request.effectId)
  const placed: string[] = []
  const command = timelineCommand(`Add ${manifest?.name ?? 'Effect'}`, (draft, cmd) => {
    if (!manifest) throw new CommandError(`ginosa doesn't have an effect called "${request.effectId}"`)
    const sequence = draft.sequence
    const { name, modulatorId } = channelModulator(sequence, request.rowId)
    cmd.label = `Add ${manifest.name} to ${name}`
    const param = request.param ?? mainParam(manifest)
    if (!param) throw new CommandError(`${manifest.name} has no value a channel can move`)
    let clips = [...new Set(request.clipIds)].map((id) => findClip(sequence, id)).filter((c) => c.kind === 'video')
    if (clips.length === 0) {
      const frame = frameTicks(sequence)
      const end = Math.max(toFrame(sequenceEnd(sequence), frame), toFrame(secondsToTicks(EMPTY_SONG_SECONDS), frame))
      const video = sequence.tracks.filter((t) => t.kind === 'video')
      const busy = (id: string) => sequence.clips.some((c) => c.trackId === id && c.start < end && clipEnd(c) > 0)
      const topUsed = video.reduce((top, t, i) => (busy(t.id) ? i : top), -1)
      let track = video.slice(topUsed + 1).find((t) => !t.locked)
      if (!track) {
        if (video.length >= 99) throw new CommandError('A sequence can have at most 99 tracks of each kind')
        track = createTrack('video', video.length, newId)
        sequence.tracks.push(track)
      }
      const layer = adjustmentLayerClip(sequence, track.id, 0, end, newId())
      layer.name = `${name}: ${manifest.name}`
      sequence.clips.push(layer)
      clips = [sequence.clips[sequence.clips.length - 1]!]
    }
    for (const clip of clips) {
      assertUnlocked(findTrack(sequence, clip.trackId))
      const instance = newEffectInstance(manifest, effectImageSize(clip, draft.media, sequence), newId)
      clip.effects.push(instance)
      const pushed = clip.effects[clip.effects.length - 1]!
      applyLink(clip, { clipId: clip.id, effectId: pushed.id, param }, modulatorId, request.at, {}, newId)
      placed.push(clip.id)
    }
  })
  return Object.assign(command, { clipIds: placed })
}
