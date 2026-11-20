import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { dragTension, insertPoint, movePoint, removePoints, setShape, SHAPE_LABELS, snapCurveTime, snapStepBeats, tensionLabel } from '@engine/automation/edit'
import { findEffect, propertySpec } from '@engine/keyframes/properties'
import { AUTOMATION_SHAPES, type AutomationPoint, type AutomationShape, type Clip } from '@engine/project/model'
import { linkToAutomation, setAutomationPoints, setControlsTempo, setTempoRange } from '@engine/timeline/automation-edits'
import { linksTo, removeLinks } from '@engine/timeline/modulation-edits'
import { effectById } from '../../../effects/registry'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { ValuePicker } from '../app/ValuePicker'
import { PLAYHEAD_THROTTLE, STATE_AND_PLAYHEAD, useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { drawAutomationEditor, editorGeometry, hitEditor } from './automation-draw'
import { AUTOMATION_DRAG_TYPE, automationUi } from './automation-ui'
import { tempoGrid } from '@engine/audio/tempo-map'

/**
 * The automation editor (W2.2, decision 127): an automation clip's curve, FL Studio's way. Click
 * empty space to add a point; drag points; drag a stretch's small handle up or down for its
 * tension (a curve's bend, or how many steps or cycles); right-click a point or a stretch for its
 * shape. Points snap to the beat grid (hold ⌥ to move freely). Beside the graph: what the clip
 * controls, picking more values, and its name to drag onto a value in Effect Controls.
 */

type Drag =
  | { kind: 'point'; index: number; base: AutomationPoint[]; stroke: string; moved: boolean; x: number; y: number }
  | { kind: 'tension'; index: number; base: AutomationPoint[]; stroke: string; y: number }

export function AutomationEditorWindow() {
  useObservable(projectController)
  useObservable(automationUi)
  useObservable(timelineController, STATE_AND_PLAYHEAD, PLAYHEAD_THROTTLE)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const [picking, setPicking] = useState(false)
  const sequence = projectController.project?.sequence ?? null
  // The automation clip selected on the timeline, else the one last opened.
  const selectedAuto = sequence?.clips.find((c) => c.kind === 'automation' && c.automation && timelineController.selection.has(c.id))
  const clip: Clip | null = selectedAuto ?? sequence?.clips.find((c) => c.id === automationUi.clipId && c.automation) ?? null

  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.max(100, entry.contentRect.width), height: Math.max(80, entry.contentRect.height) })
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [clip !== null])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !clip?.automation || !sequence || size.width === 0) return
    const ratio = window.devicePixelRatio || 1
    const w = Math.round(size.width * ratio)
    const h = Math.round(size.height * ratio)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const tempo = clip.automation.tempo
    drawAutomationEditor(ctx, {
      clip,
      points: clip.automation.points,
      size,
      grid: tempoGrid(sequence),
      selected: new Set(automationUi.selected),
      playhead: timelineController.playhead,
      valueLabel: tempo ? (v) => String(Math.round(tempo.min + (tempo.max - tempo.min) * v)) : undefined
    })
  })

  if (!sequence || !clip?.automation) {
    return (
      <div className="automation-editor empty">
        <p className="muted small">Double-click an automation clip on the timeline to edit its curve here. Make one with the Control Panel’s New automation clip, or right-click a value in Effect Controls › Create Automation Clip.</p>
      </div>
    )
  }

  const automation = clip.automation
  const points = automation.points
  const g = editorGeometry(clip, size)
  const grid = tempoGrid(sequence)
  const frame = timelineController.frame()
  const stepBeats = grid ? snapStepBeats(grid, (g.x1 - g.x0) / Math.max(1, g.to - g.from)) : 1
  const snap = (time: number, free: boolean) => (automationUi.snapping && !free ? snapCurveTime(time, clip, grid, stepBeats, frame) : Math.max(0, Math.round(time)))
  const commit = (next: AutomationPoint[], stroke: string | null = null) => projectController.dispatch(setAutomationPoints(clip.id, next, stroke))
  const selected = automationUi.selected.filter((i) => i < points.length)
  const local = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const shapeItems = (indexes: number[]): MenuEntry[] =>
    AUTOMATION_SHAPES.map((shape: AutomationShape) => ({
      label: SHAPE_LABELS[shape],
      shortcut: indexes.every((i) => points[i]?.shape === shape) ? '✓' : undefined,
      onSelect: () => void commit(setShape(points, indexes, shape))
    }))
  const remove = (indexes: number[]) => {
    const next = removePoints(points, indexes)
    if (!next) return projectController.showMessage('An automation clip keeps at least one point')
    if (commit(next)) automationUi.select([])
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the browser doesn't know (a test's): nothing to capture.
    }
    const { x, y } = local(event)
    const hit = hitEditor(points, g, x, y)
    const stroke = `${clip.id}:${Date.now()}`
    if (hit?.kind === 'handle') {
      automationUi.select([hit.index])
      drag.current = { kind: 'tension', index: hit.index, base: points.map((p) => ({ ...p })), stroke, y }
      return
    }
    if (hit?.kind === 'point') {
      if (event.shiftKey || event.metaKey) automationUi.select(selected.includes(hit.index) ? selected.filter((i) => i !== hit.index) : [...selected, hit.index])
      else if (!selected.includes(hit.index)) automationUi.select([hit.index])
      drag.current = { kind: 'point', index: hit.index, base: points.map((p) => ({ ...p })), stroke, moved: false, x, y }
      return
    }
    if (x < g.x0 || x > g.x1 || y < g.y0 - 4 || y > g.y1 + 4) return
    // Empty space: a new point there, and keep dragging it.
    const added = insertPoint(points, snap(g.timeOf(x), event.altKey), g.valueOf(y))
    if (!commit(added.points, stroke)) return
    automationUi.select([added.index])
    drag.current = { kind: 'point', index: added.index, base: added.points, stroke, moved: true, x, y }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    const { x, y } = local(event)
    if (!d) {
      const hit = hitEditor(points, g, x, y)
      event.currentTarget.style.cursor = hit?.kind === 'handle' ? 'ns-resize' : hit ? 'grab' : 'crosshair'
      return
    }
    if (d.kind === 'point') {
      if (!d.moved && Math.hypot(x - d.x, y - d.y) < 3) return
      d.moved = true
      commit(movePoint(d.base, d.index, snap(g.timeOf(x), event.altKey), g.valueOf(y)), d.stroke)
    } else {
      const point = d.base[d.index]!
      const tension = dragTension(point.tension, point, d.base[d.index + 1], y - d.y, g.y1 - g.y0)
      commit(d.base.map((p, i) => (i === d.index ? { ...p, tension } : p)), d.stroke)
    }
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const onContextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const { x, y } = local(event)
    const hit = hitEditor(points, g, x, y)
    if (hit?.kind === 'point') {
      const indexes = selected.includes(hit.index) ? selected : [hit.index]
      if (!selected.includes(hit.index)) automationUi.select([hit.index])
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          ...shapeItems(indexes),
          'separator',
          { label: 'Straighten', onSelect: () => void commit(points.map((p, i) => (indexes.includes(i) ? { ...p, tension: 0 } : p))) },
          { label: indexes.length > 1 ? 'Delete Points' : 'Delete Point', shortcut: '⌫', danger: true, disabled: points.length <= indexes.length, onSelect: () => remove(indexes) }
        ]
      })
      return
    }
    const time = g.timeOf(x)
    let stretch = 0
    points.forEach((p, i) => {
      if (p.time <= time) stretch = i
    })
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: 'Add Point Here',
          onSelect: () => {
            const added = insertPoint(points, snap(time, false), g.valueOf(y))
            if (commit(added.points)) automationUi.select([added.index])
          }
        },
        'separator',
        ...shapeItems([stretch])
      ]
    })
  }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return
    if ((event.key === 'Backspace' || event.key === 'Delete') && selected.length) {
      event.preventDefault()
      event.stopPropagation()
      remove(selected)
    } else if ((event.metaKey || event.ctrlKey) && event.code === 'KeyA') {
      event.preventDefault()
      event.stopPropagation()
      automationUi.select(points.map((_, i) => i))
    } else if (event.key === 'Escape' && selected.length) {
      event.stopPropagation()
      automationUi.select([])
    }
  }

  const first = selected.length ? points[selected[0]!] : undefined
  const sameShape = first && selected.every((i) => points[i]?.shape === first.shape) ? first.shape : ''
  const tempo = automation.tempo
  const valueText = (v: number) => (tempo ? `${(tempo.min + (tempo.max - tempo.min) * v).toFixed(1)} BPM` : `${Math.round(v * 100)}%`)
  const readout = first ? [valueText(first.value), timelineController.timecode(clip.start + first.time - clip.sourceIn), tensionLabel(first)].filter(Boolean).join(' · ') : `${points.length} point${points.length === 1 ? '' : 's'}`
  const targets = linksTo(sequence, automation.modulatorId)
  const label = (t: (typeof targets)[number]) => {
    const spec = propertySpec(t.clip, t.ref.effectId, t.ref.param)
    const effect = t.ref.effectId ? findEffect(t.clip, t.ref.effectId) : null
    return `${effect ? `${effectById(effect.effectId)?.name ?? 'Effect'} · ` : ''}${spec?.label ?? t.ref.param}`
  }

  return (
    <div className="automation-editor" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="auto-main">
        <div className="auto-head">
          <span className="auto-name">{clip.name}</span>
          <label className="auto-shape">
            <span className="muted small">Shape</span>
            <select
              className="input compact"
              aria-label="Shape of the selected stretches"
              value={sameShape}
              disabled={selected.length === 0}
              onChange={(e) => void commit(setShape(points, selected, e.target.value as AutomationShape))}
            >
              {!sameShape && <option value="">{selected.length ? 'Mixed' : '—'}</option>}
              {AUTOMATION_SHAPES.map((shape) => (
                <option key={shape} value={shape}>
                  {SHAPE_LABELS[shape]}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small auto-readout">{readout}</span>
          <span className="spacer" />
          <button
            className={`cp-button auto-snap ${automationUi.snapping ? 'on' : ''}`}
            aria-pressed={automationUi.snapping}
            title={grid ? 'Snap points to the beat grid (hold ⌥ while dragging to move freely)' : 'Snap points to frames (hold ⌥ while dragging to move freely)'}
            onClick={() => automationUi.setSnapping(!automationUi.snapping)}
          >
            Snap
          </button>
        </div>
        <div className="auto-graph" ref={areaRef}>
          <canvas
            ref={canvasRef}
            tabIndex={-1}
            aria-label={`${clip.name}: its curve`}
            style={{ width: size.width, height: size.height }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onContextMenu={onContextMenu}
          />
        </div>
        <p className="muted small auto-hint">Click to add a point · drag points, or a stretch’s small handle for its tension · right-click for shapes · ⌫ deletes · hold ⌥ to move freely</p>
      </div>
      <aside className="auto-side">
        <div
          className="auto-drag"
          draggable
          title="Drag onto a value in Effect Controls: it follows this clip too"
          onDragStart={(e) => {
            e.dataTransfer.setData(AUTOMATION_DRAG_TYPE, clip.id)
            e.dataTransfer.effectAllowed = 'link'
          }}
        >
          <span aria-hidden="true">⠿</span> {clip.name}
        </div>
        <div className="fx-section-title">Controls</div>
        {tempo ? (
          <div className="channel-value auto-target auto-tempo">
            <span className="auto-tempo-label">Tempo</span>
            <input
              key={`min:${tempo.min}`}
              className="input compact mono auto-bpm"
              aria-label="Tempo at the bottom of the curve (BPM)"
              title="The tempo at the bottom of the curve"
              defaultValue={tempo.min}
              onBlur={(e) => {
                const v = Number(e.currentTarget.value)
                if (v !== tempo.min) projectController.dispatch(setTempoRange(clip.id, v, tempo.max))
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <span className="muted small">–</span>
            <input
              key={`max:${tempo.max}`}
              className="input compact mono auto-bpm"
              aria-label="Tempo at the top of the curve (BPM)"
              title="The tempo at the top of the curve"
              defaultValue={tempo.max}
              onBlur={(e) => {
                const v = Number(e.currentTarget.value)
                if (v !== tempo.max) projectController.dispatch(setTempoRange(clip.id, tempo.min, v))
              }}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <span className="muted small">BPM</span>
            <span className="spacer" />
            <button className="channel-unlink" aria-label="Stop setting the tempo" title="Stop setting the tempo" onClick={() => projectController.dispatch(setControlsTempo(clip.id, false))}>
              ×
            </button>
          </div>
        ) : null}
        {targets.length === 0 && !tempo && <p className="muted small">Nothing yet: pick a value below, or drag the name above onto one.</p>}
        {targets.map((t) => (
          <div key={t.link.id} className="channel-value auto-target">
            <button className="link-button" title="Show that clip" onClick={() => timelineController.select([t.clip.id], 'replace')}>
              {label(t)}
            </button>
            <span className="muted small auto-target-clip">{t.clip.name}</span>
            <span className="spacer" />
            <button className="channel-unlink" aria-label={`Unlink ${label(t)}`} title="Stop controlling this value" onClick={() => projectController.dispatch(removeLinks(t.ref, t.link.id))}>
              ×
            </button>
          </div>
        ))}
        {picking ? (
          <>
            <ValuePicker
              sequence={sequence}
              targetName={clip.name}
              linked={(c, effectId, param) => (effectId === null ? c.modulation : c.effects.find((e) => e.id === effectId)?.modulation)?.[param]?.some((l) => l.modulatorId === automation.modulatorId) ?? false}
              onPick={(ref) => {
                if (projectController.dispatch(linkToAutomation(ref, clip.id))) setPicking(false)
              }}
            />
            <button className="button compact" onClick={() => setPicking(false)}>
              Back
            </button>
          </>
        ) : (
          <>
            <button className="button compact" onClick={() => setPicking(true)}>
              + Pick a value…
            </button>
            {!tempo && (
              <button className="button compact" title="This clip's curve sets the tempo too (W2.3)" onClick={() => projectController.dispatch(setControlsTempo(clip.id, true))}>
                + Control the tempo
              </button>
            )}
          </>
        )}
      </aside>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}
