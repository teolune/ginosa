import { ALL_FORMATS, AudioBufferSink, EncodedPacket, Input, UrlSource, VideoSampleSink, type InputAudioTrack, type InputVideoTrack } from 'mediabunny'
import { getGpu } from '../gpu/shared'
import { TRANSFER_HLG, TRANSFER_PQ, TRANSFER_UNSPECIFIED, hvccLengthSize, hvccTransfer, rewriteHvcc, rewriteSample } from '@engine/colour/hevc-sps'

/**
 * Opened media files, shared by playback and the still preview. Each file is opened
 * once (Mediabunny reads it in ranges through the read-only ginosa-media protocol).
 */

export interface OpenedMedia {
  path: string
  input: Input
  video: InputVideoTrack | null
  audio: InputAudioTrack | null
  videoSink: VideoSampleSink | null
  audioSink: AudioBufferSink | null
  /**
   * Media time 0 in the file's own timestamps (seconds). One origin for both tracks keeps
   * picture and sound in sync. AAC audio often starts a few ms below zero (encoder
   * priming that players discard), so the origin is never below 0.
   */
  origin: number
  /**
   * Set when the file is HLG or PQ HEVC whose transfer tag ginosa rewrote, so frames
   * arrive as raw HDR values for ginosa's own conversion (see hevc-sps.ts).
   */
  rawHdr: 'hlg' | 'pq' | null
}

function bytesOf(description: AllowSharedBufferSource | undefined): Uint8Array | null {
  if (!description) return null
  if (description instanceof Uint8Array) return description
  if (ArrayBuffer.isView(description)) return new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
  return new Uint8Array(description)
}

/** Rewrites any SPS repeated inside the packets Mediabunny reads for this track. */
function rewritePackets(track: InputVideoTrack, lengthSize: number): void {
  const backing = (track as unknown as { _backing: Record<string, (...args: unknown[]) => Promise<EncodedPacket | null>> })._backing
  for (const name of ['getFirstPacket', 'getPacket', 'getNextPacket', 'getKeyPacket', 'getNextKeyPacket']) {
    const read = backing[name]
    if (typeof read !== 'function') throw new Error(`Mediabunny changed: no ${name}`)
    backing[name] = async (...args: unknown[]) => {
      const packet = await read.apply(backing, args)
      if (!packet || packet.data.byteLength === 0) return packet
      const data = rewriteSample(packet.data, lengthSize, TRANSFER_UNSPECIFIED)
      return data ? new EncodedPacket(data, packet.type, packet.timestamp, packet.duration, packet.sequenceNumber, data.byteLength, packet.sideData) : packet
    }
  }
}

/**
 * Open files, by path, least recently used first. Readers (picture streams, exact frames,
 * sound feeders) hold a file while they read it (`useMedia`); at most MAX_OPEN files stay
 * open, but a file someone is still reading is never closed (closing cancels its reads), so
 * a timeline using more files at once (a mixdown of sound from many clips, many stacked
 * layers) goes over the limit until they're done.
 */
interface Opened {
  media: Promise<OpenedMedia>
  users: number
}

const opened = new Map<string, Opened>()
const MAX_OPEN = 12

/** A file held open while it's read: `release` it when done (closing the reader). */
export interface MediaUse {
  readonly media: OpenedMedia
  release(): void
}

function entryFor(path: string): Opened {
  const existing = opened.get(path)
  if (existing) {
    // Most recently used goes to the end.
    opened.delete(path)
    opened.set(path, existing)
    return existing
  }
  const media = (async (): Promise<OpenedMedia> => {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(window.ginosa.mediaUrl(path)) })
    const video = await input.getPrimaryVideoTrack()
    let rawHdr: OpenedMedia['rawHdr'] = null
    if (video) {
      // Ask for the stored Y'CbCr → R'G'B' values only (sRGB transfer = no conversion on import).
      // Chromium honours this whenever the file leaves its transfer unspecified, as iPhone log
      // files do; for tagged Rec.709 the compositor undoes Chromium's display transform instead.
      // HLG/PQ HEVC: Chromium would tone-map it itself, so the stream's transfer tag is
      // rewritten to "unspecified" (header and any in-band SPS) and it arrives raw too.
      const tagged = await video.getColorSpace().catch(() => ({}) as VideoColorSpaceInit)
      const original = video.getDecoderConfig.bind(video)
      const first = await original()
      const description = first && /^(hvc1|hev1)/.test(first.codec) ? bytesOf(first.description) : null
      const transfer = description ? hvccTransfer(description) : null
      let replacement: Uint8Array | null = null
      if (description && (transfer === TRANSFER_HLG || transfer === TRANSFER_PQ)) {
        try {
          replacement = rewriteHvcc(description, TRANSFER_UNSPECIFIED)
          if (replacement) {
            rewritePackets(video, hvccLengthSize(description))
            rawHdr = transfer === TRANSFER_HLG ? 'hlg' : 'pq'
          }
        } catch (error) {
          // Chromium's own tone-mapping is the fallback; the player notices from the frames.
          console.warn(`HDR tag rewrite failed for ${path}:`, (error as Error).message)
          replacement = null
        }
      }
      video.getDecoderConfig = async () => {
        const config = await original()
        if (!config) return config
        return {
          ...config,
          ...(replacement ? { description: replacement } : {}),
          colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: tagged.matrix ?? 'bt709', fullRange: tagged.fullRange ?? false }
        }
      }
    }
    const audio = await input.getPrimaryAudioTrack()
    const videoOk = video ? await video.canDecode() : false
    const audioOk = audio ? await audio.canDecode() : false
    return {
      path,
      input,
      video,
      audio,
      videoSink: video && videoOk ? new VideoSampleSink(video) : null,
      audioSink: audio && audioOk ? new AudioBufferSink(audio) : null,
      origin: Math.max(0, await input.getFirstTimestamp()),
      rawHdr
    }
  })()
  const entry: Opened = { media, users: 0 }
  media.catch(() => {
    if (opened.get(path) === entry) opened.delete(path)
  })
  opened.set(path, entry)
  return entry
}

