import { useEffect, useMemo, useRef, useState } from 'react'
import { sampleGradient } from '@engine/gradients/evaluate'
import { gradientNotes, type Gradient, type GradientMethod } from '@engine/gradients/gradient'
import { countIn, gradientsIn, subfolders, type LibraryGradient } from '@engine/gradients/library'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { useObservable } from '../state/observable'
import { gradientController } from './gradient-controller'

const css = new WeakMap<Gradient, Map<GradientMethod, string>>()

/** A gradient as a CSS linear-gradient (48 samples, opacity left out), cached per gradient. */
export function gradientCss(g: Gradient, method: GradientMethod): string {
  let byMethod = css.get(g)
  if (!byMethod) css.set(g, (byMethod = new Map()))
  const hit = byMethod.get(method)
  if (hit) return hit
  const n = 48
  const s = sampleGradient(g, method, n)
  const stops = Array.from({ length: n }, (_, i) => `rgb(${[0, 1, 2].map((k) => Math.round(s[i * 4 + k]! * 255)).join(',')}) ${((i / (n - 1)) * 100).toFixed(2)}%`)
  const out = `linear-gradient(to right, ${stops.join(', ')})`
  byMethod.set(method, out)
  return out
}

/** The gradient drawn pixel for pixel, its opacity over a checkerboard when `showOpacity`. */
export function GradientBar({ gradient, method, height = 24, showOpacity = false }: { gradient: Gradient; method: GradientMethod; height?: number; showOpacity?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(300)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const observer = new ResizeObserver(() => setWidth(Math.max(16, Math.round(canvas.clientWidth))))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const scale = window.devicePixelRatio || 1
    const w = Math.round(width * scale)
    const h = Math.round(height * scale)
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const samples = sampleGradient(gradient, method, w)
    const image = ctx.createImageData(w, h)
    const cell = Math.max(4, Math.round(6 * scale))
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = showOpacity ? samples[x * 4 + 3]! : 1
        const checker = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 0.8 : 1
        const i = (y * w + x) * 4
        for (let k = 0; k < 3; k++) image.data[i + k] = Math.round((samples[x * 4 + k]! * a + checker * (1 - a)) * 255)
        image.data[i + 3] = 255
      }
    ctx.putImageData(image, 0, 0)
  }, [gradient, method, width, height, showOpacity])
  return <canvas ref={ref} className="gradient-bar" style={{ height }} />
}

/**
 * The library: folders on the left, the selected folder's gradients as swatches on the
 * right, and a search across everything. Click a swatch to use it; right-click to rename,
 * move or delete (when `manage`).
 */
