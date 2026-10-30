import { rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaFingerprint } from '../../engine/project/media'
import type { GenerateRequest } from '../../shared/media-types'
import type { CacheService } from '../cache/cache-service'
import { runTool } from './ffmpeg'

/** Thumbnails and waveform peaks, generated with FFmpeg into the project's cache. */

export const WAVEFORM_BUCKETS_PER_SECOND = 100
const WAVEFORM_SAMPLE_RATE = 8000
const HEADER_BYTES = 8

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
 * Waveform peaks: min/max pairs (Float32) at 100 per second from a mono 8 kHz decode.
 * File layout: uint32 buckets-per-second, uint32 bucket count, then the pairs.
 */
export async function ensureWaveform(cache: CacheService, request: GenerateRequest): Promise<ArrayBuffer> {
  const dir = await cache.categoryDir(request.projectId, 'waveforms')
  const out = join(dir, cacheFileName(request.mediaId, request.fingerprint, 'peaks'))
  if (await exists(out)) {
    const data = await (await import('node:fs/promises')).readFile(out)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }
  const key = `wave:${out}`
  const pending = inFlight.get(key)
  if (pending) return pending as Promise<ArrayBuffer>
  const job = limiter.run(async () => {
    const samplesPerBucket = WAVEFORM_SAMPLE_RATE / WAVEFORM_BUCKETS_PER_SECOND
    const peaks: number[] = []
    let min = Infinity
    let max = -Infinity
    let count = 0
    let carry: Buffer = Buffer.alloc(0)
    const result = await runTool(
      'ffmpeg',
      ['-hide_banner', '-nostdin', '-v', 'error', '-i', request.path, '-vn', '-ac', '1', '-ar', String(WAVEFORM_SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
      {
        collect: false,
        onStdout(chunk) {
          const data: Buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk
          const usable = data.length - (data.length % 4)
          for (let offset = 0; offset < usable; offset += 4) {
            const v = data.readFloatLE(offset)
            if (v < min) min = v
            if (v > max) max = v
            if (++count === samplesPerBucket) {
              peaks.push(min, max)
              min = Infinity
              max = -Infinity
              count = 0
            }
          }
          carry = data.subarray(usable)
        }
      }
    )
    if (result.code !== 0) throw new Error(`Waveform failed: ${result.stderr.trim().split('\n').pop() ?? 'unknown error'}`)
    if (count > 0) peaks.push(min, max)
    const buffer = Buffer.alloc(HEADER_BYTES + peaks.length * 4)
    buffer.writeUInt32LE(WAVEFORM_BUCKETS_PER_SECOND, 0)
    buffer.writeUInt32LE(peaks.length / 2, 4)
    peaks.forEach((v, i) => buffer.writeFloatLE(Math.max(-1, Math.min(1, v)), HEADER_BYTES + i * 4))
    const temp = `${out}.partial`
    await writeFile(temp, buffer)
    await rename(temp, out)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  })
  inFlight.set(key, job)
  try {
    return (await job) as ArrayBuffer
  } finally {
    inFlight.delete(key)
  }
}
