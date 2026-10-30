import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { HarnessJob, HarnessReport } from '@shared/ipc'
import { handleMediaProtocol, registerMediaSchemePrivileges } from './media-protocol'
import { isHarnessRun, parseHarnessArgs, writeHarnessFile, type HarnessOptions } from './harness'

app.setName('ginosa')

// Escape hatch if WebGPU is ever unavailable on a future Electron build.
if (process.env['GINOSA_UNSAFE_WEBGPU'] === '1') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
}

registerMediaSchemePrivileges()

const harnessMode = isHarnessRun(process.argv)
let harness: HarnessOptions | null = null
if (harnessMode) {
  try {
    harness = parseHarnessArgs(process.argv, process.cwd())
  } catch (error) {
    console.error(`[harness] ${(error as Error).message}`)
    app.exit(2)
  }
}

const HARNESS_TIMEOUT_MS = 120_000

function rendererEntry(window: BrowserWindow, query: Record<string, string>): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl && !harnessMode) {
    const url = new URL(devUrl)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return window.loadURL(url.toString())
  }
  return window.loadFile(join(__dirname, '../renderer/index.html'), { query })
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
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
      nodeIntegration: false
    }
  })
  window.once('ready-to-show', () => window.show())
  // Links open in the default browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  void rendererEntry(window, {})
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

function registerIpc(): void {
  ipcMain.handle('dialog:openMedia', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
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

  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  // Standard macOS behaviour: the app stays open until Cmd+Q; the harness always quits.
  if (process.platform !== 'darwin' || harnessMode) app.quit()
})
