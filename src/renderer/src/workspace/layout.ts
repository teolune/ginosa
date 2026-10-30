/**
 * Floating-window layout: pure functions, no DOM, so they are unit-tested.
 * Coordinates are CSS pixels relative to the workspace area (below the title bar).
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  w: number
  h: number
}

export type WindowMode = 'normal' | 'minimized' | 'maximized'

export interface WindowLayout {
  open: boolean
  rect: Rect
  mode: WindowMode
  docked: boolean
  z: number
}

export interface WorkspaceLayout {
  windows: Record<string, WindowLayout>
  mediaWidth: number
  timelineHeight: number
  dockWidth: number
}

export interface WorkspaceFile {
  version: 1
  active: string
  layouts: Record<string, WorkspaceLayout>
}

export interface WindowSpec {
  id: string
  title: string
  /** Electron accelerator, shown in the Window menu. */
  shortcut: string
  defaultRect: Rect
  minSize: Size
  dockable: boolean
  defaultOpen: boolean
  defaultDocked: boolean
}

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const TITLE_BAR_HEIGHT = 28
/** How much of a window must stay inside the workspace so it can always be grabbed. */
export const GRAB_MARGIN = 80
export const SNAP_DISTANCE = 8
export const DEFAULT_WORKSPACE = 'Edit'

export const PANEL_LIMITS = {
  mediaWidth: { min: 180, max: 560, initial: 260 },
  timelineHeight: { min: 140, max: 640, initial: 280 },
  dockWidth: { min: 240, max: 560, initial: 320 }
} as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** Keeps a window a sensible size and its title bar reachable inside `bounds`. */
export function clampRect(rect: Rect, bounds: Size, min: Size): Rect {
  const w = clamp(Math.round(rect.w), min.w, bounds.w)
  const h = clamp(Math.round(rect.h), min.h, bounds.h)
  const x = clamp(Math.round(rect.x), GRAB_MARGIN - w, bounds.w - GRAB_MARGIN)
  const y = clamp(Math.round(rect.y), 0, bounds.h - TITLE_BAR_HEIGHT)
  return { x, y, w, h }
}

/** Snaps a moving window's edges to the workspace edges and to other windows' edges. */
export function snapMove(rect: Rect, bounds: Size, others: Rect[], distance = SNAP_DISTANCE): Rect {
  const xTargets = [0, bounds.w]
  const yTargets = [0, bounds.h]
  for (const other of others) {
    xTargets.push(other.x, other.x + other.w)
    yTargets.push(other.y, other.y + other.h)
  }
  const snapAxis = (start: number, size: number, targets: number[]): number => {
    let best = start
    let bestDistance = distance + 1
    for (const target of targets) {
      for (const [edge, offset] of [
        [start, 0],
        [start + size, size]
      ] as const) {
        const d = Math.abs(edge - target)
        if (d < bestDistance) {
          bestDistance = d
          best = target - offset
        }
      }
    }
    return best
  }
  return { ...rect, x: snapAxis(rect.x, rect.w, xTargets), y: snapAxis(rect.y, rect.h, yTargets) }
}

/** New rect after dragging `edge` by (dx, dy) from `start`, respecting the minimum size. */
export function resizeRect(start: Rect, edge: ResizeEdge, dx: number, dy: number, min: Size): Rect {
  let { x, y, w, h } = start
  if (edge.includes('e')) w = Math.max(min.w, start.w + dx)
  if (edge.includes('s')) h = Math.max(min.h, start.h + dy)
  if (edge.includes('w')) {
    w = Math.max(min.w, start.w - dx)
    x = start.x + start.w - w
  }
  if (edge.includes('n')) {
    h = Math.max(min.h, start.h - dy)
    y = start.y + start.h - h
  }
  return { x, y, w, h }
}

