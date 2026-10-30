import type { GinosaBridge } from '../shared/ipc'

declare global {
  interface Window {
    ginosa: GinosaBridge
  }
}

export {}
