import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runTool } from './ffmpeg'

/**
 * Stem separation for the Channel Rack's Automatic Detection (decisions 108, W4.2), on this Mac,
 * in `.stems/` in the ginosa folder (set up by `npm run stems-setup`; the Cache window lists and
 * deletes it). Two separators, best first:
 *  - BS-RoFormer-SW (jarredou, through mlx-audio-separator on MLX): six stems; on MVSEP's test
 *    set 14.11 dB on drums and 14.62 on bass, about 2.6–2.9 dB better than Demucs;
 *  - htdemucs (Meta's Demucs, through demucs-mlx): four stems, about 7× quicker.
 * The song file is only read; stems go to the project's cache.
 */

export const STEM_NAMES = ['drums', 'bass', 'vocals', 'other'] as const
export type StemName = (typeof STEM_NAMES)[number]
export type StemPaths = Record<StemName, string>

export const SEPARATORS = ['bs-roformer-sw', 'htdemucs'] as const
export type Separator = (typeof SEPARATORS)[number]

export interface StemsStatus {
  ready: boolean
  /** Why not, in a sentence. */
  detail: string | null
  /** The separators set up on this Mac, best first. */
  separators: Separator[]
}

const bin = (appRoot: string, name: string) => join(appRoot, '.stems', 'venv', 'bin', name)
const models = (appRoot: string) => join(appRoot, '.stems', 'models')
/** BS-RoFormer-SW's checkpoint, and the MLX weights converted from it once (the separator wants both). */
const SW_FILES = ['BS-Roformer-SW.ckpt', 'BS-Roformer-SW.safetensors', 'BS-Roformer-SW.yaml']

const exists = (path: string, mode = constants.R_OK) =>
  access(path, mode).then(
    () => true,
    () => false
  )

export async function stemsStatus(appRoot: string): Promise<StemsStatus> {
  const separators: Separator[] = []
  if ((await exists(bin(appRoot, 'mlx-audio-separator'), constants.X_OK)) && (await Promise.all(SW_FILES.map((f) => exists(join(models(appRoot), f))))).every(Boolean)) separators.push('bs-roformer-sw')
  if (await exists(bin(appRoot, 'demucs-mlx'), constants.X_OK)) separators.push('htdemucs')
  return separators.length
    ? { ready: true, detail: null, separators }
    : { ready: false, detail: 'Stem separation isn’t set up on this Mac yet: set it up in the Cache window, or run  npm run stems-setup  in Terminal (once).', separators }
}

