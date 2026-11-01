import { lstat, readdir, readFile, rename, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CacheService, isProjectId } from './cache-service'

/**
 * Preview renders (M9): one JPEG per frame in `<cache>/<project>/renders/<key>.jpg`, named
 * by the frame's key (frame-keys.ts), so a file is valid for as long as its frame looks
 * the same. All projects' previews share one size limit; past it, the least recently used
 * files go first (reading a preview counts as using it). Deletion goes through the cache's
 * guarded removeFile, like every cache deletion.
 */

/** 20 GB: at about 0.4 MB a 1080p frame, roughly 40 minutes of previews. */
export const DEFAULT_PREVIEW_LIMIT = 20 * 1024 ** 3

const KEY = /^[0-9a-f]{16}$/
const FILE = /^([0-9a-f]{16})\.jpg$/

interface Entry {
  projectId: string
  key: string
  path: string
  bytes: number
  used: number
}

export class PreviewStore {
  /** Every preview file, once looked for (null until then, or after the cache changes). */
  private index: Map<string, Entry> | null = null

  constructor(
    private readonly cache: CacheService,
    public limit = DEFAULT_PREVIEW_LIMIT
  ) {}

  private async dir(projectId: string): Promise<string> {
    return this.cache.categoryDir(projectId, 'renders')
  }

  private check(projectId: string, key: string): void {
    if (!isProjectId(projectId) || !KEY.test(key)) throw new Error('Not a preview')
  }

  /** The cache was cleared or moved: look again next time. */
  forget(): void {
    this.index = null
  }

  private async load(): Promise<Map<string, Entry>> {
    if (this.index) return this.index
    const index = new Map<string, Entry>()
    let projects: string[] = []
    try {
      projects = (await readdir(this.cache.rootPath)).filter(isProjectId)
    } catch {
      projects = []
    }
    for (const projectId of projects) {
      const dir = join(this.cache.rootPath, projectId, 'renders')
      let files: string[] = []
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      for (const name of files) {
        const match = FILE.exec(name)
        if (!match) continue
        const path = join(dir, name)
        const info = await lstat(path)
        if (!info.isFile()) continue
        index.set(path, { projectId, key: match[1]!, path, bytes: info.size, used: info.mtimeMs })
      }
    }
    this.index = index
    return index
  }

  /** The keys a project has previews for. */
  async list(projectId: string): Promise<string[]> {
    if (!isProjectId(projectId)) throw new Error('Not a project id')
    const index = await this.load()
    return [...index.values()].filter((e) => e.projectId === projectId).map((e) => e.key)
  }

  async read(projectId: string, key: string): Promise<ArrayBuffer | null> {
    this.check(projectId, key)
    const path = join(await this.dir(projectId), `${key}.jpg`)
    try {
      const data = await readFile(path)
      const now = Date.now()
      await utimes(path, now / 1000, now / 1000).catch(() => undefined)
      const entry = (await this.load()).get(path)
      if (entry) entry.used = now
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    } catch {
      return null
    }
  }

  /** Stores a frame's preview, then keeps every project within the limit. Returns what was let go of. */
  async write(projectId: string, key: string, data: ArrayBuffer): Promise<Array<{ projectId: string; key: string }>> {
    this.check(projectId, key)
    const path = join(await this.dir(projectId), `${key}.jpg`)
    await writeFile(`${path}.partial`, Buffer.from(data))
    await rename(`${path}.partial`, path)
    const index = await this.load()
    index.set(path, { projectId, key, path, bytes: data.byteLength, used: Date.now() })
    return this.enforce()
  }

  async total(): Promise<number> {
    let sum = 0
    for (const e of (await this.load()).values()) sum += e.bytes
    return sum
  }

  /** Least recently used first, down to 95% of the limit (so it isn't trimming on every write). */
  async enforce(): Promise<Array<{ projectId: string; key: string }>> {
    const index = await this.load()
    let total = 0
    for (const e of index.values()) total += e.bytes
    if (total <= this.limit) return []
    const removed: Array<{ projectId: string; key: string }> = []
    for (const e of [...index.values()].sort((a, b) => a.used - b.used)) {
      if (total <= this.limit * 0.95) break
      await this.cache.removeFile(e.path)
      index.delete(e.path)
      total -= e.bytes
      removed.push({ projectId: e.projectId, key: e.key })
    }
    return removed
  }
}
