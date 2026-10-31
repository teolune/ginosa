import type { FrameRate } from '../time'

/**
 * Export settings and the FFmpeg command that carries them out. The renderer
 * composites each frame (the same code as playback), converts it to Rec.709 Y'CbCr
 * with dither on the GPU, and pipes the raw frames to FFmpeg, which encodes them in
 * hardware (VideoToolbox) or with prores_ks and muxes the mixed-down sound.
 */

export type ExportFormat = 'h264' | 'hevc' | 'hevc10' | 'prores-422hq' | 'prores-4444'
export type ExportContainer = 'mp4' | 'mov'

export interface ExportSettings {
  format: ExportFormat
  container: ExportContainer
  /** Average video bitrate for H.264/HEVC, in Mbit/s (ProRes sets its own). */
  bitrateMbps: number
  /** Keyframe interval for H.264/HEVC, in seconds. */
  keyframeSeconds: number
}

export type RawPixelFormat = 'nv12' | 'p010le' | 'yuv422p10le' | 'yuv444p10le'

export interface FormatInfo {
  label: string
  pixelFormat: RawPixelFormat
  bitDepth: 8 | 10
  containers: ExportContainer[]
  /** Uses a bitrate setting (ProRes doesn't). */
  bitrate: boolean
}

export const FORMATS: Record<ExportFormat, FormatInfo> = {
  h264: { label: 'H.264', pixelFormat: 'nv12', bitDepth: 8, containers: ['mp4', 'mov'], bitrate: true },
  hevc: { label: 'HEVC (H.265)', pixelFormat: 'nv12', bitDepth: 8, containers: ['mp4', 'mov'], bitrate: true },
  hevc10: { label: 'HEVC 10-bit', pixelFormat: 'p010le', bitDepth: 10, containers: ['mp4', 'mov'], bitrate: true },
  'prores-422hq': { label: 'ProRes 422 HQ', pixelFormat: 'yuv422p10le', bitDepth: 10, containers: ['mov'], bitrate: false },
  'prores-4444': { label: 'ProRes 4444', pixelFormat: 'yuv444p10le', bitDepth: 10, containers: ['mov'], bitrate: false }
}

export const DEFAULT_EXPORT: ExportSettings = { format: 'h264', container: 'mp4', bitrateMbps: 40, keyframeSeconds: 1 }

/** A bitrate that keeps quality similar across sizes and rates: 40 Mbit/s at 1080p25, scaled by pixels per second. */
export function suggestedBitrate(width: number, height: number, rate: FrameRate, format: ExportFormat): number {
  const scale = (width * height * (rate.num / rate.den)) / (1920 * 1080 * 25)
  const base = format === 'h264' ? 40 : 30 // HEVC needs less for the same quality
  return Math.max(4, Math.round(base * scale))
}

/** Bytes in one raw frame as piped to FFmpeg. */
export function frameBytes(pixelFormat: RawPixelFormat, width: number, height: number): number {
  const luma = width * height
  switch (pixelFormat) {
    case 'nv12':
      return luma + 2 * (width / 2) * (height / 2)
    case 'p010le':
      return 2 * (luma + 2 * (width / 2) * (height / 2))
    case 'yuv422p10le':
      return 2 * (luma + 2 * (width / 2) * height)
    case 'yuv444p10le':
      return 2 * 3 * luma
  }
}

/** Why these settings can't export this sequence, or null. */
export function exportProblem(settings: ExportSettings, width: number, height: number): string | null {
  const info = FORMATS[settings.format]
  if (!info.containers.includes(settings.container)) return `${info.label} goes in a ${info.containers.map((c) => c.toUpperCase()).join(' or ')} file`
  if (width % 2 !== 0 || height % 2 !== 0) return `The sequence is ${width} × ${height}; export needs an even width and height`
  if (info.bitrate && !(settings.bitrateMbps >= 1 && settings.bitrateMbps <= 400)) return 'Bitrate must be between 1 and 400 Mbit/s'
  if (!(settings.keyframeSeconds > 0 && settings.keyframeSeconds <= 10)) return 'Keyframe interval must be between 0 and 10 seconds'
  return null
}

export interface FfmpegJob {
  width: number
  height: number
  rate: FrameRate
  /** The mixed-down sound (WAV). */
  audioPath: string
  output: string
}

const REC709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']

/** The FFmpeg arguments: raw frames on stdin, the WAV as the second input. */
export function ffmpegArgs(settings: ExportSettings, job: FfmpegJob): string[] {
  const info = FORMATS[settings.format]
  const fps = `${job.rate.num}/${job.rate.den}`
  const gop = String(Math.max(1, Math.round((settings.keyframeSeconds * job.rate.num) / job.rate.den)))
  const bitrate = `${settings.bitrateMbps}M`
  const video: string[] = (() => {
    switch (settings.format) {
      case 'h264':
        return ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', bitrate, '-g', gop, '-allow_sw', '0']
      case 'hevc':
        return ['-c:v', 'hevc_videotoolbox', '-profile:v', 'main', '-tag:v', 'hvc1', '-b:v', bitrate, '-g', gop, '-allow_sw', '0']
      case 'hevc10':
        return ['-c:v', 'hevc_videotoolbox', '-profile:v', 'main10', '-tag:v', 'hvc1', '-b:v', bitrate, '-g', gop, '-allow_sw', '0']
      case 'prores-422hq':
        return ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0']
      case 'prores-4444':
        return ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0']
    }
  })()
  const audio = info.bitrate ? ['-c:a', 'aac_at', '-b:a', '320k'] : ['-c:a', 'pcm_s24le']
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-f', 'rawvideo',
    '-pix_fmt', info.pixelFormat,
    '-s', `${job.width}x${job.height}`,
    '-r', fps,
    ...REC709,
    '-i', 'pipe:0',
    '-i', job.audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    ...video,
    ...REC709,
    ...audio,
    '-ar', '48000',
    '-r', fps,
    '-movflags', '+faststart+write_colr',
    '-f', settings.container === 'mp4' ? 'mp4' : 'mov',
    '-y',
    job.output
  ]
}

/** A 32-bit float stereo WAV header for `frames` sample frames. */
export function wavHeader(frames: number, sampleRate: number, channels = 2): Uint8Array {
  const bytesPerSample = 4
  const dataBytes = frames * channels * bytesPerSample
  const header = new DataView(new ArrayBuffer(44))
  const text = (at: number, value: string) => [...value].forEach((c, i) => header.setUint8(at + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  header.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 3, true) // IEEE float
  header.setUint16(22, channels, true)
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * channels * bytesPerSample, true)
  header.setUint16(32, channels * bytesPerSample, true)
  header.setUint16(34, 32, true)
  text(36, 'data')
  header.setUint32(40, dataBytes, true)
  return new Uint8Array(header.buffer)
}
