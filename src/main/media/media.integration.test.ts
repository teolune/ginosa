import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { optimiseReasons, type OptimiseReason } from '../../engine/project/media'
import { CacheService } from '../cache/cache-service'
import { findTool, runTool } from './ffmpeg'
import { ensureThumbnail, ensureWaveform } from './generate'
import { probeFile, type ProbedFile } from './media-files'
import { OptimiseQueue, type OptimiseJob } from './optimise'

/**
 * Runs the real Homebrew FFmpeg against small generated clips. Skipped automatically
 * on machines without FFmpeg (e.g. Claude's cloud workspace).
 */

const PROJECT = '6f1c2b3a-4d5e-4f60-8a1b-2c3d4e5f6a7b'
let available = true
// Create an empty file renders/.keep-fixtures to keep the generated clips in renders/test-fixtures for inspection.
const KEEP = (await import('node:fs')).existsSync(join(process.cwd(), 'renders', '.keep-fixtures'))
try {
  await findTool('ffmpeg')
  await findTool('ffprobe')
} catch {
  available = false
}

let dir: string
let cache: CacheService

async function make(name: string, args: string[]): Promise<string> {
  const out = join(dir, name)
  const result = await runTool('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args, out])
  if (result.code !== 0) throw new Error(`fixture ${name}: ${result.stderr}`)
  return out
}

async function probeOk(path: string): Promise<ProbedFile> {
  const result = await probeFile(path)
  if (!result.ok) throw new Error(result.error)
  return result.file
}

function optimise(queue: OptimiseQueue, file: ProbedFile, reasons: ReturnType<typeof optimiseReasons>['required'], updates: OptimiseJob[]): Promise<OptimiseJob> {
  return new Promise((resolve) => {
    const watch = setInterval(() => {
      const last = updates.filter((u) => u.mediaId === file.name).at(-1)
      if (last && ['done', 'failed', 'cancelled'].includes(last.status)) {
        clearInterval(watch)
        resolve(last)
      }
    }, 50)
    void queue.enqueue({ projectId: PROJECT, mediaId: file.name, name: file.name, path: file.path, fingerprint: file.fingerprint, info: file.info, reasons })
  })
}

describe.skipIf(!available)('media pipeline with real FFmpeg', () => {
  const src = 'testsrc2=size=640x360:rate=25:duration=3'
  const tone = 'sine=frequency=440:sample_rate=48000:duration=3'
  const files: Record<string, string> = {}

  beforeAll(async () => {
    dir = KEEP ? join(process.cwd(), 'renders', 'test-fixtures') : await mkdtemp(join(tmpdir(), 'ginosa-media-test-'))
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true })
    cache = new CacheService(join(dir, 'ginosa Cache'))
    files.h264 = await make('clip_h264.mp4', ['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', tone, '-c:v', 'libx264', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
    files.longgop = await make('clip_longgop.mp4', ['-f', 'lavfi', '-i', src, '-c:v', 'libx264', '-g', '250', '-sc_threshold', '0', '-pix_fmt', 'yuv420p'])
    files.prores = await make('clip_prores.mov', ['-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', tone, '-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le', '-shortest'])
    files.vfr = await make('clip_vfr.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-vf', "setpts='if(lt(N,60),N/30,2+(N-60)/12)/TB'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
    files.hlg = await make('clip_hlg.mov', ['-f', 'lavfi', '-i', src, '-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', '-pix_fmt', 'p010le', '-tag:v', 'hvc1', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
      // Apple's encoder writes only the matrix; stamp primaries (9) and HLG transfer (18) into the stream like an iPhone does.
      '-bsf:v', 'hevc_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9'])
    files.song = await make('song.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=2', '-c:a', 'pcm_s24le'])
    files.still = await make('still.png', ['-f', 'lavfi', '-i', 'testsrc2=size=800x600:rate=1', '-frames:v', '1'])
  }, 60_000)

  afterAll(async () => {
    if (dir && !KEEP) await rm(dir, { recursive: true, force: true })
  })

  it('probes video, audio and image files', async () => {
    const video = await probeOk(files.h264!)
    expect(video.kind).toBe('video')
    expect(video.info.video?.codec).toBe('h264')
    expect(video.info.video?.width).toBe(640)
    expect(video.info.video?.frameRate).toEqual({ num: 25, den: 1 })
    expect(video.info.video?.variableFrameRate).toBe(false)
    expect(video.info.video?.keyframeInterval).toBeCloseTo(0.48, 1)
    expect(video.info.audio?.sampleRate).toBe(48_000)
    expect((await probeOk(files.song!)).kind).toBe('audio')
    const still = await probeOk(files.still!)
    expect(still.kind).toBe('image')
    expect(still.info.video?.width).toBe(800)
  })

  it('detects variable frame rate, HDR, 10-bit and long keyframe intervals', async () => {
    expect((await probeOk(files.vfr!)).info.video?.variableFrameRate).toBe(true)
    const hlg = await probeOk(files.hlg!)
    expect(hlg.info.video?.hdr).toBe('hlg')
    expect(hlg.info.video?.bitDepth).toBe(10)
    expect((await probeOk(files.longgop!)).info.video?.keyframeInterval).toBeGreaterThan(2)
  })

  it('reports unreadable files instead of throwing', async () => {
    const result = await probeFile(join(dir, 'missing.mov'))
    expect(result.ok).toBe(false)
  })

  it('generates a thumbnail and waveform peaks into the cache', async () => {
    const video = await probeOk(files.h264!)
    const request = { projectId: PROJECT, mediaId: 'clip', path: video.path, kind: video.kind, fingerprint: video.fingerprint, durationSeconds: 3 }
    const thumb = await ensureThumbnail(cache, request)
    expect((await stat(thumb)).size).toBeGreaterThan(1000)
    const file = await ensureWaveform(cache, request)
    const peaks = new DataView(file)
    expect(peaks.getUint32(0, true)).toBe(4800)
    expect(peaks.getUint32(4, true)).toBeGreaterThanOrEqual(299 * 48)
    // FFmpeg's sine source peaks at 1/8: the highest of the peaks in the second second (a little
    // over, from the AAC coding's ripple, which shows at the full rate).
    const pairs = new Int16Array(file, 8)
    let high = 0
    for (let i = 4800; i < 9600; i++) high = Math.max(high, pairs[i * 2 + 1]!)
    expect(high / 32767).toBeGreaterThan(0.12)
    expect(high / 32767).toBeLessThan(0.14)
  })

  it('makes playable optimised copies for ProRes and variable-rate sources, and keeps HDR as HDR', async () => {
    const updates: OptimiseJob[] = []
    const queue = new OptimiseQueue(cache, (job) => updates.push(job))
    for (const key of ['prores', 'vfr', 'hlg'] as const) {
      const file = await probeOk(files[key]!)
      const decodable = key !== 'prores'
      const needs = optimiseReasons(file.info, decodable)
      if (key === 'hlg') expect(needs).toEqual({ required: [], suggested: [] })
      // HDR needs no copy by itself; copy it anyway (as for a ProRes HLG clip) to check it stays HDR.
      const reasons: OptimiseReason[] = key === 'hlg' ? ['long-gop'] : needs.required
      expect(reasons.length).toBeGreaterThan(0)
      const job = await optimise(queue, file, reasons, updates)
      expect(job.status, job.error ?? '').toBe('done')
      const copy = await probeOk(job.output!)
      expect(['h264', 'hevc']).toContain(copy.info.video?.codec)
      expect(copy.info.video?.variableFrameRate).toBe(false)
      expect(copy.info.video?.keyframeInterval ?? 99).toBeLessThanOrEqual(1)
      if (key === 'hlg') {
        expect(copy.info.video?.hdr).toBe('hlg')
        expect(copy.info.video?.colour.primaries).toBe('bt2020')
        expect(copy.info.video?.colour.transfer).toBe('arib-std-b67')
        expect(copy.info.video?.bitDepth).toBe(10)
      }
      if (key === 'prores') expect(copy.info.audio?.codec).toBe('pcm_s24le')
      expect(Math.abs(copy.info.durationSeconds - file.info.durationSeconds)).toBeLessThan(0.2)
    }
  }, 120_000)
})
