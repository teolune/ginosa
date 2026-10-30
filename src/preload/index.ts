import { contextBridge, ipcRenderer } from 'electron'
import type { GinosaBridge, HarnessReport } from '@shared/ipc'
import { mediaUrlForPath } from '@shared/ipc'

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
  }
}

contextBridge.exposeInMainWorld('ginosa', bridge)
