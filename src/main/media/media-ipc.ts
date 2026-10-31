import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { PROJECT_EXTENSION } from '../../shared/ipc'
import { parseCube } from '../../engine/colour/cube'
import { IMPORT_EXTENSIONS, type MediaFingerprint, type MediaInfo, type MediaKind, type OptimiseReason } from '../../engine/project/media'
import { CACHE_CATEGORIES, CacheService, type CacheCategory } from '../cache/cache-service'
import { JsonFile } from '../settings-store'
import { ensureThumbnail, ensureWaveform } from './generate'
import { checkFile, classifyImportPaths, fingerprintFile, probeFiles, probeFile, searchForMoved } from './media-files'
import { OptimiseQueue, type OptimiseJob } from './optimise'

/** IPC for media import, generated files, optimised copies and the cache. */

interface AppSettings {
  cacheParent?: string
}

export interface MediaServices {
  cache: CacheService
  queue: OptimiseQueue
}

export async function registerMediaIpc(getWindow: () => BrowserWindow | null, options: { cacheRoot?: string } = {}): Promise<MediaServices> {
  const settingsFile = new JsonFile(join(app.getPath('userData'), 'settings.json'))
  const settings = ((await settingsFile.read()) ?? {}) as AppSettings
  const cache = new CacheService(options.cacheRoot ?? join(app.getPath('videos'), 'ginosa Cache'))
  if (settings.cacheParent && !options.cacheRoot) cache.setParentFolder(settings.cacheParent)

  const queue = new OptimiseQueue(cache, (job: OptimiseJob) => {
    getWindow()?.webContents.send('media:jobUpdate', job)
  })

  const owner = (sender: Electron.WebContents) => BrowserWindow.fromWebContents(sender) ?? undefined

  ipcMain.handle('media:chooseImport', async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import Media',
      buttonLabel: 'Import',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: [...IMPORT_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const window = owner(event.sender)
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('media:classify', (_event, paths: string[]) => classifyImportPaths(paths))
  ipcMain.handle('media:probe', (_event, paths: string[]) => probeFiles(paths))
  ipcMain.handle('media:probeOne', (_event, path: string) => probeFile(path))
  ipcMain.handle('media:fingerprint', (_event, path: string) => fingerprintFile(path))

  ipcMain.handle(
    'media:thumbnail',
    (_event, request: { projectId: string; mediaId: string; path: string; kind: MediaKind; fingerprint: MediaFingerprint; durationSeconds: number }) =>
      ensureThumbnail(cache, request)
  )
  ipcMain.handle(
    'media:waveform',
    (_event, request: { projectId: string; mediaId: string; path: string; kind: MediaKind; fingerprint: MediaFingerprint; durationSeconds: number }) =>
      ensureWaveform(cache, request)
  )

  ipcMain.handle('media:checkFiles', async (_event, items: Array<{ id: string; path: string; fingerprint: MediaFingerprint }>) =>
    Promise.all(items.map(async (item) => ({ id: item.id, status: await checkFile(item.path, item.fingerprint) })))
  )

  // ---- Input LUTs: copied into the project folder so the project carries them ----------
  const projectDir = async (projectPath: string): Promise<string> => {
    const dir = resolve(projectPath)
    if (!dir.endsWith(PROJECT_EXTENSION) || !(await stat(dir)).isDirectory()) throw new Error('Not a ginosa project folder')
    return dir
  }

  ipcMain.handle('media:chooseLut', async (event) => {
    const options: Electron.OpenDialogOptions = { title: 'Choose an input LUT', buttonLabel: 'Use LUT', properties: ['openFile'], filters: [{ name: 'Cube LUT', extensions: ['cube'] }] }
    const window = owner(event.sender)
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('media:importLut', async (_event, projectPath: string, source: string) => {
    const dir = await projectDir(projectPath)
    parseCube(await readFile(source, 'utf8')) // refuse broken files before copying anything
    await mkdir(join(dir, 'luts'), { recursive: true })
    const name = basename(source, extname(source))
    let file = join('luts', `${name}.cube`)
    for (let n = 2; await stat(join(dir, file)).then(() => true, () => false); n++) file = join('luts', `${name} ${n}.cube`)
    await copyFile(source, join(dir, file))
    return { name, file }
  })

  ipcMain.handle('media:readLut', async (_event, projectPath: string, file: string) => {
    const dir = await projectDir(projectPath)
    const full = resolve(dir, file)
    if (!full.startsWith(dir + sep)) throw new Error('That LUT is outside the project folder')
    return readFile(full, 'utf8')
  })

  ipcMain.handle('media:chooseRelink', async (event, fileName: string) => {
    const options: Electron.OpenDialogOptions = {
      title: `Locate "${fileName}"`,
      message: 'Choose the file, or a folder to search for every missing file.',
      buttonLabel: 'Locate',
      properties: ['openFile', 'openDirectory']
    }
    const window = owner(event.sender)
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('media:searchMoved', (_event, folder: string, wanted: Array<{ id: string; fileName: string; size: number }>) => searchForMoved(folder, wanted))

  ipcMain.handle('media:reveal', (_event, path: string) => shell.showItemInFolder(path))

  ipcMain.handle(
    'media:optimise',
    (_event, request: { projectId: string; mediaId: string; name: string; path: string; fingerprint: MediaFingerprint; info: MediaInfo; reasons: OptimiseReason[] }) =>
      queue.enqueue(request)
  )
  ipcMain.handle('media:optimisedPath', (_event, projectId: string, mediaId: string, fingerprint: MediaFingerprint) => queue.existing(projectId, mediaId, fingerprint))
  ipcMain.handle('media:jobs', () => queue.list())
  ipcMain.handle('media:cancelJob', (_event, jobId: string) => queue.cancel(jobId))

  ipcMain.handle('cache:registerProject', (_event, projectId: string, name: string, path: string) => cache.registerProject(projectId, name, path))
  ipcMain.handle('cache:usage', async () => ({ root: cache.rootPath, projects: await cache.usage() }))
  ipcMain.handle('cache:clear', async (_event, projectId: string, category: CacheCategory | 'all') => {
    if (category === 'all' || category === 'optimised') queue.cancelProject(projectId)
    await cache.remove(projectId, category)
  })
  ipcMain.handle('cache:reveal', async () => {
    await (await import('node:fs/promises')).mkdir(cache.rootPath, { recursive: true })
    await shell.openPath(cache.rootPath)
  })
  ipcMain.handle('cache:chooseLocation', async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where the cache lives',
      message: 'A folder named "ginosa Cache" will be created inside the folder you choose.',
      buttonLabel: 'Use This Folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const window = owner(event.sender)
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const parent = result.canceled ? null : result.filePaths[0]
    if (!parent) return null
    const previous = cache.rootPath
    const root = cache.setParentFolder(parent)
    settings.cacheParent = parent
    await settingsFile.write(settings)
    return { root, previous }
  })
  ipcMain.handle('cache:categories', () => CACHE_CATEGORIES)

  return { cache, queue }
}
