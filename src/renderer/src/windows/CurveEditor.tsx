import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { IDENTITY_CURVE, MAX_CURVE_POINTS, curveValue, formatCurve, parseCurve, type CurvePoint } from '@engine/effects/curves'

/**
 * A curve, edited as in Photoshop: click to add a point (up to 16), drag points to reshape,
 * drag one off the graph or double-click it to remove it, arrow keys to nudge the selected
 * point by one level (Shift: ten). The ends can move too. A drag is one undo step.
 */

const SIZE = 256
const PAD = 8
const VIEW = SIZE + 2 * PAD
/** Closest two points may be along x (in 0–1). */
const GAP = 1 / 255
/** How far off the graph (in 0–1) a dragged point is removed. */
const OFF = 0.12
/** Hit radius around a point, in graph pixels. */
const HIT = 9

export const CHANNEL_COLOURS: Record<string, string> = { master: '#d9d9d9', red: '#ff6b6b', green: '#4fd47a', blue: '#6b9bff' }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const level = (v: number) => Math.round(v * 255)

export function CurveEditor({ value, onChange, colour, disabled, label }: { value: string; onChange(value: string): void; colour: string; disabled: boolean; label: string }) {
  const stored = useMemo(() => parseCurve(value) ?? parseCurve(IDENTITY_CURVE)!, [value])
  const [selected, setSelected] = useState<number | null>(null)
  // While a point is dragged off the graph it's shown removed, and removed on release.
  const [drag, setDrag] = useState<{ index: number; off: boolean } | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const points = drag?.off ? stored.filter((_, i) => i !== drag.index) : stored

  const toCurve = (event: { clientX: number; clientY: number }): CurvePoint => {
    const r = svg.current!.getBoundingClientRect()
    const x = (((event.clientX - r.left) / r.width) * VIEW - PAD) / SIZE
    const y = 1 - (((event.clientY - r.top) / r.height) * VIEW - PAD) / SIZE
    return [x, y]
  }
  const commit = (next: CurvePoint[]) => {
    const text = formatCurve(next)
    if (text !== formatCurve(stored)) onChange(text)
  }
  /** Moves point `index` towards (x, y), kept between its neighbours. */
  const moved = (index: number, [x, y]: CurvePoint): CurvePoint[] => {
    const lo = index > 0 ? stored[index - 1]![0] + GAP : 0
    const hi = index < stored.length - 1 ? stored[index + 1]![0] - GAP : 1
    return stored.map((p, i) => (i === index ? [Math.min(hi, Math.max(lo, x)), clamp01(y)] : p))
  }
  const hitTest = (event: { clientX: number; clientY: number }): number | null => {
    const r = svg.current!.getBoundingClientRect()
    const scale = r.width / VIEW
    let best: number | null = null
    let distance = HIT * scale
    stored.forEach(([px, py], i) => {
      const sx = r.left + (PAD + px * SIZE) * scale
      const sy = r.top + (PAD + (1 - py) * SIZE) * scale
      const d = Math.hypot(event.clientX - sx, event.clientY - sy)
      if (d <= distance) (distance = d), (best = i)
    })
    return best
  }

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0) return
    svg.current!.focus()
    let index = hitTest(event)
    if (index === null) {
      const [x, y] = toCurve(event)
      if (x < 0 || x > 1 || stored.length >= MAX_CURVE_POINTS) return
      if (stored.some(([px]) => Math.abs(px - x) < GAP)) return
      const at = stored.findIndex(([px]) => px > x)
      const next = [...stored]
      next.splice(at < 0 ? stored.length : at, 0, [x, clamp01(y)])
      index = at < 0 ? stored.length : at
      commit(next)
    }
    setSelected(index)
    setDrag({ index, off: false })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return
    const [x, y] = toCurve(event)
    const off = stored.length > 2 && (x < -OFF || x > 1 + OFF || y < -OFF || y > 1 + OFF)
    if (off !== drag.off) setDrag({ ...drag, off })
    if (!off) commit(moved(drag.index, [x, y]))
  }
  const onPointerUp = () => {
    if (drag?.off) {
      commit(stored.filter((_, i) => i !== drag.index))
      setSelected(null)
    }
    setDrag(null)
  }
  const remove = (index: number) => {
    if (stored.length <= 2) return
    commit(stored.filter((_, i) => i !== index))
    setSelected(null)
  }
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (disabled || selected === null || selected >= stored.length) return
    const step = (event.shiftKey ? 10 : 1) / 255
    const [x, y] = stored[selected]!
    const nudge: Record<string, CurvePoint> = { ArrowLeft: [x - step, y], ArrowRight: [x + step, y], ArrowUp: [x, y + step], ArrowDown: [x, y - step] }
    if (nudge[event.key]) {
      event.preventDefault()
      event.stopPropagation()
      commit(moved(selected, nudge[event.key]!))
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      remove(selected)
    }
  }

  const path = useMemo(() => {
    const steps = 128
    return Array.from({ length: steps + 1 }, (_, i) => {
      const x = i / steps
      return `${i ? 'L' : 'M'}${(PAD + x * SIZE).toFixed(1)},${(PAD + (1 - curveValue(points, x)) * SIZE).toFixed(1)}`
    }).join(' ')
  }, [points])
  const shown = selected !== null && !drag?.off ? stored[selected] : null
  return (
    <div className="curve-editor">
      <svg
        ref={svg}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className={`curve-graph ${disabled ? 'disabled' : ''}`}
        role="application"
        aria-label={`${label} curve`}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <rect x={PAD} y={PAD} width={SIZE} height={SIZE} className="curve-bg" />
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f} className="curve-grid">
            <line x1={PAD + f * SIZE} y1={PAD} x2={PAD + f * SIZE} y2={PAD + SIZE} />
            <line x1={PAD} y1={PAD + f * SIZE} x2={PAD + SIZE} y2={PAD + f * SIZE} />
          </g>
        ))}
        <line className="curve-diagonal" x1={PAD} y1={PAD + SIZE} x2={PAD + SIZE} y2={PAD} />
        <path d={path} className="curve-line" style={{ stroke: colour }} />
        {stored.map(([x, y], i) => (
          <rect
            key={i}
            className={`curve-point ${i === selected ? 'selected' : ''} ${drag?.off && drag.index === i ? 'removing' : ''}`}
            x={PAD + x * SIZE - 4}
            y={PAD + (1 - y) * SIZE - 4}
            width={8}
            height={8}
            onDoubleClick={(event) => (event.stopPropagation(), remove(i))}
          />
        ))}
      </svg>
      <div className="curve-readout muted small">
        {drag?.off ? 'Release to remove this point' : shown ? `Input ${level(shown[0])} → Output ${level(shown[1])}` : stored.length >= MAX_CURVE_POINTS ? `${MAX_CURVE_POINTS} points (the most)` : 'Click to add a point · drag one off or double-click to remove'}
      </div>
    </div>
  )
}
