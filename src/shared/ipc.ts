/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Keep this file free of Node or DOM imports so every side can use it.
 */

/** Custom URL scheme that streams local media files (read-only, with HTTP range support). */
export const MEDIA_SCHEME = 'ginosa-media'

/** Build a URL the renderer can fetch for a local file path. */
export function mediaUrlForPath(absolutePath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(absolutePath)}`
}

/** Inverse of mediaUrlForPath. Returns null when the URL is not a media URL. */
export function pathFromMediaUrl(url: string): string | null {
  const prefix = `${MEDIA_SCHEME}://local/`
  if (!url.startsWith(prefix)) return null
  const encoded = url.slice(prefix.length).split(/[?#]/)[0] ?? ''
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export type TestEffect = 'none' | 'invert'

/** A render-harness job, built by the main process from command-line flags. */
export interface HarnessJob {
  input: string
  inputUrl: string
  /** Frame indices to render (0-based, in the file's own frame rate). */
  frames: number[]
  effect: TestEffect
  amount: number
  outDir: string
}

export interface HarnessFrameResult {
  frame: number
  file: string
  timestamp: number | null
  decodeMs: number
  gpuMs: number
}

export interface HarnessReport {
  ok: boolean
  error?: string
  job: HarnessJob
  diagnostics: unknown
  clip: unknown
  frames: HarnessFrameResult[]
}

/** API exposed to the renderer by the preload script as `window.ginosa`. */
export interface GinosaBridge {
  versions: { electron: string; chrome: string; node: string }
  platform: string
  arch: string
  openMediaDialog(): Promise<string | null>
  mediaUrl(absolutePath: string): string
  harness: {
    getJob(): Promise<HarnessJob | null>
    writeFile(name: string, data: ArrayBuffer): Promise<string>
    done(report: HarnessReport): Promise<void>
    log(message: string): void
  }
}
