import { History, replayPatches, type Change, type Patch } from '@engine/history'
import { CommandError, type Command } from '@engine/project/commands'
import { createProject, type Project } from '@engine/project/model'
import { parseProject, ProjectFormatError, serializeProject } from '@engine/project/serialize'
import type { RecentProject, RecoveryInfo } from '@shared/ipc'
import { Observable } from './observable'

/**
 * Owns the open project in the renderer: undo history, saving, autosave, the
 * crash journal and recovery. The main process only stores files.
 */

const AUTOSAVE_IDLE_MS = 5_000
const AUTOSAVE_MAX_MS = 60_000

export interface PendingRecovery {
  recovered: Project
  changeCount: number
  lastChangeAt: string | null
  baseSavedAt: string
}

export type SaveStatus =
  | { kind: 'clean'; at: Date | null }
  | { kind: 'dirty' }
  | { kind: 'autosaved'; at: Date }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }

function projectNameFromPath(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.ginosa$/, '')
}

export class ProjectController extends Observable {
  private history: History | null = null
  private unsubscribeHistory: (() => void) | null = null
  private savedMarker = 0
  private autosavedMarker = 0
  private journalSeq = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null

  path: string | null = null
  status: SaveStatus = { kind: 'clean', at: null }
  recent: RecentProject[] = []
  recovery: PendingRecovery | null = null
  lastError: string | null = null

  private get bridge() {
    return window.ginosa.project
  }

  get project(): Project | null {
    return this.history?.state ?? null
  }

  get historyView(): History | null {
    return this.history
  }

  get isDirty(): boolean {
    return this.history !== null && this.history.marker !== this.savedMarker
  }

  async refreshRecent(): Promise<void> {
    this.recent = await this.bridge.recent()
    this.notify()
  }

  // ---- Opening and creating ------------------------------------------------

  async newProject(): Promise<void> {
    if (!(await this.confirmLeave())) return
    const path = await this.bridge.chooseNewLocation()
    if (!path) return
    await this.createAt(path)
  }

  async createAt(path: string, name = projectNameFromPath(path)): Promise<void> {
    const project = createProject({ name })
    try {
      await this.closeQuietly()
      await this.bridge.create(path, serializeProject(project))
      this.load(project, path, 'New Project')
      this.status = { kind: 'clean', at: new Date() }
      await this.refreshRecent()
    } catch (error) {
      await this.reportError("Couldn't create the project", error)
    }
  }

  async open(path?: string): Promise<void> {
    if (!(await this.confirmLeave())) return
    try {
      await this.closeQuietly()
      const opened = await this.bridge.open(path)
      if (!opened) return
      const project = parseProject(opened.json)
      this.load(project, opened.path, 'Open Project')
      this.status = { kind: 'clean', at: null }
      if (opened.recovery) this.prepareRecovery(opened.recovery)
      await this.refreshRecent()
    } catch (error) {
      await this.reportError("Couldn't open the project", error)
      await this.refreshRecent()
    }
  }

  private load(project: Project, path: string, label: string): void {
    this.unsubscribeHistory?.()
    this.history = new History(project)
    this.history.reset(project, label)
    this.unsubscribeHistory = this.history.subscribe((change) => this.onChange(change))
    this.path = path
    this.savedMarker = this.history.marker
    this.autosavedMarker = this.history.marker
    this.journalSeq = 0
    this.recovery = null
    this.notify()
  }

  private prepareRecovery(info: RecoveryInfo): void {
    try {
      const base = parseProject(info.baseJson)
      const recovered = parseProject(replayPatches(base, info.journal as Patch[][]))
      this.recovery = {
        recovered,
        changeCount: info.journal.length,
        lastChangeAt: info.lastChangeAt,
        baseSavedAt: info.baseSavedAt
      }
    } catch (error) {
      console.error('Recovery data could not be replayed', error)
      this.lastError = `Unsaved changes from the last session couldn't be restored: ${(error as Error).message}`
      void this.bridge.discardRecovery()
    }
    this.notify()
  }

  /** Restores the recovered state (marked unsaved) or keeps the last saved version. */
  async resolveRecovery(restore: boolean): Promise<void> {
    const recovery = this.recovery
    if (!recovery || !this.history || !this.path) return
    this.recovery = null
    if (restore) {
      this.history.reset(recovery.recovered, 'Restore Unsaved Changes')
      this.savedMarker = -1 // the restored state isn't saved yet
      this.autosavedMarker = -1
      await this.autosave()
    } else {
      await this.bridge.discardRecovery()
    }
    this.notify()
  }

  // ---- Editing ---------------------------------------------------------------

