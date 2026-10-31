import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { deleteBin, moveToBin, removeMedia, renameBin, renameMedia } from '@engine/project/media-commands'
import { OPTIMISE_REASON_TEXT, type Bin, type MediaItem } from '@engine/project/media'
import { CommitInput } from '../app/CommitInput'
import { Icon } from '../app/Icon'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { mediaController, type MediaRuntime } from '../state/media-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { formatCodec, formatDuration, formatFps, formatSize } from './format'

const DRAG_TYPE = 'application/x-ginosa-items'
const binKey = (id: string) => `bin:${id}`

type Row = { type: 'bin'; bin: Bin; depth: number; count: number } | { type: 'media'; item: MediaItem; depth: number; path?: string }

function buildRows(bins: Bin[], media: MediaItem[], expanded: Set<string>, query: string): Row[] {
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true })
  if (query.trim()) {
    const q = query.trim().toLowerCase()
    const binPath = (id: string | null): string => {
      const parts: string[] = []
      let current = id
      while (current) {
        const bin = bins.find((b) => b.id === current)
        if (!bin) break
        parts.unshift(bin.name)
        current = bin.parentId
      }
      return parts.join(' / ')
    }
    return media
      .filter((m) => m.name.toLowerCase().includes(q) || m.path.toLowerCase().includes(q))
      .sort(byName)
      .map((item) => ({ type: 'media', item, depth: 0, path: binPath(item.binId) }))
  }
  const rows: Row[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const bin of bins.filter((b) => b.parentId === parentId).sort(byName)) {
      const count = media.filter((m) => m.binId === bin.id).length + bins.filter((b) => b.parentId === bin.id).length
      rows.push({ type: 'bin', bin, depth, count })
      if (expanded.has(bin.id)) walk(bin.id, depth + 1)
    }
    for (const item of media.filter((m) => m.binId === parentId).sort(byName)) rows.push({ type: 'media', item, depth })
  }
  walk(null, 0)
  return rows
}

function Status({ item, runtime }: { item: MediaItem; runtime: MediaRuntime }) {
  const job = runtime.job
  if (runtime.status === 'offline') {
    return (
      <button className="status-pill bad" title="The file has moved or been deleted. Click to locate it." onClick={() => void mediaController.relink(item.id)}>
        Offline
      </button>
    )
  }
  if (runtime.status === 'changed') return <span className="status-pill warn" title="The file on disk has changed size since it was imported">Changed</span>
  if (job?.status === 'running') {
    return (
      <span className="status-progress" title={`Making an optimised copy: ${job.reasons.map((r) => OPTIMISE_REASON_TEXT[r]).join('; ')}`}>
        <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
        <em>Optimising {Math.round(job.progress * 100)}%</em>
      </span>
    )
  }
  if (job?.status === 'queued') return <span className="status-pill muted">Waiting…</span>
  if (job?.status === 'failed') return <span className="status-pill bad" title={job.error ?? ''}>Copy failed</span>
  if (runtime.optimisedPath) {
    const reasons = (runtime.required.length ? runtime.required : runtime.suggested).map((r) => OPTIMISE_REASON_TEXT[r]).join('; ')
    return <span className="status-pill ok" title={`Playing from an optimised copy. ${reasons}`}>Optimised</span>
  }
  if (runtime.required.length) return <span className="status-pill warn" title={runtime.required.map((r) => OPTIMISE_REASON_TEXT[r]).join('; ')}>Needs copy</span>
  if (runtime.suggested.length) return <span className="status-pill muted" title={`${OPTIMISE_REASON_TEXT['long-gop']}. Right-click → Create Optimised Copy.`}>Slow scrub</span>
  if (item.kind === 'video' && runtime.decodable === null && runtime.status === 'checking') return <span className="status-pill muted">Checking…</span>
  return null
}

