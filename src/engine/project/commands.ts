import type { Draft } from 'immer'
import { FRAME_RATES, type FrameRateName } from '../time'
import {
  MAX_DIMENSION,
  MIN_DIMENSION,
  createTrack,
  defaultId,
  type IdFactory,
  type Project,
  type SequenceSettings,
  type Track,
  type TrackKind
} from './model'

/**
 * Every change to a project is a Command. Commands are the only way to edit the
 * document, which is what makes undo, autosave and the crash journal reliable.
 */
export interface Command {
  /** Shown in Edit > Undo and the History window. */
  label: string
  /** Consecutive commands with the same key within a short time merge into one undo step (e.g. typing a name). */
  coalesceKey?: string
  apply(draft: Draft<Project>): void
  /** Set by apply() when the user should hear about a side effect (e.g. clips Sync Lock had to split). */
  notice?: string
}

export class CommandError extends Error {}

function findTrack(draft: Draft<Project>, id: string): Draft<Track> {
  const track = draft.sequence.tracks.find((t) => t.id === id)
  if (!track) throw new CommandError(`No track with id ${id}`)
  return track
}

function cleanName(name: string, fallback: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed.slice(0, 120) : fallback
}

export function renameProject(name: string): Command {
  return {
    label: 'Rename Project',
    coalesceKey: 'rename-project',
    apply(draft) {
      draft.name = cleanName(name, draft.name)
    }
  }
}

export function setSequenceSettings(changes: Partial<SequenceSettings>): Command {
  const keys = Object.keys(changes).join(', ')
  return {
    label: `Change Sequence ${keys.includes('frameRate') && !keys.includes('width') ? 'Frame Rate' : 'Settings'}`,
    apply(draft) {
      const next = { ...draft.sequence.settings, ...changes }
      for (const dimension of [next.width, next.height]) {
        if (!Number.isInteger(dimension) || dimension < MIN_DIMENSION || dimension > MAX_DIMENSION) {
          throw new CommandError(`Frame size must be a whole number between ${MIN_DIMENSION} and ${MAX_DIMENSION}`)
        }
      }
      if (!(next.frameRate in FRAME_RATES)) throw new CommandError(`Unsupported frame rate ${String(next.frameRate)}`)
      if (next.frameRate !== draft.sequence.settings.frameRate && draft.sequence.clips.length > 0) {
        throw new CommandError('The frame rate can’t change once clips are on the timeline: every cut sits on the current frame grid')
      }
      if (next.width % 2 !== 0 || next.height % 2 !== 0) throw new CommandError('Frame size must use even numbers (video encoders require it)')
      draft.sequence.settings = next
    }
  }
}

export function setFrameRate(frameRate: FrameRateName): Command {
  return setSequenceSettings({ frameRate })
}

export function addTrack(kind: TrackKind, createId: IdFactory = defaultId): Command {
  return {
    label: `Add ${kind === 'video' ? 'Video' : 'Audio'} Track`,
    apply(draft) {
      const count = draft.sequence.tracks.filter((t) => t.kind === kind).length
      if (count >= 99) throw new CommandError('A sequence can have at most 99 tracks of each kind')
      draft.sequence.tracks.push(createTrack(kind, count, createId))
    }
  }
}

export function removeTrack(id: string): Command {
  return {
    label: 'Delete Track',
    apply(draft) {
      const track = findTrack(draft, id)
      const sameKind = draft.sequence.tracks.filter((t) => t.kind === track.kind)
      if (sameKind.length <= 1) throw new CommandError(`A sequence needs at least one ${track.kind} track`)
      draft.sequence.tracks = draft.sequence.tracks.filter((t) => t.id !== id)
      draft.sequence.clips = draft.sequence.clips.filter((c) => c.trackId !== id)
    }
  }
}

export function renameTrack(id: string, name: string): Command {
  return {
    label: 'Rename Track',
    coalesceKey: `rename-track:${id}`,
    apply(draft) {
      const track = findTrack(draft, id)
      track.name = cleanName(name, track.name)
    }
  }
}

export type TrackFlag = 'muted' | 'locked' | 'visible' | 'syncLock' | 'solo'

const FLAG_LABELS: Record<TrackFlag, [string, string]> = {
  muted: ['Mute Track', 'Unmute Track'],
  locked: ['Lock Track', 'Unlock Track'],
  visible: ['Show Track', 'Hide Track'],
  syncLock: ['Sync Lock Track', 'Turn Off Sync Lock'],
  solo: ['Solo Track', 'Unsolo Track']
}

export function setTrackFlag(id: string, flag: TrackFlag, value: boolean): Command {
  const [on, off] = FLAG_LABELS[flag]
  return {
    label: value ? on : off,
    apply(draft) {
      findTrack(draft, id)[flag] = value
    }
  }
}
