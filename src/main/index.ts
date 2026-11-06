import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { HarnessJob, HarnessReport, JournalEntry, MenuState, UnsavedChoice } from '@shared/ipc'
import { PROJECT_EXTENSION } from '@shared/ipc'
import { handleMediaProtocol, registerMediaSchemePrivileges } from './media-protocol'
import { isHarnessRun, parseHarnessArgs, writeHarnessFile, type HarnessOptions } from './harness'
import { analyseExport } from './export/analyse'
import { registerExportIpc } from './export/export-service'
import { registerMediaIpc } from './media/media-ipc'
import { AppMenu } from './menu'
import { normaliseProjectPath, ProjectService, RecentProjects } from './project-service'
import { JsonFile } from './settings-store'
import { isSnapshotRun, parseSnapshotArgs, type SnapshotOptions } from './snapshot'
import { renderSymbols } from './symbols'

app.setName('ginosa')

// Escape hatch if WebGPU is ever unavailable on a future Electron build.
if (process.env['GINOSA_UNSAFE_WEBGPU'] === '1') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
}

registerMediaSchemePrivileges()

const harnessMode = isHarnessRun(process.argv)
const snapshotMode = isSnapshotRun(process.argv)
let harness: HarnessOptions | null = null
let snapshot: SnapshotOptions | null = null
try {
  if (harnessMode) harness = parseHarnessArgs(process.argv, process.cwd())
  if (snapshotMode) snapshot = parseSnapshotArgs(process.argv, process.cwd())
} catch (error) {
  console.error(`[ginosa] ${(error as Error).message}`)
  app.exit(2)
}

if (snapshotMode) {
  // A throwaway settings folder, so snapshots never touch real recents or layouts.
  app.setPath('userData', join(tmpdir(), `ginosa-snapshot-${process.pid}`))
}

const HARNESS_TIMEOUT_MS = 120_000
const projects = new ProjectService()
const recent = new RecentProjects(join(app.getPath('userData'), 'recent-projects.json'))
const workspaces = new JsonFile(join(app.getPath('userData'), 'workspaces.json'))
let mainWindow: BrowserWindow | null = null
let allowClose = false
let quitting = false
const menu = new AppMenu(() => mainWindow)

function rendererEntry(window: BrowserWindow, query: Record<string, string>): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl && !harnessMode && !snapshotMode) {
    const url = new URL(devUrl)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return window.loadURL(url.toString())
  }
  return window.loadFile(join(__dirname, '../renderer/index.html'), { query })
}

function createMainWindow(): BrowserWindow {
  const size = snapshot ? { width: snapshot.width, height: snapshot.height } : { width: 1600, height: 1000 }
  const window = new BrowserWindow({
    ...size,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#111214',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !snapshot,
      // An editor plays sound when you press Play; no extra click needed (and none in automated runs).
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: snapshot ? [`--ginosa-snapshot=${snapshot.scenario}`] : []
    }
  })
  window.once('ready-to-show', () => (snapshot ? window.showInactive() : window.show()))
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.on('close', (event) => {
    if (allowClose || snapshot) return
    // The renderer decides: it knows whether there are unsaved changes.
    event.preventDefault()
    window.webContents.send('app:close-requested')
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    allowClose = false
  })
  if (snapshot) {
    window.webContents.on('console-message', (event) => console.log(`[renderer] ${event.message}`))
  }
  void rendererEntry(window, snapshot ? { mode: 'snapshot' } : {})
  return window
}

