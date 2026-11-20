import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { access, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { frameKind, joinM4v, splitM4v } from '../../engine/datamosh/m4v'
import { motionReaderScript, vectorScript } from '../../engine/datamosh/vectors'
import { frameRateValue, type FrameRate } from '../../engine/time'
import type { BakeBegin, BakeFile, BakeProgress, BakeStatus } from '../../shared/ipc'
import type { CacheService } from '../cache/cache-service'
import { findTool } from '../media/ffmpeg'
import { probeFile } from '../media/media-files'

/**
 * Datamosh Bake (M15, decision 133), the main process's part. The interface renders the span's
 * frames and sends them here as raw Y'CbCr (like an export); FFglitch's ffgac encodes them as
 * MPEG-4 Part 2 with keyframes only where the bake's plan says; the frames are put in the plan's
 * order (melts and blooms); ffedit runs the bake's vector script (with a motion source's vectors
 * read out of its own encode first); FFmpeg decodes the broken stream, errors tolerated, scales
 * it back to the effect's picture size with whole blocks, and writes H.264 into the project's
 * cache as bakes/<key>.mp4, with <key>.json beside it. Everything in between is in a temporary
 * folder that goes when the bake ends, worked or not.
 */

const FFGLITCH_VERSION = '0.10.2'

/** FFglitch's programs in .ffglitch/bin (npm run ffglitch-setup), or GINOSA_FFGLITCH's folder. */
function glitchTool(name: 'ffgac' | 'ffedit'): string {
  return join(process.env['GINOSA_FFGLITCH'] ?? join(app.getAppPath(), '.ffglitch', 'bin'), name)
}

async function canRun(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function bakeStatus(): Promise<BakeStatus> {
  const ready = (await canRun(glitchTool('ffgac'))) && (await canRun(glitchTool('ffedit')))
  return { ready, version: ready ? FFGLITCH_VERSION : null, detail: ready ? null : 'FFglitch isn’t set up. In Terminal, in the ginosa folder: npm run ffglitch-setup' }
}

interface Job {
  id: string
  request: BakeBegin
  temp: string
  encoders: Record<'picture' | 'motion', Encoder | null>
  aborted: boolean
  children: Set<ChildProcess>
}

interface Encoder {
  child: ChildProcessWithoutNullStreams
  exited: Promise<number>
  stderr: string
  output: string
  frames: number
}

const jobs = new Map<string, Job>()

const rateText = (rate: FrameRate) => `${rate.num}/${rate.den}`

/** ffgac: raw NV12 frames in, MPEG-4 Part 2 out, with keyframes only on `keyframes` (frame numbers). */
function encoderArgs(request: BakeBegin, keyframes: readonly number[], output: string): string[] {
  const expr = keyframes.map((k) => `eq(n,${k})`).join('+') || 'eq(n,0)'
  // prettier-ignore
  return [
    '-hide_banner', '-nostdin', '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'nv12', '-s', `${request.width}x${request.height}`, '-r', rateText(request.rate), '-i', 'pipe:0',
    '-an', '-vcodec', 'mpeg4',
    // Every block has a vector (so ffedit can move it), and no block is coded afresh inside a
    // P-frame (that would heal the mosh); the widest vectors (fcode 6); no B-frames; keyframes
    // only where asked (no GOP length, no scene-change keyframes).
    '-mpv_flags', '+nopimb+forcemv', '-qscale:v', String(request.quantiser), '-fcode', '6', '-bf', '0',
    '-g', 'max', '-sc_threshold', 'max', '-force_key_frames', `expr:${expr}`,
    '-f', 'rawvideo', output
  ]
}

function startEncoder(job: Job, keyframes: readonly number[], output: string): Encoder {
  const child = spawn(glitchTool('ffgac'), encoderArgs(job.request, keyframes, output), { stdio: ['pipe', 'pipe', 'pipe'] })
  job.children.add(child)
  const encoder: Encoder = { child, exited: new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1))), stderr: '', output, frames: 0 }
  child.stderr.on('data', (chunk: Buffer) => {
    encoder.stderr = (encoder.stderr + chunk.toString()).slice(-16_000)
  })
  child.stdin.on('error', () => undefined) // reported through the exit code
  child.on('error', (error) => (encoder.stderr += error.message))
  void encoder.exited.then(() => job.children.delete(child))
  return encoder
}