/** Closes the least recently used files nobody is reading, down to MAX_OPEN. */
function closeIdle(): void {
  if (opened.size <= MAX_OPEN) return
  for (const [path, entry] of opened) {
    if (opened.size <= MAX_OPEN) break
    if (entry.users > 0) continue
    opened.delete(path)
    void entry.media.then((m) => (m.input as unknown as { dispose?: () => void }).dispose?.()).catch(() => undefined)
  }
}

/** Open files and how many are being read (for tests). */
export function openFiles(): { open: number; inUse: number; held: string[] } {
  const held = [...opened].filter(([, entry]) => entry.users > 0).map(([path]) => path)
  return { open: opened.size, inUse: held.length, held }
}

/** A file, opened once and shared, for a quick look (not held: it may be closed once idle). */
export function openMedia(path: string): Promise<OpenedMedia> {
  const entry = entryFor(path)
  closeIdle()
  return entry.media
}

/** A file held open until `release()`: for anything that reads from it over time. */
export async function useMedia(path: string): Promise<MediaUse> {
  const entry = entryFor(path)
  entry.users++
  closeIdle()
  let released = false
  const release = () => {
    if (released) return
    released = true
    entry.users--
    closeIdle()
  }
  try {
    return { media: await entry.media, release }
  } catch (error) {
    release()
    throw error
  }
}

/**
 * Decoded stills, least recently used first, within a memory budget: a photo montage can't
 * fill memory. Each GPU keeps its own copy (LayerBuilder), so this only saves decoding again.
 * Anything used in the last couple of seconds stays, whatever the budget, so a still is never
 * closed between being handed out and being uploaded.
 */
interface DecodedStill {
  bitmap: Promise<ImageBitmap>
  bytes: number
  usedAt: number
}
const stills = new Map<string, DecodedStill>()
export const STILL_CACHE_BYTES = 384 * 1024 * 1024
const RECENT_MS = 2000

function trimStills(): void {
  let total = 0
  for (const entry of stills.values()) total += entry.bytes
  const now = performance.now()
  for (const [path, entry] of stills) {
    if (total <= STILL_CACHE_BYTES) break
    if (entry.bytes === 0 || now - entry.usedAt < RECENT_MS) continue
    stills.delete(path)
    total -= entry.bytes
    void entry.bitmap.then((b) => b.close()).catch(() => undefined)
  }
}

/** Bytes of decoded stills held (for tests). */
export function stillCacheBytes(): number {
  let total = 0
  for (const entry of stills.values()) total += entry.bytes
  return total
}

/**
 * Decodes a still once; the compositor uploads it to the GPU. Full size (for punch-ins,
 * decision 26), unless it's bigger than the GPU can hold: then it's scaled to fit.
 */
export function openStill(path: string): Promise<ImageBitmap> {
  const existing = stills.get(path)
  if (existing) {
    existing.usedAt = performance.now()
    stills.delete(path)
    stills.set(path, existing)
    return existing.bitmap
  }
  const entry: DecodedStill = { bitmap: Promise.resolve(null as unknown as ImageBitmap), bytes: 0, usedAt: performance.now() }
  entry.bitmap = (async () => {
    const response = await fetch(window.ginosa.mediaUrl(path))
    if (!response.ok) throw new Error(`Couldn't read the image (${response.status})`)
    let image = await createImageBitmap(await response.blob())
    const limit = (await getGpu()).device.limits.maxTextureDimension2D
    if (image.width > limit || image.height > limit) {
      const k = limit / Math.max(image.width, image.height)
      const smaller = await createImageBitmap(image, { resizeWidth: Math.max(1, Math.floor(image.width * k)), resizeHeight: Math.max(1, Math.floor(image.height * k)), resizeQuality: 'high' })
      image.close()
      image = smaller
    }
    entry.bytes = image.width * image.height * 4
    entry.usedAt = performance.now()
    trimStills()
    return image
  })()
  entry.bitmap.catch(() => {
    if (stills.get(path) === entry) stills.delete(path)
  })
  stills.set(path, entry)
  return entry.bitmap
}
