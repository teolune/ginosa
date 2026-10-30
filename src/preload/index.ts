import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { GinosaBridge, HarnessReport, JournalEntry, MenuCommand, MenuState } from '@shared/ipc'
import type { OptimiseJob } from '@shared/media-types'
import { mediaUrlForPath } from '@shared/ipc'

const snapshotArg = process.argv.find((arg) => arg.startsWith('--ginosa-snapshot='))

function listen<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const bridge: GinosaBridge = {
  versions: {
    electron: process.versions['electron'] ?? 'unknown',
    chrome: process.versions['chrome'] ?? 'unknown',
    node: process.versions['node'] ?? 'unknown'
  },
  platform: process.platform,
  arch: process.arch,
  openMediaDialog: () => ipcRenderer.invoke('dialog:openMedia'),
  mediaUrl: (absolutePath: string) => mediaUrlForPath(absolutePath),
  harness: {
    getJob: () => ipcRenderer.invoke('harness:getJob'),
    writeFile: (name: string, data: ArrayBuffer) => ipcRenderer.invoke('harness:writeFile', name, data),
    done: (report: HarnessReport) => ipcRenderer.invoke('harness:done', report),
    log: (message: string) => ipcRenderer.send('harness:log', message)
  },
  project: {
    chooseNewLocation: () => ipcRenderer.invoke('project:chooseNewLocation'),
    create: (path: string, json: string) => ipcRenderer.invoke('project:create', path, json),
    open: (path?: string) => ipcRenderer.invoke('project:open', path),
    save: (json: string) => ipcRenderer.invoke('project:save', json),
    saveAs: (json: string) => ipcRenderer.invoke('project:saveAs', json),
    autosave: (json: string) => ipcRenderer.invoke('project:autosave', json),
    journal: (entry: JournalEntry) => ipcRenderer.send('project:journal', entry),
    discardRecovery: () => ipcRenderer.invoke('project:discardRecovery'),
    close: () => ipcRenderer.invoke('project:close'),
    recent: () => ipcRenderer.invoke('project:recent'),
    reveal: () => ipcRenderer.invoke('project:reveal'),
    askUnsaved: (projectName: string) => ipcRenderer.invoke('project:askUnsaved', projectName),
    showError: (title: string, detail: string) => ipcRenderer.invoke('project:showError', title, detail)
  },
  workspace: {
    load: () => ipcRenderer.invoke('workspace:load'),
    save: (data: unknown) => ipcRenderer.invoke('workspace:save', data)
  },
  menu: {
    setState: (state: MenuState) => ipcRenderer.send('menu:setState', state),
    onCommand: (listener: (command: MenuCommand) => void) => listen('menu:command', listener)
  },
  app: {
    onCloseRequested: (listener: () => void) => listen('app:close-requested', () => listener()),
    closeNow: () => ipcRenderer.send('app:closeNow'),
    closeCancelled: () => ipcRenderer.send('app:closeCancelled')
  },
  media: {
    chooseImport: () => ipcRenderer.invoke('media:chooseImport'),
    classify: (paths) => ipcRenderer.invoke('media:classify', paths),
    probe: (paths) => ipcRenderer.invoke('media:probe', paths),
    probeOne: (path) => ipcRenderer.invoke('media:probeOne', path),
    thumbnail: (request) => ipcRenderer.invoke('media:thumbnail', request),
    waveform: (request) => ipcRenderer.invoke('media:waveform', request),
    checkFiles: (items) => ipcRenderer.invoke('media:checkFiles', items),
    chooseRelink: (fileName) => ipcRenderer.invoke('media:chooseRelink', fileName),
    searchMoved: (folder, wanted) => ipcRenderer.invoke('media:searchMoved', folder, wanted),
    reveal: (path) => ipcRenderer.invoke('media:reveal', path),
    optimise: (request) => ipcRenderer.invoke('media:optimise', request),
    optimisedPath: (projectId, mediaId, fingerprint) => ipcRenderer.invoke('media:optimisedPath', projectId, mediaId, fingerprint),
    jobs: () => ipcRenderer.invoke('media:jobs'),
    cancelJob: (jobId) => ipcRenderer.invoke('media:cancelJob', jobId),
    onJobUpdate: (listener: (job: OptimiseJob) => void) => listen('media:jobUpdate', listener),
    pathForFile: (file: File) => webUtils.getPathForFile(file)
  },
  cache: {
    registerProject: (projectId, name, path) => ipcRenderer.invoke('cache:registerProject', projectId, name, path),
    usage: () => ipcRenderer.invoke('cache:usage'),
    clear: (projectId, category) => ipcRenderer.invoke('cache:clear', projectId, category),
    reveal: () => ipcRenderer.invoke('cache:reveal'),
    chooseLocation: () => ipcRenderer.invoke('cache:chooseLocation')
  },
  snapshot: {
    scenario: snapshotArg ? snapshotArg.slice('--ginosa-snapshot='.length) : null,
    tempProjectPath: () => ipcRenderer.invoke('snapshot:tempProjectPath'),
    simulateCrash: () => ipcRenderer.invoke('snapshot:simulateCrash'),
    testMedia: () => ipcRenderer.invoke('snapshot:testMedia'),
    ready: () => ipcRenderer.invoke('snapshot:ready')
  }
}

contextBridge.exposeInMainWorld('ginosa', bridge)
