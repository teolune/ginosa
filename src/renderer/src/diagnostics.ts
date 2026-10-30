import { summariseAdapter, type GpuAdapterSummary, type GpuContext } from './gpu/gpu'

/**
 * Platform diagnostics for M0: what this Mac's Chromium/Electron can actually do.
 * The answers decide real choices later (e.g. which files need optimised copies).
 */

export interface CodecCheck {
  name: string
  codec: string
  supported: boolean
  note?: string
}

export interface Diagnostics {
  versions: { electron: string; chrome: string; node: string }
  platform: string
  arch: string
  userAgent: string
  gpu: (GpuAdapterSummary & { deviceFeatures: string[] }) | { error: string }
  videoDecoders: CodecCheck[]
  videoEncoders: CodecCheck[]
  audioDecoders: CodecCheck[]
}

const VIDEO_DECODE_CHECKS: Array<[string, string]> = [
  ['H.264 High, 1080p', 'avc1.640028'],
  ['HEVC Main, 1080p', 'hvc1.1.6.L120.90'],
  ['HEVC Main 10, 1080p', 'hvc1.2.4.L120.90'],
  ['VP9 Profile 0', 'vp09.00.40.08'],
  ['AV1 Main', 'av01.0.08M.08'],
  ['ProRes 422', 'apcn']
]

const VIDEO_ENCODE_CHECKS: Array<[string, string]> = [
  ['H.264 High, 1080p', 'avc1.640028'],
  ['HEVC Main, 1080p', 'hvc1.1.6.L123.90'],
  ['HEVC Main 10, 1080p', 'hvc1.2.4.L123.90']
]

const AUDIO_DECODE_CHECKS: Array<[string, string]> = [
  ['AAC-LC', 'mp4a.40.2'],
  ['MP3', 'mp3'],
  ['Opus', 'opus']
]

async function checkVideoDecoder([name, codec]: [string, string]): Promise<CodecCheck> {
  if (typeof VideoDecoder === 'undefined') return { name, codec, supported: false, note: 'WebCodecs missing' }
  try {
    const result = await VideoDecoder.isConfigSupported({
      codec,
      codedWidth: 1920,
      codedHeight: 1080,
      hardwareAcceleration: 'prefer-hardware'
    })
    return { name, codec, supported: result.supported === true }
  } catch (error) {
    return { name, codec, supported: false, note: (error as Error).message }
  }
}

async function checkVideoEncoder([name, codec]: [string, string]): Promise<CodecCheck> {
  if (typeof VideoEncoder === 'undefined') return { name, codec, supported: false, note: 'WebCodecs missing' }
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec,
      width: 1920,
      height: 1080,
      bitrate: 20_000_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware'
    })
    return { name, codec, supported: result.supported === true }
  } catch (error) {
    return { name, codec, supported: false, note: (error as Error).message }
  }
}

async function checkAudioDecoder([name, codec]: [string, string]): Promise<CodecCheck> {
  if (typeof AudioDecoder === 'undefined') return { name, codec, supported: false, note: 'WebCodecs missing' }
  try {
    const result = await AudioDecoder.isConfigSupported({ codec, sampleRate: 48_000, numberOfChannels: 2 })
    return { name, codec, supported: result.supported === true }
  } catch (error) {
    return { name, codec, supported: false, note: (error as Error).message }
  }
}

export async function collectDiagnostics(gpu: GpuContext | null, gpuError?: string): Promise<Diagnostics> {
  const bridge = window.ginosa
  const [videoDecoders, videoEncoders, audioDecoders] = await Promise.all([
    Promise.all(VIDEO_DECODE_CHECKS.map(checkVideoDecoder)),
    Promise.all(VIDEO_ENCODE_CHECKS.map(checkVideoEncoder)),
    Promise.all(AUDIO_DECODE_CHECKS.map(checkAudioDecoder))
  ])
  return {
    versions: bridge.versions,
    platform: bridge.platform,
    arch: bridge.arch,
    userAgent: navigator.userAgent,
    gpu: gpu
      ? { ...summariseAdapter(gpu.adapter), deviceFeatures: gpu.features }
      : { error: gpuError ?? 'WebGPU unavailable' },
    videoDecoders,
    videoEncoders,
    audioDecoders
  }
}
