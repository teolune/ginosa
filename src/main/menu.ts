import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand, MenuState } from '@shared/ipc'

/** Native macOS menu bar. Items send MenuCommands to the renderer, which owns the app state. */

const EMPTY_STATE: MenuState = {
  hasProject: false,
  dirty: false,
  undoLabel: null,
  redoLabel: null,
  windows: [],
  workspaces: [],
  activeWorkspace: null,
  recent: []
}

export class AppMenu {
  private state: MenuState = EMPTY_STATE

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  update(state: MenuState): void {
    this.state = state
    this.build()
  }

  private send(command: MenuCommand): void {
    this.getWindow()?.webContents.send('menu:command', command)
  }

  build(): void {
    const s = this.state
    const isDev = !app.isPackaged
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'ginosa',
        submenu: [
          { role: 'about', label: 'About ginosa' },
          { type: 'separator' },
          { label: 'Show All Warnings Again', click: () => this.send({ type: 'show-warnings' }) },
          { type: 'separator' },
          { role: 'hide', label: 'Hide ginosa' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit ginosa' }
        ]
      },
      {
        label: 'File',
        submenu: [
          { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => this.send({ type: 'new-project' }) },
          { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => this.send({ type: 'open-project' }) },
          {
            label: 'Open Recent',
            enabled: s.recent.length > 0,
            submenu: s.recent.length
              ? s.recent.map((item) => ({ label: item.name, click: () => this.send({ type: 'open-recent', path: item.path }) }))
              : [{ label: 'No recent projects', enabled: false }]
          },
          { type: 'separator' },
          { label: 'Import…', accelerator: 'CmdOrCtrl+I', enabled: s.hasProject, click: () => this.send({ type: 'import' }) },
          { label: 'New Bin', accelerator: 'CmdOrCtrl+B', enabled: s.hasProject, click: () => this.send({ type: 'new-bin' }) },
          { label: 'New Adjustment Layer', enabled: s.hasProject, click: () => this.send({ type: 'new-adjustment-layer' }) },
          { type: 'separator' },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', enabled: s.hasProject, click: () => this.send({ type: 'save' }) },
          { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', enabled: s.hasProject, click: () => this.send({ type: 'save-as' }) },
          { type: 'separator' },
          { label: 'Export…', accelerator: 'CmdOrCtrl+M', enabled: s.hasProject, click: () => this.send({ type: 'export' }) },
          { type: 'separator' },
          { label: 'Show Project in Finder', enabled: s.hasProject, click: () => this.send({ type: 'reveal-project' }) },
          { label: 'Close Project', enabled: s.hasProject, click: () => this.send({ type: 'close-project' }) }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          {
            label: s.undoLabel ? `Undo ${s.undoLabel}` : 'Undo',
            accelerator: 'CmdOrCtrl+Z',
            click: () => this.send({ type: 'undo' })
          },
          {
            label: s.redoLabel ? `Redo ${s.redoLabel}` : 'Redo',
            accelerator: 'Shift+CmdOrCtrl+Z',
            click: () => this.send({ type: 'redo' })
          },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        // Previews and cleanup (decision 60).
        label: 'Cache',
        submenu: [
          { label: 'Render Previews', accelerator: 'Enter', registerAccelerator: false, enabled: s.hasProject, click: () => this.send({ type: 'render-previews' }) },
          { label: 'Delete This Project’s Previews…', enabled: s.hasProject, click: () => this.send({ type: 'delete-previews' }) },
          { type: 'separator' },
          { label: 'Clean Up Finished Project…', enabled: s.hasProject, click: () => this.send({ type: 'clean-up-project', autosaves: false }) },
          { label: 'Clean Up Finished Project and Autosaves…', enabled: s.hasProject, click: () => this.send({ type: 'clean-up-project', autosaves: true }) },
          { type: 'separator' },
          { label: 'Cache Manager', enabled: s.hasProject, click: () => this.send({ type: 'toggle-window', id: 'cache-manager' }) }
        ]
      },
      {
        label: 'Window',
        submenu: [
          ...s.windows.map(
            (w): MenuItemConstructorOptions => ({
              label: w.title,
              type: 'checkbox',
              checked: w.open,
              accelerator: w.shortcut,
              enabled: s.hasProject,
              click: () => this.send({ type: 'toggle-window', id: w.id })
            })
          ),
          { type: 'separator' },
          {
            label: 'Workspaces',
            enabled: s.hasProject,
            submenu: [
              ...s.workspaces.map(
                (name): MenuItemConstructorOptions => ({
                  label: name,
                  type: 'radio',
                  checked: name === s.activeWorkspace,
                  click: () => this.send({ type: 'workspace-apply', name })
                })
              ),
              { type: 'separator' },
              { label: 'Save Workspace As…', click: () => this.send({ type: 'workspace-save-as' }) },
              { label: 'Reset Current Workspace', click: () => this.send({ type: 'workspace-reset' }) }
            ]
          },
          { type: 'separator' },
          // ⌘M is Export, as in Premiere; Minimize keeps its menu item without the shortcut.
          { label: 'Minimize', click: () => BrowserWindow.getFocusedWindow()?.minimize() },
          { role: 'zoom' }
        ]
      },
      ...(isDev
        ? [
            {
              label: 'Developer',
              submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]
            }
          ]
        : [])
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }
}
