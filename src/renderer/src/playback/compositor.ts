import { BLEND_MODES, type BlendMode } from '@engine/project/model'
import type { Affine } from '@engine/timeline/motion'
import type { Matrix3 } from '@engine/colour/colour'
import shaderSource from './composite.wgsl?raw'

/** One layer to composite: a decoded frame or a still, how it's placed, and how it blends. */
export interface CompositeLayer {
  source: { kind: 'video'; frame: VideoFrame } | { kind: 'image'; texture: GPUTexture }
  /** Sequence pixel -> source pixel (as displayed). */
  inverse: Affine
  /** Source size as displayed (after rotation metadata). */
  width: number
  height: number
  /** Clockwise quarter turns from stored to displayed pixels. */
  rotation: number
  opacity: number
  blend: BlendMode
  colour: LayerColour
}

/** How a layer's pixels become working (Rec.709 code) values. */
export interface LayerColour {
  /** True when Chromium applied the Mac video display transform on import (undone here). */
  undoMacDisplay: boolean
  conversion: { kind: 'none' } | { kind: 'apple-log'; gamut: Matrix3 } | { kind: 'lut'; lut: GpuLut } | { kind: 'hdr'; transfer: 'hlg' | 'pq' }
}

export interface GpuLut {
  texture: GPUTexture
  size: number
  min: [number, number, number]
  max: [number, number, number]
}

const LAYER_BYTES = 144

/** float32 → IEEE half, for 16-bit float textures. */
function toHalf(value: number): number {
  const f = new Float32Array([value])
  const x = new Uint32Array(f.buffer)[0]!
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  let mant = x & 0x7fffff
  if (exp <= 0) {
    if (exp < -10) return sign
    mant = (mant | 0x800000) >> (1 - exp)
    return sign | ((mant + 0x1000) >> 13)
  }
  if (exp >= 31) return sign | 0x7c00
  const half = sign | (exp << 10) | ((mant + 0x1000) >> 13)
  return half
}

/**
 * The GPU compositor: layers are drawn bottom to top into a 16-bit float image the
 * size of the sequence (times the playback resolution), then copied to the screen.
 * Preview and export share it.
 */
export class Compositor {
  private readonly module: GPUShaderModule
  private readonly sampler: GPUSampler
  private videoPipeline: GPURenderPipeline | null = null
  private imagePipeline: GPURenderPipeline | null = null
  private presentPipelines = new Map<GPUTextureFormat, GPURenderPipeline>()
  private targets: [GPUTexture, GPUTexture] | null = null
  private uniformPool: GPUBuffer[] = []
  private readonly noLut: GPUTexture
  width = 0
  height = 0

