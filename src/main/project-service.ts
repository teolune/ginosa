import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { JournalEntry, OpenedProject, RecentProject, RecoveryInfo } from '@shared/ipc'
import { PROJECT_EXTENSION } from '@shared/ipc'

/**
 * Project files on disk. A project is a folder `<Name>.ginosa/` containing:
 *   project.json     the saved project
 *   autosave/        rotating snapshots (newest 20 kept)
 *   journal.jsonl    every change since the last save or autosave
 *   session.lock     present while the project is open; left behind by a crash
 *
 * All writes are atomic (temp file + rename) and run one at a time in order, so
 * a crash can never leave a half-written project.json.
 */

const PROJECT_FILE = 'project.json'
const AUTOSAVE_DIR = 'autosave'
const JOURNAL_FILE = 'journal.jsonl'
const LOCK_FILE = 'session.lock'
const AUTOSAVE_KEEP = 20

export class ProjectError extends Error {}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, contents, 'utf8')
  await rename(temp, path)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function projectNameFromPath(path: string): string {
  return basename(path).replace(new RegExp(`${PROJECT_EXTENSION.replace('.', '\\.')}$`), '')
}

/** Normalises a dialog result: adds the extension, accepts project.json inside a project. */
export function normaliseProjectPath(path: string): string {
  if (basename(path) === PROJECT_FILE) return dirname(path)
  return path.endsWith(PROJECT_EXTENSION) ? path : `${path}${PROJECT_EXTENSION}`
}

export class ProjectService {
  private currentPath: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  get path(): string | null {
    return this.currentPath
  }

  /** Runs file operations strictly in the order they were requested. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  async create(path: string, json: string): Promise<void> {
    return this.enqueue(async () => {
      if (await exists(path)) {
        if (!(await exists(join(path, PROJECT_FILE)))) {
          throw new ProjectError(`"${basename(path)}" already exists and is not a ginosa project. Choose another name.`)
        }
      }
      await this.releaseLock()
      await mkdir(join(path, AUTOSAVE_DIR), { recursive: true })
      await writeAtomic(join(path, PROJECT_FILE), json)
      await writeFile(join(path, JOURNAL_FILE), '')
      this.currentPath = path
      await this.takeLock()
    })
  }

  async open(path: string): Promise<OpenedProject> {
    return this.enqueue(async () => {
      const projectFile = join(path, PROJECT_FILE)
      if (!(await exists(projectFile))) throw new ProjectError(`No project.json in "${path}". Is this a ginosa project?`)
      const json = await readFile(projectFile, 'utf8')
      const recovery = await this.findRecovery(path)
      await this.releaseLock()
      this.currentPath = path
      await mkdir(join(path, AUTOSAVE_DIR), { recursive: true })
      await this.takeLock()
      return { path, json, recovery }
    })
  }

  async save(json: string): Promise<void> {
    return this.enqueue(async () => {
      const path = this.requirePath()
      await writeAtomic(join(path, PROJECT_FILE), json)
      await writeFile(join(path, JOURNAL_FILE), '')
    })
  }

  /** Writes the project into a new folder and switches to it. */
  async saveAs(path: string, json: string): Promise<void> {
    if (path === this.currentPath) return this.save(json)
    return this.enqueue(async () => {
      if ((await exists(path)) && !(await exists(join(path, PROJECT_FILE)))) {
        throw new ProjectError(`"${basename(path)}" already exists and is not a ginosa project. Choose another name.`)
      }
      await mkdir(join(path, AUTOSAVE_DIR), { recursive: true })
      await writeAtomic(join(path, PROJECT_FILE), json)
      await writeFile(join(path, JOURNAL_FILE), '')
      await this.releaseLock()
      this.currentPath = path
      await this.takeLock()
    })
  }

  async autosave(json: string): Promise<void> {
    return this.enqueue(async () => {
      const path = this.requirePath()
      const dir = join(path, AUTOSAVE_DIR)
      await mkdir(dir, { recursive: true })
      const stampText = new Date().toISOString().replace(/[:.]/g, '-')
      await writeAtomic(join(dir, `autosave-${stampText}.json`), json)
      await writeFile(join(path, JOURNAL_FILE), '')
      const files = (await readdir(dir)).filter((f) => f.startsWith('autosave-') && f.endsWith('.json')).sort()
      for (const old of files.slice(0, Math.max(0, files.length - AUTOSAVE_KEEP))) {
        // Only ever deletes old autosave snapshots inside this project's autosave folder.
        await rm(join(dir, old), { force: true })
      }
    })
  }

  /** Clean Up Finished Project and Autosaves (decision 60): this project's autosave snapshots, and nothing else. */
  deleteAutosaves(): Promise<number> {
    return this.enqueue(async () => {
      const dir = join(this.requirePath(), AUTOSAVE_DIR)
      let files: string[] = []
      try {
        files = (await readdir(dir)).filter((f) => /^autosave-[0-9TZ-]+\.json$/.test(f))
      } catch {
        return 0
      }
      // Only ever deletes autosave snapshots inside this project's autosave folder.
      for (const file of files) await rm(join(dir, file), { force: true })
      return files.length
    })
  }

  appendJournal(entry: JournalEntry): Promise<void> {
    return this.enqueue(async () => {
      if (!this.currentPath) return
      await appendFile(join(this.currentPath, JOURNAL_FILE), `${JSON.stringify(entry)}\n`, 'utf8')
    })
  }

