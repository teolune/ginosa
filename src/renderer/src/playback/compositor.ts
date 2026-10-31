import { BLEND_MODES, type BlendMode } from '@engine/project/model'
import type { Affine } from '@engine/timeline/motion'
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
}

const LAYER_BYTES = 48

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
  width = 0
  height = 0

  constructor(private readonly device: GPUDevice) {
    this.module = device.createShaderModule({ label: 'composite.wgsl', code: shaderSource })
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
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
      data.set([m.a, m.b, m.c, m.d, m.e, m.f, layer.width, layer.height, scale, layer.opacity, layer.rotation, BLEND_MODES.findIndex((b) => b.id === layer.blend)])
      const buffer = this.uniforms(index)
      this.device.queue.writeBuffer(buffer, 0, data)
      const pipeline = this.layerPipeline(layer.source.kind)
      const entries: GPUBindGroupEntry[] = [
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer } },
        { binding: 3, resource: read.createView() }
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
  }
}