  constructor(private readonly device: GPUDevice) {
    this.module = device.createShaderModule({ label: 'composite.wgsl', code: shaderSource })
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    this.noLut = device.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING })
  }

  /** Sets the size of the composite in pixels (sequence size × playback resolution). */
  resize(width: number, height: number): void {
    if (this.targets && width === this.width && height === this.height) return
    this.targets?.forEach((t) => t.destroy())
    this.width = width
    this.height = height
    const make = () =>
      this.device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
      })
    this.targets = [make(), make()]
  }

  private layerPipeline(kind: 'video' | 'image'): GPURenderPipeline {
    const existing = kind === 'video' ? this.videoPipeline : this.imagePipeline
    if (existing) return existing
    const pipeline = this.device.createRenderPipeline({
      label: `composite ${kind}`,
      layout: 'auto',
      vertex: { module: this.module, entryPoint: 'vs' },
      fragment: { module: this.module, entryPoint: kind === 'video' ? 'fsVideo' : 'fsImage', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' }
    })
    if (kind === 'video') this.videoPipeline = pipeline
    else this.imagePipeline = pipeline
    return pipeline
  }

  private presentPipeline(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.presentPipelines.get(format)
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        label: `present ${format}`,
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vs' },
        fragment: { module: this.module, entryPoint: 'fsPresent', targets: [{ format }] },
        primitive: { topology: 'triangle-list' }
      })
      this.presentPipelines.set(format, pipeline)
    }
    return pipeline
  }

  private uniforms(index: number): GPUBuffer {
    while (this.uniformPool.length <= index) {
      this.uniformPool.push(this.device.createBuffer({ size: LAYER_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }))
    }
    return this.uniformPool[index]!
  }

  /**
   * Composites `layers` (bottom first) over black. `scale` is output pixels per sequence
   * pixel. Must run in the task that produced the VideoFrames (external textures expire).
   * Returns the texture holding the result.
   */
  render(layers: CompositeLayer[], scale: number): GPUTexture {
    if (!this.targets) throw new Error('Compositor has no size yet')
    const encoder = this.device.createCommandEncoder({ label: 'composite' })
    let [read, write] = this.targets
    // Start from black.
    encoder.beginRenderPass({ colorAttachments: [{ view: read.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }).end()
    layers.forEach((layer, index) => {
      const data = new Float32Array(LAYER_BYTES / 4)
      const m = layer.inverse
      const conversion = layer.colour.conversion
      const lut = conversion.kind === 'lut' ? conversion.lut : null
      const gamut = conversion.kind === 'apple-log' ? conversion.gamut : ([1, 0, 0, 0, 1, 0, 0, 0, 1] as Matrix3)
      data.set([
        m.a, m.b, m.c, m.d, m.e, m.f, layer.width, layer.height,
        scale, layer.opacity, layer.rotation, BLEND_MODES.findIndex((b) => b.id === layer.blend),
        layer.colour.undoMacDisplay ? 1 : 0, conversion.kind === 'apple-log' ? 1 : conversion.kind === 'lut' ? 2 : conversion.kind === 'hdr' ? (conversion.transfer === 'hlg' ? 3 : 4) : 0, lut?.size ?? 1, 0,
        ...(lut?.min ?? [0, 0, 0]), 0,
        ...(lut?.max ?? [1, 1, 1]), 0,
        // WGSL matrices are column-major: column j holds row-major entries j, j+3, j+6.
        gamut[0], gamut[3], gamut[6], 0,
        gamut[1], gamut[4], gamut[7], 0,
        gamut[2], gamut[5], gamut[8], 0
      ])
      const buffer = this.uniforms(index)
      this.device.queue.writeBuffer(buffer, 0, data)
      const pipeline = this.layerPipeline(layer.source.kind)
      const entries: GPUBindGroupEntry[] = [
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer } },
        { binding: 3, resource: read.createView() },
        { binding: 7, resource: (lut?.texture ?? this.noLut).createView({ dimension: '3d' }) }
      ]
      if (layer.source.kind === 'video') entries.push({ binding: 0, resource: this.device.importExternalTexture({ source: layer.source.frame }) })
      else entries.push({ binding: 4, resource: layer.source.texture.createView() })
      const bindGroup = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: write.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      ;[read, write] = [write, read]
    })
    this.device.queue.submit([encoder.finish()])
    return read
  }

  /** Copies a composite to a canvas (scaled to fit its size). */
  present(result: GPUTexture, context: GPUCanvasContext, format: GPUTextureFormat): void {
    const pipeline = this.presentPipeline(format)
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 5, resource: result.createView() },
        { binding: 6, resource: this.sampler }
      ]
    })
    const encoder = this.device.createCommandEncoder({ label: 'present' })
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  /** Uploads a 3D LUT (size³ RGB triplets, red fastest) as a 16-bit float 3D texture. */
  lutTexture(size: number, rgb: Float32Array, min: [number, number, number], max: [number, number, number]): GpuLut {
    const data = new Uint16Array(size * size * size * 4)
    for (let i = 0; i < size * size * size; i++) {
      data[i * 4] = toHalf(rgb[i * 3]!)
      data[i * 4 + 1] = toHalf(rgb[i * 3 + 1]!)
      data[i * 4 + 2] = toHalf(rgb[i * 3 + 2]!)
      data[i * 4 + 3] = toHalf(1)
    }
    const texture = this.device.createTexture({ size: [size, size, size], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.device.queue.writeTexture({ texture }, data, { bytesPerRow: size * 8, rowsPerImage: size }, [size, size, size])
    return { texture, size, min, max }
  }

  /** Uploads a still image as a texture. */
  imageTexture(bitmap: ImageBitmap): GPUTexture {
    const texture = this.device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    })
    this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height])
    return texture
  }

  destroy(): void {
    this.targets?.forEach((t) => t.destroy())
    this.uniformPool.forEach((b) => b.destroy())
    this.noLut.destroy()
  }
}
