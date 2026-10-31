import { ALL_FORMATS, AudioBufferSink, EncodedPacket, Input, UrlSource, VideoSampleSink, type InputAudioTrack, type InputVideoTrack } from 'mediabunny'
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

const opened = new Map<string, Promise<OpenedMedia>>()
const order: string[] = []
const MAX_OPEN = 12

export function openMedia(path: string): Promise<OpenedMedia> {
  let media = opened.get(path)
  if (media) {
    order.splice(order.indexOf(path), 1)
    order.push(path)
    return media
  }
  media = (async () => {
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
  media.catch(() => {
    opened.delete(path)
    order.splice(order.indexOf(path), 1)
  })
  opened.set(path, media)
  order.push(path)
  while (order.length > MAX_OPEN) {
    const oldest = order.shift()!
    void opened.get(oldest)?.then((m) => (m.input as unknown as { dispose?: () => void }).dispose?.()).catch(() => undefined)
    opened.delete(oldest)
  }
  return media
}

const stills = new Map<string, Promise<ImageBitmap>>()

/** Decodes a still once; the compositor uploads it to the GPU. */
export function openStill(path: string): Promise<ImageBitmap> {
  let bitmap = stills.get(path)
  if (!bitmap) {
    bitmap = fetch(window.ginosa.mediaUrl(path))
      .then((response) => {
        if (!response.ok) throw new Error(`Couldn't read the image (${response.status})`)
        return response.blob()
      })
      .then((blob) => createImageBitmap(blob))
    bitmap.catch(() => stills.delete(path))
    stills.set(path, bitmap)
  }
  return bitmap
}
