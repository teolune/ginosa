import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runTool } from './ffmpeg'

/**
 * Stem separation for the Channel Rack's Automatic Detection (decisions 108, W4.2), on this Mac,
 * in `.stems/` in the ginosa folder (set up by `npm run stems-setup`; the Cache window lists and
 * deletes it). Two separators, best first:
 *  - BS-RoFormer-SW (jarredou, through mlx-audio-separator on MLX): six stems; on MVSEP's test
 *    set 14.11 dB on drums and 14.62 on bass, about 2.6–2.9 dB better than Demucs;
 *  - htdemucs (Meta's Demucs, through demucs-mlx): four stems, about 7× quicker.
 * Then the drum transcriber (W4.3, scripts/detect/listen.py) finds the kick, snare and hi-hat
 * hits in the drums stem. The song file is only read; stems and hits go to the project's cache.
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
  /** The drum transcriber (W4.3: DrumSep and ADTOF) is set up. */
  transcriber: boolean
  /** Beat This! (W4.5) is set up, for the tempo and bar 1 of the song on A1. */
  beats: boolean
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

const allThere = async (dir: string, files: string[]) => (await Promise.all(files.map((f) => exists(join(dir, f))))).every(Boolean)

/** DrumSep (MDX23C, aufr33 and jarredou): its checkpoint (a placeholder once converted), MLX weights and settings. */
const DRUMSEP_FILES = ['MDX23C-DrumSep-aufr33-jarredou.ckpt', 'MDX23C-DrumSep-aufr33-jarredou.safetensors', 'config_drumsep_mdx23c.yaml']

const LISTEN = (appRoot: string) => join(appRoot, 'scripts', 'detect', 'listen.py')

/** ADTOF's PyTorch port in the environment, DrumSep's weights and the script that runs them. */
async function transcriberReady(appRoot: string): Promise<boolean> {
  const lib = join(appRoot, '.stems', 'venv', 'lib')
  const versions = (await readdir(lib).catch(() => [] as string[])).filter((d) => d.startsWith('python'))
  const adtof = (await Promise.all(versions.map((v) => exists(join(lib, v, 'site-packages', 'adtof_pytorch', 'model.py'))))).some(Boolean)
  return adtof && (await exists(bin(appRoot, 'python'), constants.X_OK)) && (await exists(bin(appRoot, 'mlx-audio-separator'), constants.X_OK)) && (await allThere(models(appRoot), DRUMSEP_FILES)) && (await exists(LISTEN(appRoot)))
}

const BEATS = (appRoot: string) => join(appRoot, 'scripts', 'detect', 'beats.py')
const BEAT_THIS_CHECKPOINT = (appRoot: string) => join(appRoot, '.stems', 'torch', 'hub', 'checkpoints', 'beat_this-final0.ckpt')

/** Beat This! in the environment, its checkpoint and the script that runs it. */
async function beatsReady(appRoot: string): Promise<boolean> {
  const lib = join(appRoot, '.stems', 'venv', 'lib')
  const versions = (await readdir(lib).catch(() => [] as string[])).filter((d) => d.startsWith('python'))
  const beatThis = (await Promise.all(versions.map((v) => exists(join(lib, v, 'site-packages', 'beat_this', 'inference.py'))))).some(Boolean)
  return beatThis && (await exists(bin(appRoot, 'python'), constants.X_OK)) && (await exists(BEAT_THIS_CHECKPOINT(appRoot))) && (await exists(BEATS(appRoot)))
}

