import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { PROJECT_EXTENSION } from '../../shared/ipc'
import { parseCube } from '../../engine/colour/cube'
import { IMPORT_EXTENSIONS, type MediaFingerprint, type MediaInfo, type MediaKind, type OptimiseReason } from '../../engine/project/media'
import { CACHE_CATEGORIES, CacheService, type CacheCategory } from '../cache/cache-service'
import { JsonFile } from '../settings-store'
import { DEFAULT_PREVIEW_LIMIT, PreviewStore } from '../cache/preview-store'
import { ensureThumbnail, ensureWaveform } from './generate'
import { checkFile, classifyImportPaths, fingerprintFile, listFolder, probeFiles, probeFile, searchForMoved } from './media-files'
import { OptimiseQueue, type OptimiseJob } from './optimise'
import { separateStems, stemPcm, stemsStatus } from './stems'

/** IPC for media import, generated files, optimised copies and the cache. */

interface AppSettings {
  cacheParent?: string
  /** Preview renders' size limit, bytes (M9). */
  previewLimit?: number
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

  const previews = new PreviewStore(cache, settings.previewLimit ?? DEFAULT_PREVIEW_LIMIT)

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
  // The media panel's folder browser (read only).
  ipcMain.handle('media:chooseFolder', async (event) => {
    const options: Electron.OpenDialogOptions = { title: 'Open Folder', buttonLabel: 'Open', properties: ['openDirectory'] }
    const window = owner(event.sender)
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('media:listFolder', (_event, folder: string) => listFolder(folder))
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

  // Audio analysis results (M8): computed in the renderer, kept in the project's cache as `<key>.bin`.
  const analysisFile = async (projectId: string, key: string) => {
    if (!/^[0-9a-f]{16}$/.test(key)) throw new Error('bad analysis key')
    return join(await cache.categoryDir(projectId, 'analysis'), `${key}.bin`)
  }
  ipcMain.handle('analysis:read', async (_event, projectId: string, key: string) => {
    try {
      const data = await readFile(await analysisFile(projectId, key))
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    } catch {
      return null
    }
  })
  ipcMain.handle('analysis:write', async (_event, projectId: string, key: string, data: ArrayBuffer) => {
    const file = await analysisFile(projectId, key)
    await writeFile(`${file}.partial`, Buffer.from(data))
    await rename(`${file}.partial`, file)
  })

  // Stems for the Channel Rack's detection (W3): separated once per song file, kept with the analysis.
  ipcMain.handle('stems:status', () => stemsStatus(app.getAppPath()))
  ipcMain.handle('stems:separate', async (event, projectId: string, input: string, key: string) => {
    if (!/^[0-9a-f]{16}$/.test(key)) throw new Error('bad stems key')
    const dir = join(await cache.categoryDir(projectId, 'analysis'), 'stems', key)
    return separateStems(app.getAppPath(), input, dir, (line) => event.sender.send('stems:progress', line))
  })
  ipcMain.handle('stems:pcm', (_event, path: string, rate: number) => stemPcm(path, rate))

  // Preview renders (M9): one JPEG per frame, named by its frame key.
  ipcMain.handle('renders:list', (_event, projectId: string) => previews.list(projectId))
  ipcMain.handle('renders:read', (_event, projectId: string, key: string) => previews.read(projectId, key))
  ipcMain.handle('renders:write', (_event, projectId: string, key: string, data: ArrayBuffer) => previews.write(projectId, key, data))
  ipcMain.handle('cache:previewLimit', async () => ({ limit: previews.limit, used: await previews.total() }))
  ipcMain.handle('cache:setPreviewLimit', async (_event, bytes: number) => {
    if (!Number.isFinite(bytes) || bytes < 256 * 1024 ** 2) throw new Error('The limit is at least 256 MB')
    previews.limit = bytes
    settings.previewLimit = bytes
    await settingsFile.write(settings)
    return previews.enforce()
  })

  ipcMain.handle('media:checkFiles', async (_event, items: Array<{ id: string; path: string; fingerprint: MediaFingerprint }>) =>
    Promise.all(items.map(async (item) => ({ id: item.id, status: await checkFile(item.path, item.fingerprint) })))
  )

  // ---- Input LUTs: copied into the project folder so the project carries them ----------
  const projectDir = async (projectPath: string): Promise<string> => {
    const dir = resolve(projectPath)
    if (!dir.endsWith(PROJECT_EXTENSION) || !(await stat(dir)).isDirectory()) throw new Error('Not a ginosa project folder')
    return dir
  }

  ipcMain.handle('media:chooseLut', async (event, purpose?: 'input' | 'look') => {
    const title = purpose === 'look' ? 'Choose a look LUT (it will be copied into the project)' : 'Choose an input LUT'
    const options: Electron.OpenDialogOptions = { title, buttonLabel: 'Use LUT', properties: ['openFile'], filters: [{ name: 'Cube LUT', extensions: ['cube'] }] }
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

  ipcMain.handle('media:listLuts', async (_event, projectPath: string) => {
    const dir = await projectDir(projectPath)
    const names = await readdir(join(dir, 'luts')).catch(() => [] as string[])
    return names
      .filter((n) => /\.cube$/i.test(n) && !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b))
      .map((n) => ({ name: n.replace(/\.cube$/i, ''), file: `luts/${n}` }))
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
    previews.forget()
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
    previews.forget()
    settings.cacheParent = parent
    await settingsFile.write(settings)
    return { root, previous }
  })
  ipcMain.handle('cache:categories', () => CACHE_CATEGORIES)

  return { cache, queue }
}
