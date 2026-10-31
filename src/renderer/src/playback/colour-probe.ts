import { ALL_FORMATS, Input, UrlSource, VideoSampleSink } from 'mediabunny'
import { getGpu } from '../gpu/shared'
import { Compositor } from './compositor'

/**
 * Diagnostic for colour handling: decodes test patches and reads back what reaches the
 * GPU, both with the file's own colour tags and with the decoder told the frames are
 * plain BT.709 (so Chromium only converts Y'CbCr to RGB and leaves the values alone).
 */

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}

/** Reads RGB at sequence pixels from a composite texture. */
export async function readPixels(texture: GPUTexture, points: Array<[number, number]>): Promise<number[][]> {
  const { device } = await getGpu()
  const out: number[][] = []
  for (const [x, y] of points) {
    const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture, origin: { x, y } }, { buffer, bytesPerRow: 256 }, [1, 1])
    device.queue.submit([encoder.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    const half = new Uint16Array(buffer.getMappedRange())
    out.push([0, 1, 2].map((i) => Math.round(halfToFloat(half[i]!) * 1000) / 1000))
    buffer.destroy()
  }
  return out
}

export async function probePatches(path: string, override: VideoColorSpaceInit | null): Promise<{ colorSpace: VideoColorSpaceInit | null; patches: number[][] }> {
  const { device } = await getGpu()
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(window.ginosa.mediaUrl(path)) })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('no video')
  if (override) {
    const original = track.getDecoderConfig.bind(track)
    track.getDecoderConfig = async () => {
      const config = await original()
      return config && { ...config, colorSpace: override }
    }
  }
  const sink = new VideoSampleSink(track)
  const sample = await sink.getSample(0.5)
  if (!sample) throw new Error('no frame')
  const frame = sample.toVideoFrame()
  const colorSpace = frame.colorSpace.toJSON()
  const compositor = new Compositor(device)
  compositor.resize(1280, 720)
  const result = compositor.render(
    [{ source: { kind: 'video', frame }, inverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, width: 1280, height: 720, rotation: 0, opacity: 1, blend: 'normal', colour: { undoMacDisplay: false, conversion: { kind: 'none' } } }],
    1
  )
  frame.close()
  sample.close()
  const patches: number[][] = []
  for (const x of [128, 384, 640, 896, 1152]) {
    const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture: result, origin: { x, y: 360 } }, { buffer, bytesPerRow: 256 }, [1, 1])
    device.queue.submit([encoder.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    const half = new Uint16Array(buffer.getMappedRange())
    patches.push([0, 1, 2].map((i) => Math.round(halfToFloat(half[i]!) * 1000) / 1000))
    buffer.destroy()
  }
  compositor.destroy()
  return { colorSpace, patches }
}
