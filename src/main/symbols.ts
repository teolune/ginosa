import { nativeImage, screen } from 'electron'
import { SYMBOLS, type SymbolName, type SymbolSet } from '../shared/symbols'

/** Rendered large and scaled down by the renderer, so icons stay sharp on Retina screens. */
const POINT_SIZE = 48

let cached: SymbolSet | null = null

/** Asks macOS for every SF Symbol the interface uses. Missing ones are left out; the UI falls back to text. */
export function renderSymbols(): SymbolSet {
  if (cached) return cached
  const set: SymbolSet = {}
  if (process.platform !== 'darwin') return (cached = set)
  // macOS draws the symbol at the screen's backing scale (2x on Retina) but labels it 1x,
  // so pixels / (point size × backing scale) gives the size relative to the font size.
  const backing = screen.getPrimaryDisplay().scaleFactor || 2
  for (const [key, name] of Object.entries(SYMBOLS) as Array<[SymbolName, string]>) {
    try {
      const image = nativeImage.createFromNamedImage(name, { pointSize: POINT_SIZE, weight: 'regular', scale: 'medium' })
      if (image.isEmpty()) continue
      const { width, height } = image.getSize()
      set[key] = { url: image.toDataURL(), width: width / (POINT_SIZE * backing), height: height / (POINT_SIZE * backing) }
    } catch {
      // Unknown on this macOS version: fall back to text.
    }
  }
  return (cached = set)
}
