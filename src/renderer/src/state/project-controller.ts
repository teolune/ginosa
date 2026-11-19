import { History, replayPatches, type Change, type Patch } from '@engine/history'
import { CommandError, type Command } from '@engine/project/commands'
import { createProject, type Project, type SequenceSettings } from '@engine/project/model'
import { parseProject, ProjectFormatError, serializeProject } from '@engine/project/serialize'
import type { OpenedProject, RecentProject, RecoveryInfo } from '@shared/ipc'
import { Observable } from './observable'

/**
 * Owns the open projects in the renderer, one per tab in the title bar (decision 128): each with
 * its own undo history, saving, autosave, crash journal and recovery. The main process only
 * stores files. Everything else in the app works on the active tab's project; with the home page
 * showing there is none.
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

const CLEAN: SaveStatus = { kind: 'clean', at: null }

/** One open project: a tab. */
export class ProjectTab {
  savedMarker: number
  autosavedMarker: number
  journalSeq = 0
  idleTimer: ReturnType<typeof setTimeout> | null = null
  maxTimer: ReturnType<typeof setTimeout> | null = null
  status: SaveStatus = CLEAN
  recovery: PendingRecovery | null = null
  unsubscribe: () => void = () => undefined

  constructor(
    readonly key: number,
    readonly history: History,
    public path: string
  ) {
    this.savedMarker = history.marker
    this.autosavedMarker = history.marker
  }

  get project(): Project {
    return this.history.state
  }

  get isDirty(): boolean {
    return this.history.marker !== this.savedMarker
  }
}

export class ProjectController extends Observable {
  /** The open projects, in the order of their tabs. */
  tabs: ProjectTab[] = []
  private current: ProjectTab | null = null
  private nextKey = 1

  recent: RecentProject[] = []
  lastError: string | null = null

  private get bridge() {
    return window.ginosa.project
  }

  /** The tab being worked on; null while the home page shows. */
  get active(): ProjectTab | null {
    return this.current
  }

  /** Tells tabs apart even when two hold copies of one project (the same id). */
  get activeKey(): number | null {
    return this.current?.key ?? null
  }

  get project(): Project | null {
    return this.current?.project ?? null
  }

  get historyView(): History | null {
    return this.current?.history ?? null
  }

  get isDirty(): boolean {
    return this.current?.isDirty ?? false
  }

  get path(): string | null {
    return this.current?.path ?? null
  }

  get status(): SaveStatus {
    return this.current?.status ?? CLEAN
  }

  get recovery(): PendingRecovery | null {
    return this.current?.recovery ?? null
  }

  tabAt(path: string): ProjectTab | undefined {
    return this.tabs.find((tab) => tab.path === path)
  }

  async refreshRecent(): Promise<void> {
    this.recent = await this.bridge.recent()
    this.notify()
  }

  // ---- Tabs ------------------------------------------------------------------

  /** The clef in the title bar: the home page. The tabs stay open. */
  showHome(): void {
    this.activate(null)
  }

  switchTo(tab: ProjectTab): void {
    if (this.tabs.includes(tab)) this.activate(tab)
  }

  /** Control-Tab and Control-Shift-Tab: the next or previous tab, round the end (from home, the first or last). */
  cycle(step: 1 | -1): void {
    const count = this.tabs.length
    if (count === 0) return
    const at = this.current ? this.tabs.indexOf(this.current) : step > 0 ? -1 : count
    this.activate(this.tabs[(at + step + count) % count] ?? null)
  }

  private activate(tab: ProjectTab | null): void {
    if (tab === this.current) {
      this.notify()
      return
    }
    if (this.current && tab) {
      // Through "no project" on the way, so everything tied to the old project lets go of it
      // (playback, analysis, previews), even when the new tab holds a copy with the same id.
      this.current = null
      this.notify()
    }
    this.current = tab
    this.notify()
  }

  private addTab(project: Project, path: string, label: string): ProjectTab {
    const history = new History(project)
    history.reset(project, label)
    const tab = new ProjectTab(this.nextKey++, history, path)
    tab.unsubscribe = history.subscribe((change) => this.onChange(tab, change))
    this.tabs = [...this.tabs, tab]
    this.activate(tab)
    return tab
  }

  // ---- Opening and creating ------------------------------------------------

  /** New Project: asks where to save it, then makes it with these sequence settings (the title screen's choices), in a new tab. */
  async newProject(settings?: Partial<SequenceSettings>): Promise<void> {
    const path = await this.bridge.chooseNewLocation()
    if (!path) return
    await this.createAt(path, projectNameFromPath(path), settings)
  }

