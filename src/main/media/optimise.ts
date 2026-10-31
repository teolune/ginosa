import { rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { frameRateValue, type MediaFingerprint, type MediaInfo, type OptimiseReason } from '../../engine/project/media'
import type { OptimiseJob, OptimiseRequest } from '../../shared/media-types'
import { FRAME_RATES, nearestStandardRate } from '../../engine/time'
import type { CacheService } from '../cache/cache-service'
import { runTool } from './ffmpeg'
import { cacheFileName } from './generate'

/**
 * Optimised copies: edit-friendly versions of files WebCodecs can't play well,
 * written to the cache. One copy at a time, with progress and cancel.
 *   8-bit sources  -> H.264 High, keyframe every half second
 *   10-bit sources -> HEVC Main 10 (hardware encoder), so log footage keeps its precision
 * HDR (HLG/PQ) stays HDR: 10-bit, with its BT.2020 + HLG/PQ labels kept, so nothing
 * is lost before grading. Conversion to the sequence's colour space happens on the GPU.
 * Audio is copied as uncompressed 24-bit PCM. Originals are only read.
 */

export type { JobStatus, OptimiseJob, OptimiseRequest } from '../../shared/media-types'

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

/** Bump whenever the conversion changes, so copies made by older code are regenerated. */
export const OPTIMISE_VERSION = 2

export function optimisedFileName(mediaId: string, fingerprint: MediaFingerprint): string {
  return cacheFileName(mediaId, fingerprint, `v${OPTIMISE_VERSION}.mov`)
}

/** H.265 colour codes (ITU-T H.273) for the HDR labels a copy must keep. */
const HDR_CODES = { hlg: { trc: 'arib-std-b67', code: 18 }, pq: { trc: 'smpte2084', code: 16 } } as const

/** FFmpeg arguments for one optimised copy (exported for tests). */
export function buildOptimiseArgs(input: string, output: string, info: MediaInfo, reasons: OptimiseReason[]): string[] {
  const video = info.video
  if (!video) throw new Error('Only video files get optimised copies')
  const hdr = video.hdr
  const tenBit = (video.bitDepth ?? 8) > 8 || hdr !== null
  const fps = frameRateValue(video.frameRate) || 25
  const standard = nearestStandardRate(fps, 0.02)
  const rate = standard ?? FRAME_RATES['25']
  const gop = Math.max(1, Math.round(fps / 2))
  const pixelFormat = tenBit ? 'p010le' : 'yuv420p'

  const codec = tenBit
    ? ['-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', '-q:v', '70', '-tag:v', 'hvc1']
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-profile:v', 'high']
  const timing = reasons.includes('vfr') ? ['-fps_mode', 'cfr', '-r', `${rate.num}/${rate.den}`] : []
  // Apple's HEVC encoder drops the primaries and transfer labels, so HDR copies get
  // them stamped back into the bitstream; otherwise the copy would read as SDR.
  const colourTags = hdr
    ? [
        '-color_primaries', 'bt2020', '-color_trc', HDR_CODES[hdr].trc, '-colorspace', 'bt2020nc', '-color_range', video.colour.range === 'pc' ? 'pc' : 'tv',
        '-bsf:v', `hevc_metadata=colour_primaries=9:transfer_characteristics=${HDR_CODES[hdr].code}:matrix_coefficients=9`
      ]
    : []
  const audio = info.audio ? ['-map', '0:a:0', '-c:a', 'pcm_s24le'] : ['-an']

  return [
    '-hide_banner', '-nostdin', '-y', '-v', 'error', '-nostats', '-progress', 'pipe:1',
    '-i', input,
    '-map', '0:v:0', ...audio,
    '-vf', `format=${pixelFormat}`,
    ...codec, '-g', String(gop), ...timing, ...colourTags,
    '-f', 'mov', output
  ]
}

export class OptimiseQueue {
  private jobs: OptimiseJob[] = []
  private requests = new Map<string, OptimiseRequest>()
  private running: { id: string; abort: AbortController } | null = null
  private counter = 0

  constructor(
    private readonly cache: CacheService,
    private readonly onUpdate: (job: OptimiseJob) => void
  ) {}

  list(): OptimiseJob[] {
    return this.jobs.map((job) => ({ ...job }))
  }

  /** Path of an existing optimised copy, or null. */
  async existing(projectId: string, mediaId: string, fingerprint: MediaFingerprint): Promise<string | null> {
    const path = join(await this.cache.categoryDir(projectId, 'optimised'), optimisedFileName(mediaId, fingerprint))
    return (await exists(path)) ? path : null
  }

  async enqueue(request: OptimiseRequest): Promise<OptimiseJob> {
    const active = this.jobs.find((j) => j.mediaId === request.mediaId && j.projectId === request.projectId && (j.status === 'queued' || j.status === 'running'))
    if (active) return { ...active }
    const done = await this.existing(request.projectId, request.mediaId, request.fingerprint)
    const job: OptimiseJob = {
      id: `job-${++this.counter}`,
      projectId: request.projectId,
      mediaId: request.mediaId,
      name: request.name,
      reasons: request.reasons,
      status: done ? 'done' : 'queued',
      progress: done ? 1 : 0,
      output: done,
      error: null
    }
    this.jobs = [...this.jobs.filter((j) => !(j.mediaId === request.mediaId && j.projectId === request.projectId)), job]
    this.requests.set(job.id, request)
    this.onUpdate({ ...job })
    void this.pump()
    return { ...job }
  }

  cancel(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId)
    if (!job) return
    if (this.running?.id === jobId) this.running.abort.abort()
    else if (job.status === 'queued') this.update(job, { status: 'cancelled' })
  }

  /** Cancels everything belonging to a project (it was closed). */
  cancelProject(projectId: string): void {
    for (const job of this.jobs) if (job.projectId === projectId) this.cancel(job.id)
  }

  private update(job: OptimiseJob, changes: Partial<OptimiseJob>): void {
    Object.assign(job, changes)
    this.onUpdate({ ...job })
  }

  private async pump(): Promise<void> {
    if (this.running) return
    const job = this.jobs.find((j) => j.status === 'queued')
    if (!job) return
    const request = this.requests.get(job.id)
    if (!request) return
    const abort = new AbortController()
    this.running = { id: job.id, abort }
    this.update(job, { status: 'running', progress: 0 })
    const dir = await this.cache.categoryDir(request.projectId, 'optimised')
    const output = join(dir, optimisedFileName(request.mediaId, request.fingerprint))
    const partial = `${output}.partial.mov`
    try {
      const args = buildOptimiseArgs(request.path, partial, request.info, request.reasons)
      const totalUs = Math.max(1, request.info.durationSeconds * 1_000_000)
      let lastSent = 0
      const result = await runTool('ffmpeg', args, {
        signal: abort.signal,
        collect: false,
        onStdout: (chunk) => {
          const match = /out_time_us=(\d+)/g
          let m: RegExpExecArray | null
          let latest = -1
          while ((m = match.exec(chunk.toString())) !== null) latest = Number(m[1])
          if (latest >= 0 && Date.now() - lastSent > 250) {
            lastSent = Date.now()
            this.update(job, { progress: Math.min(0.99, latest / totalUs) })
          }
        }
      })
      if (abort.signal.aborted) {
        await this.cache.removeFile(partial).catch(() => undefined)
        this.update(job, { status: 'cancelled' })
      } else if (result.code !== 0) {
        await this.cache.removeFile(partial).catch(() => undefined)
        this.update(job, { status: 'failed', error: result.stderr.trim().split('\n').slice(-2).join(' ') || `FFmpeg exited with ${result.code}` })
      } else {
        await rename(partial, output)
        this.update(job, { status: 'done', progress: 1, output })
      }
    } catch (error) {
      await this.cache.removeFile(partial).catch(() => undefined)
      this.update(job, { status: 'failed', error: (error as Error).message })
    } finally {
      this.running = null
      this.requests.delete(job.id)
      void this.pump()
    }
  }
}
