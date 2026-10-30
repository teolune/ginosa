import type { WindowSpec } from './layout'

/** Every tool window. New windows (Effects Library, Keyframe Editor…) register here. */
export const WINDOW_SPECS: WindowSpec[] = [
  {
    id: 'project-settings',
    title: 'Project Settings',
    shortcut: 'Alt+1',
    defaultRect: { x: 300, y: 40, w: 380, h: 560 },
    minSize: { w: 300, h: 260 },
    dockable: true,
    defaultOpen: false,
    defaultDocked: false
  },
  {
    id: 'history',
    title: 'History',
    shortcut: 'Alt+2',
    defaultRect: { x: 700, y: 40, w: 300, h: 420 },
    minSize: { w: 220, h: 160 },
    dockable: true,
    defaultOpen: true,
    defaultDocked: true
  },
  {
    id: 'diagnostics',
    title: 'Diagnostics',
    shortcut: 'Alt+3',
    defaultRect: { x: 1020, y: 40, w: 320, h: 600 },
    minSize: { w: 260, h: 200 },
    dockable: true,
    defaultOpen: false,
    defaultDocked: false
  },
  {
    id: 'playback-test',
    title: 'Playback Test (M0)',
    shortcut: 'Alt+4',
    defaultRect: { x: 340, y: 120, w: 760, h: 520 },
    minSize: { w: 480, h: 320 },
    dockable: false,
    defaultOpen: false,
    defaultDocked: false
  }
]