/** Snaps only the edges being dragged during a resize. */
export function snapResize(rect: Rect, edge: ResizeEdge, bounds: Size, others: Rect[], min: Size, distance = SNAP_DISTANCE): Rect {
  const xTargets = [0, bounds.w, ...others.flatMap((o) => [o.x, o.x + o.w])]
  const yTargets = [0, bounds.h, ...others.flatMap((o) => [o.y, o.y + o.h])]
  const nearest = (value: number, targets: number[]): number => {
    let best = value
    let bestDistance = distance + 1
    for (const target of targets) {
      const d = Math.abs(value - target)
      if (d < bestDistance) {
        bestDistance = d
        best = target
      }
    }
    return best
  }
  let { x, y, w, h } = rect
  if (edge.includes('e')) w = Math.max(min.w, nearest(x + w, xTargets) - x)
  if (edge.includes('s')) h = Math.max(min.h, nearest(y + h, yTargets) - y)
  if (edge.includes('w')) {
    const left = nearest(x, xTargets)
    const right = x + w
    if (right - left >= min.w) {
      x = left
      w = right - left
    }
  }
  if (edge.includes('n')) {
    const top = nearest(y, yTargets)
    const bottom = y + h
    if (bottom - top >= min.h) {
      y = top
      h = bottom - top
    }
  }
  return { x, y, w, h }
}

export function topZ(layout: WorkspaceLayout): number {
  return Object.values(layout.windows).reduce((max, w) => Math.max(max, w.z), 0)
}

export function defaultLayout(specs: WindowSpec[]): WorkspaceLayout {
  const windows: Record<string, WindowLayout> = {}
  specs.forEach((spec, index) => {
    windows[spec.id] = { open: spec.defaultOpen, rect: { ...spec.defaultRect }, mode: 'normal', docked: spec.defaultDocked, z: index + 1 }
  })
  return {
    windows,
    mediaWidth: PANEL_LIMITS.mediaWidth.initial,
    timelineHeight: PANEL_LIMITS.timelineHeight.initial,
    dockWidth: PANEL_LIMITS.dockWidth.initial
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

/** Accepts a saved layout from disk, repairing anything missing or invalid. */
export function normaliseLayout(raw: unknown, specs: WindowSpec[]): WorkspaceLayout {
  const base = defaultLayout(specs)
  if (!isRecord(raw)) return base
  const windows = isRecord(raw['windows']) ? raw['windows'] : {}
  for (const spec of specs) {
    const saved = windows[spec.id]
    if (!isRecord(saved)) continue
    const rect = isRecord(saved['rect']) ? saved['rect'] : {}
    const mode = saved['mode']
    base.windows[spec.id] = {
      open: saved['open'] === true,
      docked: spec.dockable && saved['docked'] === true,
      mode: mode === 'minimized' || mode === 'maximized' ? mode : 'normal',
      z: readNumber(saved['z'], base.windows[spec.id]?.z ?? 1, 0, 10_000),
      rect: {
        x: readNumber(rect['x'], spec.defaultRect.x, -5000, 10_000),
        y: readNumber(rect['y'], spec.defaultRect.y, 0, 10_000),
        w: readNumber(rect['w'], spec.defaultRect.w, spec.minSize.w, 10_000),
        h: readNumber(rect['h'], spec.defaultRect.h, spec.minSize.h, 10_000)
      }
    }
  }
  const limits = PANEL_LIMITS
  base.mediaWidth = readNumber(raw['mediaWidth'], limits.mediaWidth.initial, limits.mediaWidth.min, limits.mediaWidth.max)
  base.timelineHeight = readNumber(raw['timelineHeight'], limits.timelineHeight.initial, limits.timelineHeight.min, limits.timelineHeight.max)
  base.dockWidth = readNumber(raw['dockWidth'], limits.dockWidth.initial, limits.dockWidth.min, limits.dockWidth.max)
  return base
}

export function normaliseWorkspaceFile(raw: unknown, specs: WindowSpec[]): WorkspaceFile {
  const file: WorkspaceFile = { version: 1, active: DEFAULT_WORKSPACE, layouts: { [DEFAULT_WORKSPACE]: defaultLayout(specs) } }
  if (!isRecord(raw) || !isRecord(raw['layouts'])) return file
  for (const [name, layout] of Object.entries(raw['layouts'])) {
    if (name.trim().length === 0 || name.length > 60) continue
    file.layouts[name] = normaliseLayout(layout, specs)
  }
  const active = raw['active']
  if (typeof active === 'string' && file.layouts[active]) file.active = active
  return file
}
