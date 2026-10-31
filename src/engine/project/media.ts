import type { Ticks } from '../time'

/**
 * Imported media. The project stores what a file is (probed once on import) and
 * where it lives; the file itself is never modified. Generated files (thumbnails,
 * waveforms, optimised copies) live in the cache, not in the project.
 */

export type MediaKind = 'video' | 'audio' | 'image'

export interface FrameRateFraction {
  num: number
  den: number
}

export interface ColourInfo {
  primaries: string | null
  transfer: string | null
  matrix: string | null
  range: 'tv' | 'pc' | null
}

export interface VideoStreamInfo {
  codec: string
  profile: string | null
  /** Display size, after any rotation. */
  width: number
  height: number
  rotation: number
  frameRate: FrameRateFraction | null
  frameCount: number | null
  pixelFormat: string | null
  bitDepth: number | null
  colour: ColourInfo
  hdr: 'hlg' | 'pq' | null
  variableFrameRate: boolean
  /** Average seconds between keyframes, measured from the start of the file. */
  keyframeInterval: number | null
}

export interface AudioStreamInfo {
  codec: string
  sampleRate: number
  channels: number
  channelLayout: string | null
}

export interface MediaInfo {
  container: string
  durationSeconds: number
  bitRate: number | null
  video: VideoStreamInfo | null
  audio: AudioStreamInfo | null
}

/** Identifies a file even after it moves: size, modification time and a hash of its first and last MiB. */
export interface MediaFingerprint {
  size: number
  mtimeMs: number
  sample: string
}

export interface MediaMarks {
  in: Ticks | null
  out: Ticks | null
}

/**
 * How a file's colour is read (like Premiere's Interpret Footage): detected from its
 * tags, or set by hand. An input LUT, when set, replaces the built-in conversion.
 */
export type ColourInput = 'auto' | 'rec709' | 'apple-log' | 'apple-log-2'
export type DetectedColour = 'rec709' | 'apple-log' | 'apple-log-2' | 'hlg' | 'pq'

export interface MediaColour {
  input: ColourInput
  /** An input LUT copied into the project folder (`file` is relative to it). */
  lut: { name: string; file: string } | null
}

export const DEFAULT_COLOUR: MediaColour = { input: 'auto', lut: null }

export const COLOUR_LABELS: Record<DetectedColour, string> = {
  rec709: 'Rec.709',
  'apple-log': 'Apple Log',
  'apple-log-2': 'Apple Log 2',
  hlg: 'HDR (HLG)',
  pq: 'HDR (PQ)'
}

export interface MediaItem {
  id: string
  name: string
  kind: MediaKind
  path: string
  fingerprint: MediaFingerprint
  info: MediaInfo
  binId: string | null
  importedAt: string
  marks: MediaMarks
  colour: MediaColour
}

/**
 * What a file's colour tags suggest. iPhone log files leave the transfer unspecified:
 * Apple Log keeps BT.2020 primaries, Apple Log 2 (Apple Wide Gamut) leaves them
 * unspecified too; both use the BT.2020 matrix and 10-bit.
 */
export function detectColour(info: MediaInfo): DetectedColour {
  const video = info.video
  if (!video) return 'rec709'
  if (video.hdr) return video.hdr
  const c = video.colour
  const unspecified = (v: string | null) => v === null || v === 'unspecified' || v === 'reserved'
  const bt2020Matrix = c.matrix === 'bt2020nc' || c.matrix === 'bt2020_ncl'
  if ((video.bitDepth ?? 8) >= 10 && bt2020Matrix && unspecified(c.transfer)) {
    if (c.primaries === 'bt2020') return 'apple-log'
    if (unspecified(c.primaries)) return 'apple-log-2'
  }
  return 'rec709'
}

/** The conversion that applies: the hand-set choice, else what the tags suggest. */
export function effectiveColour(item: MediaItem): DetectedColour {
  return item.colour.input === 'auto' ? detectColour(item.info) : item.colour.input
}

export interface Bin {
  id: string
  name: string
  parentId: string | null
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'bmp', 'gif', 'heic'] as const
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mxf', 'mts', 'm2ts', 'mpg', 'mpeg'] as const
export const AUDIO_EXTENSIONS = ['wav', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'caf'] as const
export const IMPORT_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS]

/** Reasons a file gets an optimised copy instead of being decoded directly. */
export type OptimiseReason = 'codec' | 'vfr' | 'long-gop'

export const OPTIMISE_REASON_TEXT: Record<OptimiseReason, string> = {
  codec: "WebCodecs can't decode this codec on this Mac",
  vfr: 'Variable frame rate (converted to constant)',
  'long-gop': 'Keyframes far apart (slow scrubbing)'
}

/** Keyframes further apart than this make scrubbing and reverse play sluggish. */
export const LONG_GOP_SECONDS = 2

/**
 * Which optimisations a file needs. `decodable` comes from the renderer's WebCodecs
 * check. Long-GOP files are only flagged: copying them is offered, not automatic.
 * HDR alone never needs a copy: HDR clips are used as they are and converted to the
 * sequence's colour space on the GPU (decision 20).
 */
export function optimiseReasons(info: MediaInfo, decodable: boolean): { required: OptimiseReason[]; suggested: OptimiseReason[] } {
  const required: OptimiseReason[] = []
  const suggested: OptimiseReason[] = []
  const video = info.video
  if (!video) return { required, suggested }
  if (!decodable) required.push('codec')
  if (video.variableFrameRate) required.push('vfr')
  if (video.keyframeInterval !== null && video.keyframeInterval > LONG_GOP_SECONDS && required.length === 0) suggested.push('long-gop')
  return { required, suggested }
}

export function frameRateValue(rate: FrameRateFraction | null): number {
  return rate && rate.den > 0 ? rate.num / rate.den : 0
}

/** Bin ids from `binId` up to the root (inclusive of `binId`). */
export function binAncestors(bins: Bin[], binId: string | null): string[] {
  const chain: string[] = []
  let current = binId
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = bins.find((b) => b.id === current)?.parentId ?? null
  }
  return chain
}

/** A bin and every bin nested inside it. */
export function binDescendants(bins: Bin[], binId: string): string[] {
  const result = [binId]
  for (let i = 0; i < result.length; i++) {
    for (const bin of bins) if (bin.parentId === result[i]) result.push(bin.id)
  }
  return result
}

export function displayNameFromPath(path: string): string {
  const file = path.split('/').pop() ?? path
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}
