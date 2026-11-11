import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { AUDIO_EXTENSIONS, displayNameFromPath, IMAGE_EXTENSIONS, IMPORT_EXTENSIONS, type MediaFingerprint } from '../../engine/project/media'
import type { FileStatus, FolderEntry, FolderListing, ProbeResult } from '../../shared/media-types'
import { runTool } from './ffmpeg'
import { parsePackets, parseProbe } from './probe-parse'

/** Reading media files: probing, fingerprints, folder scans and online checks. Never writes. */

const SAMPLE_BYTES = 1024 * 1024
const PACKET_SCAN_SECONDS = 10

export type { ProbedFile, ProbeResult } from '../../shared/media-types'

/** Size, modification time and a hash of the first and last MiB: cheap, and enough to recognise a file. */
export async function fingerprintFile(path: string): Promise<MediaFingerprint> {
  const info = await stat(path)
  const hash = createHash('sha1')
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, info.size))
    await handle.read(head, 0, head.length, 0)
    hash.update(head)
    if (info.size > SAMPLE_BYTES * 2) {
      const tail = Buffer.alloc(SAMPLE_BYTES)
      await handle.read(tail, 0, SAMPLE_BYTES, info.size - SAMPLE_BYTES)
      hash.update(tail)
    }
  } finally {
    await handle.close()
  }
  hash.update(String(info.size))
  return { size: info.size, mtimeMs: Math.round(info.mtimeMs), sample: hash.digest('hex').slice(0, 16) }
}

export async function probeFile(path: string): Promise<ProbeResult> {
  try {
    const formatRun = await runTool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
    if (formatRun.code !== 0) return { ok: false, path, error: formatRun.stderr.trim().split('\n').pop() || "FFmpeg couldn't read this file" }
    const json = JSON.parse(formatRun.stdout.toString('utf8')) as unknown
    const packetsRun = await runTool('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-read_intervals', `%+${PACKET_SCAN_SECONDS}`,
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path
    ])
    const packets = packetsRun.code === 0 ? parsePackets(packetsRun.stdout.toString('utf8')) : []
    const { kind, info } = parseProbe(json, path, packets, PACKET_SCAN_SECONDS)
    const fingerprint = await fingerprintFile(path)
    return { ok: true, file: { path, name: displayNameFromPath(path), kind, info, fingerprint } }
  } catch (error) {
    return { ok: false, path, error: (error as Error).message }
  }
}

/** Probes several files, a few at a time. */
export async function probeFiles(paths: string[], concurrency = 4): Promise<ProbeResult[]> {
  const results: ProbeResult[] = new Array(paths.length)
  let next = 0
  const worker = async () => {
    while (next < paths.length) {
      const index = next++
      results[index] = await probeFile(paths[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker))
  return results
}

function isImportable(path: string): boolean {
  return (IMPORT_EXTENSIONS as readonly string[]).includes(extname(path).slice(1).toLowerCase())
}

function kindOf(name: string): FolderEntry['kind'] | null {
  const extension = extname(name).slice(1).toLowerCase()
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(extension)) return 'audio'
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return 'image'
  return (IMPORT_EXTENSIONS as readonly string[]).includes(extension) ? 'video' : null
}

/**
 * One folder's subfolders and media files, for the media panel's folder browser. Only reads:
 * nothing is copied or changed. Hidden files are skipped; other files are counted, not listed.
 */
export async function listFolder(folder: string, limit = 2000): Promise<FolderListing> {
  if (!isAbsolute(folder)) throw new Error('The folder path must be absolute')
  const entries = await readdir(folder, { withFileTypes: true })
  const listed: FolderEntry[] = []
  let other = 0
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(folder, entry.name)
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      const target = await stat(path).catch(() => null)
      isDirectory = target?.isDirectory() ?? false
      isFile = target?.isFile() ?? false
    }
    if (isDirectory) {
      listed.push({ name: entry.name, path, kind: 'folder', size: 0, modified: 0 })
      continue
    }
    const kind = isFile ? kindOf(entry.name) : null
    if (!kind) {
      other++
      continue
    }
    if (listed.length >= limit) continue
    const info = await stat(path).catch(() => null)
    listed.push({ name: entry.name, path, kind, size: info?.size ?? 0, modified: info?.mtimeMs ?? 0 })
  }
  listed.sort((a, b) => (a.kind === 'folder') !== (b.kind === 'folder') ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }))
  const parent = dirname(folder)
  return { path: folder, parent: parent === folder ? null : parent, entries: listed.slice(0, limit), other }
}

/** Media files inside a folder (recursively, hidden files skipped), capped to keep imports sane. */
export async function findMediaInFolder(folder: string, limit = 1000): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && isImportable(full)) found.push(full)
    }
  }
  await walk(folder)
  return found
}

/** Splits dropped or chosen paths into loose files and folders to import as bins. */
export async function classifyImportPaths(paths: string[]): Promise<{ files: string[]; folders: Array<{ name: string; files: string[] }> }> {
  const files: string[] = []
  const folders: Array<{ name: string; files: string[] }> = []
  for (const path of paths) {
    try {
      const info = await stat(path)
      if (info.isDirectory()) folders.push({ name: basename(path), files: await findMediaInFolder(path) })
      else if (isImportable(path)) files.push(path)
    } catch {
      // vanished between choosing and importing
    }
  }
  return { files, folders }
}

export async function checkFile(path: string, fingerprint: MediaFingerprint): Promise<FileStatus> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return 'offline'
    return info.size === fingerprint.size ? 'online' : 'changed'
  } catch {
    return 'offline'
  }
}

/** Looks for moved files by name and size under `folder`. */
export async function searchForMoved(folder: string, wanted: Array<{ id: string; fileName: string; size: number }>): Promise<Array<{ id: string; path: string }>> {
  const candidates = await findMediaInFolder(folder, 20_000)
  const byName = new Map<string, string[]>()
  for (const path of candidates) {
    const key = basename(path).toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), path])
  }
  const matches: Array<{ id: string; path: string }> = []
  for (const item of wanted) {
    for (const path of byName.get(item.fileName.toLowerCase()) ?? []) {
      try {
        if ((await stat(path)).size === item.size) {
          matches.push({ id: item.id, path })
          break
        }
      } catch {
        // skip
      }
    }
  }
  return matches
}
