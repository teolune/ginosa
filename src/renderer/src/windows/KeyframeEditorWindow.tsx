import { produce } from 'immer'
import { useEffect, useRef, useState } from 'react'
import { components, type InterpolationPreset, type Keyframe } from '@engine/keyframes/keyframes'
import { keyframesOf } from '@engine/keyframes/properties'
import { frameRateOf, type Sequence } from '@engine/project/model'
import { frameRateValue, secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import {
  applyDragKeyframe,
  applyKeyframeChange,
  applyMoveKeyframes,
  applyScaleKeyframes,
  changeKeyframe,
  dragKeyframe,
  moveKeyframes,
  scaleKeyframes,
  setKeyframeInterpolation,
  type KeyframeChange,
  type KeyframeRef
} from '@engine/timeline/keyframe-edits'
import { snapTargets, snapTime } from '@engine/timeline/snapping'
import { clipEnd } from '@engine/timeline/timeline'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { keyframeController } from '../keyframes/keyframe-controller'
import {
  LABEL_W,
  ROW_H,
  RULER_H,
  drawEditor,
  editorRows,
  graphRange,
  hitDope,
  hitGraph,
  rowTop,
  valueToY,
  xToTime,
  yToValue,
  type EditorRow,
  type EditorView,
  type GraphRange,
  type KeyframeHit
} from '../keyframes/editor-canvas'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { SNAP_PIXELS } from '../timeline/geometry'
import { timelineController as tl } from '../timeline/timeline-controller'

type Drag =
  | { type: 'scrub' }
  | { type: 'marquee'; x0: number; y0: number; x1: number; y1: number; base: KeyframeRef[] }
  | { type: 'pending'; hit: KeyframeHit; x0: number; y0: number; alt: boolean; row: EditorRow }
  | { type: 'move'; hit: KeyframeHit; refs: KeyframeRef[]; x0: number; delta: Ticks; grabbed: Ticks; targets: Ticks[] }
  | { type: 'scale'; hit: KeyframeHit; refs: KeyframeRef[]; pivot: Ticks; grabbed: Ticks; factor: number }
  | { type: 'value'; hit: KeyframeHit; row: EditorRow; x0: number; y0: number; delta: Ticks; change: KeyframeChange; range: GraphRange }
  | { type: 'handle'; hit: KeyframeHit; row: EditorRow; change: KeyframeChange; range: GraphRange }

const PRESETS: Array<[InterpolationPreset, string]> = [
  ['linear', 'Linear'],
  ['bezier', 'Bezier'],
  ['hold', 'Hold'],
  ['ease-in', 'Ease In'],
  ['ease-out', 'Ease Out'],
  ['ease-in-out', 'Ease In and Out']
]

function committed(): Sequence | null {
  return projectController.project?.sequence ?? null
}

/** Absolute time of a keyframe. */
function absolute(sequence: Sequence, ref: KeyframeRef): Ticks | null {
  const clip = sequence.clips.find((c) => c.id === ref.clipId)
  const k = clip ? keyframesOf(clip, ref.effectId, ref.param).find((x) => x.id === ref.keyframeId) : undefined
  return clip && k ? clip.start + k.time : null
}

/**
 * The Keyframe Editor: every animated value of the selected clips. The dope sheet moves
 * keyframes in time (drag; Option-drag stretches the selection's timing; box-select on
 * empty space); the graph shows one value's curve, where keyframes drag in time and
 * value and bezier handles shape the curve. Each drag is one undo step.
 */
export function KeyframeEditorWindow() {
  useObservable(projectController)
  useObservable(tl)
  useObservable(keyframeController)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [view, setView] = useState<EditorView>({ pps: 60, scroll: 0, scrollY: 0 })
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const drag = useRef<Drag | null>(null)
  const [, redraw] = useState(0)
  const fitted = useRef<string>('')

  const project = projectController.project
  const sequence = tl.sequence
  const rows = sequence ? editorRows(sequence, tl.selection) : []
  const mode = keyframeController.mode
  const valueRows = rows.filter((r) => r.ref)
  const graphRow = valueRows.find((r) => keyframeController.isFocused(r.ref!)) ?? valueRows[0] ?? null
  const frozen = drag.current && (drag.current.type === 'value' || drag.current.type === 'handle') ? drag.current.range : null
  const range = frozen ?? (graphRow ? graphRange(graphRow, view, size) : { lo: 0, hi: 1 })

  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.max(200, entry.contentRect.width), height: Math.max(80, entry.contentRect.height) })
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [project !== null])

  // Fit the view to the selected clips whenever the selection changes (once the window has a size).
  const selectionKey = [...tl.selection].sort().join(',')
  useEffect(() => {
    if (selectionKey === fitted.current || rows.length === 0 || size.width === 0) return
    fitted.current = selectionKey
    fit()
  })

  function fit(): void {
    if (rows.length === 0) return
    const start = Math.min(...rows.map((r) => r.clip.start))
    const end = Math.max(...rows.map((r) => clipEnd(r.clip)))
    const seconds = Math.max(0.5, ticksToSeconds(end - start))
    const pps = Math.min(2400, Math.max(0.05, (size.width - LABEL_W - 40) / seconds))
    setView((v) => ({ ...v, pps, scroll: ticksToSeconds(start) - 20 / pps }))
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !sequence || size.width === 0) return
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
    const d = drag.current
    drawEditor(ctx, {
      rows,
      view,
      size,
      mode,
      graphRow,
      range,
      playhead: tl.playhead,
      fps: frameRateValue(frameRateOf(sequence.settings)),
      timecode: (t) => tl.timecode(t),
      isSelected: (ref) => keyframeController.isSelected(ref),
      isFocused: (ref) => keyframeController.isFocused(ref),
      marquee: d?.type === 'marquee' ? d : null,
      markers: sequence.markers.map((m) => m.time)
    })
  })

  if (!project || !sequence) return null

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const allShown = (): KeyframeRef[] =>
    (mode === 'graph' && graphRow ? [graphRow] : rows).flatMap((r) => (r.ref ? keyframesOf(r.clip, r.ref.effectId, r.ref.param).map((k) => ({ ...r.ref!, keyframeId: k.id })) : []))
  const hitAt = (x: number, y: number): KeyframeHit | null =>
    mode === 'dope' ? hitDope(rows, view, x, y) : graphRow ? hitGraph(graphRow, view, size, range, x, y, (r) => keyframeController.isSelected(r)) : null
  const rowAtY = (y: number): EditorRow | null => rows[Math.floor((y - RULER_H + view.scrollY) / ROW_H)] ?? null
  const preview = (apply: (d: Sequence) => void): boolean => {
    const base = committed()
    if (!base) return false
    try {
      tl.preview = produce(base, apply)
      tl.changed()
      return true
    } catch (error) {
      tl.preview = null
      projectController.showMessage((error as Error).message)
      drag.current = null
      tl.changed()
      return false
    }
  }
  const snapThreshold = secondsToTicks(SNAP_PIXELS / view.pps)

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    const { x, y } = local(event)
    canvasRef.current!.setPointerCapture(event.pointerId)
    canvasRef.current!.focus()
    if (y < RULER_H && x >= LABEL_W) {
      drag.current = { type: 'scrub' }
      tl.movePlayhead(xToTime(x, view))
      return
    }
    if (x < LABEL_W) {
      const row = rowAtY(y)
      if (row?.ref) keyframeController.focus(row.ref)
      return
    }
    const hit = hitAt(x, y)
    if (!hit) {
      const base = event.shiftKey || event.metaKey ? keyframeController.selection : []
      if (!event.shiftKey && !event.metaKey) keyframeController.select([], 'replace')
      drag.current = { type: 'marquee', x0: x, y0: y, x1: x, y1: y, base }
      return
    }
    if (event.shiftKey || event.metaKey) keyframeController.select([hit.ref], 'toggle')
    else if (!keyframeController.isSelected(hit.ref)) keyframeController.select([hit.ref], 'replace')
    const row = mode === 'graph' ? graphRow! : rowAtY(y)!
    if (row.ref) keyframeController.focus(row.ref)
    drag.current = { type: 'pending', hit, x0: x, y0: y, alt: event.altKey, row }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    if (!d) return
    const { x, y } = local(event)
    const base = committed()
    if (!base) return
    switch (d.type) {
      case 'scrub':
        tl.movePlayhead(xToTime(Math.max(LABEL_W, x), view))
        return
      case 'marquee': {
        d.x1 = x
        d.y1 = y
        const t0 = xToTime(Math.min(d.x0, x), view)
        const t1 = xToTime(Math.max(d.x0, x), view)
        const yTop = Math.min(d.y0, y)
        const yBottom = Math.max(d.y0, y)
        const hits: KeyframeRef[] = []
        const consider = (row: EditorRow, test: (k: Keyframe) => boolean) => {
          if (!row.ref) return
          for (const k of keyframesOf(row.clip, row.ref.effectId, row.ref.param)) {
            const at = row.clip.start + k.time
            if (at >= t0 && at <= t1 && test(k)) hits.push({ ...row.ref, keyframeId: k.id })
          }
        }
        if (mode === 'dope') {
          rows.forEach((row, i) => {
            const mid = rowTop(i, view) + ROW_H / 2
            if (mid >= yTop && mid <= yBottom) consider(row, () => true)
          })
        } else if (graphRow) {
          const n = graphRow.spec?.kind === 'point' ? 2 : 1
          consider(graphRow, (k) => {
            if (graphRow.spec?.kind === 'stepped') return true
            for (let c = 0; c < n; c++) {
              const ky = valueToY(components(k.value)?.[c] ?? 0, range, size)
              if (ky >= yTop && ky <= yBottom) return true
            }
            return false
          })
        }
        keyframeController.select([...d.base, ...hits], 'replace')
        redraw((n) => n + 1)
        return
      }
      case 'pending': {
        if (Math.hypot(x - d.x0, y - d.y0) < 3) return
        const refs = keyframeController.selection
        const grabbed = absolute(base, d.hit.ref)
        if (grabbed === null) return
        if (mode === 'graph' && d.hit.part !== 'key') {
          drag.current = { type: 'handle', hit: d.hit, row: d.row, change: {}, range }
        } else if (mode === 'graph' && d.row.spec?.kind !== 'stepped') {
          drag.current = { type: 'value', hit: d.hit, row: d.row, x0: d.x0, y0: d.y0, delta: 0, change: {}, range }
        } else if (d.alt && refs.length > 1) {
          // Option-drag stretches the selection's timing, pinned at the keyframe farthest from the one grabbed.
          const times = refs.map((r) => absolute(base, r)).filter((t): t is Ticks => t !== null)
          const pivot = times.reduce((far, t) => (Math.abs(t - grabbed) > Math.abs(far - grabbed) ? t : far), grabbed)
          drag.current = pivot === grabbed ? { type: 'move', hit: d.hit, refs, x0: d.x0, delta: 0, grabbed, targets: [] } : { type: 'scale', hit: d.hit, refs, pivot, grabbed, factor: 1 }
        } else {
          drag.current = { type: 'move', hit: d.hit, refs, x0: d.x0, delta: 0, grabbed, targets: moveTargets(base, refs) }
        }
        onPointerMove(event)
        return
      }
      case 'move': {
        let target = d.grabbed + xToTime(x, view) - xToTime(d.x0, view)
        if (tl.snapping && !event.shiftKey) target = snapTime(target, d.targets, snapThreshold).time
        d.delta = target - d.grabbed
        preview((s) => applyMoveKeyframes(s, d.refs, d.delta))
        return
      }
      case 'scale': {
        const target = xToTime(x, view)
        d.factor = Math.max(0, (target - d.pivot) / (d.grabbed - d.pivot))
        preview((s) => applyScaleKeyframes(s, d.refs, d.pivot, d.factor))
        return
      }
      case 'value': {
        const k = d.hit.keyframe
        const old = components(k.value) ?? [0]
        const next = [...old]
        // Shift: value only (keep the time).
        next[d.hit.component] = (old[d.hit.component] ?? 0) + yToValue(y, d.range, size) - yToValue(d.y0, d.range, size)
        d.delta = event.shiftKey ? 0 : xToTime(x, view) - xToTime(d.x0, view)
        d.change = { value: Array.isArray(k.value) ? [next[0]!, next[1]!] : next[0]! }
        preview((s) => applyDragKeyframe(s, d.hit.ref, d.delta, d.change))
        return
      }
      case 'handle': {
        const clip = base.clips.find((c) => c.id === d.hit.ref.clipId)
        if (!clip) return
        const track = keyframesOf(clip, d.hit.ref.effectId, d.hit.ref.param)
        const index = track.findIndex((k) => k.id === d.hit.ref.keyframeId)
        const k = track[index]
        const neighbour = d.hit.part === 'out' ? track[index + 1] : track[index - 1]
        if (!k || !neighbour) return
        const time = xToTime(x, view) - clip.start
        const span = Math.abs(neighbour.time - k.time)
        const t = Math.min(1, Math.max(0, (d.hit.part === 'out' ? time - k.time : k.time - time) / Math.max(1, span)))
        const handle = d.hit.part === 'out' ? k.out : k.in
        const v = [...handle.v]
        v[d.hit.component] = yToValue(y, d.range, size) - (components(k.value)?.[d.hit.component] ?? 0)
        d.change = d.hit.part === 'out' ? { out: { t, v } } : { in: { t, v } }
        preview((s) => applyKeyframeChange(s, d.hit.ref, d.change))
        return
      }
    }
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    tl.preview = null
    if (!d) return tl.changed()
    switch (d.type) {
      case 'move':
        if (d.delta !== 0) projectController.dispatch(moveKeyframes(d.refs, d.delta))
        break
      case 'scale':
        if (d.factor !== 1) projectController.dispatch(scaleKeyframes(d.refs, d.pivot, d.factor))
        break
      case 'value':
        if (d.change.value !== undefined) projectController.dispatch(dragKeyframe(d.hit.ref, d.delta, d.change))
        break
      case 'handle':
        if (d.change.in || d.change.out) projectController.dispatch(changeKeyframe(d.hit.ref, d.change))
        break
    }
    tl.changed()
    redraw((n) => n + 1)
  }

  /** Where a moved keyframe snaps: edit points, markers, the playhead and keyframes that aren't moving. */
  function moveTargets(base: Sequence, refs: KeyframeRef[]): Ticks[] {
    const moving = new Set(refs.map((r) => `${r.clipId}|${r.keyframeId}`))
    const targets = snapTargets(base, { playhead: tl.playhead, exclude: new Set() })
    for (const row of rows) {
      if (!row.ref) continue
      for (const k of keyframesOf(row.clip, row.ref.effectId, row.ref.param)) if (!moving.has(`${row.clip.id}|${k.id}`)) targets.push(row.clip.start + k.time)
    }
    return targets
  }

  const interpolate = (preset: InterpolationPreset) => {
    if (keyframeController.selected.size > 0) projectController.dispatch(setKeyframeInterpolation(keyframeController.selection, preset))
  }

  const contextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const { x, y } = local(event)
    const hit = hitAt(x, y)
    if (hit && !keyframeController.isSelected(hit.ref)) keyframeController.select([hit.ref], 'replace')
    const row = x < LABEL_W ? rowAtY(y) : mode === 'graph' ? graphRow : rowAtY(y)
    if (row?.ref && (x < LABEL_W || !hit)) keyframeController.focus(row.ref)
    const any = keyframeController.selected.size > 0
    const items: MenuEntry[] = [
      ...PRESETS.map(([preset, label]): MenuEntry => ({ label, onSelect: () => interpolate(preset), disabled: !any })),
      'separator',
      { label: 'Copy', shortcut: '⌘C', onSelect: () => keyframeController.copy(), disabled: !any },
      { label: 'Paste at Playhead', shortcut: '⌘V', onSelect: () => keyframeController.paste(), disabled: !keyframeController.clipboard },
      { label: 'Delete', shortcut: '⌫', onSelect: () => keyframeController.deleteSelected(), disabled: !any, danger: true },
      'separator',
      { label: 'Go to Keyframe', onSelect: () => hit && go(hit.ref), disabled: !hit },
      { label: 'Select All', shortcut: '⌘A', onSelect: () => keyframeController.select(allShown(), 'replace') }
    ]
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  const go = (ref: KeyframeRef) => {
    const base = committed()
    const at = base ? absolute(base, ref) : null
    if (at !== null) tl.movePlayhead(at)
  }

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const { x } = local(event)
    if (event.altKey || event.metaKey || event.ctrlKey) {
      const anchor = Math.max(LABEL_W, x)
      const at = (anchor - LABEL_W) / view.pps + view.scroll
      const pps = Math.min(2400, Math.max(0.05, view.pps * Math.exp(-event.deltaY * 0.0025)))
      setView({ ...view, pps, scroll: at - (anchor - LABEL_W) / pps })
    } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
      const dx = event.shiftKey ? event.deltaY : event.deltaX
      setView({ ...view, scroll: view.scroll + dx / view.pps })
    } else if (mode === 'dope') {
      const max = Math.max(0, rows.length * ROW_H - (size.height - RULER_H) + 8)
      setView({ ...view, scrollY: Math.min(max, Math.max(0, view.scrollY + event.deltaY)) })
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const cmd = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (event.key === 'Delete' || event.key === 'Backspace') keyframeController.deleteSelected()
    else if (cmd && key === 'c') keyframeController.copy()
    else if (cmd && key === 'v') keyframeController.paste()
    else if (cmd && key === 'a') keyframeController.select(allShown(), 'replace')
    else if (event.key === 'Escape') keyframeController.select([], 'replace')
    else if (!cmd && key === 'f') fit()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const selectedCount = keyframeController.selected.size
  return (
    <div className="keyframe-editor">
      <div className="kfe-toolbar">
        <div className="segmented" role="tablist">
          <button className={`segment ${mode === 'dope' ? 'active' : ''}`} onClick={() => keyframeController.setMode('dope')} title="Keyframes of every animated value, along time">
            Dope Sheet
          </button>
          <button className={`segment ${mode === 'graph' ? 'active' : ''}`} onClick={() => keyframeController.setMode('graph')} title="The focused value's curve, with bezier handles">
            Graph
          </button>
        </div>
        <span className="kfe-sep" />
        {PRESETS.map(([preset, label]) => (
          <button key={preset} className="button compact" disabled={selectedCount === 0} onClick={() => interpolate(preset)} title={`Selected keyframes: ${label}`}>
            {label}
          </button>
        ))}
        <span className="spacer" />
        <span className="muted small">{selectedCount > 0 ? `${selectedCount} selected` : ''}</span>
        <button className="button compact" onClick={fit} title="Fit the selected clips (F)">
          Fit
        </button>
      </div>
      <div className="kfe-area" ref={areaRef}>
        {rows.length === 0 ? (
          <div className="empty-state">
            <p className="muted">Select clips in the timeline to see their keyframes. Animate a value with its stopwatch (⏱) in Effect Controls.</p>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            className="kfe-canvas"
            tabIndex={0}
            style={{ width: size.width, height: size.height }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(event) => {
              const { x, y } = local(event)
              const hit = hitAt(x, y)
              if (hit) go(hit.ref)
            }}
            onContextMenu={contextMenu}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

