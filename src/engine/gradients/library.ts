import { readGrd, writeGrd, type GrdEntry } from './grd'
import { gradientNotes, starterGradients, toGradient, type Gradient } from './gradient'

/**
 * The gradient library (M13): every gradient you've saved or imported, in folders, shared by
 * every project (like effect presets). Importing a .grd puts its gradients in a folder named
 * after the file, keeping the file's own folders inside it; exporting writes a folder (or
 * everything) back out as a version 5 .grd that Photoshop reads.
 *
 * These functions don't change the library they're given; they return a new one.
 */

export interface LibraryGradient {
  id: string
  /** Folder path, outermost first; [] at the top. */
  folder: string[]
  gradient: Gradient
}

export interface GradientLibrary {
  version: 1
  /** Every folder, in order (so empty folders stay). */
  folders: string[][]
  items: LibraryGradient[]
}

export type IdMaker = () => string

const key = (path: readonly string[]) => JSON.stringify(path)
const inside = (path: readonly string[], folder: readonly string[]) => folder.every((p, i) => path[i] === p) && path.length >= folder.length

export const BASICS = ['Basics']

export function starterLibrary(newId: IdMaker): GradientLibrary {
  return { version: 1, folders: [BASICS], items: starterGradients().map((gradient) => ({ id: newId(), folder: BASICS, gradient })) }
}

/** The library as stored; anything damaged is skipped. A missing library starts with the Basics. */
export function parseLibrary(raw: unknown, newId: IdMaker): GradientLibrary {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>)['items'])) return starterLibrary(newId)
  const r = raw as Record<string, unknown>
  const isPath = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === 'string' && p.length > 0)
  const items: LibraryGradient[] = []
  const ids = new Set<string>()
  for (const entry of r['items'] as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const gradient = toGradient(e['gradient'])
    if (!gradient) continue
    let id = typeof e['id'] === 'string' && e['id'] ? e['id'] : newId()
    if (ids.has(id)) id = newId()
    ids.add(id)
    items.push({ id, folder: isPath(e['folder']) ? e['folder'] : [], gradient })
  }
  const folders = withParents([...(Array.isArray(r['folders']) ? (r['folders'] as unknown[]).filter(isPath) : []), ...items.map((i) => i.folder)])
  return { version: 1, folders, items }
}

/** Folders with every parent listed before its children, each once, keeping their order. */
function withParents(paths: readonly string[][]): string[][] {
  const out: string[][] = []
  const seen = new Set<string>()
  for (const path of paths)
    for (let i = 1; i <= path.length; i++) {
      const p = path.slice(0, i)
      if (!seen.has(key(p))) {
        seen.add(key(p))
        out.push(p)
      }
    }
  return out
}

