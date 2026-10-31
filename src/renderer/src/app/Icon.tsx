import type { CSSProperties } from 'react'
import type { SymbolName, SymbolSet } from '@shared/symbols'

let symbols: SymbolSet = {}

/** Fetches the SF Symbols from the main process once, before the interface first renders. */
export async function loadSymbols(): Promise<void> {
  try {
    symbols = await window.ginosa.ui.symbols()
  } catch (error) {
    console.warn(`SF Symbols unavailable, using text icons: ${(error as Error).message}`)
  }
}

/**
 * An SF Symbol, sized by the surrounding font size and coloured by `color` (it's used
 * as a mask), so hover, active and disabled states work like text. Falls back to text
 * if macOS doesn't know the symbol.
 */
export function Icon({ name, fallback, className }: { name: SymbolName; fallback: string; className?: string }) {
  const image = symbols[name]
  if (!image) return <span className={`icon-fallback ${className ?? ''}`}>{fallback}</span>
  const style = {
    width: `${image.width}em`,
    height: `${image.height}em`,
    WebkitMaskImage: `url(${image.url})`,
    maskImage: `url(${image.url})`
  } as CSSProperties
  return <span className={`icon ${className ?? ''}`} style={style} aria-hidden="true" />
}
