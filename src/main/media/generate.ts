import { rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaFingerprint } from '../../engine/project/media'
import type { GenerateRequest } from '../../shared/media-types'
import type { CacheService } from '../cache/cache-service'
import { PeakWriter, WAVEFORM_EXTENSION, WAVEFORM_SAMPLE_RATE } from '../../shared/waveform'
import { runTool } from './ffmpeg'

/** Thumbnails and waveform peaks, generated with FFmpeg into the project's cache. */

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

/** Limits how many FFmpeg processes run at once for background generation. */
class Limiter {
  private running = 0
  private waiting: Array<() => void> = []
  constructor(private readonly max: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    try {
      return await task()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}

const limiter = new Limiter(2)
const inFlight = new Map<string, Promise<string | ArrayBuffer>>()

export function cacheFileName(mediaId: string, fingerprint: MediaFingerprint, extension: string): string {
  return `${mediaId}-${fingerprint.sample.slice(0, 8)}.${extension}`
}

export type { GenerateRequest } from '../../shared/media-types'

export async function ensureThumbnail(cache: CacheService, request: GenerateRequest): Promise<string> {
  const dir = await cache.categoryDir(request.projectId, 'thumbnails')
  const out = join(dir, cacheFileName(request.mediaId, request.fingerprint, 'jpg'))
  if (await exists(out)) return out
  const key = `thumb:${out}`
  const pending = inFlight.get(key)
  if (pending) return pending as Promise<string>
  const job = limiter.run(async () => {
    const temp = `${out}.partial.jpg`
    const seek = request.kind === 'video' ? ['-ss', String(Math.min(Math.max(request.durationSeconds * 0.1, 0), 5))] : []
    const result = await runTool('ffmpeg', [
      '-hide_banner', '-nostdin', '-y', '-v', 'error', ...seek, '-i', request.path,
      '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', temp
    ])
    if (result.code !== 0) throw new Error(`Thumbnail failed: ${result.stderr.trim().split('\n').pop() ?? 'unknown error'}`)
    await rename(temp, out)
    return out
  })
  inFlight.set(key, job)
  try {
    return await job
  } finally {
    inFlight.delete(key)
  }
}

/**
 * Waveform peaks (shared/waveform.ts): the lowest and highest of every 10 samples of a 48 kHz
 * mono mix, so the timeline can zoom in to single pixels' worth of sound.
 */
export async function ensureWaveform(cache: CacheService, request: GenerateRequest): Promise<ArrayBuffer> {
  const dir = await cache.categoryDir(request.projectId, 'waveforms')
  const out = join(dir, cacheFileName(request.mediaId, request.fingerprint, WAVEFORM_EXTENSION))
  if (await exists(out)) {
    const data = await (await import('node:fs/promises')).readFile(out)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
  const key = `wave:${out}`
  const pending = inFlight.get(key)
  if (pending) return pending as Promise<ArrayBuffer>
  const job = limiter.run(async () => {
    const writer = new PeakWriter()
    let carry: Buffer = Buffer.alloc(0)
    const result = await runTool(
      'ffmpeg',
      ['-hide_banner', '-nostdin', '-v', 'error', '-i', request.path, '-vn', '-ac', '1', '-ar', String(WAVEFORM_SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
      {
        collect: false,
        onStdout(chunk) {
          const data: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk
          const usable = data.length - (data.length % 4)
          // Copied, so the floats are aligned whatever offset the chunk had.
          writer.add(new Float32Array(Uint8Array.prototype.slice.call(data, 0, usable).buffer))
          carry = Buffer.from(data.subarray(usable))
        }
      }
    )
    if (result.code !== 0) throw new Error(`Waveform failed: ${result.stderr.trim().split('\n').pop() ?? 'unknown error'}`)
    const bytes = writer.finish()
    const temp = `${out}.partial`
    await writeFile(temp, bytes)
    await rename(temp, out)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  })
  inFlight.set(key, job)
  try {
    return (await job) as ArrayBuffer
  } finally {
    inFlight.delete(key)
  }
}