  /** The user chose not to restore: clear the journal so the offer isn't repeated. */
  async discardRecovery(): Promise<void> {
    return this.enqueue(async () => {
      if (this.currentPath) await writeFile(join(this.currentPath, JOURNAL_FILE), '')
    })
  }

  /** Closing deliberately (saved or "Don't Save"): unsaved journal entries are discarded. */
  async close(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.currentPath) return
      await writeFile(join(this.currentPath, JOURNAL_FILE), '').catch(() => undefined)
      await this.releaseLock()
      this.currentPath = null
    })
  }

  /**
   * Snapshot tests only: forget the open project as if the app had crashed,
   * leaving its journal and a lock from a process that no longer exists.
   */
  async simulateCrash(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.currentPath) return
      await writeFile(join(this.currentPath, LOCK_FILE), JSON.stringify({ pid: 999_999, openedAt: new Date().toISOString() }))
      this.currentPath = null
    })
  }

  private requirePath(): string {
    if (!this.currentPath) throw new ProjectError('No project is open')
    return this.currentPath
  }

  private async takeLock(): Promise<void> {
    const path = this.requirePath()
    await writeFile(join(path, LOCK_FILE), JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() }))
  }

  private async releaseLock(): Promise<void> {
    if (!this.currentPath) return
    await rm(join(this.currentPath, LOCK_FILE), { force: true })
  }

  /**
   * After a crash the lock file is still there and its process is gone. The newest
   * snapshot (project.json or an autosave) plus the journal rebuilds the last state.
   */
  private async findRecovery(path: string): Promise<RecoveryInfo | null> {
    const lockPath = join(path, LOCK_FILE)
    if (!(await exists(lockPath))) return null
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number }
      if (typeof lock.pid === 'number' && lock.pid !== process.pid && isProcessAlive(lock.pid)) {
        throw new ProjectError('This project is already open in another ginosa window.')
      }
    } catch (error) {
      if (error instanceof ProjectError) throw error
    }

    const projectFile = join(path, PROJECT_FILE)
    let baseJson = await readFile(projectFile, 'utf8')
    let baseTime = (await stat(projectFile)).mtime
    const autosaveDir = join(path, AUTOSAVE_DIR)
    if (await exists(autosaveDir)) {
      const newest = (await readdir(autosaveDir)).filter((f) => f.startsWith('autosave-') && f.endsWith('.json')).sort().at(-1)
      if (newest) {
        const autosavePath = join(autosaveDir, newest)
        const autosaveTime = (await stat(autosavePath)).mtime
        if (autosaveTime > baseTime) {
          baseJson = await readFile(autosavePath, 'utf8')
          baseTime = autosaveTime
        }
      }
    }

    const journal: unknown[][] = []
    let lastChangeAt: string | null = null
    const journalPath = join(path, JOURNAL_FILE)
    if (await exists(journalPath)) {
      const lines = (await readFile(journalPath, 'utf8')).split('\n').filter((line) => line.trim().length > 0)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as JournalEntry
          if (Array.isArray(entry.patches)) {
            journal.push(entry.patches)
            lastChangeAt = entry.at
          }
        } catch {
          // A line cut off by the crash: everything before it is still valid.
          break
        }
      }
    }

    const projectTime = (await stat(projectFile)).mtime
    if (journal.length === 0 && baseTime <= projectTime) return null
    return { baseJson, baseSavedAt: baseTime.toISOString(), journal, lastChangeAt }
  }
}

/** True when a session lock was left behind by a process that no longer exists. */
async function wasInterrupted(path: string): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(join(path, LOCK_FILE), 'utf8')) as { pid?: number }
    return typeof lock.pid === 'number' && lock.pid !== process.pid && !isProcessAlive(lock.pid)
  } catch {
    return false
  }
}

/** A project's createdAt, read from the start of its project file (it sits near the top), or null. */
export async function readCreatedAt(projectPath: string): Promise<string | null> {
  try {
    const handle = await open(join(projectPath, PROJECT_FILE), 'r')
    try {
      const buffer = Buffer.alloc(16_384)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const match = /"createdAt"\s*:\s*"([^"]{10,40})"/.exec(buffer.subarray(0, bytesRead).toString('utf8'))
      return match && !Number.isNaN(Date.parse(match[1]!)) ? match[1]! : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/** Recently opened projects, kept in the app's own settings folder. */
export class RecentProjects {
  constructor(private readonly file: string) {}

  async list(): Promise<RecentProject[]> {
    try {
      const items = JSON.parse(await readFile(this.file, 'utf8')) as RecentProject[]
      const present: RecentProject[] = []
      for (const item of items) {
        if (!(await exists(join(item.path, PROJECT_FILE)))) continue
        const createdAt = item.createdAt ?? (await readCreatedAt(item.path))
        present.push({ name: item.name, path: item.path, openedAt: item.openedAt, ...(createdAt ? { createdAt } : {}), interrupted: await wasInterrupted(item.path) })
      }
      return present
    } catch {
      return []
    }
  }

  async add(path: string): Promise<RecentProject[]> {
    const items = (await this.list()).filter((item) => item.path !== path)
    const createdAt = await readCreatedAt(path)
    items.unshift({ name: projectNameFromPath(path), path, openedAt: new Date().toISOString(), ...(createdAt ? { createdAt } : {}), interrupted: false })
    const trimmed = items.slice(0, 12)
    await mkdir(dirname(this.file), { recursive: true })
    await writeAtomic(this.file, JSON.stringify(trimmed, null, 2))
    return trimmed
  }
}
