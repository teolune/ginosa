import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { FolderEntry, FolderListing } from '@shared/media-types'
import { Icon } from '../app/Icon'
import { mediaController } from '../state/media-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'

const FOLDER_KEY = 'ginosa.folder-browser'

function recallFolder(): string | null {
  try {
    return localStorage.getItem(FOLDER_KEY)
  } catch {
    return null
  }
}

function rememberFolder(path: string): void {
  try {
    localStorage.setItem(FOLDER_KEY, path)
  } catch {
    // Nothing to remember it in.
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} B`
}

/** The last few parts of a path, each one clickable. */
function crumbs(path: string): Array<{ name: string; path: string }> {
  const parts = path.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join('/')}` })).slice(-3)
}

const ICONS: Record<FolderEntry['kind'], { name: 'folder' | 'musicNote' | 'play' | 'landscape'; fallback: string }> = {
  folder: { name: 'folder', fallback: '▸' },
  video: { name: 'play', fallback: '▶' },
  audio: { name: 'musicNote', fallback: '♪' },
  image: { name: 'landscape', fallback: '▭' }
}

/**
 * Open Folder / Browse Folder (the wireframe's media column): look through a folder on disk
 * and import from it. It only reads the folder; imported files stay where they are.
 */
export function FolderBrowser() {
  useObservable(projectController)
  const [folder, setFolder] = useState<string | null>(recallFolder)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!folder) return
    let live = true
    window.ginosa.media
      .listFolder(folder)
      .then((result) => {
        if (!live) return
        setListing(result)
        setError(null)
      })
      .catch((e: Error) => {
        if (!live) return
        setListing(null)
        setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      })
    return () => {
      live = false
    }
  }, [folder, reload])

  const inProject = useMemo(() => new Set(projectController.project?.media.map((m) => m.path) ?? []), [projectController.project?.media])

  const go = (path: string) => {
    setFolder(path)
    setSelected([])
    setAnchor(null)
    rememberFolder(path)
  }
  const openFolder = async () => {
    const chosen = await window.ginosa.media.chooseFolder()
    if (chosen) go(chosen)
  }
  const importPaths = (paths: string[]) => {
    if (paths.length) void mediaController.importPaths(paths, mediaController.targetBinId)
  }

  const entries = listing?.entries ?? []
  const files = entries.filter((e) => e.kind !== 'folder')
  const select = (entry: FolderEntry, event: ReactMouseEvent) => {
    if (event.shiftKey && anchor) {
      const from = entries.findIndex((e) => e.path === anchor)
      const to = entries.findIndex((e) => e.path === entry.path)
      const [a, b] = from < to ? [from, to] : [to, from]
      setSelected(entries.slice(a, b + 1).map((e) => e.path))
      return
    }
    if (event.metaKey) setSelected((s) => (s.includes(entry.path) ? s.filter((p) => p !== entry.path) : [...s, entry.path]))
    else setSelected([entry.path])
    setAnchor(entry.path)
  }

  return (
    <div className="folder-browser">
      <div className="folder-bar">
        <button className="button compact" title="Choose a folder to browse" onClick={() => void openFolder()}>
          Open Folder…
        </button>
        <button className="icon-button" title="Up one folder" aria-label="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)}>
          <Icon name="upFolder" fallback="↑" />
        </button>
        <span className="folder-crumbs" title={folder ?? undefined}>
          {folder &&
            crumbs(folder).map((c, i, all) => (
              <span key={c.path}>
                <button className="crumb" onClick={() => go(c.path)}>
                  {c.name}
                </button>
                {i < all.length - 1 && <span className="muted"> / </span>}
              </span>
            ))}
        </span>
      </div>
      <div
        className="folder-list"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && selected.length) {
            event.preventDefault()
            const only = entries.find((e) => e.path === selected[0])
            if (selected.length === 1 && only?.kind === 'folder') go(only.path)
            else importPaths(selected)
          }
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelected([])
        }}
      >
        {!folder && (
          <div className="empty-state">
            <p>Browse a folder of footage and music.</p>
            <p className="muted small">Open Folder, then double-click a file (or select several and Import) to bring it in. Double-click a folder to go into it. Nothing in the folder is moved or changed.</p>
          </div>
        )}
        {error && <p className="error-text small pad">Couldn't read that folder: {error}</p>}
        {listing && entries.length === 0 && <p className="muted small pad">No media or folders here{listing.other ? ` (${listing.other} other files)` : ''}.</p>}
        {entries.map((entry) => (
          <div
            key={entry.path}
            className={`folder-row ${selected.includes(entry.path) ? 'selected' : ''}`}
            title={entry.path}
            onClick={(event) => select(entry, event)}
            onDoubleClick={() => (entry.kind === 'folder' ? go(entry.path) : importPaths([entry.path]))}
          >
            <span className={`folder-kind ${entry.kind}`}>
              <Icon name={ICONS[entry.kind].name} fallback={ICONS[entry.kind].fallback} />
            </span>
            <span className="item-name">{entry.name}</span>
            {inProject.has(entry.path) && <span className="status-pill ok">In project</span>}
            <span className="mono muted small">{entry.kind === 'folder' ? '' : formatBytes(entry.size)}</span>
          </div>
        ))}
      </div>
      {listing && (
        <footer className="folder-foot">
          <span className="muted small">
            {files.length} media · {entries.length - files.length} folders{listing.other ? ` · ${listing.other} other` : ''}
          </span>
          <span className="spacer" />
          <button className="icon-button" title="Read the folder again" aria-label="Refresh" onClick={() => setReload((n) => n + 1)}>
            ⟳
          </button>
          <button className="button compact" disabled={!folder} title="Import every media file in this folder and its subfolders into a bin named after it" onClick={() => folder && importPaths([folder])}>
            Import Folder
          </button>
          <button className="button compact primary" disabled={selected.length === 0} onClick={() => importPaths(selected)}>
            Import{selected.length > 1 ? ` ${selected.length}` : ''}
          </button>
        </footer>
      )}
    </div>
  )
}
