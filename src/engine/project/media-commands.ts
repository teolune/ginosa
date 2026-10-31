import type { Draft } from 'immer'
import type { Ticks } from '../time'
import { CommandError, type Command } from './commands'
import { binAncestors, binDescendants, type Bin, type MediaFingerprint, type MediaInfo, type MediaItem } from './media'
import { defaultId, type IdFactory, type Project } from './model'

/** Undoable media-library edits. Removing media from a project never touches the files on disk. */

function cleanName(name: string, fallback: string): string {
  const trimmed = name.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed.slice(0, 200) : fallback
}

function findItem(draft: Draft<Project>, id: string): Draft<MediaItem> {
  const item = draft.media.find((m) => m.id === id)
  if (!item) throw new CommandError(`No media item with id ${id}`)
  return item
}

function findBin(draft: Draft<Project>, id: string): Draft<Bin> {
  const bin = draft.bins.find((b) => b.id === id)
  if (!bin) throw new CommandError(`No bin with id ${id}`)
  return bin
}

export function importMedia(items: MediaItem[]): Command {
  return {
    label: items.length === 1 ? 'Import Media' : `Import ${items.length} Items`,
    apply(draft) {
      const existing = new Set(draft.media.map((m) => m.id))
      for (const item of items) {
        if (existing.has(item.id)) throw new CommandError(`Media item ${item.id} is already in the project`)
        if (item.binId && !draft.bins.some((b) => b.id === item.binId)) throw new CommandError('Import target bin no longer exists')
        draft.media.push(structuredClone(item))
      }
    }
  }
}

export function createBin(name: string, parentId: string | null, createId: IdFactory = defaultId): Command & { binId: string } {
  const binId = createId()
  return {
    binId,
    label: 'New Bin',
    apply(draft) {
      if (parentId && !draft.bins.some((b) => b.id === parentId)) throw new CommandError('Parent bin no longer exists')
      draft.bins.push({ id: binId, name: cleanName(name, 'Bin'), parentId })
    }
  }
}

export function renameBin(id: string, name: string): Command {
  return {
    label: 'Rename Bin',
    apply(draft) {
      const bin = findBin(draft, id)
      bin.name = cleanName(name, bin.name)
    }
  }
}

/** Removes a bin, the bins inside it, and the media they hold, from the project only. */
export function deleteBin(id: string): Command {
  return {
    label: 'Delete Bin',
    apply(draft) {
      findBin(draft, id)
      const doomed = new Set(binDescendants(draft.bins, id))
      draft.bins = draft.bins.filter((b) => !doomed.has(b.id))
      const removed = new Set(draft.media.filter((m) => m.binId && doomed.has(m.binId)).map((m) => m.id))
      draft.media = draft.media.filter((m) => !removed.has(m.id))
      // Clips of removed media go too, as in Premiere.
      draft.sequence.clips = draft.sequence.clips.filter((c) => !removed.has(c.mediaId))
    }
  }
}

/** Moves media items and bins into `targetBinId` (null = top level). */
export function moveToBin(mediaIds: string[], binIds: string[], targetBinId: string | null): Command {
  return {
    label: 'Move to Bin',
    apply(draft) {
      if (targetBinId) findBin(draft, targetBinId)
      const targetChain = new Set(binAncestors(draft.bins, targetBinId))
      for (const binId of binIds) {
        const bin = findBin(draft, binId)
        if (targetChain.has(binId)) throw new CommandError("A bin can't be moved into itself")
        bin.parentId = targetBinId
      }
      for (const id of mediaIds) findItem(draft, id).binId = targetBinId
    }
  }
}

export function renameMedia(id: string, name: string): Command {
  return {
    label: 'Rename Media',
    apply(draft) {
      const item = findItem(draft, id)
      item.name = cleanName(name, item.name)
    }
  }
}

export function removeMedia(ids: string[]): Command {
  const command: Command = {
    label: ids.length === 1 ? 'Remove Media' : `Remove ${ids.length} Items`,
    apply(draft) {
      const doomed = new Set(ids)
      draft.media = draft.media.filter((m) => !doomed.has(m.id))
      const before = draft.sequence.clips.length
      draft.sequence.clips = draft.sequence.clips.filter((c) => !doomed.has(c.mediaId))
      const removed = before - draft.sequence.clips.length
      command.notice = removed > 0 ? `Also removed ${removed} clip${removed === 1 ? '' : 's'} from the timeline. Cmd+Z brings ${removed === 1 ? 'it' : 'them'} back.` : undefined
    }
  }
  return command
}

/** Points a media item at a moved or replaced file. */
export function relinkMedia(id: string, path: string, fingerprint: MediaFingerprint, info: MediaInfo): Command {
  return {
    label: 'Relink Media',
    apply(draft) {
      const item = findItem(draft, id)
      item.path = path
      item.fingerprint = { ...fingerprint }
      item.info = structuredClone(info)
    }
  }
}

export function setMarks(id: string, marks: { in?: Ticks | null; out?: Ticks | null }): Command {
  const label = marks.in !== undefined && marks.out === undefined ? 'Mark In' : marks.out !== undefined && marks.in === undefined ? 'Mark Out' : 'Set Marks'
  return {
    label,
    apply(draft) {
      const item = findItem(draft, id)
      const next = { in: marks.in !== undefined ? marks.in : item.marks.in, out: marks.out !== undefined ? marks.out : item.marks.out }
      // Premiere behaviour: a new In after the Out (or Out before In) clears the other mark.
      if (next.in !== null && next.out !== null && next.in >= next.out) {
        if (marks.in !== undefined) next.out = null
        else next.in = null
      }
      item.marks = next
    }
  }
}
