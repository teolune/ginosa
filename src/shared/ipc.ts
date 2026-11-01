/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Keep this file free of Node or DOM imports so every side can use it.
 */

import type { MediaFingerprint, MediaInfo } from '../engine/project/media'
import type { ExportSettings } from '../engine/export/export-settings'
import type { FrameRate } from '../engine/time'
import type {
  CacheCategory,
  CacheProjectUsage,
  FileStatus,
  GenerateRequest,
  OptimiseJob,
  OptimiseRequest,
  ProbeResult
} from './media-types'
import type { SymbolSet } from './symbols'

export interface ExportBegin {
  settings: ExportSettings
  width: number
  height: number
  rate: FrameRate
  /** Sample frames of the mixed-down sound that will follow. */
  audioFrames: number
  sampleRate: number
  output: string
}

export interface ExportAnalysis {
  width: number
  height: number
  fps: number
  videoStart: number
  audioStart: number
  rows: number[][][]
  onsets: number[]
  /** Sound level: RMS of the mono mix in 10 ms windows from the audio stream's start. */
  envelope: number[]
  tags: { primaries: string | null; transfer: string | null; matrix: string | null; range: string | null }
}

export interface ExportResult {
  path: string
  size: number
  frames: number
  /** The finished file as ffprobe reads it (codec, colour tags, duration). */
  info: MediaInfo | null
}

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
  | { type: 'import' }
  | { type: 'export' }
  | { type: 'new-adjustment-layer' }
  | { type: 'new-bin' }
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
  | { type: 'show-warnings' }
  | { type: 'render-previews' }
  | { type: 'delete-previews' }
  | { type: 'clean-up-project'; autosaves: boolean }

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
    /** Deletes the open project's autosave snapshots; returns how many. */
    deleteAutosaves(): Promise<number>
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
  media: {
    chooseImport(): Promise<string[]>
    classify(paths: string[]): Promise<{ files: string[]; folders: Array<{ name: string; files: string[] }> }>
    probe(paths: string[]): Promise<ProbeResult[]>
    probeOne(path: string): Promise<ProbeResult>
    thumbnail(request: GenerateRequest): Promise<string>
    waveform(request: GenerateRequest): Promise<ArrayBuffer>
    checkFiles(items: Array<{ id: string; path: string; fingerprint: MediaFingerprint }>): Promise<Array<{ id: string; status: FileStatus }>>
    chooseRelink(fileName: string): Promise<string | null>
    /** Input LUTs (.cube): pick one, copy it into the project folder, read it back. */
    chooseLut(): Promise<string | null>
    importLut(projectPath: string, source: string): Promise<{ name: string; file: string }>
    readLut(projectPath: string, file: string): Promise<string>
    searchMoved(folder: string, wanted: Array<{ id: string; fileName: string; size: number }>): Promise<Array<{ id: string; path: string }>>
    reveal(path: string): Promise<void>
    optimise(request: OptimiseRequest): Promise<OptimiseJob>
    optimisedPath(projectId: string, mediaId: string, fingerprint: MediaFingerprint): Promise<string | null>
    jobs(): Promise<OptimiseJob[]>
    cancelJob(jobId: string): Promise<void>
    onJobUpdate(listener: (job: OptimiseJob) => void): () => void
    /** Path of a file dropped from Finder. */
    pathForFile(file: File): string
  }
  presets: {
    read(): Promise<unknown>
    write(data: unknown): Promise<void>
  }
  /** Preview renders in the project's cache (M9): one JPEG per frame, by frame key. */
  renders: {
    list(projectId: string): Promise<string[]>
    read(projectId: string, key: string): Promise<ArrayBuffer | null>
    /** Returns previews let go of to stay within the size limit (any project). */
    write(projectId: string, key: string, data: ArrayBuffer): Promise<Array<{ projectId: string; key: string }>>
  }
  /** Audio analysis results in the project's cache (M8). */
  analysis: {
    read(projectId: string, key: string): Promise<ArrayBuffer | null>
    write(projectId: string, key: string, data: ArrayBuffer): Promise<void>
  }
  export: {
    chooseFile(suggestedName: string, extension: string): Promise<string | null>
    begin(request: ExportBegin): Promise<string>
    audio(id: string, samples: Uint8Array): Promise<void>
    startVideo(id: string): Promise<void>
    frame(id: string, bytes: Uint8Array): Promise<void>
    finish(id: string): Promise<ExportResult>
    cancel(id: string): Promise<void>
  }
  cache: {
    registerProject(projectId: string, name: string, path: string): Promise<void>
    usage(): Promise<{ root: string; projects: CacheProjectUsage[] }>
    clear(projectId: string, category: CacheCategory | 'all'): Promise<void>
    /** Preview renders' size limit and how much they take now (all projects), bytes. */
    previewLimit(): Promise<{ limit: number; used: number }>
    setPreviewLimit(bytes: number): Promise<Array<{ projectId: string; key: string }>>
    reveal(): Promise<void>
    chooseLocation(): Promise<{ root: string; previous: string } | null>
  }
  ui: {
    /** SF Symbols drawn by macOS for the interface icons (see shared/symbols.ts). */
    symbols(): Promise<SymbolSet>
  }
  snapshot: {
    /** Present only when the app was started with --snapshot (automated UI screenshots). */
    scenario: string | null
    tempProjectPath(): Promise<string>
    simulateCrash(): Promise<void>
    /** Files in the repo's media/test folder (snapshot runs only). */
    testMedia(): Promise<string[]>
    referenceClips(): Promise<string[]>
    analyseExport(path: string, xs: number[]): Promise<ExportAnalysis | null>
    /** renders/export/<name> (snapshot mode only). */
    exportPath(name: string): Promise<string | null>
    ready(): Promise<void>
    /** Saves a JSON report next to the screenshot (renders/ui/<scenario>.json). */
    report(data: unknown): Promise<void>
  }
}
