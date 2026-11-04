import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * A detented knob (M12) for a steps parameter: drag up or right to turn it up, down or left
 * to turn it down (one step every 8 px), arrow keys step it, double-click goes back to the
 * default. The readout says what the step means (e.g. "1/16 · 8.53 fps").
 */

const SWEEP = 270
const PIXELS_PER_STEP = 8

export function StepsKnob({ value, steps, defaultValue, onChange, disabled, label, readout }: { value: number; steps: ReadonlyArray<{ id: string; label: string }>; defaultValue: number; onChange(value: number): void; disabled: boolean; label: string; readout?: string | null }) {
  const drag = useRef<{ x: number; y: number; from: number } | null>(null)
  const count = steps.length
  const index = Math.min(count - 1, Math.max(0, Math.round(value)))
  const set = (v: number) => {
    const next = Math.min(count - 1, Math.max(0, Math.round(v)))
    if (next !== index) onChange(next)
  }
  const angle = -SWEEP / 2 + (count > 1 ? (index / (count - 1)) * SWEEP : 0)
  const rad = ((angle - 90) * Math.PI) / 180
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, from: index }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    const moved = (event.clientX - d.x - (event.clientY - d.y)) / PIXELS_PER_STEP
    set(d.from + Math.trunc(moved))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0
    if (delta) {
      event.preventDefault()
      event.stopPropagation()
      set(index + delta)
    }
  }
  // The detents: a tick for every step.
  const ticks = steps.map((_, i) => {
    const a = ((-SWEEP / 2 + (count > 1 ? (i / (count - 1)) * SWEEP : 0) - 90) * Math.PI) / 180
    return <line key={i} x1={14 + Math.cos(a) * 11.5} y1={14 + Math.sin(a) * 11.5} x2={14 + Math.cos(a) * 13.5} y2={14 + Math.sin(a) * 13.5} className={i <= index ? 'knob-tick on' : 'knob-tick'} />
  })
  return (
    <span className="steps-knob">
      <button
        className="knob"
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={count - 1}
        aria-valuenow={index}
        aria-valuetext={readout ?? steps[index]?.label}
        title={`${steps[index]?.label ?? ''}: drag up or down, or use the arrow keys. Double-click for the default.`}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => !disabled && set(defaultValue)}
        onKeyDown={onKeyDown}
      >
        <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
          {ticks}
          <circle cx="14" cy="14" r="9" className="knob-body" />
          <line x1="14" y1="14" x2={14 + Math.cos(rad) * 7.5} y2={14 + Math.sin(rad) * 7.5} className="knob-pointer" />
        </svg>
      </button>
      <span className="knob-readout">{readout ?? steps[index]?.label}</span>
    </span>
  )
}