  async createAt(path: string, name = projectNameFromPath(path), settings?: Partial<SequenceSettings>): Promise<void> {
    const project = createProject({ name, settings })
    try {
      await this.bridge.create(path, serializeProject(project))
      const tab = this.addTab(project, path, 'New Project')
      tab.status = { kind: 'clean', at: new Date() }
      await this.refreshRecent()
    } catch (error) {
      await this.reportError("Couldn't create the project", error)
    }
  }

  /** Opens a project in a new tab, or switches to its tab if it's open already. */
  async open(path?: string, retried = false): Promise<void> {
    const openTab = path ? this.tabAt(path) : undefined
    if (openTab) return this.switchTo(openTab)
    let opened: OpenedProject | null = null
    try {
      opened = await this.bridge.open(path)
      if (!opened) return
      if (opened.alreadyOpen) {
        const tab = this.tabAt(opened.path)
        if (tab) return this.switchTo(tab)
        // Open in the main process but not here (the window was reloaded): let go of it and open it again.
        await this.bridge.close(opened.path)
        if (!retried) return this.open(opened.path, true)
        return
      }
      const project = parseProject(opened.json)
      const tab = this.addTab(project, opened.path, 'Open Project')
      if (opened.recovery) this.prepareRecovery(tab, opened.recovery)
      await this.refreshRecent()
    } catch (error) {
      // Read but not usable: nothing keeps it open.
      if (opened && !opened.alreadyOpen && !this.tabAt(opened.path)) await this.bridge.close(opened.path).catch(() => undefined)
      await this.reportError("Couldn't open the project", error)
      await this.refreshRecent()
    }
  }

  private prepareRecovery(tab: ProjectTab, info: RecoveryInfo): void {
    try {
      const base = parseProject(info.baseJson)
      const recovered = parseProject(replayPatches(base, info.journal as Patch[][]))
      tab.recovery = {
        recovered,
        changeCount: info.journal.length,
        lastChangeAt: info.lastChangeAt,
        baseSavedAt: info.baseSavedAt
      }
    } catch (error) {
      console.error('Recovery data could not be replayed', error)
      this.lastError = `Unsaved changes from the last session couldn't be restored: ${(error as Error).message}`
      void this.bridge.discardRecovery(tab.path)
    }
    this.notify()
  }

  /** Restores the recovered state (marked unsaved) or keeps the last saved version. */
  async resolveRecovery(restore: boolean): Promise<void> {
    const tab = this.current
    const recovery = tab?.recovery
    if (!tab || !recovery) return
    tab.recovery = null
    if (restore) {
      tab.history.reset(recovery.recovered, 'Restore Unsaved Changes')
      tab.savedMarker = -1 // the restored state isn't saved yet
      tab.autosavedMarker = -1
      await this.autosave(tab)
    } else {
      await this.bridge.discardRecovery(tab.path)
    }
    this.notify()
  }

  // ---- Editing (the active tab) ------------------------------------------------

