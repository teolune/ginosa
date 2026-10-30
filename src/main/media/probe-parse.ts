import { IMAGE_EXTENSIONS, type AudioStreamInfo, type MediaInfo, type MediaKind, type VideoStreamInfo } from '../../engine/project/media'

/**
 * Turns ffprobe output into MediaInfo. Pure functions, unit-tested with fixtures;
 * probe.ts runs ffprobe and feeds them.
 */

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(o: Json, key: string): string | null {
  const v = o[key]
  return typeof v === 'string' && v !== 'unknown' && v !== 'N/A' ? v : null
}

function num(o: Json, key: string): number | null {
  const v = o[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

export function parseRate(text: string | null): { num: number; den: number } | null {
  if (!text) return null
  const [a, b] = text.split('/').map(Number)
  if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return null
  return { num: a, den: b }
}

function bitDepthOf(pixelFormat: string | null, rawBits: number | null): number | null {
  if (rawBits && rawBits > 0) return rawBits
  if (!pixelFormat) return null
  const match = /p(\d{2})(le|be)?$|(\d{2})(le|be)$/.exec(pixelFormat)
  const bits = match ? Number(match[1] ?? match[3]) : NaN
  return Number.isFinite(bits) ? bits : 8
}

function rotationOf(stream: Json): number {
  const sideData = stream['side_data_list']
  if (Array.isArray(sideData)) {
    for (const entry of sideData) {
      if (isObject(entry) && typeof entry['rotation'] === 'number') return ((-entry['rotation'] % 360) + 360) % 360
    }
  }
  const tags = isObject(stream['tags']) ? stream['tags'] : {}
  const rotate = num(tags, 'rotate')
  return rotate ? ((rotate % 360) + 360) % 360 : 0
}

export interface PacketTiming {
  pts: number
  keyframe: boolean
}

/** Parses `ffprobe -show_entries packet=pts_time,flags -of csv=p=0` output. */
export function parsePackets(csv: string): PacketTiming[] {
  const packets: PacketTiming[] = []
  for (const line of csv.split('\n')) {
    const [ptsText, flags] = line.trim().split(',')
    const pts = Number(ptsText)
    if (!ptsText || !Number.isFinite(pts)) continue
    packets.push({ pts, keyframe: (flags ?? '').includes('K') })
  }
  return packets
}

/** Variable frame rate if frame durations vary a lot (B-frame reordering is undone by sorting). */
export function detectVariableFrameRate(packets: PacketTiming[]): boolean {
  if (packets.length < 8) return false
  const times = packets.map((p) => p.pts).sort((a, b) => a - b)
  const deltas: number[] = []
  for (let i = 1; i < times.length; i++) {
    const d = times[i]! - times[i - 1]!
    if (d > 0) deltas.push(d)
  }
  if (deltas.length < 4) return false
  const sorted = [...deltas].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const outliers = deltas.filter((d) => Math.abs(d - median) > median * 0.25).length
  return outliers / deltas.length > 0.05
}

/** Average spacing of keyframes in the scanned packets; the scan length if there's only one. */
export function keyframeInterval(packets: PacketTiming[], scanSeconds: number): number | null {
  const keys = packets.filter((p) => p.keyframe).map((p) => p.pts).sort((a, b) => a - b)
  if (packets.length === 0) return null
  if (keys.length <= 1) return scanSeconds
  return (keys[keys.length - 1]! - keys[0]!) / (keys.length - 1)
}

export class UnsupportedMediaError extends Error {}

export function parseProbe(probe: unknown, path: string, packets: PacketTiming[] = [], scanSeconds = 10): { kind: MediaKind; info: MediaInfo } {
  if (!isObject(probe)) throw new UnsupportedMediaError('ffprobe returned no information')
  const format = isObject(probe['format']) ? probe['format'] : {}
  const streams = Array.isArray(probe['streams']) ? probe['streams'].filter(isObject) : []
  const extension = (path.split('.').pop() ?? '').toLowerCase()
  const formatName = str(format, 'format_name') ?? 'unknown'

  const videoStream = streams.find((s) => {
    const disposition = isObject(s['disposition']) ? s['disposition'] : {}
    return s['codec_type'] === 'video' && disposition['attached_pic'] !== 1
  })
  const audioStream = streams.find((s) => s['codec_type'] === 'audio')

  const isImage =
    (IMAGE_EXTENSIONS as readonly string[]).includes(extension) || formatName.includes('image2') || /_pipe$/.test(formatName)

  let video: VideoStreamInfo | null = null
  if (videoStream) {
    const pixelFormat = str(videoStream, 'pix_fmt')
    const rotation = isImage ? 0 : rotationOf(videoStream)
    const codedW = num(videoStream, 'width') ?? 0
    const codedH = num(videoStream, 'height') ?? 0
    const swap = rotation === 90 || rotation === 270
    const transfer = str(videoStream, 'color_transfer')
    const range = str(videoStream, 'color_range')
    const avg = parseRate(str(videoStream, 'avg_frame_rate'))
    const real = parseRate(str(videoStream, 'r_frame_rate'))
    video = {
      codec: str(videoStream, 'codec_name') ?? 'unknown',
      profile: str(videoStream, 'profile'),
      width: swap ? codedH : codedW,
      height: swap ? codedW : codedH,
      rotation,
      frameRate: isImage ? null : (avg ?? real),
      frameCount: isImage ? 1 : num(videoStream, 'nb_frames'),
      pixelFormat,
      bitDepth: bitDepthOf(pixelFormat, num(videoStream, 'bits_per_raw_sample')),
      colour: {
        primaries: str(videoStream, 'color_primaries'),
        transfer,
        matrix: str(videoStream, 'color_space'),
        range: range === 'tv' || range === 'pc' ? range : null
      },
      hdr: transfer === 'arib-std-b67' ? 'hlg' : transfer === 'smpte2084' ? 'pq' : null,
      variableFrameRate: isImage ? false : detectVariableFrameRate(packets),
      keyframeInterval: isImage ? null : keyframeInterval(packets, scanSeconds)
    }
    if (video.width <= 0 || video.height <= 0) throw new UnsupportedMediaError('The video stream has no frame size')
  }

  let audio: AudioStreamInfo | null = null
  if (audioStream) {
    audio = {
      codec: str(audioStream, 'codec_name') ?? 'unknown',
      sampleRate: num(audioStream, 'sample_rate') ?? 0,
      channels: num(audioStream, 'channels') ?? 0,
      channelLayout: str(audioStream, 'channel_layout')
    }
    if (audio.sampleRate <= 0 || audio.channels <= 0) audio = null
  }

  const kind: MediaKind | null = video ? (isImage ? 'image' : 'video') : audio ? 'audio' : null
  if (!kind) throw new UnsupportedMediaError('No video or audio streams found')

  return {
    kind,
    info: {
      container: formatName,
      durationSeconds: kind === 'image' ? 0 : (num(format, 'duration') ?? 0),
      bitRate: num(format, 'bit_rate'),
      video,
      audio: kind === 'image' ? null : audio
    }
  }
}
