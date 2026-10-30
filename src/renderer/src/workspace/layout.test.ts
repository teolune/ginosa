import { describe, expect, it } from 'vitest'
import {
  clampRect,
  defaultLayout,
  normaliseWorkspaceFile,
  resizeRect,
  snapMove,
  snapResize,
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
