import { useRef, type PointerEvent as ReactPointerEvent } from 'react'

interface Props {
  value: number
  min: number
  max: number
  /** Double-click goes back here. */
  reset: number
  /** Where the arc starts: the knob's rest (0 for strength, the middle for nudge). */
  origin: number
  label: string
  format(value: number): string
  /** `stroke` stays the same through one drag, so it's one undo step. */
  onChange(value: number, stroke: string): void
  disabled?: boolean
}

const SWEEP = 270

function point(turn: number, r: number): [number, number] {
  const a = ((-SWEEP / 2 + turn * SWEEP) * Math.PI) / 180
  return [10 + Math.sin(a) * r, 10 - Math.cos(a) * r]
}

function arc(from: number, to: number, r: number): string {
  const [a, b] = from <= to ? [from, to] : [to, from]
  const [x0, y0] = point(a, r)
  const [x1, y1] = point(b, r)
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${(b - a) * SWEEP > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

/** A small knob (the Channel Rack's strength and nudge): drag up or down, scroll, arrows; double-click resets. */
export function MiniKnob({ value, min, max, reset, origin, label, format, onChange, disabled }: Props) {
  const drag = useRef<{ y: number; start: number; stroke: string } | null>(null)
  const turn = (v: number) => (v - min) / (max - min)
  const set = (v: number, stroke: string) => onChange(Math.round(Math.min(max, Math.max(min, v)) * 10) / 10, stroke)
  const span = max - min
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { y: event.clientY, start: value, stroke: `${label}:${Date.now()}` }
  }
  const [px, py] = point(turn(value), 5.5)
  return (
    <button
      className="mini-knob"
      aria-label={label}
      title={`${label}: ${format(value)}. Drag up or down (Shift: finer), double-click to reset.`}
      disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        const d = drag.current
        if (!d) return
        set(d.start + ((d.y - event.clientY) / (event.shiftKey ? 600 : 150)) * span, d.stroke)
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => set(reset, `${label}:reset:${Date.now()}`)}
      onWheel={(event) => set(value + (event.deltaY < 0 ? 1 : -1) * span * 0.02, `${label}:wheel`)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        event.stopPropagation()
        set(value + (event.key === 'ArrowUp' ? 1 : -1) * span * 0.02, `${label}:keys`)
      }}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <path d={arc(0, 1, 8)} className="mini-knob-track" />
        {Math.abs(turn(value) - turn(origin)) > 0.004 && <path d={arc(turn(origin), turn(value), 8)} className="mini-knob-arc" />}
        <circle cx="10" cy="10" r="6" className="mini-knob-body" />
        <line x1="10" y1="10" x2={px.toFixed(2)} y2={py.toFixed(2)} className="mini-knob-pointer" />
      </svg>
    </button>
  )
}
