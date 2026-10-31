import { ALL_FORMATS, AudioBufferSink, Input, UrlSource, VideoSampleSink, type InputAudioTrack, type InputVideoTrack } from 'mediabunny'

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
    if (video) {
      // Ask for the stored Y'CbCr → R'G'B' values only (sRGB transfer = no conversion on import).
      // Chromium honours this whenever the file leaves its transfer unspecified, as iPhone log
      // files do; for tagged Rec.709 the compositor undoes Chromium's display transform instead.
      const tagged = await video.getColorSpace().catch(() => ({}) as VideoColorSpaceInit)
      const original = video.getDecoderConfig.bind(video)
      video.getDecoderConfig = async () => {
        const config = await original()
        return config && { ...config, colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: tagged.matrix ?? 'bt709', fullRange: tagged.fullRange ?? false } }
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
      origin: Math.max(0, await input.getFirstTimestamp())
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
