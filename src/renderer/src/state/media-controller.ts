import { ALL_FORMATS, Input, UrlSource } from 'mediabunny'
import { createBin, importMedia, relinkMedia } from '@engine/project/media-commands'
import { IMPORT_EXTENSIONS, optimiseReasons, type MediaItem, type OptimiseReason } from '@engine/project/media'
import type { Project } from '@engine/project/model'
import type { FileStatus, OptimiseJob, ProbedFile } from '@shared/media-types'
import { Observable } from './observable'
import { projectController } from './project-controller'

/**
 * Runtime state for the media library: what isn't saved in the project because it
 * depends on this Mac (thumbnails, waveforms, decodability, optimised copies, offline files).
 */

export interface Waveform {
  bucketsPerSecond: number
  /** min, max pairs */
  peaks: Float32Array
}

export interface MediaRuntime {
  status: FileStatus | 'checking'
  thumbnailUrl: string | null
  waveform: Waveform | null
  decodable: boolean | null
  required: OptimiseReason[]
  suggested: OptimiseReason[]
  optimisedPath: string | null
  job: OptimiseJob | null
}

export interface ImportProgress {
  total: number
  done: number
  failed: Array<{ path: string; error: string }>
}

const EMPTY: MediaRuntime = {
  status: 'checking',
  thumbnailUrl: null,
  waveform: null,
  decodable: null,
  required: [],
  suggested: [],
  optimisedPath: null,
  job: null
}

async function canDecodeVideo(path: string): Promise<boolean> {
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(window.ginosa.mediaUrl(path)) })
  try {
    const track = await input.getPrimaryVideoTrack()
    return track ? await track.canDecode() : false
  } catch {
    return false
  } finally {
    const dispose = (input as unknown as { dispose?: () => void }).dispose
    if (typeof dispose === 'function') dispose.call(input)
  }
}

export class MediaController extends Observable {
  private runtime = new Map<string, MediaRuntime>()
  private projectId: string | null = null
  private pendingThumbs = new Set<string>()
  private pendingWaves = new Set<string>()
  importing: ImportProgress | null = null
  /** Item shown in the Source Monitor. */
  sourceId: string | null = null
  /** Where Import puts new media: the bin selected in the Media panel, or the top level. */
  targetBinId: string | null = null
  /** A bin the Media panel should start renaming (set by New Bin). */
  renameRequest: string | null = null

  constructor() {
    super()
    projectController.subscribe(() => this.syncProject())
    window.ginosa.media.onJobUpdate((job) => this.onJob(job))
  }

  get(id: string): MediaRuntime {
    return this.runtime.get(id) ?? EMPTY
  }

  private set(id: string, changes: Partial<MediaRuntime>): void {
    this.runtime.set(id, { ...this.get(id), ...changes })
    this.notify()
  }

  private get project(): Project | null {
    return projectController.project
  }

  private item(id: string): MediaItem | undefined {
    return this.project?.media.find((m) => m.id === id)
  }

  /** Called whenever the project changes; re-checks files when a different project opens. */
  private syncProject(): void {
    const project = this.project
    const id = project?.id ?? null
    if (id === this.projectId) {
      // Same project: pick up newly added items (import, undo of a removal, relink).
      if (project) for (const item of project.media) if (!this.runtime.has(item.id)) void this.check(item)
      return
    }
    this.projectId = id
    this.runtime.clear()
    this.sourceId = null
    this.notify()
    if (!project || !projectController.path) return
    void window.ginosa.cache.registerProject(project.id, project.name, projectController.path)
    for (const item of project.media) void this.check(item)
  }

  /** Online check, decodability and optimised-copy state for one item. */
  private async check(item: MediaItem): Promise<void> {
    this.runtime.set(item.id, { ...EMPTY })
    const projectId = this.projectId
    if (!projectId) return
    const [result] = await window.ginosa.media.checkFiles([{ id: item.id, path: item.path, fingerprint: item.fingerprint }])
    const status = result?.status ?? 'offline'
    this.set(item.id, { status })
    if (status === 'offline' || item.kind !== 'video') return
    const decodable = await canDecodeVideo(item.path)
    const { required, suggested } = optimiseReasons(item.info, decodable)
    const optimisedPath = await window.ginosa.media.optimisedPath(projectId, item.id, item.fingerprint)
    this.set(item.id, { decodable, required, suggested, optimisedPath })
    if (required.length > 0 && !optimisedPath) await this.optimise(item.id, required)
  }

