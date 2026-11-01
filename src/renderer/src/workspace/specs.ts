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
    id: 'effect-controls',
    title: 'Effect Controls',
    shortcut: 'Alt+7',
    defaultRect: { x: 640, y: 60, w: 340, h: 520 },
    minSize: { w: 260, h: 200 },
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
    id: 'source-monitor',
    title: 'Source Monitor',
    shortcut: 'Alt+5',
    defaultRect: { x: 420, y: 30, w: 720, h: 500 },
    minSize: { w: 420, h: 300 },
    dockable: true,
    defaultOpen: false,
    defaultDocked: false
  },
  {
    id: 'cache-manager',
    title: 'Cache Manager',
    shortcut: 'Alt+6',
    defaultRect: { x: 560, y: 60, w: 520, h: 520 },
    minSize: { w: 400, h: 260 },
    dockable: true,
    defaultOpen: false,
    defaultDocked: false
  },
  {
    id: 'effects-library',
    title: 'Effects',
    shortcut: 'Alt+9',
    defaultRect: { x: 60, y: 80, w: 300, h: 460 },
    minSize: { w: 220, h: 220 },
    dockable: true,
    defaultOpen: true,
    defaultDocked: true
  },
  {
    id: 'keyframe-editor',
    title: 'Keyframe Editor',
    shortcut: 'Alt+0',
    defaultRect: { x: 240, y: 380, w: 900, h: 300 },
    minSize: { w: 420, h: 160 },
    dockable: true,
    defaultOpen: false,
    defaultDocked: false
  },
  {
    id: 'audio-analysis',
    title: 'Audio Analysis',
    shortcut: 'Alt+Shift+1',
    defaultRect: { x: 200, y: 340, w: 920, h: 380 },
    minSize: { w: 560, h: 260 },
    dockable: true,
    defaultOpen: false,
    defaultDocked: false
  },
  {
    id: 'export',
    title: 'Export',
    shortcut: 'Alt+8',
    defaultRect: { x: 380, y: 60, w: 440, h: 560 },
    minSize: { w: 380, h: 420 },
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