/** A separator's stems in `dir`: `drums.wav` as kept in the cache, or `…_(drums)_…` as mlx-audio-separator names them. */
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
        const stem = (/_\((\w+)\)_/.exec(e.name)?.[1] ?? e.name.replace(/\.(flac|wav|mp3)$/i, '')) as StemName
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
 * The song's stems by `separator`, from the cache when they've been made before (`dir` is keyed
 * by the song file's fingerprint and the separator), otherwise separated now: the song is
 * converted to a WAV first (so any format ginosa imports works), then the separator runs on it.
 */
export async function separateStems(appRoot: string, input: string, dir: string, separator: Separator, onLine: (line: string) => void = () => undefined): Promise<StemPaths> {
  const cached = await findStems(dir)
  if (complete(cached)) return cached
  const status = await stemsStatus(appRoot)
  if (!status.separators.includes(separator)) throw new Error(status.detail ?? `${separator} isn’t set up on this Mac`)
  if (settingUp) throw new Error('Detection is being set up; try again when it has finished.')
  separating++
  try {
    return await separate(appRoot, input, dir, separator, onLine)
  } finally {
    separating--
  }
}

function command(appRoot: string, separator: Separator, wav: string, out: string): { exe: string; args: string[]; env: NodeJS.ProcessEnv } {
  const stems = join(appRoot, '.stems')
  if (separator === 'htdemucs') return { exe: bin(appRoot, 'demucs-mlx'), args: [wav, '-o', out, '-n', 'htdemucs'], env: { ...process.env, DEMUCS_MLX_CACHE_DIR: join(stems, 'weights') } }
  // Its weights stay in .stems/models (never ~/.cache), and it runs in MLX's default precision
  // (TF32 on the M5's GPU: 42.6 dB from full float32 on the drums of your song, far below separation's own error).
  return {
    exe: bin(appRoot, 'mlx-audio-separator'),
    args: [wav, '-m', 'BS-Roformer-SW.ckpt', '--model_file_dir', models(appRoot), '--output_dir', out, '--output_format', 'WAV'],
    env: { ...process.env, HF_HOME: join(stems, 'hf') }
  }
}

async function separate(appRoot: string, input: string, dir: string, separator: Separator, onLine: (line: string) => void): Promise<StemPaths> {
  const work = `${dir}.working`
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })
  const wav = join(work, 'song.wav')
  const decoded = await runTool('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', wav], { collect: false })
  if (decoded.code !== 0) throw new Error(`Couldn’t read the song: ${decoded.stderr.trim().split('\n').at(-1) ?? 'FFmpeg failed'}`)
  const { exe, args, env } = command(appRoot, separator, wav, join(work, 'out'))
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let tail = ''
    const read = (chunk: Buffer) => {
      const text = chunk.toString()
      tail = (tail + text).slice(-4000)
      for (const line of text.split(/[\r\n]+/)) if (line.trim()) onLine(line.trim())
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${separator} stopped (exit ${code}): ${tail.trim().split('\n').at(-1) ?? ''}`))))
  })
  const made = await findStems(join(work, 'out'))
  if (!complete(made)) throw new Error(`${separator} didn’t write all four stems (found ${Object.keys(made).join(', ') || 'none'})`)
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

/** The detection models in `.stems/` (decision 119): what's there and its size, for the Cache window. */
export interface DetectionModels {
  root: string
  total: number
  parts: Array<{ name: string; bytes: number }>
  /** Stem separation works (the separator is installed). */
  ready: boolean
}

const PART_NAMES: Record<string, string> = {
  venv: 'Python packages (MLX, PyTorch, the separators)',
  python: 'Python 3.12 (a private copy)',
  bootstrap: 'Setup tools (uv)',
  weights: 'Demucs model (htdemucs)',
  hf: 'Models from Hugging Face',
  models: 'Separation models (BS-RoFormer-SW, …)'
}

async function bytesIn(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path).catch(() => [] as string[])) total += await bytesIn(join(path, entry))
  return total
}

export async function detectionModels(appRoot: string): Promise<DetectionModels> {
  const root = join(appRoot, '.stems')
  const parts: DetectionModels['parts'] = []
  for (const entry of (await readdir(root).catch(() => [] as string[])).filter((e) => !e.startsWith('.')).sort()) {
    parts.push({ name: PART_NAMES[entry] ?? entry, bytes: await bytesIn(join(root, entry)) })
  }
  return { root, total: parts.reduce((sum, p) => sum + p.bytes, 0), parts, ready: (await stemsStatus(appRoot)).ready }
}

/** Separations running now: the models can't be deleted or set up meanwhile. */
let separating = 0
let settingUp = false

export async function deleteDetectionModels(appRoot: string): Promise<void> {
  if (separating > 0 || settingUp) throw new Error('Detection is using the models right now; try again when it has finished.')
  await rm(join(appRoot, '.stems'), { recursive: true, force: true })
}

/** Runs `npm run stems-setup`'s script (downloads Python packages and models), line by line; resolves with its exit code. */
export async function setUpDetection(appRoot: string, onLine: (line: string) => void): Promise<number> {
  if (settingUp) throw new Error('Detection is already being set up.')
  if (separating > 0) throw new Error('Detection is running; set up again when it has finished.')
  settingUp = true
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn('bash', [join(appRoot, 'scripts', 'stems-setup.sh')], { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      const read = (chunk: Buffer) => {
        // eslint-disable-next-line no-control-regex
        for (const line of chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').split(/[\r\n]+/)) if (line.trim()) onLine(line.trim())
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? -1))
    })
  } finally {
    settingUp = false
  }
}