/** Runs a program to the end; rejects with the end of its errors when it fails. */
function run(job: Job, bin: string, args: string[], what: string, onStdout?: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (job.aborted) return reject(new Error('Cancelled'))
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: job.temp })
    job.children.add(child)
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => onStdout?.(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16_000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      job.children.delete(child)
      if (job.aborted) return reject(new Error('Cancelled'))
      if (code === 0) resolve()
      else reject(new Error(`${what} failed: ${stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`}`))
    })
  })
}

async function finishEncoder(encoder: Encoder | null, what: string): Promise<void> {
  if (!encoder) return
  encoder.child.stdin.end()
  const code = await encoder.exited
  if (code !== 0) throw new Error(`${what} failed: ${encoder.stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`}`)
}

async function bake(job: Job, cache: CacheService, progress: (p: BakeProgress) => void): Promise<BakeFile> {
  const { request, temp } = job
  await finishEncoder(job.encoders.picture, 'Encoding')
  await finishEncoder(job.encoders.motion, 'Encoding the motion source')
  if (job.encoders.picture!.frames !== request.frames) throw new Error(`Only ${job.encoders.picture!.frames} of ${request.frames} frames arrived`)

  // The frame surgery: the plan's order (melts and blooms).
  progress({ id: job.id, stage: 'breaking', fraction: 0 })
  const stream = splitM4v(new Uint8Array(await readFile(job.encoders.picture!.output)))
  if (stream.frames.length !== request.frames) throw new Error(`The encoder made ${stream.frames.length} frames, not ${request.frames}`)
  const kinds = stream.frames.map(frameKind)
  const wanted = new Set(request.keyframes)
  const wrong = kinds.findIndex((k, i) => (k === 'I') !== wanted.has(i) || k === 'B')
  if (wrong >= 0) throw new Error(`The encoder put a ${kinds[wrong]}-frame at frame ${wrong}, against the bake's plan`)
  const edited = join(temp, 'edited.m4v')
  await writeFile(edited, joinM4v(stream, request.order))

  // The vector tools.
  let broken = edited
  const notes: string[] = []
  if (request.vectors) {
    let motionFile: string | null = null
    if (job.encoders.motion) {
      progress({ id: job.id, stage: 'vectors', fraction: 0 })
      motionFile = join(temp, 'motion.txt')
      await writeFile(join(temp, 'motion-reader.js'), motionReaderScript(motionFile))
      await run(job, glitchTool('ffedit'), ['-i', job.encoders.motion.output, '-f', 'mv', '-s', join(temp, 'motion-reader.js')], 'Reading the motion source’s vectors')
      const lines = (await readFile(motionFile, 'utf8').catch(() => '')).split('\n').filter(Boolean)
      const firstVectors = (lines.find((l) => l !== '-') ?? '').split(',').map(Number)
      const meanH = firstVectors.filter((_, k) => k % 2 === 0).reduce((a, b) => a + b, 0) / Math.max(1, firstVectors.length / 2)
      notes.push(`motion source: ${lines.length} lines, ${lines.filter((l) => l !== '-').length} with vectors, the first ${firstVectors.length} numbers long, mean h ${meanH.toFixed(2)}`)
    }
    progress({ id: job.id, stage: 'vectors', fraction: 0.5 })
    const logFile = join(temp, 'vectors-log.txt')
    await writeFile(join(temp, 'vectors.js'), vectorScript({ frames: request.vectors, unit: request.unit, seed: request.seed, motionFile, logFile }))
    broken = join(temp, 'glitched.m4v')
    await run(job, glitchTool('ffedit'), ['-y', '-i', edited, '-f', 'mv', '-s', join(temp, 'vectors.js'), '-o', broken], 'ffedit')
    notes.push(...(await readFile(logFile, 'utf8').catch(() => 'no vector log')).split('\n'))
  }

  // Back to video: decoded with errors tolerated, whole blocks scaled to the picture's size, H.264.
  progress({ id: job.id, stage: 'decoding', fraction: 0 })
  const dir = await cache.categoryDir(request.projectId, 'bakes')
  const output = join(dir, `${request.key}.mp4`)
  const partial = join(temp, 'bake.mp4')
  const gop = Math.max(1, Math.round(frameRateValue(request.rate) / 2))
  // prettier-ignore
  const args = [
    '-hide_banner', '-nostdin', '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1',
    '-err_detect', 'ignore_err', '-r', rateText(request.rate), '-f', 'm4v', '-i', broken,
    // A frame the decoder couldn't make at the very end is the last one again, so the length holds.
    '-vf', `scale=${request.output.width}:${request.output.height}:flags=neighbor,tpad=stop_mode=clone:stop=${request.frames},format=yuv420p`,
    '-frames:v', String(request.frames), '-r', rateText(request.rate),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-profile:v', 'high', '-g', String(gop),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-an', '-movflags', '+faststart', '-f', 'mp4', partial
  ]
  await run(job, await findTool('ffmpeg'), args, 'Decoding the bake', (text) => {
    const frame = /frame=(\d+)/.exec(text)
    if (frame) progress({ id: job.id, stage: 'decoding', fraction: Math.min(1, Number(frame[1]) / request.frames) })
  })
  await rename(partial, output).catch(async () => {
    // Another volume: copy by reading, then remove.
    await writeFile(output, await readFile(partial))
  })
  const probe = await probeFile(output)
  if (!probe.ok) throw new Error(`The bake can't be read back: ${probe.error}`)
  const file: BakeFile = { key: request.key, path: output, frames: request.frames, info: probe.file.info, size: (await stat(output)).size, notes: notes.join('\n').split('\n').filter(Boolean).slice(-20) }
  await writeFile(join(dir, `${request.key}.json`), JSON.stringify(file))
  return file
}

async function stop(job: Job): Promise<void> {
  job.aborted = true
  for (const child of job.children) child.kill('SIGKILL')
  jobs.delete(job.id)
  await rm(job.temp, { recursive: true, force: true })
}

export function registerBakeIpc(cache: CacheService): void {
  ipcMain.handle('bake:status', () => bakeStatus())

  ipcMain.handle('bake:setUp', (event) => {
    return new Promise<number>((resolve, reject) => {
      const root = app.getAppPath()
      const child = spawn('bash', [join(root, 'scripts', 'ffglitch-setup.sh')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      const read = (chunk: Buffer) => {
        // eslint-disable-next-line no-control-regex
        for (const line of chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').split(/[\r\n]+/)) if (line.trim()) event.sender.send('bake:setupLine', line.trim())
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? -1))
    })
  })

  /** The bakes in a project's cache, from the notes written beside them. */
  ipcMain.handle('bake:list', async (_event, projectId: string): Promise<BakeFile[]> => {
    const dir = await cache.categoryDir(projectId, 'bakes')
    const out: BakeFile[] = []
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{16}\.json$/.test(name)) continue
      try {
        const file = JSON.parse(await readFile(join(dir, name), 'utf8')) as BakeFile
        if (file.path === join(dir, `${file.key}.mp4`) && (await stat(file.path)).size === file.size) out.push(file)
      } catch {
        // A bake without its video, or a note that can't be read: not a bake.
      }
    }
    return out
  })

  ipcMain.handle('bake:begin', async (_event, request: BakeBegin) => {
    const status = await bakeStatus()
    if (!status.ready) throw new Error(status.detail ?? 'FFglitch isn’t set up')
    if (!/^[0-9a-f]{16}$/.test(request.key)) throw new Error('bad bake key')
    if (request.order.length !== request.frames || request.frames <= 0) throw new Error('The bake’s plan doesn’t fit its frames')
    await findTool('ffmpeg')
    const id = globalThis.crypto.randomUUID()
    const temp = await mkdtemp(join(tmpdir(), 'ginosa-bake-'))
    const job: Job = { id, request, temp, encoders: { picture: null, motion: null }, aborted: false, children: new Set() }
    job.encoders.picture = startEncoder(job, request.keyframes, join(temp, 'picture.m4v'))
    // The motion source: one keyframe, at the start, so every other frame has its motion.
    if (request.motion) job.encoders.motion = startEncoder(job, [0], join(temp, 'motion.m4v'))
    jobs.set(id, job)
    return id
  })

  ipcMain.handle('bake:frame', async (_event, id: string, which: 'picture' | 'motion', bytes: Uint8Array) => {
    const job = jobs.get(id)
    const encoder = job?.encoders[which]
    if (!job || !encoder) throw new Error('That bake was cancelled')
    if (encoder.child.exitCode !== null) throw new Error(`The encoder stopped: ${encoder.stderr.trim().split('\n').pop() ?? 'unknown error'}`)
    if (!encoder.child.stdin.write(bytes)) await Promise.race([once(encoder.child.stdin, 'drain'), encoder.exited])
    encoder.frames++
  })

  ipcMain.handle('bake:finish', async (event, id: string): Promise<BakeFile> => {
    const job = jobs.get(id)
    if (!job) throw new Error('That bake was cancelled')
    try {
      return await bake(job, cache, (p) => event.sender.send('bake:progress', p))
    } finally {
      await stop(job)
    }
  })

  ipcMain.handle('bake:cancel', async (_event, id: string) => {
    const job = jobs.get(id)
    if (job) await stop(job)
  })
}