export function LibraryBrowser({ onPick, manage = false, method = 'classic' }: { onPick(item: LibraryGradient): void; manage?: boolean; method?: GradientMethod }) {
  useObservable(gradientController)
  const [search, setSearch] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  useEffect(() => void gradientController.load(), [])
  const lib = gradientController.library
  const folder = gradientController.folder
  const shown = useMemo(() => {
    if (!lib) return []
    const q = search.trim().toLowerCase()
    return q ? lib.items.filter((i) => i.gradient.name.toLowerCase().includes(q)).slice(0, 500) : gradientsIn(lib, folder)
  }, [lib, folder, search])
  if (!lib) return <div className="gradient-library muted small">Loading the library…</div>
  const ask = (title: string, initial: string, confirm: string, done: (value: string) => void) =>
    setPrompt({
      title,
      label: 'Name',
      initial,
      confirm,
      resolve: (value) => {
        setPrompt(null)
        if (value?.trim()) done(value.trim())
      }
    })
  const folderMenu = (path: string[], x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: 'New Folder Inside…', onSelect: () => (gradientController.openFolder(path), ask('New Folder', 'Folder', 'Create', (n) => void gradientController.newFolder(n))) },
        { label: 'Rename…', onSelect: () => ask('Rename Folder', path[path.length - 1]!, 'Rename', (n) => void gradientController.renameFolder(path, n)) },
        { label: 'Export as .grd…', onSelect: () => void gradientController.export(path) },
        'separator',
        { label: `Delete Folder (${countIn(lib, path)} gradients)`, danger: true, onSelect: () => void gradientController.removeFolder(path) }
      ]
    })
  const itemMenu = (item: LibraryGradient, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: 'Use', onSelect: () => onPick(item) },
        { label: 'Rename…', onSelect: () => ask('Rename Gradient', item.gradient.name, 'Rename', (n) => void gradientController.renameGradient(item.id, n)) },
        { label: `Move to “${folder.join(' › ') || 'Top'}”`, disabled: JSON.stringify(item.folder) === JSON.stringify(folder), onSelect: () => void gradientController.moveGradient(item.id, folder) },
        'separator',
        { label: 'Delete', danger: true, onSelect: () => void gradientController.removeGradient(item.id) }
      ]
    })
  const tree = (path: string[]): React.ReactNode =>
    subfolders(lib, path).map((f) => (
      <div key={f.join('/')}>
        <button
          className={`gradient-folder ${JSON.stringify(f) === JSON.stringify(folder) && !search ? 'on' : ''}`}
          style={{ paddingLeft: 6 + (f.length - 1) * 12 }}
          onClick={() => (gradientController.openFolder(f), setSearch(''))}
          onContextMenu={(event) => {
            event.preventDefault()
            if (manage) folderMenu(f, event.clientX, event.clientY)
          }}
        >
          {f[f.length - 1]} <span className="muted">{countIn(lib, f)}</span>
        </button>
        {JSON.stringify(folder.slice(0, f.length)) === JSON.stringify(f) && tree(f)}
      </div>
    ))
  return (
    <div className="gradient-library">
      <div className="gradient-folders">
        <input className="input compact" placeholder="Search" aria-label="Search gradients" value={search} onChange={(event) => setSearch(event.target.value)} />
        <button className={`gradient-folder ${folder.length === 0 && !search ? 'on' : ''}`} onClick={() => (gradientController.openFolder([]), setSearch(''))}>
          All folders <span className="muted">{lib.items.length}</span>
        </button>
        {tree([])}
      </div>
      <div className="gradient-swatches">
        {shown.length === 0 && <div className="muted small">{search ? 'No gradients by that name.' : 'No gradients in this folder.'}</div>}
        {shown.map((item) => {
          const notes = gradientNotes(item.gradient)
          return (
            <button
              key={item.id}
              className="gradient-swatch"
              title={`${item.gradient.name}${search ? ` (${item.folder.join(' › ') || 'Top'})` : ''}${notes.length ? `\n${notes.join('\n')}` : ''}`}
              onClick={() => onPick(item)}
              onContextMenu={(event) => {
                event.preventDefault()
                if (manage) itemMenu(item, event.clientX, event.clientY)
              }}
            >
              <span className="gradient-swatch-colours" style={{ background: gradientCss(item.gradient, item.gradient.kind === 'solid' ? (item.gradient.method ?? method) : method) }} />
              <span className="gradient-swatch-name">
                {notes.length > 0 && <span className="gradient-flag" title={notes.join('\n')}>!</span>}
                {item.gradient.name}
              </span>
            </button>
          )
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog request={prompt} />}
    </div>
  )
}

/** A small floating library, for picking a gradient without opening the editor. */
export function GradientPopover({ x, y, onPick, onClose }: { x: number; y: number; onPick(item: LibraryGradient): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && ref.current?.contains(event.target as Node)) return
      // Clicks in the rename/delete menus and dialogs above the popover don't close it.
      if (event instanceof MouseEvent && (event.target as Element | null)?.closest?.('.context-menu, .dialog-backdrop')) return
      onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [onClose])
  const width = 460
  const height = 300
  return (
    <div ref={ref} className="gradient-popover" style={{ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)), width, height }}>
      <LibraryBrowser
        onPick={(item) => {
          onPick(item)
          onClose()
        }}
      />
    </div>
  )
}
