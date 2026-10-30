import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  /** Called once when editing ends (Enter or leaving the field), not on every keystroke. */
  onCommit(value: string): void
  autoSelect?: boolean
}

/** A text field that edits a local draft and commits it as one undoable change. Escape cancels. */
export function CommitInput({ value, onCommit, autoSelect, onBlur, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)

  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (autoSelect) ref.current?.select()
  }, [autoSelect])

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    if (draft !== value) onCommit(draft)
  }

  return (
    <input
      {...rest}
      ref={ref}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        commit()
        onBlur?.(event)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          cancelled.current = true
          setDraft(value)
          event.currentTarget.blur()
        }
        onKeyDown?.(event)
      }}
    />
  )
}
