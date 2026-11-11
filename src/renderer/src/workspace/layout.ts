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

/**
 * Frames (decision 95): presets for where the panels sit. Landscape is the desktop wireframe
 * (media | preview | effects, the timeline under media and preview); portrait is the mobile
 * wireframe (media | effects | a tall preview, the timeline under media and effects). Auto
 * picks portrait for sequences taller than they are wide.
 */
export type FrameChoice = 'auto' | 'landscape' | 'portrait'
export type Frame = 'landscape' | 'portrait'

export interface WorkspaceLayout {
  windows: Record<string, WindowLayout>
  mediaWidth: number
  timelineHeight: number
  dockWidth: number
  frame: FrameChoice
  /** The left column (media, folders): the Control Panel's Open/Close Import Folder. */
  mediaOpen: boolean
  /** The tall preview column in the portrait frame. */
  previewWidth: number
}

export function resolveFrame(choice: FrameChoice, sequence: Frame): Frame {
  return choice === 'auto' ? sequence : choice
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
  mediaWidth: { min: 200, max: 760, initial: 460 },
  timelineHeight: { min: 140, max: 640, initial: 280 },
  dockWidth: { min: 240, max: 640, initial: 340 },
  previewWidth: { min: 240, max: 1000, initial: 420 }
} as const

export type PanelKey = keyof typeof PANEL_LIMITS

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
    dockWidth: PANEL_LIMITS.dockWidth.initial,
    frame: 'auto',
    mediaOpen: true,
    previewWidth: PANEL_LIMITS.previewWidth.initial
  }
}

/** Width of the gaps between panels, which are also the drag handles. */
export const SPLIT = 6

export type GridArea = 'media' | 'preview' | 'dock' | 'timeline' | 'empty' | 'split-media' | 'split-side' | 'split-timeline'

export interface WorkspaceGrid {
  columns: string
  rows: string
  /** CSS grid-template-areas. */
  areas: string
  /** The areas in use (each panel and handle is rendered only if its area is here). */
  uses: Set<GridArea>
}

/**
 * Where the panels sit for a frame. Landscape: media | preview, the timeline under both, the
 * dock column on the right at full height. Portrait: media | dock, the timeline under both,
 * the tall preview on the right at full height. Closing the media column (or having nothing
 * docked) gives its room to the neighbour.
 */
export function workspaceGrid(layout: WorkspaceLayout, frame: Frame, hasDock: boolean): WorkspaceGrid {
  const upper: Array<{ area: GridArea; width: string }> = []
  const side: Array<{ area: GridArea; width: string }> = []
  const media = layout.mediaOpen
  if (frame === 'landscape') {
    if (media) upper.push({ area: 'media', width: `${layout.mediaWidth}px` }, { area: 'split-media', width: `${SPLIT}px` })
    upper.push({ area: 'preview', width: '1fr' })
    if (hasDock) side.push({ area: 'split-side', width: `${SPLIT}px` }, { area: 'dock', width: `${layout.dockWidth}px` })
  } else {
    if (media && hasDock) upper.push({ area: 'media', width: `${layout.mediaWidth}px` }, { area: 'split-media', width: `${SPLIT}px` }, { area: 'dock', width: '1fr' })
    else if (media) upper.push({ area: 'media', width: '1fr' })
    else upper.push({ area: hasDock ? 'dock' : 'empty', width: '1fr' })
    side.push({ area: 'split-side', width: `${SPLIT}px` }, { area: 'preview', width: `${layout.previewWidth}px` })
  }
  const row = (cells: GridArea[]) => `"${[...cells, ...side.map((s) => s.area)].join(' ')}"`
  const areas = [row(upper.map((c) => c.area)), row(upper.map(() => 'split-timeline')), row(upper.map(() => 'timeline'))].join(' ')
  return {
    columns: [...upper, ...side].map((c) => c.width).join(' '),
    rows: `1fr ${SPLIT}px ${layout.timelineHeight}px`,
    areas,
    uses: new Set<GridArea>([...upper, ...side].map((c) => c.area).concat(['split-timeline', 'timeline']))
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
  // Saved before frames and the Control Panel: the right column becomes the wireframe's
  // Effect Controls | Add Effects tabs. Floating windows stay where they were.
  const beforeFrames = !('frame' in raw)
  for (const spec of specs) {
    const saved = windows[spec.id]
    if (!isRecord(saved)) continue
    const rect = isRecord(saved['rect']) ? saved['rect'] : {}
    const mode = saved['mode']
    const wasDocked = spec.dockable && saved['docked'] === true
    const reset = beforeFrames && (wasDocked || (spec.defaultOpen && spec.defaultDocked))
    base.windows[spec.id] = {
      open: reset ? spec.defaultOpen : saved['open'] === true,
      docked: reset ? spec.defaultDocked : wasDocked,
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
  base.previewWidth = readNumber(raw['previewWidth'], limits.previewWidth.initial, limits.previewWidth.min, limits.previewWidth.max)
  const frame = raw['frame']
  base.frame = frame === 'landscape' || frame === 'portrait' ? frame : 'auto'
  base.mediaOpen = raw['mediaOpen'] !== false
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