export async function stemsStatus(appRoot: string): Promise<StemsStatus> {
  const separators: Separator[] = []
  if ((await exists(bin(appRoot, 'mlx-audio-separator'), constants.X_OK)) && (await allThere(models(appRoot), SW_FILES))) separators.push('bs-roformer-sw')
  if (await exists(bin(appRoot, 'demucs-mlx'), constants.X_OK)) separators.push('htdemucs')
  const transcriber = separators.length > 0 && (await transcriberReady(appRoot))
  const beats = await beatsReady(appRoot)
  return separators.length
    ? { ready: true, detail: null, separators, transcriber, beats }
    : { ready: false, detail: 'Stem separation isn’t set up on this Mac yet: set it up in the Cache window, or run  npm run stems-setup  in Terminal (once).', separators, transcriber, beats }
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
        // The last name in brackets ("song_(drums)_BS-Roformer-SW_(kick)_…" is a kick), else the file's name.
        const stem = ([...e.name.matchAll(/_\((\w+)\)_/g)].at(-1)?.[1] ?? e.name.replace(/\.(flac|wav|mp3)$/i, '')) as StemName
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

/** The drum transcriber's channels (listen.py): ADTOF's five classes, ginosa's names. */
export const DRUM_KINDS = ['kick', 'clap', 'hihat', 'toms', 'cymbals'] as const
export type DrumHits = Partial<Record<(typeof DRUM_KINDS)[number], number[]>>
/** Raised when listen.py's method changes, so songs are transcribed again. */
const TRANSCRIBER_VERSION = 3

/**
 * The drum hits (seconds in the song file) in the stems in `dir` (made by separateStems): from
 * the cache when transcribed before, otherwise by listen.py now (DrumSep, ADTOF, then each
 * channel's hits: ADTOF's, plus the strong onsets in its DrumSep piece ADTOF missed).
 */
export async function drumHits(appRoot: string, dir: string, onLine: (line: string) => void = () => undefined): Promise<DrumHits> {
  const out = join(dir, `drum-hits-v${TRANSCRIBER_VERSION}`)
  const file = join(out, 'drum-hits.json')
  const read = async (): Promise<DrumHits | null> => {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) return null
    const parsed = JSON.parse(text) as Record<string, unknown>
    const hits: DrumHits = {}
    for (const kind of DRUM_KINDS) {
      const times = parsed[kind]
      if (Array.isArray(times)) hits[kind] = times.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0)
    }
    return hits
  }
  const cached = await read()
  if (cached) return cached
  const drums = (await findStems(dir)).drums
  if (!drums) throw new Error('the song hasn’t been separated into stems yet')
  if (!(await transcriberReady(appRoot))) throw new Error('the drum transcriber isn’t set up on this Mac: set up detection again in the Cache window')
  if (settingUp) throw new Error('Detection is being set up; try again when it has finished.')
  separating++
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin(appRoot, 'python'), [LISTEN(appRoot), drums, out], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HF_HOME: join(appRoot, '.stems', 'hf') } })
      let tail = ''
      const take = (chunk: Buffer) => {
        const text = chunk.toString()
        tail = (tail + text).slice(-4000)
        for (const line of text.split(/[\r\n]+/)) if (line.trim()) onLine(line.trim())
      }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`the drum transcriber stopped (exit ${code}): ${tail.trim().split('\n').at(-1) ?? ''}`))))
    })
  } finally {
    separating--
  }
  const made = await read()
  if (!made) throw new Error('the drum transcriber wrote no hits')
  return made
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

/** What Beat This! heard in a song (beats.py): seconds in the song file. */
export interface SongBeats {
  beats: number[]
  downbeats: number[]
  firstSound: number
}
/** Raised when beats.py's method changes, so songs are heard again. */
const BEATS_VERSION = 1

/**
 * The beats and downbeats of the song file `input` (W4.5), from the cache in `dir` when heard
 * before, otherwise by Beat This! now (the song is converted to a WAV first, so any format works).
 */
export async function songBeats(appRoot: string, input: string, dir: string): Promise<SongBeats> {
  const file = join(dir, `beats-v${BEATS_VERSION}.json`)
  const read = async (): Promise<SongBeats | null> => {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) return null
    const parsed = JSON.parse(text) as Record<string, unknown>
    const times = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0) : [])
    return { beats: times(parsed['beats']), downbeats: times(parsed['downbeats']), firstSound: typeof parsed['firstSound'] === 'number' ? parsed['firstSound'] : 0 }
  }
  const cached = await read()
  if (cached) return cached
  if (!(await beatsReady(appRoot))) throw new Error('Beat This! isn’t set up on this Mac: set up detection again in the Cache window')
  if (settingUp) throw new Error('Detection is being set up; try again when it has finished.')
  separating++
  const work = `${dir}.beats-working`
  try {
    await rm(work, { recursive: true, force: true })
    await mkdir(work, { recursive: true })
    const wav = join(work, 'song.wav')
    const decoded = await runTool('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_f32le', wav], { collect: false })
    if (decoded.code !== 0) throw new Error(`Couldn’t read the song: ${decoded.stderr.trim().split('\n').at(-1) ?? 'FFmpeg failed'}`)
    await mkdir(dir, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin(appRoot, 'python'), [BEATS(appRoot), wav, file], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TORCH_HOME: join(appRoot, '.stems', 'torch') } })
      let tail = ''
      const take = (chunk: Buffer) => (tail = (tail + chunk.toString()).slice(-4000))
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Beat This! stopped (exit ${code}): ${tail.trim().split('\n').at(-1) ?? ''}`))))
    })
  } finally {
    separating--
    await rm(work, { recursive: true, force: true })
  }
  const heard = await read()
  if (!heard) throw new Error('Beat This! wrote no beats')
  return heard
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
  venv: 'Python packages (MLX, PyTorch, the separators, ADTOF, Beat This!)',
  torch: 'Beat This! model',
  python: 'Python 3.12 (a private copy)',
  bootstrap: 'Setup tools (uv)',
  weights: 'Demucs model (htdemucs)',
  hf: 'Models from Hugging Face',
  models: 'Separation models (BS-RoFormer-SW, DrumSep)'
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
