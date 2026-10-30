/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Keep this file free of Node or DOM imports so every side can use it.
 */

/** Custom URL scheme that streams local media files (read-only, with HTTP range support). */
export const MEDIA_SCHEME = 'ginosa-media'

/** Build a URL the renderer can fetch for a local file path. */
export function mediaUrlForPath(absolutePath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(absolutePath)}`
}

/** Inverse of mediaUrlForPath. Returns null when the URL is not a media URL. */
export function pathFromMediaUrl(url: string): string | null {
  const prefix = `${MEDIA_SCHEME}://local/`
  if (!url.startsWith(prefix)) return null
  const encoded = url.slice(prefix.length).split(/[?#]/)[0] ?? ''
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export type TestEffect = 'none' | 'invert'

/** A render-harness job, built by the main process from command-line flags. */
export interface HarnessJob {
  input: string
  inputUrl: string
  /** Frame indices to render (0-based, in the file's own frame rate). */
  frames: number[]
  effect: TestEffect
  amount: number
  outDir: string
}

export interface HarnessFrameResult {
  frame: number
  file: string
  timestamp: number | null
  decodeMs: number
  gpuMs: number
}

export interface HarnessReport {
  ok: boolean
  error?: string
  job: HarnessJob
  diagnostics: unknown
  clip: unknown
  frames: HarnessFrameResult[]
}

/** A project as stored on disk: a folder named `<Name>.ginosa` holding project.json. */
export const PROJECT_EXTENSION = '.ginosa'

export interface RecentProject {
  name: string
  path: string
  openedAt: string
  /** The last session with this project ended without closing it (crash or force quit). */
  interrupted?: boolean
}

export interface RecoveryInfo {
  /** JSON of the newest snapshot (project.json or an autosave), before the journal is replayed. */
  baseJson: string
  /** When that snapshot was written. */
  baseSavedAt: string
  /** Each entry is one change's Immer patches, in order. */
  journal: unknown[][]
  /** Time of the last journal entry, i.e. the last change before the crash. */
  lastChangeAt: string | null
}

export interface OpenedProject {
  path: string
  json: string
  recovery: RecoveryInfo | null
}

export interface JournalEntry {
  seq: number
  at: string
  kind: 'do' | 'undo' | 'redo'
  label: string
  patches: unknown[]
}

/** Commands sent from the native menu to the renderer. */
export type MenuCommand =
  | { type: 'new-project' }
  | { type: 'open-project' }
  | { type: 'open-recent'; path: string }
  | { type: 'save' }
  | { type: 'save-as' }
  | { type: 'close-project' }
  | { type: 'reveal-project' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'toggle-window'; id: string }
  | { type: 'workspace-apply'; name: string }
  | { type: 'workspace-save-as' }
  | { type: 'workspace-reset' }

/** What the renderer tells the main process so the native menu can reflect it. */
export interface MenuState {
  hasProject: boolean
  dirty: boolean
  undoLabel: string | null
  redoLabel: string | null
  windows: Array<{ id: string; title: string; shortcut: string; open: boolean }>
  workspaces: string[]
  activeWorkspace: string | null
  recent: RecentProject[]
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

/** API exposed to the renderer by the preload script as `window.ginosa`. */
export interface GinosaBridge {
  versions: { electron: string; chrome: string; node: string }
  platform: string
  arch: string
  openMediaDialog(): Promise<string | null>
  mediaUrl(absolutePath: string): string
  harness: {
    getJob(): Promise<HarnessJob | null>
    writeFile(name: string, data: ArrayBuffer): Promise<string>
    done(report: HarnessReport): Promise<void>
    log(message: string): void
  }
  project: {
    /** Asks where to create a new project. Returns the folder path (not yet created) or null. */
    chooseNewLocation(): Promise<string | null>
    create(path: string, json: string): Promise<void>
    /** Shows the open dialog when no path is given. */
    open(path?: string): Promise<OpenedProject | null>
    save(json: string): Promise<void>
    saveAs(json: string): Promise<string | null>
    autosave(json: string): Promise<void>
    journal(entry: JournalEntry): void
    discardRecovery(): Promise<void>
    close(): Promise<void>
    recent(): Promise<RecentProject[]>
    reveal(): Promise<void>
    askUnsaved(projectName: string): Promise<UnsavedChoice>
    showError(title: string, detail: string): Promise<void>
  }
  workspace: {
    load(): Promise<unknown>
    save(data: unknown): Promise<void>
  }
  menu: {
    setState(state: MenuState): void
    onCommand(listener: (command: MenuCommand) => void): () => void
  }
  app: {
    onCloseRequested(listener: () => void): () => void
    closeNow(): void
    closeCancelled(): void
  }
  snapshot: {
    /** Present only when the app was started with --snapshot (automated UI screenshots). */
    scenario: string | null
    tempProjectPath(): Promise<string>
    simulateCrash(): Promise<void>
    ready(): Promise<void>
  }
}
