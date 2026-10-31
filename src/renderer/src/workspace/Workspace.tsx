import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../app/Icon'
import { MediaPanel } from '../media-panel/MediaPanel'
import { ProgramMonitor } from '../panels/ProgramMonitor'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { useObservable } from '../state/observable'
import { workspaceController } from '../state/workspace'
import { FloatingWindow } from './FloatingWindow'
import type { Size } from './layout'
import { renderWindow } from './windows'

type PanelKey = 'mediaWidth' | 'timelineHeight' | 'dockWidth'

/** Drag handle between fixed panels; `sign` flips direction for panels measured from the far side. */
function Splitter({ panel, axis, sign }: { panel: PanelKey; axis: 'x' | 'y'; sign: 1 | -1 }) {
  const onPointerDown = (event: ReactPointerEvent) => {
    event.preventDefault()
    const start = axis === 'x' ? event.clientX : event.clientY
    const initial = workspaceController.layout[panel]
    const move = (e: PointerEvent) => {
      const now = axis === 'x' ? e.clientX : e.clientY
      workspaceController.setPanelSize(panel, initial + sign * (now - start))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('dragging')
    }
    document.body.classList.add('dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className={`splitter ${axis}`} onPointerDown={onPointerDown} />
}

/**
 * The main editing environment (media, monitor, timeline) with an optional dock
 * column, plus the layer where floating tool windows live.
 */
export function Workspace() {
  useObservable(workspaceController)
  const layout = workspaceController.layout
  const floatLayerRef = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState<Size>({ w: 1200, h: 800 })

  useLayoutEffect(() => {
    const element = floatLayerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const next = { w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }
      setBounds(next)
      workspaceController.fitToBounds(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const specs = workspaceController.specs
  const docked = specs.filter((s) => layout.windows[s.id]?.open && layout.windows[s.id]?.docked)
  const floating = specs.filter((s) => {
    const w = layout.windows[s.id]
    return w?.open && !w.docked && w.mode !== 'minimized'
  })
  const minimized = specs.filter((s) => {
    const w = layout.windows[s.id]
    return w?.open && !w.docked && w.mode === 'minimized'
  })
  // The active dock tab is whichever docked window was focused most recently.
  const dockTab = docked.reduce<(typeof docked)[number] | undefined>(
    (best, spec) => (!best || (layout.windows[spec.id]?.z ?? 0) > (layout.windows[best.id]?.z ?? 0) ? spec : best),
    undefined
  )

  const columns = `${layout.mediaWidth}px 4px 1fr${docked.length ? ` 4px ${layout.dockWidth}px` : ''}`

  return (
    <div className="workspace">
      <div className="workspace-grid" style={{ gridTemplateColumns: columns }}>
        <MediaPanel />
        <Splitter panel="mediaWidth" axis="x" sign={1} />
        <div className="center-column" style={{ gridTemplateRows: `1fr 4px ${layout.timelineHeight}px` }}>
          <ProgramMonitor />
          <Splitter panel="timelineHeight" axis="y" sign={-1} />
          <TimelinePanel />
        </div>
        {docked.length > 0 && <Splitter panel="dockWidth" axis="x" sign={-1} />}
        {docked.length > 0 && dockTab && (
          <aside className="panel dock-column">
            <header className="dock-tabs">
              {docked.map((spec) => (
                <button
                  key={spec.id}
                  className={`dock-tab ${spec.id === dockTab.id ? 'active' : ''}`}
                  onClick={() => workspaceController.focus(spec.id)}
                >
                  {spec.title}
                </button>
              ))}
              <span className="spacer" />
              <button className="window-button" title="Float this window" onClick={() => workspaceController.setDocked(dockTab.id, false)}>
                <Icon name="undock" fallback="⇤" />
              </button>
              <button className="window-button close" title="Close" onClick={() => workspaceController.close(dockTab.id)}>
                <Icon name="close" fallback="×" />
              </button>
            </header>
            <div className="dock-content">{renderWindow(dockTab.id)}</div>
          </aside>
        )}
      </div>

      <div className="float-layer" ref={floatLayerRef}>
        {floating.map((spec) => (
          <FloatingWindow
            key={spec.id}
            id={spec.id}
            title={spec.title}
            bounds={bounds}
            others={floating.filter((o) => o.id !== spec.id).map((o) => layout.windows[o.id]!.rect)}
          >
            {renderWindow(spec.id)}
          </FloatingWindow>
        ))}
        {minimized.length > 0 && (
          <div className="minimized-tray">
            {minimized.map((spec) => (
              <button key={spec.id} className="minimized-window" onClick={() => workspaceController.restore(spec.id)} title="Restore">
                {spec.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
