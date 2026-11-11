import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../app/Icon'
import { MediaPanel } from '../media-panel/MediaPanel'
import { ProgramMonitor } from '../panels/ProgramMonitor'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { useObservable, useSelect } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { FloatingWindow } from './FloatingWindow'
import { resolveFrame, workspaceGrid, type GridArea, type PanelKey, type Size } from './layout'
import { renderWindow } from './windows'


/** Drag handle between fixed panels; `sign` flips direction for panels measured from the far side. */
function Splitter({ panel, axis, sign, area }: { panel: PanelKey; axis: 'x' | 'y'; sign: 1 | -1; area: GridArea }) {
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
  return <div className={`splitter ${axis}`} style={{ gridArea: area }} onPointerDown={onPointerDown} />
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

  const shape = useSelect(projectController, () => {
    const settings = projectController.project?.sequence.settings
    return settings && settings.height > settings.width ? 'portrait' : 'landscape'
  })
  const frame = resolveFrame(layout.frame, shape)
  const grid = workspaceGrid(layout, frame, docked.length > 0 && dockTab !== undefined)
  const uses = grid.uses

  return (
    <div className="workspace">
      <div className={`workspace-grid frame-${frame}`} style={{ gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows, gridTemplateAreas: grid.areas }}>
        {uses.has('media') && (
          <div className="grid-cell" style={{ gridArea: 'media' }}>
            <MediaPanel />
          </div>
        )}
        {uses.has('split-media') && <Splitter panel="mediaWidth" axis="x" sign={1} area="split-media" />}
        <div className="grid-cell" style={{ gridArea: 'preview' }}>
          <ProgramMonitor frame={frame} />
        </div>
        <Splitter panel="timelineHeight" axis="y" sign={-1} area="split-timeline" />
        <div className="grid-cell" style={{ gridArea: 'timeline' }}>
          <TimelinePanel />
        </div>
        {uses.has('split-side') && <Splitter panel={frame === 'portrait' ? 'previewWidth' : 'dockWidth'} axis="x" sign={-1} area="split-side" />}
        {uses.has('dock') && dockTab && (
          <aside className="panel dock-column" style={{ gridArea: 'dock' }}>
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
        {uses.has('empty') && (
          <section className="panel empty-dock" style={{ gridArea: 'empty' }}>
            <div className="empty-state">
              <p className="muted">Nothing is docked here.</p>
              <button className="button compact" onClick={() => workspaceController.setDocked('effect-controls', true)}>
                Effect Controls
              </button>{' '}
              <button className="button compact" onClick={() => workspaceController.setDocked('effects-library', true)}>
                Add Effects
              </button>{' '}
              <button className="button compact" onClick={() => workspaceController.toggleMedia(true)}>
                Media
              </button>
            </div>
          </section>
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