function createHarnessWindow(options: HarnessOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: options.show,
    backgroundColor: '#111214',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  window.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[harness] renderer crashed: ${details.reason}`)
    app.exit(3)
  })
  void rendererEntry(window, { mode: 'harness' })
  return window
}

function ownerOf(sender: Electron.WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined
}

function defaultProjectsFolder(): string {
  return join(app.getPath('videos'), 'ginosa Projects')
}

function registerIpc(): void {
  ipcMain.handle('dialog:openMedia', async (event) => {
    const owner = ownerOf(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Open media',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ---- Projects ----------------------------------------------------------

  ipcMain.handle('project:chooseNewLocation', async (event) => {
    await mkdir(defaultProjectsFolder(), { recursive: true }).catch(() => undefined)
    const options: Electron.SaveDialogOptions = {
      title: 'New Project',
      buttonLabel: 'Create',
      defaultPath: join(defaultProjectsFolder(), `Untitled${PROJECT_EXTENSION}`),
      nameFieldLabel: 'Project name:',
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    const owner = ownerOf(event.sender)
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath ? null : normaliseProjectPath(result.filePath)
  })

  ipcMain.handle('project:create', async (_event, path: string, json: string) => {
    await projects.create(path, json)
    await recent.add(path)
  })

  ipcMain.handle('project:open', async (event, path?: string) => {
    let target = path
    if (!target) {
      const options: Electron.OpenDialogOptions = {
        title: 'Open Project',
        defaultPath: defaultProjectsFolder(),
        properties: ['openDirectory', 'openFile'],
        filters: [{ name: 'ginosa project', extensions: ['ginosa', 'json'] }]
      }
      const owner = ownerOf(event.sender)
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      target = normaliseProjectPath(result.filePaths[0])
    }
    const opened = await projects.open(target)
    await recent.add(opened.path)
    return opened
  })

  ipcMain.handle('project:save', (_event, json: string) => projects.save(json))

  ipcMain.handle('project:saveAs', async (event, json: string) => {
    const options: Electron.SaveDialogOptions = {
      title: 'Save Project As',
      defaultPath: projects.path ?? join(defaultProjectsFolder(), `Untitled${PROJECT_EXTENSION}`),
      properties: ['createDirectory', 'showOverwriteConfirmation']
    }
    const owner = ownerOf(event.sender)
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const target = normaliseProjectPath(result.filePath)
    await projects.saveAs(target, json)
    await recent.add(target)
    return target
  })

  ipcMain.handle('project:autosave', (_event, json: string) => projects.autosave(json))
  ipcMain.handle('project:deleteAutosaves', () => projects.deleteAutosaves())
  ipcMain.on('project:journal', (_event, entry: JournalEntry) => {
    void projects.appendJournal(entry).catch((error: Error) => console.error(`[project] journal: ${error.message}`))
  })
  ipcMain.handle('project:discardRecovery', () => projects.discardRecovery())
  ipcMain.handle('project:close', () => projects.close())
  ipcMain.handle('project:recent', () => recent.list())
  ipcMain.handle('project:reveal', () => {
    if (projects.path) shell.showItemInFolder(projects.path)
  })

  ipcMain.handle('project:askUnsaved', async (event, projectName: string): Promise<UnsavedChoice> => {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: `Save changes to "${projectName}"?`,
      detail: "Your changes will be lost if you don't save them.",
      buttons: ['Save', 'Cancel', "Don't Save"],
      defaultId: 0,
      cancelId: 1
    }
    const owner = ownerOf(event.sender)
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    return response === 0 ? 'save' : response === 2 ? 'discard' : 'cancel'
  })

  ipcMain.handle('project:showError', async (event, title: string, detail: string) => {
    const options: Electron.MessageBoxOptions = { type: 'error', message: title, detail, buttons: ['OK'] }
    const owner = ownerOf(event.sender)
    if (owner) await dialog.showMessageBox(owner, options)
    else await dialog.showMessageBox(options)
  })

  // ---- Workspace layouts, menu, closing -----------------------------------

  ipcMain.handle('workspace:load', () => workspaces.read())
  ipcMain.handle('workspace:save', (_event, data: unknown) => workspaces.write(data))
  ipcMain.on('menu:setState', (_event, state: MenuState) => menu.update(state))
  ipcMain.on('app:closeNow', () => {
    allowClose = true
    if (quitting) app.quit()
    else mainWindow?.close()
  })
  ipcMain.on('app:closeCancelled', () => {
    quitting = false
  })

  ipcMain.handle('ui:symbols', () => renderSymbols())

  // ---- Snapshot mode --------------------------------------------------------

  ipcMain.handle('snapshot:tempProjectPath', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ginosa-snapshot-project-'))
    return join(dir, `Snapshot${PROJECT_EXTENSION}`)
  })

  ipcMain.handle('snapshot:testMedia', async () => {
    if (!snapshot) return []
    const dir = join(process.cwd(), 'media', 'test')
    const { readdir } = await import('node:fs/promises')
    return (await readdir(dir).catch(() => [] as string[])).filter((f) => !f.startsWith('.')).sort().map((f) => join(dir, f))
  })

  // Your own clips for the footage check: ../Reference Materials/AppleLogClips (never copied or changed).
  ipcMain.handle('snapshot:referenceClips', async () => {
    if (!snapshot) return []
    const dir = join(process.cwd(), '..', 'Reference Materials', 'AppleLogClips')
    const { readdir } = await import('node:fs/promises')
    return (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.(mov|mp4)$/i.test(f)).sort().map((f) => join(dir, f))
  })

  // The effect preset library (validated in the renderer; see engine/effects/presets.ts).
  const presets = new JsonFile(join(app.getPath('userData'), 'effect-presets.json'))
  ipcMain.handle('presets:read', () => presets.read())
  ipcMain.handle('presets:write', (_event, data: unknown) => presets.write(data))

  // The gradient library (M13), like presets; .grd files are only read when imported.
  const gradients = new JsonFile(join(app.getPath('userData'), 'gradient-library.json'))
  ipcMain.handle('gradients:read', () => gradients.read())
  ipcMain.handle('gradients:write', (_event, data: unknown) => gradients.write(data))
  const MAX_GRD_BYTES = 256 * 1024 * 1024
  const readGrdFile = async (path: string) => {
    if ((await stat(path)).size > MAX_GRD_BYTES) throw new Error(`${basename(path)} is larger than any gradient library (256 MB)`)
    return { name: basename(path), bytes: new Uint8Array(await readFile(path)) }
  }
  ipcMain.handle('gradients:chooseImport', async (event) => {
    const options: Electron.OpenDialogOptions = { title: 'Import Gradients', buttonLabel: 'Import', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Photoshop Gradients', extensions: ['grd'] }] }
    const window = ownerOf(event.sender)
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : Promise.all(result.filePaths.map(readGrdFile))
  })
  ipcMain.handle('gradients:export', async (event, name: string, bytes: Uint8Array) => {
    const options: Electron.SaveDialogOptions = { title: 'Export Gradients', buttonLabel: 'Export', defaultPath: `${basename(name).replace(/[/:]/g, '-') || 'Gradients'}.grd`, filters: [{ name: 'Photoshop Gradients', extensions: ['grd'] }] }
    const window = ownerOf(event.sender)
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, bytes)
    return result.filePath
  })

  // Your gradients for the fidelity check: ../Reference Materials/Gradients (never copied or changed).
  ipcMain.handle('snapshot:referenceGradients', async () => {
    const empty = { libraries: [], renders: [] }
    if (!snapshot) return empty
    const dir = join(process.cwd(), '..', 'Reference Materials', 'Gradients')
    const { readdir } = await import('node:fs/promises')
    const walk = async (folder: string): Promise<string[]> => {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
      const files = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(folder, e.name)) : Promise.resolve([join(folder, e.name)]))))
      return files.flat()
    }
    const files = (await walk(dir)).sort()
    const read = async (path: string) => ({ name: path.slice(dir.length + 1), bytes: new Uint8Array(await readFile(path)) })
    return {
      libraries: await Promise.all(files.filter((f) => /\.grd$/i.test(f)).map(read)),
      renders: await Promise.all(files.filter((f) => /\.png$/i.test(f)).map(read))
    }
  })

  ipcMain.handle('snapshot:analyseExport', async (_event, path: string, xs: number[]) => (snapshot ? analyseExport(path, xs) : null))

  ipcMain.handle('snapshot:exportPath', async (_event, name: string) => {
    if (!snapshot) return null
    const dir = join(process.cwd(), 'renders', 'export')
    await mkdir(dir, { recursive: true })
    return join(dir, basename(name))
  })

  ipcMain.handle('snapshot:simulateCrash', async () => {
    if (snapshot) await projects.simulateCrash()
  })

  ipcMain.handle('snapshot:report', async (_event, report: unknown) => {
    if (!snapshot) return
    const path = snapshot.out.replace(/\.png$/, '.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`[snapshot] report -> ${path}`)
    console.log(JSON.stringify(report))
  })

  ipcMain.handle('snapshot:ready', async (event) => {
    if (!snapshot) return
    const window = ownerOf(event.sender)
    if (!window) return
    const image = await window.webContents.capturePage()
    await mkdir(dirname(snapshot.out), { recursive: true })
    await writeFile(snapshot.out, image.toPNG())
    console.log(`[snapshot] ${snapshot.scenario} -> ${snapshot.out} (${image.getSize().width}×${image.getSize().height})`)
    await projects.close().catch(() => undefined)
    setTimeout(() => app.exit(0), 50)
  })

  // ---- Render harness -----------------------------------------------------

  ipcMain.handle('harness:getJob', (): HarnessJob | null => harness?.job ?? null)

  ipcMain.handle('harness:writeFile', async (_event, name: string, data: ArrayBuffer | Uint8Array) => {
    if (!harness) throw new Error('Not in harness mode')
    return writeHarnessFile(harness.job, name, data)
  })

  ipcMain.handle('harness:done', async (_event, report: HarnessReport) => {
    if (!harness) return
    const reportPath = await writeHarnessFile(harness.job, 'report.json', new TextEncoder().encode(JSON.stringify(report, null, 2)))
    console.log(`[harness] ${report.ok ? 'done' : 'FAILED'}: ${report.frames.length} frame(s) -> ${harness.job.outDir}`)
    if (!report.ok && report.error) console.error(`[harness] ${report.error}`)
    console.log(`[harness] report: ${reportPath}`)
    setTimeout(() => app.exit(report.ok ? 0 : 1), 50)
  })

  ipcMain.on('harness:log', (_event, message: string) => {
    console.log(`[harness] ${message}`)
  })
}

app.whenReady().then(async () => {
  handleMediaProtocol()
  registerIpc()
  // Snapshots use a throwaway cache, like their throwaway settings folder.
  registerExportIpc()
  await registerMediaIpc(() => mainWindow, snapshotMode ? { cacheRoot: join(app.getPath('userData'), 'ginosa Cache') } : {})

  if (harnessMode) {
    if (!harness) return
    const options = harness
    console.log(`[harness] rendering ${options.job.frames.join(', ')} of ${options.job.input}`)
    createHarnessWindow(options)
    setTimeout(async () => {
      console.error(`[harness] timed out after ${HARNESS_TIMEOUT_MS / 1000}s`)
      try {
        await writeFile(join(options.job.outDir, 'TIMEOUT'), 'Render harness timed out\n')
      } catch {
        // Output folder may not exist yet; the exit code still reports the failure.
      }
      app.exit(4)
    }, HARNESS_TIMEOUT_MS).unref()
    return
  }

  if (snapshotMode) {
    if (!snapshot) return
    setTimeout(() => {
      console.error('[snapshot] timed out after 60 s')
      app.exit(4)
    }, 60_000).unref()
  }

  menu.build()
  mainWindow = createMainWindow()
  app.on('activate', () => {
    if (!mainWindow) mainWindow = createMainWindow()
  })
})

app.on('before-quit', () => {
  // Cmd+Q goes through the window's close handler, which asks about unsaved changes;
  // once the renderer has saved (or the user chose not to), quitting continues.
  quitting = true
})

app.on('window-all-closed', () => {
  // Standard macOS behaviour: the app stays open until Cmd+Q; the harness and snapshots always quit.
  if (process.platform !== 'darwin' || harnessMode || snapshotMode) app.quit()
})