/** A folder name not already used next to it ("Kiwi", "Kiwi 2"…). */
export function freeFolderName(lib: GradientLibrary, parent: readonly string[], name: string): string {
  const taken = new Set(lib.folders.filter((f) => f.length === parent.length + 1 && inside(f, parent)).map((f) => f[f.length - 1]))
  if (!taken.has(name)) return name
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`
}

export interface ImportResult {
  library: GradientLibrary
  folder: string[]
  added: number
  /** What couldn't be read, and what can't be shown exactly (CMYK, book colours, noise). */
  warnings: string[]
}

/** A .grd file's gradients, added in a new folder named after the file (its own folders inside). */
export function importGrd(lib: GradientLibrary, fileName: string, bytes: Uint8Array, newId: IdMaker): ImportResult {
  const grd = readGrd(bytes)
  const base = fileName.replace(/\.grd$/i, '').trim() || 'Imported'
  const folder = [freeFolderName(lib, [], base)]
  const items = grd.entries.map((e): LibraryGradient => ({ id: newId(), folder: [...folder, ...e.folder], gradient: e.gradient }))
  const notes = new Map<string, number>()
  for (const item of items) for (const note of gradientNotes(item.gradient)) notes.set(note, (notes.get(note) ?? 0) + 1)
  const warnings = [...grd.warnings, ...[...notes].map(([note, n]) => `${note} (${n} gradient${n === 1 ? '' : 's'})`)]
  return {
    library: { version: 1, folders: withParents([...lib.folders, folder, ...grd.folders.map((f) => [...folder, ...f]), ...items.map((i) => i.folder)]), items: [...lib.items, ...items] },
    folder,
    added: items.length,
    warnings
  }
}

/** A folder (with its subfolders), or the whole library, as a .grd; folders inside it are kept. */
export function exportGrd(lib: GradientLibrary, folder: readonly string[] | null): Uint8Array {
  const root = folder ?? []
  const entries: GrdEntry[] = lib.items.filter((i) => inside(i.folder, root)).map((i) => ({ gradient: i.gradient, folder: i.folder.slice(root.length) }))
  const folders = lib.folders.filter((f) => f.length > root.length && inside(f, root)).map((f) => f.slice(root.length))
  return writeGrd(entries, folders)
}

export function addFolder(lib: GradientLibrary, parent: readonly string[], name: string): { library: GradientLibrary; folder: string[] } {
  const folder = [...parent, freeFolderName(lib, parent, name.trim() || 'Folder')]
  return { library: { ...lib, folders: withParents([...lib.folders, folder]) }, folder }
}

export function renameFolder(lib: GradientLibrary, folder: readonly string[], name: string): GradientLibrary {
  const clean = name.trim()
  if (!clean || folder.length === 0) return lib
  const parent = folder.slice(0, -1)
  const next = [...parent, folder[folder.length - 1] === clean ? clean : freeFolderName(lib, parent, clean)]
  const move = (path: string[]) => (inside(path, folder) ? [...next, ...path.slice(folder.length)] : path)
  return { ...lib, folders: lib.folders.map(move), items: lib.items.map((i) => ({ ...i, folder: move(i.folder) })) }
}

/** Removes a folder and everything in it. */
export function removeFolder(lib: GradientLibrary, folder: readonly string[]): GradientLibrary {
  if (folder.length === 0) return lib
  return { ...lib, folders: lib.folders.filter((f) => !inside(f, folder)), items: lib.items.filter((i) => !inside(i.folder, folder)) }
}

export function addGradient(lib: GradientLibrary, folder: readonly string[], gradient: Gradient, newId: IdMaker): { library: GradientLibrary; id: string } {
  const id = newId()
  return { library: { ...lib, folders: withParents([...lib.folders, [...folder]]), items: [...lib.items, { id, folder: [...folder], gradient }] }, id }
}

export function updateGradient(lib: GradientLibrary, id: string, change: (g: Gradient) => Gradient): GradientLibrary {
  return { ...lib, items: lib.items.map((i) => (i.id === id ? { ...i, gradient: change(i.gradient) } : i)) }
}

export function moveGradients(lib: GradientLibrary, ids: readonly string[], folder: readonly string[]): GradientLibrary {
  const set = new Set(ids)
  return { ...lib, folders: withParents([...lib.folders, [...folder]]), items: lib.items.map((i) => (set.has(i.id) ? { ...i, folder: [...folder] } : i)) }
}

export function removeGradients(lib: GradientLibrary, ids: readonly string[]): GradientLibrary {
  const set = new Set(ids)
  return { ...lib, items: lib.items.filter((i) => !set.has(i.id)) }
}

/** The gradients directly in a folder (not its subfolders). */
export function gradientsIn(lib: GradientLibrary, folder: readonly string[]): LibraryGradient[] {
  const k = key(folder)
  return lib.items.filter((i) => key(i.folder) === k)
}

/** A folder's subfolders, one level down. */
export function subfolders(lib: GradientLibrary, folder: readonly string[]): string[][] {
  return lib.folders.filter((f) => f.length === folder.length + 1 && inside(f, folder))
}

/** How many gradients are in a folder and below. */
export function countIn(lib: GradientLibrary, folder: readonly string[]): number {
  return lib.items.filter((i) => inside(i.folder, folder)).length
}
