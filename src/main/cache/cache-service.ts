import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/**
 * Everything ginosa generates lives under one cache root, kept apart from your media:
 *
 *   <root>/<project id>/thumbnails | waveforms | optimised | proxies | renders | analysis | bakes
 *
 * Deletion is only possible through `remove()`, which refuses any path that isn't a
 * project folder or category folder inside the root. Originals can't be reached.
 */

import { CACHE_CATEGORIES, type CacheCategory, type CacheProjectUsage } from '../../shared/media-types'

export { CACHE_CATEGORIES, type CacheCategory, type CacheProjectUsage }

export const CACHE_FOLDER_NAME = 'ginosa Cache'
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface IndexEntry {
  name: string
  path: string
  lastUsed: string
}

export class CacheGuardError extends Error {}

export function isProjectId(value: string): boolean {
  return PROJECT_ID.test(value)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Total size of a folder; symbolic links are counted as links, never followed. */
async function folderSize(path: string): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return 0
  }
  for (const name of entries) {
    const full = join(path, name)
    const info = await lstat(full)
    if (info.isDirectory()) total += await folderSize(full)
    else total += info.size
  }
  return total
}

export class CacheService {
  constructor(private root: string) {}

  get rootPath(): string {
    return this.root
  }

  /** Switches to `<parent>/ginosa Cache`. The old cache stays where it was. */
  setParentFolder(parent: string): string {
    this.root = join(parent, CACHE_FOLDER_NAME)
    return this.root
  }

  projectDir(projectId: string): string {
    if (!isProjectId(projectId)) throw new CacheGuardError(`Not a project id: ${projectId}`)
    return join(this.root, projectId)
  }

  async categoryDir(projectId: string, category: CacheCategory): Promise<string> {
    const dir = join(this.projectDir(projectId), category)
    await mkdir(dir, { recursive: true })
    return dir
  }

  private get indexPath(): string {
    return join(this.root, 'index.json')
  }

  private async readIndex(): Promise<Record<string, IndexEntry>> {
    try {
      return JSON.parse(await readFile(this.indexPath, 'utf8')) as Record<string, IndexEntry>
    } catch {
      return {}
    }
  }

  /** Remembers which project a cache folder belongs to, for the Cache Manager. */
  async registerProject(projectId: string, name: string, projectPath: string): Promise<void> {
    if (!isProjectId(projectId)) return
    await mkdir(this.root, { recursive: true })
    const index = await this.readIndex()
    index[projectId] = { name, path: projectPath, lastUsed: new Date().toISOString() }
    const temp = `${this.indexPath}.tmp-${process.pid}`
    await writeFile(temp, JSON.stringify(index, null, 2))
    await rename(temp, this.indexPath)
  }

  async usage(): Promise<CacheProjectUsage[]> {
    const index = await this.readIndex()
    let folders: string[] = []
    try {
      folders = (await readdir(this.root)).filter(isProjectId)
    } catch {
      return []
    }
    const result: CacheProjectUsage[] = []
    for (const projectId of folders) {
      const bytes = {} as Record<CacheCategory, number>
      let total = 0
      for (const category of CACHE_CATEGORIES) {
        bytes[category] = await folderSize(join(this.root, projectId, category))
        total += bytes[category]
      }
      const entry = index[projectId]
      result.push({
        projectId,
        name: entry?.name ?? 'Unknown project',
        projectPath: entry?.path ?? null,
        projectExists: entry ? await exists(join(entry.path, 'project.json')) : false,
        lastUsed: entry?.lastUsed ?? null,
        bytes,
        total
      })
    }
    return result.sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''))
  }

  /**
   * Deletes one category of one project's cache, or that project's whole cache
   * folder. The only delete operation in the cache system.
   */
  async remove(projectId: string, category: CacheCategory | 'all'): Promise<void> {
    if (!isProjectId(projectId)) throw new CacheGuardError(`Refusing to delete: "${projectId}" is not a project id`)
    if (category !== 'all' && !(CACHE_CATEGORIES as readonly string[]).includes(category)) {
      throw new CacheGuardError(`Refusing to delete unknown cache category "${String(category)}"`)
    }
    const target = category === 'all' ? join(this.root, projectId) : join(this.root, projectId, category)
    await this.assertInsideRoot(target)
    await rm(target, { recursive: true, force: true })
  }

  /** Deletes a single generated file (e.g. a failed partial copy) inside a category folder. */
  async removeFile(path: string): Promise<void> {
    await this.assertInsideRoot(path)
    const parts = relative(this.root, path).split(sep)
    if (parts.length < 3 || !isProjectId(parts[0] ?? '') || !(CACHE_CATEGORIES as readonly string[]).includes(parts[1] ?? '')) {
      throw new CacheGuardError(`Refusing to delete "${path}": not a generated cache file`)
    }
    await rm(path, { force: true })
  }

  private async assertInsideRoot(target: string): Promise<void> {
    if (!isAbsolute(target)) throw new CacheGuardError('Refusing to delete a relative path')
    let realRoot: string
    try {
      realRoot = await realpath(this.root)
    } catch {
      throw new CacheGuardError('The cache folder does not exist')
    }
    // Resolve the parent (the target itself may not exist yet, or may be a link).
    let realParent: string
    try {
      realParent = await realpath(dirname(target))
    } catch {
      return // nothing there to delete
    }
    const realTarget = join(realParent, target.split(sep).pop() ?? '')
    const rel = relative(realRoot, realTarget)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new CacheGuardError(`Refusing to delete "${target}": it is not inside the cache folder ${realRoot}`)
    }
    // The cache never creates links; one where a folder should be is refused outright.
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new CacheGuardError(`Refusing to delete "${target}": it is a link`)
    } catch (error) {
      if (error instanceof CacheGuardError) throw error
    }
  }
}
