import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { MAX_BPM, MIN_BPM } from '@engine/audio/beat-grid'

/** The tempo knob turns on a log scale, so 60–200 BPM gets most of its travel. */
const LOG_SPAN = Math.log(MAX_BPM / MIN_BPM)
const SWEEP = 270

export function bpmTurn(bpm: number): number {
  return Math.min(1, Math.max(0, Math.log(bpm / MIN_BPM) / LOG_SPAN))
}

export function clampBpm(value: number): number {
  return Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, value)) * 1000) / 1000
}

/**
 * The tempo after dragging `pixels` (up or right is positive): whole BPM, one per 4 px,
 * keeping any decimals; Shift moves 10 at a time; Option moves a hundredth per pixel.
 */
export function dragBpm(start: number, pixels: number, fine: boolean, fast: boolean): number {
  if (fine) return clampBpm(start + pixels * 0.01)
  return clampBpm(start + Math.trunc(pixels / 4) * (fast ? 10 : 1))
}

/** Typed tempo: a number from MIN_BPM to MAX_BPM, up to three decimals (a comma works too). */
export function parseBpm(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'))
  if (!Number.isFinite(value) || value < MIN_BPM || value > MAX_BPM) return null
  return Math.round(value * 1000) / 1000
}

function point(turn: number, radius: number): string {
  const angle = ((-SWEEP / 2 + turn * SWEEP) * Math.PI) / 180
  return `${(16 + Math.sin(angle) * radius).toFixed(2)} ${(16 - Math.cos(angle) * radius).toFixed(2)}`
}

function arc(from: number, to: number, radius: number): string {
  const large = (to - from) * SWEEP > 180 ? 1 : 0
  return `M ${point(from, radius)} A ${radius} ${radius} 0 ${large} 1 ${point(to, radius)}`
}

interface Props {
  bpm: number
  /** False while there is no beat grid yet: the knob shows 120 and turning it makes one. */
  set: boolean
  onChange(bpm: number, label: string): void
  onInvalid(message: string): void
}

/** The Control Panel's tempo: a knob to drag or scroll, and the number to click and type (to 999.999). */
export function BpmKnob({ bpm, set, onChange, onInvalid }: Props) {
  const [typing, setTyping] = useState(false)
  const drag = useRef<{ x: number; y: number; start: number } | null>(null)
  const turn = bpmTurn(bpm)

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, start: bpm }
    document.body.classList.add('dragging')
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d) return
    const pixels = d.y - event.clientY + (event.clientX - d.x)
    const next = dragBpm(d.start, pixels, event.altKey, event.shiftKey)
    if (next !== bpm || !set) onChange(next, 'Change Tempo')
  }
  const onPointerUp = () => {
    drag.current = null
    document.body.classList.remove('dragging')
  }
  const onWheel = (event: ReactWheelEvent<HTMLButtonElement>) => {
    const steps = event.deltaY < 0 ? 1 : -1
    onChange(clampBpm(bpm + steps * (event.altKey ? 0.01 : event.shiftKey ? 10 : 1)), 'Change Tempo')
  }

  return (
    <span className={`bpm ${set ? '' : 'unset'}`}>
      <button
        className="knob bpm-knob"
        aria-label="Tempo"
        title="Tempo: drag up or down, or scroll (Shift: 10 BPM at a time, Option: hundredths). Arrow keys nudge."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onKeyDown={(event) => {
          const step = event.altKey ? 0.01 : event.shiftKey ? 10 : 1
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(clampBpm(bpm + step), 'Change Tempo')
          else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(clampBpm(bpm - step), 'Change Tempo')
          else return
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
          <path d={arc(0, 1, 14)} className="bpm-track" />
          {turn > 0.002 && <path d={arc(0, turn, 14)} className="bpm-arc" />}
          <circle cx="16" cy="16" r="10" className="bpm-body" />
          <line x1="16" y1="16" x2={point(turn, 8.5).split(' ')[0]} y2={point(turn, 8.5).split(' ')[1]} className="bpm-pointer" />
        </svg>
      </button>
      {typing ? (
        <input
          className="input compact bpm-input mono"
          aria-label="Tempo in BPM"
          defaultValue={bpm.toFixed(3)}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            const text = event.currentTarget.value
            setTyping(false)
            const parsed = parseBpm(text)
            if (parsed === null) onInvalid(`Tempo must be a number from ${MIN_BPM} to ${MAX_BPM} BPM`)
            else if (parsed !== bpm || !set) onChange(parsed, 'Type Tempo')
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = bpm.toFixed(3)
              event.currentTarget.blur()
            }
          }}
        />
      ) : (
        <button className="bpm-readout mono" title={set ? 'Click to type a tempo (up to 999.999)' : 'No beat grid yet: click to type a tempo, or detect it'} onClick={() => setTyping(true)}>
          {bpm.toFixed(3)}
        </button>
      )}
    </span>
  )
}