  async optimise(id: string, reasons?: OptimiseReason[]): Promise<void> {
    const item = this.item(id)
    const projectId = this.projectId
    if (!item || !projectId) return
    const runtime = this.get(id)
    const job = await window.ginosa.media.optimise({
      projectId,
      mediaId: item.id,
      name: item.name,
      path: item.path,
      fingerprint: item.fingerprint,
      info: item.info,
      reasons: reasons ?? (runtime.required.length ? runtime.required : runtime.suggested)
    })
    this.onJob(job)
  }

  private onJob(job: OptimiseJob): void {
    if (job.projectId !== this.projectId) return
    this.set(job.mediaId, { job, ...(job.status === 'done' && job.output ? { optimisedPath: job.output } : {}) })
  }

  /** The file to decode: the optimised copy when there is one, otherwise the original. */
  playablePath(item: MediaItem): string | null {
    const runtime = this.get(item.id)
    if (runtime.optimisedPath) return runtime.optimisedPath
    if (runtime.status === 'offline') return null
    if (item.kind === 'video' && runtime.required.length > 0) return null
    return item.path
  }

  // ---- Thumbnails and waveforms (generated lazily, when first shown) ----------

  requestThumbnail(item: MediaItem): void {
    const projectId = this.projectId
    if (!projectId || this.pendingThumbs.has(item.id) || this.get(item.id).thumbnailUrl || item.kind === 'audio') return
    // Offline items still get their cached thumbnail; the main process only reads the original if none is cached.
    this.pendingThumbs.add(item.id)
    window.ginosa.media
      .thumbnail({ projectId, mediaId: item.id, path: item.path, kind: item.kind, fingerprint: item.fingerprint, durationSeconds: item.info.durationSeconds })
      .then((path) => this.set(item.id, { thumbnailUrl: window.ginosa.mediaUrl(path) }))
      .catch((error: Error) => console.warn(`Thumbnail for ${item.name}: ${error.message}`))
      .finally(() => this.pendingThumbs.delete(item.id))
  }

  requestWaveform(item: MediaItem): void {
    const projectId = this.projectId
    if (!projectId || !item.info.audio || this.pendingWaves.has(item.id) || this.get(item.id).waveform) return
    if (this.get(item.id).status === 'offline') return
    this.pendingWaves.add(item.id)
    window.ginosa.media
      .waveform({ projectId, mediaId: item.id, path: item.path, kind: item.kind, fingerprint: item.fingerprint, durationSeconds: item.info.durationSeconds })
      .then((buffer) => {
        const view = new DataView(buffer)
        const bucketsPerSecond = view.getUint32(0, true)
        const count = view.getUint32(4, true)
        this.set(item.id, { waveform: { bucketsPerSecond, peaks: new Float32Array(buffer.slice(8, 8 + count * 8)) } })
      })
      .catch((error: Error) => console.warn(`Waveform for ${item.name}: ${error.message}`))
      .finally(() => this.pendingWaves.delete(item.id))
  }

  // ---- Import ---------------------------------------------------------------------

  async chooseAndImport(targetBinId: string | null): Promise<void> {
    const paths = await window.ginosa.media.chooseImport()
    if (paths.length) await this.importPaths(paths, targetBinId)
  }