  /** Applies a command. Invalid commands are refused with a message; nothing changes. */
  dispatch(command: Command): boolean {
    const history = this.current?.history
    if (!history) return false
    try {
      const changed = history.dispatch(command) !== null
      if (changed && command.notice) this.showMessage(command.notice)
      return changed
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
    this.current?.history.undo()
  }

  redo(): void {
    this.current?.history.redo()
  }

  jumpTo(position: number): void {
    this.current?.history.jumpTo(position)
  }

  /** Shows a short message in the error toast. */
  showMessage(message: string): void {
    this.lastError = message
    this.notify()
  }

  clearError(): void {
    this.lastError = null
    this.notify()
  }

  private onChange(tab: ProjectTab, change: Change): void {
    if (change.kind !== 'reset') {
      this.bridge.journal(tab.path, {
        seq: ++tab.journalSeq,
        at: new Date().toISOString(),
        kind: change.kind,
        label: change.label,
        patches: change.patches as unknown[]
      })
      this.scheduleAutosave(tab)
    }
    tab.status = tab.isDirty ? { kind: 'dirty' } : CLEAN
    this.notify()
  }

  // ---- Saving ----------------------------------------------------------------

  /** Saves a tab (the active one unless given). */
  async save(tab: ProjectTab | null = this.current): Promise<boolean> {
    if (!tab) return false
    tab.status = { kind: 'saving' }
    this.notify()
    try {
      const marker = tab.history.marker
      await this.bridge.save(tab.path, serializeProject(tab.project))
      tab.savedMarker = marker
      tab.autosavedMarker = marker
      this.clearAutosaveTimers(tab)
      tab.status = { kind: 'clean', at: new Date() }
      this.notify()
      return true
    } catch (error) {
      tab.status = { kind: 'error', message: (error as Error).message }
      await this.reportError("Couldn't save the project", error)
      return false
    }
  }

  async saveAs(): Promise<void> {
    const tab = this.current
    if (!tab) return
    try {
      const marker = tab.history.marker
      const path = await this.bridge.saveAs(tab.path, serializeProject(tab.project))
      if (!path) return
      tab.path = path
      tab.savedMarker = marker
      tab.autosavedMarker = marker
      tab.status = { kind: 'clean', at: new Date() }
      await this.refreshRecent()
    } catch (error) {
      await this.reportError("Couldn't save the project", error)
    }
  }

  private scheduleAutosave(tab: ProjectTab): void {
    if (tab.idleTimer) clearTimeout(tab.idleTimer)
    tab.idleTimer = setTimeout(() => void this.autosave(tab), AUTOSAVE_IDLE_MS)
    if (!tab.maxTimer) tab.maxTimer = setTimeout(() => void this.autosave(tab), AUTOSAVE_MAX_MS)
  }

  private clearAutosaveTimers(tab: ProjectTab): void {
    if (tab.idleTimer) clearTimeout(tab.idleTimer)
    if (tab.maxTimer) clearTimeout(tab.maxTimer)
    tab.idleTimer = null
    tab.maxTimer = null
  }

  /** Autosaves a tab (the active one unless given); each tab keeps its own timers. */
  async autosave(tab: ProjectTab | null = this.current): Promise<void> {
    if (!tab || !this.tabs.includes(tab)) return
    this.clearAutosaveTimers(tab)
    const marker = tab.history.marker
    if (marker === tab.autosavedMarker || marker === tab.savedMarker) return
    try {
      await this.bridge.autosave(tab.path, serializeProject(tab.project))
      tab.autosavedMarker = marker
      if (tab.isDirty) tab.status = { kind: 'autosaved', at: new Date() }
      this.notify()
    } catch (error) {
      console.error('Autosave failed', error)
      tab.status = { kind: 'error', message: `Autosave failed: ${(error as Error).message}` }
      this.notify()
    }
  }

  // ---- Closing -----------------------------------------------------------------

  /** Asks about a tab's unsaved changes. Returns false if the user cancelled. */
  async confirmLeave(tab: ProjectTab | null = this.current): Promise<boolean> {
    if (!tab || !tab.isDirty) return true
    const choice = await this.bridge.askUnsaved(tab.project.name)
    if (choice === 'cancel') return false
    if (choice === 'save') return this.save(tab)
    return true
  }

  /** A tab's ×, ⌘W and File › Close Project: asks to save if needed, then closes it. Returns false if cancelled. */
  async closeTab(tab: ProjectTab | null = this.current): Promise<boolean> {
    if (!tab || !this.tabs.includes(tab)) return true
    if (!(await this.confirmLeave(tab))) return false
    await this.closeQuietly(tab)
    await this.refreshRecent()
    return true
  }

  async close(): Promise<void> {
    await this.closeTab()
  }

  /**
   * Cache › Clean Up Finished Project (decision 60): saves the project if needed (and, with
   * `autosaves`, deletes its autosave snapshots), closes its tab, then deletes everything ginosa
   * generated for it. Closed first, so nothing is made again straight away.
   */
  async cleanUpFinished(autosaves: boolean): Promise<{ autosaves: number } | null> {
    const tab = this.current
    if (!tab) return null
    const project = tab.project
    if (tab.isDirty && !(await this.save(tab))) return null
    const removed = autosaves ? await this.bridge.deleteAutosaves(tab.path) : 0
    await this.closeQuietly(tab)
    await window.ginosa.cache.clear(project.id, 'all')
    await this.refreshRecent()
    return { autosaves: removed }
  }

  /** Closes a tab without asking. The active tab's place goes to the tab on its right, else its left, else home. */
  private async closeQuietly(tab: ProjectTab): Promise<void> {
    const at = this.tabs.indexOf(tab)
    if (at < 0) return
    this.clearAutosaveTimers(tab)
    tab.unsubscribe()
    tab.recovery = null
    this.tabs = this.tabs.filter((other) => other !== tab)
    if (this.current === tab) this.activate(this.tabs[at] ?? this.tabs[at - 1] ?? null)
    else this.notify()
    await this.bridge.close(tab.path)
  }

  /** Snapshot tests only: forget every tab as if the app had crashed. */
  forgetAfterSimulatedCrash(): void {
    for (const tab of this.tabs) {
      this.clearAutosaveTimers(tab)
      tab.unsubscribe()
    }
    this.tabs = []
    this.current = null
    this.notify()
  }

  /** Window close / Cmd+Q: asks about each tab with unsaved changes (showing it first); true when it's safe to close. */
  async prepareToQuit(): Promise<boolean> {
    for (const tab of [...this.tabs]) {
      if (!tab.isDirty) continue
      this.activate(tab)
      if (!(await this.confirmLeave(tab))) return false
    }
    for (const tab of [...this.tabs]) await this.closeQuietly(tab)
    return true
  }

  async reveal(): Promise<void> {
    if (this.current) await this.bridge.reveal(this.current.path)
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
