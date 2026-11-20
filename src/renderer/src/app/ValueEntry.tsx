import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Typing a knob's value (your request, 20 Nov): right-click a knob and a small box opens at the
 * pointer with its value selected. Enter sets it, Esc or clicking away closes it; a value that
 * doesn't fit says why and stays open.
 */
export function ValueEntry({ x, y, label, value, hint, options, onCommit, onClose }: { x: number; y: number; label: string; value: string; hint: string; options?: readonly string[]; onCommit(text: string): string | null; onClose(): void }) {
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const listId = options ? `value-entry-${label.replace(/\W+/g, '-')}` : undefined
  return createPortal(
    // Events stop here: React passes a portal's events up to the knob it belongs to (a drag, a double-click reset).
    <div
      className="value-entry"
      style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 90) }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <label className="small muted">{label}</label>
      <input
        ref={ref}
        className="input compact mono"
        aria-label={label}
        defaultValue={value}
        list={listId}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
          if (event.key !== 'Enter') return
          const problem = onCommit(event.currentTarget.value)
          if (problem) setError(problem)
          else onClose()
        }}
        onBlur={onClose}
      />
      {listId && (
        <datalist id={listId}>
          {options!.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
      <span className={`small ${error ? 'value-entry-error' : 'muted'}`}>{error ?? hint}</span>
    </div>,
    document.body
  )
}

/** A typed number: a comma works as a decimal point; null when it isn't a number. */
export function parseTyped(text: string): number | null {
  const v = Number(text.trim().replace(',', '.').replace(/[^\d.+-]+$/, ''))
  return text.trim() !== '' && Number.isFinite(v) ? v : null
}
