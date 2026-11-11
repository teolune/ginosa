import { describe, expect, it } from 'vitest'
import {
  clampRect,
  defaultLayout,
  normaliseWorkspaceFile,
  resizeRect,
  snapMove,
  snapResize,
  resolveFrame,
  workspaceGrid,
  type WindowSpec
} from './layout'

const bounds = { w: 1200, h: 800 }
const min = { w: 200, h: 120 }

const specs: WindowSpec[] = [
  { id: 'a', title: 'A', shortcut: 'Alt+1', defaultRect: { x: 10, y: 10, w: 300, h: 200 }, minSize: min, dockable: true, defaultOpen: true, defaultDocked: false },
  { id: 'b', title: 'B', shortcut: 'Alt+2', defaultRect: { x: 400, y: 10, w: 300, h: 200 }, minSize: min, dockable: false, defaultOpen: false, defaultDocked: false }
]

describe('clampRect', () => {
  it('keeps the title bar reachable when dragged off the edges', () => {
    expect(clampRect({ x: -900, y: -50, w: 300, h: 200 }, bounds, min)).toEqual({ x: -220, y: 0, w: 300, h: 200 })
    expect(clampRect({ x: 5000, y: 5000, w: 300, h: 200 }, bounds, min)).toEqual({ x: 1120, y: 772, w: 300, h: 200 })
  })
  it('enforces the minimum size and never exceeds the workspace', () => {
    expect(clampRect({ x: 0, y: 0, w: 50, h: 5000 }, bounds, min)).toEqual({ x: 0, y: 0, w: 200, h: 800 })
  })
})

describe('snapMove', () => {
  it('snaps to the workspace edge within 8 px', () => {
    expect(snapMove({ x: 6, y: 300, w: 300, h: 200 }, bounds, []).x).toBe(0)
    expect(snapMove({ x: 895, y: 300, w: 300, h: 200 }, bounds, []).x).toBe(900)
  })
  it('snaps alongside another window', () => {
    const other = { x: 100, y: 100, w: 300, h: 200 }
    expect(snapMove({ x: 405, y: 104, w: 200, h: 150 }, bounds, [other])).toEqual({ x: 400, y: 100, w: 200, h: 150 })
  })
  it('leaves windows alone when nothing is close', () => {
    expect(snapMove({ x: 300, y: 300, w: 200, h: 150 }, bounds, [])).toEqual({ x: 300, y: 300, w: 200, h: 150 })
  })
})

describe('resizeRect', () => {
  it('grows from the south-east corner', () => {
    expect(resizeRect({ x: 10, y: 10, w: 300, h: 200 }, 'se', 50, 40, min)).toEqual({ x: 10, y: 10, w: 350, h: 240 })
  })
  it('keeps the opposite edge fixed when dragging the west edge', () => {
    expect(resizeRect({ x: 100, y: 10, w: 300, h: 200 }, 'w', -50, 0, min)).toEqual({ x: 50, y: 10, w: 350, h: 200 })
  })
  it('stops at the minimum size', () => {
    expect(resizeRect({ x: 100, y: 100, w: 300, h: 200 }, 'nw', 500, 500, min)).toEqual({ x: 200, y: 180, w: 200, h: 120 })
  })
})

describe('snapResize', () => {
  it('snaps the dragged edge to the workspace edge', () => {
    expect(snapResize({ x: 900, y: 0, w: 296, h: 200 }, 'e', bounds, [], min).w).toBe(300)
  })
})

describe('workspace files', () => {
  it('falls back to defaults for missing or broken data', () => {
    const file = normaliseWorkspaceFile({ layouts: { Edit: { windows: { a: { open: 'yes', rect: { x: 'no' } } } } } }, specs)
    expect(file.layouts['Edit']?.windows['a']?.open).toBe(false)
    expect(file.layouts['Edit']?.windows['a']?.rect.x).toBe(10)
    expect(file.layouts['Edit']?.windows['b']).toEqual(defaultLayout(specs).windows['b'])
  })
  it('never docks a window that cannot be docked', () => {
    const file = normaliseWorkspaceFile({ layouts: { Mine: { windows: { b: { open: true, docked: true } } } }, active: 'Mine' }, specs)
    expect(file.active).toBe('Mine')
    expect(file.layouts['Mine']?.windows['b']?.docked).toBe(false)
  })
})

