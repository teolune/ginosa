import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runTool } from './ffmpeg'

/**
 * Stem separation for the Channel Rack's Automatic Detection (decision 108): demucs-mlx
 * (Demucs's htdemucs on Apple silicon through MLX, MIT) splits a song into drums, bass,
 * vocals and the rest, on this Mac. It lives in `.stems/` in the project folder (the Python
 * environment and the model's weights), set up by `npm run stems-setup`. The song file is
 * only read; stems go to the project's cache.
 */

export const STEM_NAMES = ['drums', 'bass', 'vocals', 'other'] as const
export type StemName = (typeof STEM_NAMES)[number]
export type StemPaths = Record<StemName, string>

export interface StemsStatus {
  ready: boolean
  /** Why not, in a sentence. */
  detail: string | null
}

const MODEL = 'htdemucs'

function separator(appRoot: string): string {
  return join(appRoot, '.stems', 'venv', 'bin', 'demucs-mlx')
}

export async function stemsStatus(appRoot: string): Promise<StemsStatus> {
  try {
    await access(separator(appRoot), constants.X_OK)
    return { ready: true, detail: null }
  } catch {
    return { ready: false, detail: 'Stem separation isn’t set up on this Mac yet: run  npm run stems-setup  in Terminal (once).' }
  }
}

async function findStems(dir: string): Promise<Partial<StemPaths>> {
  const found: Partial<StemPaths> = {}
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else {
        const stem = e.name.replace(/\.(flac|wav|mp3)$/i, '') as StemName
        if ((STEM_NAMES as readonly string[]).includes(stem) && !found[stem]) found[stem] = full
      }
    }
  }
  await walk(dir)
  return found
}

function complete(stems: Partial<StemPaths>): stems is StemPaths {
  return STEM_NAMES.every((n) => typeof stems[n] === 'string')
}

/**
 * The song's stems, from the cache when they've been made before (`dir` is keyed by the
 * song file's fingerprint), otherwise separated now: the song is converted to a WAV first
 * (so any format ginosa imports works), then demucs-mlx runs on it.
 */
export async function separateStems(appRoot: string, input: string, dir: string, onLine: (line: string) => void = () => undefined): Promise<StemPaths> {
  const cached = await findStems(dir)
  if (complete(cached)) return cached
  const status = await stemsStatus(appRoot)
  if (!status.ready) throw new Error(status.detail ?? 'Stem separation isn’t set up')
  const work = `${dir}.working`
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  const wav = join(work, 'song.wav')
  const decoded = await runTool('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', wav], { collect: false })
  if (decoded.code !== 0) throw new Error(`Couldn’t read the song: ${decoded.stderr.trim().split('\n').at(-1) ?? 'FFmpeg failed'}`)
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env, DEMUCS_MLX_CACHE_DIR: join(appRoot, '.stems', 'weights') }
    const child = spawn(separator(appRoot), [wav, '-o', join(work, 'out'), '-n', MODEL], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let tail = ''
    const read = (chunk: Buffer) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-4000)
      for (const line of text.split(/[\r\n]+/)) if (line.trim()) onLine(line.trim())
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`demucs-mlx stopped (exit ${code}): ${tail.trim().split('\n').at(-1) ?? ''}`))))
  })
  const made = await findStems(join(work, 'out'))
  if (!complete(made)) throw new Error(`demucs-mlx didn’t write all four stems (found ${Object.keys(made).join(', ') || 'none'})`)
  await mkdir(dir, { recursive: true })
  const out = {} as StemPaths
  for (const name of STEM_NAMES) {
    const ext = made[name].replace(/^.*\./, '')
    const target = join(dir, `${name}.${ext}`)
    await rename(made[name], target)
    out[name] = target
  }
  await rm(work, { recursive: true, force: true })
  return out
}

/** A stem as mono 32-bit float samples at `rate` (for the analysis worker). */
export async function stemPcm(path: string, rate: number): Promise<ArrayBuffer> {
  await stat(path)
  const result = await runTool('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'])
  if (result.code !== 0) throw new Error(`Couldn’t read the stem: ${result.stderr.trim().split('\n').at(-1) ?? 'FFmpeg failed'}`)
  const b = result.stdout
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
