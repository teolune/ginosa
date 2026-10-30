import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer'
import type { Command } from './project/commands'
import type { Project } from './project/model'

enablePatches()

/**
 * Undo/redo history built on Immer patches. Each applied command stores the
 * patches that made the change and the patches that reverse it, so undo is exact
 * and cheap. Every change (do, undo, redo) is announced with the patches that were
 * applied, which is what the crash journal records.
 */

export interface HistoryEntry {
  /** Changes when the entry's content changes (including coalescing), so it can mark the saved point. */
  id: number
  label: string
  patches: Patch[]
  inverse: Patch[]
  time: number
  coalesceKey?: string
}

export type ChangeKind = 'do' | 'undo' | 'redo' | 'reset'

export interface Change {
  kind: ChangeKind
  label: string
  /** Patches that turn the previous state into the new one (empty for 'reset'). */
  patches: Patch[]
  state: Project
}

export interface HistoryOptions {
  limit?: number
  coalesceMs?: number
  now?: () => number
}

const BASELINE_ID = 0

export class History {
  private current: Project
  private list: HistoryEntry[] = []
  private applied = 0
  private nextId = 1
  private listeners = new Set<(change: Change) => void>()
  /** How the starting point came about ("Open Project", "Restore Unsaved Changes"…). */
  baselineLabel = 'Open Project'
  private readonly limit: number
  private readonly coalesceMs: number
  private readonly now: () => number

  constructor(initial: Project, options: HistoryOptions = {}) {
    this.current = initial
    this.limit = options.limit ?? 500
    this.coalesceMs = options.coalesceMs ?? 1000
    this.now = options.now ?? (() => Date.now())
  }

  get state(): Project {
    return this.current
  }

  get entries(): readonly HistoryEntry[] {
    return this.list
  }

  /** Number of entries currently applied (entries after this index can be redone). */
  get position(): number {
    return this.applied
  }

  /** Identifies the current point in history; compare with a saved marker to know if the project is dirty. */
  get marker(): number {
    return this.applied === 0 ? BASELINE_ID : (this.list[this.applied - 1]?.id ?? BASELINE_ID)
  }

  get canUndo(): boolean {
    return this.applied > 0
  }

  get canRedo(): boolean {
    return this.applied < this.list.length
  }

  get undoLabel(): string | null {
    return this.list[this.applied - 1]?.label ?? null
  }

  get redoLabel(): string | null {
    return this.list[this.applied]?.label ?? null
  }

  subscribe(listener: (change: Change) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Applies a command. Returns null when it changed nothing. Throws CommandError when it is invalid. */
  dispatch(command: Command): Change | null {
    const [next, patches, inverse] = produceWithPatches(this.current, (draft) => {
      command.apply(draft)
    })
    if (patches.length === 0) return null

    const time = this.now()
    // Starting a new action discards anything that could have been redone.
    this.list.length = this.applied
    const last = this.list[this.applied - 1]
    if (command.coalesceKey && last && last.coalesceKey === command.coalesceKey && time - last.time <= this.coalesceMs) {
      last.patches = [...last.patches, ...patches]
      last.inverse = [...inverse, ...last.inverse]
      last.time = time
      last.id = this.nextId++
    } else {
      const entry: HistoryEntry = { id: this.nextId++, label: command.label, patches, inverse, time }
      if (command.coalesceKey) entry.coalesceKey = command.coalesceKey
      this.list.push(entry)
      this.applied++
      if (this.list.length > this.limit) {
        this.list.shift()
        this.applied--
      }
    }
    this.current = next
    return this.emit({ kind: 'do', label: command.label, patches, state: next })
  }

  undo(): Change | null {
    const entry = this.list[this.applied - 1]
    if (!entry) return null
    this.current = applyPatches(this.current, entry.inverse)
    this.applied--
    return this.emit({ kind: 'undo', label: entry.label, patches: entry.inverse, state: this.current })
  }

  redo(): Change | null {
    const entry = this.list[this.applied]
    if (!entry) return null
    this.current = applyPatches(this.current, entry.patches)
    this.applied++
    return this.emit({ kind: 'redo', label: entry.label, patches: entry.patches, state: this.current })
  }

  /** Undo or redo until `position` entries are applied (the History window uses this). */
  jumpTo(position: number): Change[] {
    const target = Math.max(0, Math.min(this.list.length, position))
    const changes: Change[] = []
    while (this.applied > target) {
      const change = this.undo()
      if (change) changes.push(change)
    }
    while (this.applied < target) {
      const change = this.redo()
      if (change) changes.push(change)
    }
    return changes
  }

  /** Starts a fresh history from `state` (opening or recovering a project). */
  reset(state: Project, label = 'Open Project'): Change {
    this.baselineLabel = label
    this.current = state
    this.list = []
    this.applied = 0
    return this.emit({ kind: 'reset', label, patches: [], state })
  }

  private emit(change: Change): Change {
    for (const listener of this.listeners) listener(change)
    return change
  }
}

/** Applies journal patches to a saved state (crash recovery). */
export function replayPatches(state: Project, batches: Patch[][]): Project {
  return batches.reduce((acc, patches) => applyPatches(acc, patches), state)
}

export type { Patch }