describe('frames and the Control Panel layout', () => {
  const wire: WindowSpec[] = [
    { id: 'controls', title: 'Effect Controls', shortcut: 'Alt+7', defaultRect: { x: 0, y: 0, w: 300, h: 300 }, minSize: min, dockable: true, defaultOpen: true, defaultDocked: true },
    { id: 'history', title: 'History', shortcut: 'Alt+2', defaultRect: { x: 0, y: 0, w: 300, h: 300 }, minSize: min, dockable: true, defaultOpen: false, defaultDocked: true },
    { id: 'float', title: 'Float', shortcut: 'Alt+3', defaultRect: { x: 0, y: 0, w: 300, h: 300 }, minSize: min, dockable: true, defaultOpen: false, defaultDocked: false }
  ]

  it('moves layouts saved before frames to the wireframe tabs, leaving floating windows alone', () => {
    const old = { windows: { controls: { open: false, docked: false }, history: { open: true, docked: true }, float: { open: true, docked: false, rect: { x: 50, y: 60, w: 300, h: 300 } } }, mediaWidth: 300 }
    const layout = normaliseWorkspaceFile({ layouts: { Edit: old } }, wire).layouts['Edit']!
    expect(layout.windows['controls']).toMatchObject({ open: true, docked: true })
    expect(layout.windows['history']).toMatchObject({ open: false, docked: true })
    expect(layout.windows['float']).toMatchObject({ open: true, docked: false, rect: { x: 50, y: 60 } })
    expect(layout.mediaWidth).toBe(300)
    expect(layout.frame).toBe('auto')
    expect(layout.mediaOpen).toBe(true)
  })

  it('keeps windows as saved once a layout has frames', () => {
    const saved = { windows: { controls: { open: false, docked: false }, history: { open: true, docked: true } }, frame: 'portrait', mediaOpen: false, previewWidth: 9999 }
    const layout = normaliseWorkspaceFile({ layouts: { Edit: saved } }, wire).layouts['Edit']!
    expect(layout.windows['controls']).toMatchObject({ open: false, docked: false })
    expect(layout.windows['history']).toMatchObject({ open: true, docked: true })
    expect(layout.frame).toBe('portrait')
    expect(layout.mediaOpen).toBe(false)
    expect(layout.previewWidth).toBe(1000)
  })

  it('follows the sequence shape on Auto', () => {
    expect(resolveFrame('auto', 'portrait')).toBe('portrait')
    expect(resolveFrame('auto', 'landscape')).toBe('landscape')
    expect(resolveFrame('landscape', 'portrait')).toBe('landscape')
  })

  it('lays out the landscape wireframe: media | preview, timeline under both, dock at full height', () => {
    const grid = workspaceGrid({ ...defaultLayout(wire), mediaWidth: 400, dockWidth: 340, timelineHeight: 280 }, 'landscape', true)
    expect(grid.columns).toBe('400px 6px 1fr 6px 340px')
    expect(grid.rows).toBe('1fr 6px 280px')
    expect(grid.areas).toBe(
      '"media split-media preview split-side dock" "split-timeline split-timeline split-timeline split-side dock" "timeline timeline timeline split-side dock"'
    )
  })

  it('lays out the portrait wireframe: media | dock, timeline under both, a tall preview on the right', () => {
    const grid = workspaceGrid({ ...defaultLayout(wire), mediaWidth: 400, previewWidth: 420 }, 'portrait', true)
    expect(grid.columns).toBe('400px 6px 1fr 6px 420px')
    expect(grid.areas.split('" "')[0]).toBe('"media split-media dock split-side preview')
    expect(grid.areas.endsWith('timeline timeline timeline split-side preview"')).toBe(true)
  })

  it('gives a closed media column (or an empty dock) to its neighbour', () => {
    const closed = { ...defaultLayout(wire), mediaOpen: false }
    expect(workspaceGrid(closed, 'landscape', true).areas.startsWith('"preview split-side dock"')).toBe(true)
    expect(workspaceGrid(closed, 'landscape', false).columns).toBe('1fr')
    expect(workspaceGrid(closed, 'portrait', false).uses.has('empty')).toBe(true)
    expect(workspaceGrid(defaultLayout(wire), 'portrait', false).areas.startsWith('"media split-side preview"')).toBe(true)
  })
})
