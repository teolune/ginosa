/**
 * Interface icons are Apple's SF Symbols, drawn by macOS itself at runtime
 * (Electron's nativeImage.createFromNamedImage). Nothing is bundled. Browse names
 * in Apple's free SF Symbols app.
 */
export const SYMBOLS = {
  eye: 'eye',
  eyeSlash: 'eye.slash',
  speaker: 'speaker.wave.2',
  speakerSlash: 'speaker.slash',
  lock: 'lock.fill',
  lockOpen: 'lock.open',
  close: 'xmark',
  minimise: 'minus',
  maximise: 'arrow.up.left.and.arrow.down.right',
  restore: 'arrow.down.right.and.arrow.up.left',
  dock: 'sidebar.right',
  undock: 'macwindow.on.rectangle',
  chevronRight: 'chevron.right',
  chevronDown: 'chevron.down',
  folder: 'folder.fill',
  musicNote: 'music.note',
  play: 'play.fill',
  stop: 'stop.fill',
  syncLock: 'arrow.left.arrow.right.square',
  syncLockOn: 'arrow.left.arrow.right.square.fill',
  solo: 's.circle',
  soloOn: 's.circle.fill',
  toolSelect: 'cursorarrow',
  toolForward: 'arrow.right.to.line',
  toolBackward: 'arrow.left.to.line',
  toolRipple: 'arrow.right.and.line.vertical.and.arrow.left',
  toolRoll: 'arrow.left.and.line.vertical.and.arrow.right',
  toolRazor: 'scissors',
  magnet: 'magnet',
  zoomIn: 'plus.magnifyingglass',
  zoomOut: 'minus.magnifyingglass',
  zoomFit: 'arrow.left.and.right'
} as const

export type SymbolName = keyof typeof SYMBOLS

/** A rendered symbol: a PNG data URL (black on transparent, used as a mask) and its size in em. */
export interface SymbolImage {
  url: string
  /** Width and height relative to the font size, so symbols keep Apple's relative proportions. */
  width: number
  height: number
}

export type SymbolSet = Partial<Record<SymbolName, SymbolImage>>