  /** Applies a command. Invalid commands are refused with a message; nothing changes. */
  dispatch(command: Command): boolean {
    if (!this.history) return false
    try {
      return this.history.dispatch(command) !== null
    } catch (error) {
      if (error instanceof CommandError) {
        this.lastError = error.message
        this.notify()
        return false
      }
      throw error
    }
  }

  undo(): void {
    this.history?.undo()
  }

  redo(): void {
    this.history?.redo()
  }

  jumpTo(position: number): void {
    this.history?.jumpTo(position)
  }

  clearError(): void {
    this.lastError = null
    this.notify()
  }

  private onChange(change: Change): void {
    if (change.kind !== 'reset') {
      this.bridge.journal({
        seq: ++this.journalSeq,
        at: new Date().toISOString(),
        kind: change.kind,
        label: change.label,
        patches: change.patches as unknown[]
      })
      this.scheduleAutosave()
    }
    this.status = this.isDirty ? { kind: 'dirty' } : { kind: 'clean', at: null }
    this.notify()
  }

  // ---- Saving ----------------------------------------------------------------

  async save(): Promise<boolean> {
    const project = this.project
    if (!project || !this.history) return false
    this.status = { kind: 'saving' }
    this.notify()
    try {
      await this.bridge.save(serializeProject(project))
      this.savedMarker = this.history.marker
      this.autosavedMarker = this.history.marker
      this.clearAutosaveTimers()
      this.status = { kind: 'clean', at: new Date() }
      this.notify()
      return true
    } catch (error) {
      this.status = { kind: 'error', message: (error as Error).message }
      await this.reportError("Couldn't save the project", error)
      return false
    }
  }

  async saveAs(): Promise<void> {
    const project = this.project
    if (!project || !this.history) return
    try {
      const path = await this.bridge.saveAs(serializeProject(project))
      if (!path) return
      this.path = path
      this.savedMarker = this.history.marker
      this.autosavedMarker = this.history.marker
      this.status = { kind: 'clean', at: new Date() }
      await this.refreshRecent()
    } catch (error) {
      await this.reportError("Couldn't save the project", error)
    }
  }

  private scheduleAutosave(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => void this.autosave(), AUTOSAVE_IDLE_MS)
    if (!this.maxTimer) this.maxTimer = setTimeout(() => void this.autosave(), AUTOSAVE_MAX_MS)
  }

  private clearAutosaveTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.idleTimer = null
    this.maxTimer = null
  }

  async autosave(): Promise<void> {
    this.clearAutosaveTimers()
    const project = this.project
    if (!project || !this.history) return
    const marker = this.history.marker
    if (marker === this.autosavedMarker || marker === this.savedMarker) return
    try {
      await this.bridge.autosave(serializeProject(project))
      this.autosavedMarker = marker
      if (this.isDirty) this.status = { kind: 'autosaved', at: new Date() }
      this.notify()
    } catch (error) {
      console.error('Autosave failed', error)
      this.status = { kind: 'error', message: `Autosave failed: ${(error as Error).message}` }
      this.notify()
    }
  }

  // ---- Closing -----------------------------------------------------------------

  /** Asks about unsaved changes. Returns false if the user cancelled. */
  async confirmLeave(): Promise<boolean> {
    if (!this.project || !this.isDirty) return true
    const choice = await this.bridge.askUnsaved(this.project.name)
    if (choice === 'cancel') return false
    if (choice === 'save') return this.save()
    return true
  }

  async close(): Promise<void> {
    if (!(await this.confirmLeave())) return
    await this.closeQuietly()
    await this.refreshRecent()
  }

  private async closeQuietly(): Promise<void> {
    if (!this.history) return
    this.clearAutosaveTimers()
    this.unsubscribeHistory?.()
    this.unsubscribeHistory = null
    this.history = null
    this.path = null
    this.recovery = null
    this.status = { kind: 'clean', at: null }
    await this.bridge.close()
    this.notify()
  }

  /** Snapshot tests only: forget the in-memory project as if the app had crashed. */
  forgetAfterSimulatedCrash(): void {
    this.clearAutosaveTimers()
    this.unsubscribeHistory?.()
    this.unsubscribeHistory = null
    this.history = null
    this.path = null
    this.notify()
  }

  /** Window close / Cmd+Q: returns true when it's safe to close. */
  async prepareToQuit(): Promise<boolean> {
    if (!(await this.confirmLeave())) return false
    await this.closeQuietly()
    return true
  }

  async reveal(): Promise<void> {
    await this.bridge.reveal()
  }

  private async reportError(title: string, error: unknown): Promise<void> {
    const detail = error instanceof ProjectFormatError || error instanceof Error ? error.message : String(error)
    // Electron prefixes errors from the main process; strip that for readability.
    const clean = detail.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    console.error(title, error)
    await this.bridge.showError(title, clean)
    this.notify()
  }
}

export const projectController = new ProjectController()