  /** Imports files and folders (a folder becomes a bin). One undo step per import. */
  async importPaths(paths: string[], targetBinId: string | null): Promise<void> {
    const project = this.project
    if (!project) return
    const known = new Set(project.media.map((m) => m.path))
    const { files, folders } = await window.ginosa.media.classify(paths)
    const groups: Array<{ binName: string | null; files: string[] }> = [
      { binName: null, files: files.filter((p) => !known.has(p)) },
      ...folders.map((f) => ({ binName: f.name, files: f.files.filter((p) => !known.has(p)) }))
    ].filter((g) => g.files.length > 0)
    const total = groups.reduce((n, g) => n + g.files.length, 0)
    if (total === 0) {
      if (paths.length) projectController.showMessage('Nothing new to import: those files are already in the project or are not media.')
      return
    }
    this.importing = { total, done: 0, failed: [] }
    this.notify()
    for (const group of groups) {
      let binId = targetBinId
      if (group.binName) {
        const bin = createBin(group.binName, targetBinId)
        if (projectController.dispatch(bin)) binId = bin.binId
      }
      const results = await window.ginosa.media.probe(group.files)
      const items: MediaItem[] = []
      for (const result of results) {
        if (result.ok) items.push(this.toItem(result.file, binId))
        else this.importing.failed.push({ path: result.path, error: result.error })
      }
      if (items.length) projectController.dispatch(importMedia(items))
      this.importing.done += group.files.length
      this.notify()
    }
    const failed = this.importing.failed
    this.importing = null
    this.notify()
    if (failed.length) {
      await window.ginosa.project.showError(
        `${failed.length} file${failed.length === 1 ? '' : 's'} couldn't be imported`,
        failed.map((f) => `${f.path.split('/').pop()}: ${f.error}`).join('\n')
      )
    }
  }

  private toItem(file: ProbedFile, binId: string | null): MediaItem {
    return {
      id: globalThis.crypto.randomUUID(),
      name: file.name,
      kind: file.kind,
      path: file.path,
      fingerprint: file.fingerprint,
      info: file.info,
      binId,
      importedAt: new Date().toISOString(),
      marks: { in: null, out: null }
    }
  }

  // ---- Relinking ------------------------------------------------------------------

  /** Locate a missing file; choosing a folder searches it for every missing file. */
  async relink(id: string): Promise<void> {
    const item = this.item(id)
    if (!item) return
    const fileName = item.path.split('/').pop() ?? item.name
    const chosen = await window.ginosa.media.chooseRelink(fileName)
    if (!chosen) return
    const offline = (this.project?.media ?? []).filter((m) => m.id === id || this.get(m.id).status !== 'online')
    const probe = await window.ginosa.media.probeOne(chosen)
    if (probe.ok) {
      this.applyRelink(item, probe.file)
      return
    }
    const extension = chosen.split('/').pop()?.split('.').pop()?.toLowerCase() ?? ''
    if ((IMPORT_EXTENSIONS as readonly string[]).includes(extension)) {
      await window.ginosa.project.showError(`Couldn't read "${chosen.split('/').pop()}"`, probe.error)
      return
    }
    // Not a media file: treat it as a folder to search.
    const matches = await window.ginosa.media.searchMoved(
      chosen,
      offline.map((m) => ({ id: m.id, fileName: m.path.split('/').pop() ?? m.name, size: m.fingerprint.size }))
    )
    if (matches.length === 0) {
      await window.ginosa.project.showError('No matching files found', `Nothing in "${chosen}" has the same name and size as the missing media.`)
      return
    }
    for (const match of matches) {
      const target = this.item(match.id)
      const found = await window.ginosa.media.probeOne(match.path)
      if (target && found.ok) this.applyRelink(target, found.file)
    }
  }

  private applyRelink(item: MediaItem, file: ProbedFile): void {
    if (projectController.dispatch(relinkMedia(item.id, file.path, file.fingerprint, file.info))) {
      const updated = this.item(item.id)
      if (updated) void this.check(updated)
    }
  }

  newBin(): void {
    const bin = createBin('New Bin', this.targetBinId)
    if (projectController.dispatch(bin)) {
      this.renameRequest = bin.binId
      this.notify()
    }
  }

  /** Re-checks every item, e.g. after the optimised copies were cleared from the cache. */
  recheckAll(): void {
    for (const item of this.project?.media ?? []) void this.check(item)
  }

  openInSource(id: string): void {
    this.sourceId = id
    this.notify()
  }
}

export const mediaController = new MediaController()