function Thumb({ item, runtime }: { item: MediaItem; runtime: MediaRuntime }) {
  useEffect(() => {
    mediaController.requestThumbnail(item)
  }, [item, runtime.status])
  if (item.kind === 'audio') return <span className="thumb audio"><Icon name="musicNote" fallback="♪" /></span>
  return runtime.thumbnailUrl ? <img className="thumb" src={runtime.thumbnailUrl} alt="" draggable={false} /> : <span className="thumb" />
}

/** The project's media library, Premiere-style: bins, columns, drag to organise, Finder drops to import. */
export function MediaPanel() {
  useObservable(projectController)
  useObservable(mediaController)
  const project = projectController.project
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [width, setWidth] = useState(400)
  const panelRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const element = panelRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // New Bin (menu): open its parent and start renaming it.
  useEffect(() => {
    const id = mediaController.renameRequest
    if (!id || !project) return
    mediaController.renameRequest = null
    const parent = project.bins.find((b) => b.id === id)?.parentId
    if (parent) setExpanded((e) => new Set(e).add(parent))
    setSelected([binKey(id)])
    setRenaming(binKey(id))
  })

  const rows = useMemo(() => (project ? buildRows(project.bins, project.media, expanded, query) : []), [project, expanded, query])
  const keys = rows.map((r) => (r.type === 'bin' ? binKey(r.bin.id) : r.item.id))

  // Import goes into the selected bin (or the selected clip's bin).
  useEffect(() => {
    if (!project || selected.length !== 1) {
      mediaController.targetBinId = null
      return
    }
    const key = selected[0]!
    mediaController.targetBinId = key.startsWith('bin:') ? key.slice(4) : (project.media.find((m) => m.id === key)?.binId ?? null)
  }, [selected, project])

  if (!project) return null
  const showColumns = { duration: width > 330, size: width > 470, fps: width > 560, codec: width > 640 }
  const columns = ['minmax(120px, 1fr)', showColumns.duration && '96px', showColumns.size && '84px', showColumns.fps && '58px', showColumns.codec && '96px', '104px']
    .filter(Boolean)
    .join(' ')

  const select = (key: string, event: ReactMouseEvent) => {
    if (event.metaKey) {
      setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]))
      setAnchor(key)
    } else if (event.shiftKey && anchor) {
      const a = keys.indexOf(anchor)
      const b = keys.indexOf(key)
      setSelected(keys.slice(Math.min(a, b), Math.max(a, b) + 1))
    } else {
      setSelected([key])
      setAnchor(key)
    }
  }

  const selection = () => ({
    media: selected.filter((k) => !k.startsWith('bin:')),
    bins: selected.filter((k) => k.startsWith('bin:')).map((k) => k.slice(4))
  })

  const removeSelected = () => {
    const { media, bins } = selection()
    if (media.length) projectController.dispatch(removeMedia(media))
    for (const bin of bins) projectController.dispatch(deleteBin(bin))
    setSelected([])
  }

  const toggle = (binId: string) =>
    setExpanded((e) => {
      const next = new Set(e)
      if (next.has(binId)) next.delete(binId)
      else next.add(binId)
      return next
    })

  // ---- Drag and drop ----------------------------------------------------------
  const onDragStart = (key: string) => (event: DragEvent) => {
    const keysToMove = selected.includes(key) ? selected : [key]
    if (!selected.includes(key)) setSelected([key])
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(keysToMove))
    event.dataTransfer.effectAllowed = 'move'
  }

  const acceptsDrop = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE) || event.dataTransfer.types.includes('Files')

  const onDrop = (binId: string | null) => (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)
    if (event.dataTransfer.types.includes(DRAG_TYPE)) {
      const dragged = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as string[]
      const mediaIds = dragged.filter((k) => !k.startsWith('bin:'))
      const binIds = dragged.filter((k) => k.startsWith('bin:')).map((k) => k.slice(4))
      if (binId) setExpanded((e) => new Set(e).add(binId))
      projectController.dispatch(moveToBin(mediaIds, binIds, binId))
      return
    }
    const paths = [...event.dataTransfer.files].map((file) => window.ginosa.media.pathForFile(file)).filter(Boolean)
    if (paths.length) void mediaController.importPaths(paths, binId)
  }

  const dropProps = (binId: string | null) => ({
    onDragOver: (event: DragEvent) => {
      if (!acceptsDrop(event)) return
      event.preventDefault()
      event.stopPropagation()
      setDropTarget(binId ?? 'root')
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: onDrop(binId)
  })

  // ---- Context menus ---------------------------------------------------------------
  const openMenu = (event: ReactMouseEvent, row: Row | null) => {
    event.preventDefault()
    let entries: MenuEntry[]
    if (!row) {
      entries = [
        { label: 'Import…', onSelect: () => void mediaController.chooseAndImport(null) },
        { label: 'New Bin', onSelect: () => mediaController.newBin() }
      ]
    } else if (row.type === 'bin') {
      const key = binKey(row.bin.id)
      if (!selected.includes(key)) setSelected([key])
      entries = [
        { label: 'Import into Bin…', onSelect: () => void mediaController.chooseAndImport(row.bin.id) },
        {
          label: 'New Bin Inside',
          onSelect: () => {
            mediaController.targetBinId = row.bin.id
            mediaController.newBin()
          }
        },
        { label: 'Rename', onSelect: () => setRenaming(key) },
        'separator',
        { label: 'Delete Bin and Its Contents', danger: true, onSelect: () => projectController.dispatch(deleteBin(row.bin.id)) }
      ]
    } else {
      const item = row.item
      if (!selected.includes(item.id)) setSelected([item.id])
      const runtime = mediaController.get(item.id)
      const canCopy = item.kind === 'video' && !runtime.optimisedPath && runtime.job?.status !== 'running' && runtime.status !== 'offline'
      entries = [
        { label: 'Open in Source Monitor', onSelect: () => openSource(item.id) },
        { label: 'Rename', onSelect: () => setRenaming(item.id) },
        { label: 'Reveal in Finder', disabled: runtime.status === 'offline', onSelect: () => void window.ginosa.media.reveal(item.path) },
        'separator',
        { label: 'Create Optimised Copy', disabled: !canCopy, onSelect: () => void mediaController.optimise(item.id, runtime.required.length ? runtime.required : ['long-gop']) },
        ...(runtime.job?.status === 'running' || runtime.job?.status === 'queued'
          ? [{ label: 'Cancel Optimised Copy', onSelect: () => void window.ginosa.media.cancelJob(runtime.job!.id) }]
          : []),
        { label: 'Locate File…', onSelect: () => void mediaController.relink(item.id) },
        'separator',
        { label: selected.length > 1 ? `Remove ${selected.length} Items from Project` : 'Remove from Project', danger: true, onSelect: removeSelected }
      ]
    }
    setMenu({ x: event.clientX, y: event.clientY, entries })
  }

  const openSource = (id: string) => {
    mediaController.openInSource(id)
    workspaceController.open('source-monitor')
  }

  const importing = mediaController.importing
  return (
    <section className="panel media-panel" ref={panelRef}>
      <header className="panel-header">
        <span>Media</span>
        <span className="muted small">{project.media.length || ''}</span>
        <span className="spacer" />
        <input className="input compact search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="button compact" title="New Bin (Cmd+B)" onClick={() => mediaController.newBin()}>
          + Bin
        </button>
        <button className="button compact primary" title="Import (Cmd+I)" onClick={() => void mediaController.chooseAndImport(mediaController.targetBinId)}>
          Import…
        </button>
      </header>
      {importing && (
        <div className="import-progress">
          Importing {importing.done} of {importing.total}…
          <span style={{ width: `${(importing.done / importing.total) * 100}%` }} />
        </div>
      )}
      <div
        className={`media-list ${dropTarget === 'root' ? 'drop-root' : ''}`}
        tabIndex={0}
        {...dropProps(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelected([])
        }}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) openMenu(event, null)
        }}
        onKeyDown={(event) => {
          if (renaming) return
          if ((event.key === 'Backspace' || event.key === 'Delete') && selected.length) {
            event.preventDefault()
            removeSelected()
          } else if (event.key === 'Enter' && selected.length === 1) {
            event.preventDefault()
            setRenaming(selected[0]!)
          }
        }}
      >
        {project.media.length === 0 && project.bins.length === 0 ? (
          <div className="empty-state">
            <p>No media yet.</p>
            <p className="muted small">Drag files or folders here from Finder, or click Import (Cmd+I). Folders become bins.</p>
          </div>
        ) : (
          <>
            <div className="media-row media-head" style={{ gridTemplateColumns: columns }}>
              <span>Name</span>
              {showColumns.duration && <span>Duration</span>}
              {showColumns.size && <span>Size</span>}
              {showColumns.fps && <span>FPS</span>}
              {showColumns.codec && <span>Codec</span>}
              <span>Status</span>
            </div>
            {rows.map((row) => {
              if (row.type === 'bin') {
                const key = binKey(row.bin.id)
                return (
                  <div
                    key={key}
                    className={`media-row bin-row ${selected.includes(key) ? 'selected' : ''} ${dropTarget === row.bin.id ? 'drop' : ''}`}
                    style={{ gridTemplateColumns: columns }}
                    draggable={renaming !== key}
                    onDragStart={onDragStart(key)}
                    {...dropProps(row.bin.id)}
                    onClick={(event) => select(key, event)}
                    onDoubleClick={() => toggle(row.bin.id)}
                    onContextMenu={(event) => openMenu(event, row)}
                  >
                    <span className="name-cell" style={{ paddingLeft: row.depth * 16 }}>
                      <button className="twisty" onClick={(event) => (event.stopPropagation(), toggle(row.bin.id))}>
                        <Icon name={expanded.has(row.bin.id) ? 'chevronDown' : 'chevronRight'} fallback={expanded.has(row.bin.id) ? '▾' : '▸'} />
                      </button>
                      <Icon name="folder" fallback="" className="folder-icon" />
                      {renaming === key ? (
                        <CommitInput
                          className="input compact"
                          value={row.bin.name}
                          autoFocus
                          autoSelect
                          onCommit={(name) => projectController.dispatch(renameBin(row.bin.id, name))}
                          onBlur={() => setRenaming(null)}
                        />
                      ) : (
                        <span className="item-name">{row.bin.name}</span>
                      )}
                      <span className="muted small">{row.count || ''}</span>
                    </span>
                  </div>
                )
              }
              const item = row.item
              const runtime = mediaController.get(item.id)
              return (
                <div
                  key={item.id}
                  className={`media-row ${selected.includes(item.id) ? 'selected' : ''} ${runtime.status === 'offline' ? 'offline' : ''}`}
                  style={{ gridTemplateColumns: columns }}
                  draggable={renaming !== item.id}
                  onDragStart={onDragStart(item.id)}
                  onClick={(event) => select(item.id, event)}
                  onDoubleClick={() => openSource(item.id)}
                  onContextMenu={(event) => openMenu(event, row)}
                  title={item.path}
                >
                  <span className="name-cell" style={{ paddingLeft: row.depth * 16 + 18 }}>
                    <Thumb item={item} runtime={runtime} />
                    {renaming === item.id ? (
                      <CommitInput
                        className="input compact"
                        value={item.name}
                        autoFocus
                        autoSelect
                        onCommit={(name) => projectController.dispatch(renameMedia(item.id, name))}
                        onBlur={() => setRenaming(null)}
                      />
                    ) : (
                      <span className="item-name">
                        {item.name}
                        {row.path && <span className="muted small"> · {row.path}</span>}
                      </span>
                    )}
                  </span>
                  {showColumns.duration && <span className="mono">{formatDuration(item)}</span>}
                  {showColumns.size && <span className="mono">{formatSize(item)}</span>}
                  {showColumns.fps && <span className="mono">{formatFps(item)}</span>}
                  {showColumns.codec && <span className="mono">{formatCodec(item)}</span>}
                  <span>
                    <Status item={item} runtime={runtime} />
                  </span>
                </div>
              )
            })}
          </>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.entries} onClose={() => setMenu(null)} />}
    </section>
  )
}
