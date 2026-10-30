import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from 'mediabunny'

/**
 * M0 media access: opens one file through Mediabunny and returns frames by index.
 * Track metadata is read through `readTrackValue`, which accepts both the property
 * style and the async-getter style Mediabunny has used across versions.
 */

export interface ClipInfo {
  url: string
  container: string
  codec: string
  codecString: string
  canDecode: boolean
  width: number
  height: number
  rotation: number
  durationSeconds: number
  firstTimestamp: number
  fps: number
  frameCount: number
  averageBitrate: number | null
  audio: { codec: string; sampleRate: number; channels: number } | null
}

export interface DecodedFrame {
  frame: VideoFrame
  timestamp: number
  index: number
}

type AnyTrack = Record<string, unknown>

async function readTrackValue<T>(track: unknown, name: string, fallback: T): Promise<T> {
  const object = track as AnyTrack
  const getterName = `get${name.charAt(0).toUpperCase()}${name.slice(1)}`
  const getter = object[getterName]
  try {
    if (typeof getter === 'function') return ((await (getter as () => Promise<T> | T).call(track)) ?? fallback) as T
    const value = object[name]
    if (typeof value === 'function') return ((await (value as () => Promise<T> | T).call(track)) ?? fallback) as T
    return (value ?? fallback) as T
  } catch {
    return fallback
  }
}

async function callIfPresent<T>(target: unknown, method: string, ...args: unknown[]): Promise<T | undefined> {
  const fn = (target as AnyTrack)[method]
  if (typeof fn !== 'function') return undefined
  try {
    return (await (fn as (...a: unknown[]) => Promise<T> | T).apply(target, args)) as T
  } catch {
    return undefined
  }
}

export class Clip {
  private constructor(
    private readonly input: Input,
    private readonly sink: VideoSampleSink,
    readonly info: ClipInfo
  ) {}

  static async open(url: string): Promise<Clip> {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('This file has no video track.')

    const format = await callIfPresent<{ name?: string }>(input, 'getFormat')
    const durationSeconds = (await callIfPresent<number>(input, 'computeDuration')) ?? 0
    const firstTimestamp = (await callIfPresent<number>(track, 'getFirstTimestamp')) ?? 0
    const stats = await callIfPresent<{ averagePacketRate?: number; averageBitrate?: number; packetCount?: number }>(
      track,
      'computePacketStats',
      240
    )
    const fps = stats?.averagePacketRate && Number.isFinite(stats.averagePacketRate) ? stats.averagePacketRate : 0
    const canDecode = (await callIfPresent<boolean>(track, 'canDecode')) ?? false
    const codecString = (await callIfPresent<string | null>(track, 'getCodecParameterString')) ?? ''

    const audioTrack = await callIfPresent<unknown>(input, 'getPrimaryAudioTrack')
    const audio = audioTrack
      ? {
          codec: String(await readTrackValue(audioTrack, 'codec', 'unknown')),
          sampleRate: Number(await readTrackValue(audioTrack, 'sampleRate', 0)),
          channels: Number(await readTrackValue(audioTrack, 'numberOfChannels', 0))
        }
      : null

    const info: ClipInfo = {
      url,
      container: format?.name ?? 'unknown',
      codec: String(await readTrackValue(track, 'codec', 'unknown')),
      codecString: codecString ?? '',
      canDecode,
      width: Number(await readTrackValue(track, 'displayWidth', 0)),
      height: Number(await readTrackValue(track, 'displayHeight', 0)),
      rotation: Number(await readTrackValue(track, 'rotation', 0)),
      durationSeconds,
      firstTimestamp,
      fps,
      frameCount: fps > 0 ? Math.max(1, Math.round((durationSeconds - firstTimestamp) * fps)) : 0,
      averageBitrate: stats?.averageBitrate ?? null,
      audio
    }

    // An undecodable clip is still returned so diagnostics can show what it is;
    // frame requests on it fail with a clear message.
    return new Clip(input, new VideoSampleSink(track), info)
  }

  /** Timestamp (seconds) at the middle of a frame, so rounding can never land on the previous frame. */
  timestampForIndex(index: number): number {
    const fps = this.info.fps > 0 ? this.info.fps : 30
    return this.info.firstTimestamp + (index + 0.5) / fps
  }

  /** Decodes one frame. The caller owns the returned VideoFrame and must close() it. */
  async frameAt(index: number): Promise<DecodedFrame | null> {
    if (!this.info.canDecode) throw new Error(`This codec (${this.info.codec}) can't be decoded by WebCodecs on this Mac.`)
    const sample = await this.sink.getSample(this.timestampForIndex(index))
    if (!sample) return null
    const frame = sample.toVideoFrame()
    const timestamp = sample.timestamp
    sample.close()
    return { frame, timestamp, index }
  }

  /** Sequential decoding from a frame index, for the M0 playback throughput test. */
  async *framesFrom(index: number): AsyncGenerator<DecodedFrame> {
    if (!this.info.canDecode) return
    const fps = this.info.fps > 0 ? this.info.fps : 30
    let current = index
    for await (const sample of this.sink.samples(this.timestampForIndex(index))) {
      const frame = sample.toVideoFrame()
      const timestamp = sample.timestamp
      sample.close()
      current = Math.round((timestamp - this.info.firstTimestamp) * fps)
      yield { frame, timestamp, index: current }
    }
  }

  dispose(): void {
    const dispose = (this.input as unknown as { dispose?: () => void }).dispose
    if (typeof dispose === 'function') dispose.call(this.input)
  }
}
