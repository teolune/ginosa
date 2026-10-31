import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Icon } from '../app/Icon'
import { workspaceController } from '../state/workspace'
import { resizeRect, snapMove, snapResize, type Rect, type ResizeEdge, type Size } from './layout'

const EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

interface Props {
  id: string
  title: string
  bounds: Size
  /** Other visible floating windows, for snapping. */
  others: Rect[]
  children: ReactNode
}

/** A floating tool window inside the workspace: drag, resize, snap, minimise, maximise, dock, close. */
export function FloatingWindow({ id, title, bounds, others, children }: Props) {
  const layout = workspaceController.window(id)
  const spec = workspaceController.spec(id)
  const frameRef = useRef<HTMLDivElement>(null)
  if (!layout || !spec) return null

  const maximized = layout.mode === 'maximized'
  const rect = maximized ? { x: 0, y: 0, w: bounds.w, h: bounds.h } : layout.rect

  /** Moves the DOM directly while dragging (smooth), then commits once on release. */
  const track = (event: ReactPointerEvent, compute: (dx: number, dy: number) => Rect) => {
    if (event.button !== 0) return
    event.preventDefault()
    workspaceController.focus(id)
    const startX = event.clientX
    const startY = event.clientY
    const frame = frameRef.current
    let latest = rect
    const move = (e: PointerEvent) => {
      latest = compute(e.clientX - startX, e.clientY - startY)
      if (frame) {
        frame.style.left = `${latest.x}px`
        frame.style.top = `${latest.y}px`
        frame.style.width = `${latest.w}px`
        frame.style.height = `${latest.h}px`
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('dragging')
      if (latest !== rect) workspaceController.setRect(id, latest, bounds)
    }
    document.body.classList.add('dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startMove = (event: ReactPointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return
    const start = maximized ? { ...layout.rect, x: event.nativeEvent.offsetX - layout.rect.w / 2, y: 0 } : rect
    track(event, (dx, dy) => snapMove({ ...start, x: start.x + dx, y: start.y + dy }, bounds, others))
  }

  const startResize = (edge: ResizeEdge) => (event: ReactPointerEvent) => {
    event.stopPropagation()
    track(event, (dx, dy) => snapResize(resizeRect(rect, edge, dx, dy, spec.minSize), edge, bounds, others, spec.minSize))
  }

  return (
    <div
      ref={frameRef}
      className={`floating-window ${maximized ? 'maximized' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: 100 + layout.z }}
      onPointerDown={() => workspaceController.focus(id)}
      data-window={id}
    >
      <div className="window-titlebar" onPointerDown={startMove} onDoubleClick={() => workspaceController.toggleMaximize(id)}>
        <span className="window-title">{title}</span>
        <span className="spacer" />
        {spec.dockable && (
          <button className="window-button" title="Dock to the side" onClick={() => workspaceController.setDocked(id, true)}>
            <Icon name="dock" fallback="⇥" />
          </button>
        )}
        <button className="window-button" title="Minimise" onClick={() => workspaceController.minimize(id)}>
          <Icon name="minimise" fallback="–" />
        </button>
        <button className="window-button" title={maximized ? 'Restore' : 'Maximise'} onClick={() => workspaceController.toggleMaximize(id)}>
          <Icon name={maximized ? 'restore' : 'maximise'} fallback={maximized ? '❐' : '□'} />
        </button>
        <button className="window-button close" title="Close" onClick={() => workspaceController.close(id)}>
          <Icon name="close" fallback="×" />
        </button>
      </div>
      <div className="window-content">{children}</div>
      {!maximized && EDGES.map((edge) => <div key={edge} className={`resize-handle ${edge}`} onPointerDown={startResize(edge)} />)}
    </div>
  )
}
