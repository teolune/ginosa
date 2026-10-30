import { useEffect, useRef } from 'react'

export interface MenuItem {
  label: string
  onSelect(): void
  disabled?: boolean
  danger?: boolean
}

export type MenuEntry = MenuItem | 'separator'

/** A small right-click menu, closed by clicking elsewhere or pressing Escape. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && ref.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  const left = Math.min(x, window.innerWidth - 240)
  const top = Math.min(y, window.innerHeight - items.length * 26 - 12)
  return (
    <div ref={ref} className="context-menu" style={{ left, top }} role="menu">
      {items.map((item, index) =>
        item === 'separator' ? (
          <div key={`sep-${index}`} className="context-separator" />
        ) : (
          <button
            key={item.label}
            className={`context-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            role="menuitem"
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
