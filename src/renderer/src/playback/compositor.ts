import { BLEND_MODES, type BlendMode } from '@engine/project/model'
import type { Affine } from '@engine/timeline/motion'
import type { Matrix3 } from '@engine/colour/colour'
import type { EffectManifest, ParamValue } from '@engine/effects/types'
import blendSource from './blend.wgsl?raw'
import compositeSource from './composite.wgsl?raw'
import maskSource from './mask.wgsl?raw'
import { effectShaderSource, maskAa, packFrame, packParams } from './effect-shader'
import { invertAffine } from '@engine/timeline/motion'

const shaderSource = `${blendSource}\n${compositeSource}\n${maskSource}`

/** A shared mask packed for the GPU (packMask), and whether its outside is used instead. */
export interface GpuMask {
  data: Float32Array
  parts: number
  invert: boolean
  /** The frame (sequence size) it's drawn on. */
  frame: { width: number; height: number }
}

/** An effect ready to run: its manifest, values, and the shared Mix (0–1) and blend mode. */
export interface GpuEffect {
  manifest: EffectManifest
  params: Record<string, ParamValue>
  mix: number
  blend: BlendMode
  /** Where it shows (null: everywhere). */
  mask: GpuMask | null
  /** Stateful effects: their state from the frame before, and where this frame's goes. */
  state?: EffectState | null
}

/** A stateful effect's state, as one pass sees it (temporal.ts keeps it between frames). */
export interface EffectState {
  /** Frames since the reset. */
  frames: number
  /** This frame's output, if it's already kept exactly (a checkpoint, or the frame just rendered): no need to run the effect. */
  kept(width: number, height: number): GPUTexture | null
  /** The effect's output on the frame before, for a pass this size; null on the first frame (or if none is kept). */
  previous(width: number, height: number): GPUTexture | null
  /** Keeps this frame's output (copied within the same command encoder). */
  commit(encoder: GPUCommandEncoder, output: GPUTexture): void
}

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
  /** The clip's effects (switched-on ones only), run on its own pixels before Motion. */
  effects?: GpuEffect[]
}

/** An adjustment layer: effects on everything composited so far, blended back with opacity and mode. */
export interface AdjustmentStep {
  kind: 'adjustment'
  effects: GpuEffect[]
  opacity: number
  blend: BlendMode
  /** Where the layer applies (null: everywhere). */
  mask: GpuMask | null
}

export type CompositeStep = CompositeLayer | AdjustmentStep

function isAdjustment(step: CompositeStep): step is AdjustmentStep {
  return (step as AdjustmentStep).kind === 'adjustment'
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
const UNIFORM_BYTES = 256
const NO_COLOUR: LayerColour = { undoMacDisplay: false, conversion: { kind: 'none' } }

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
  private pipelines = new Map<string, GPURenderPipeline>()
  private effectPipelines = new Map<string, GPURenderPipeline>()
  private effectLayout: GPUPipelineLayout | null = null
  private scratch = new Map<string, GPUTexture[]>()
  private uniformUsed = 0
  private presentPipelines = new Map<GPUTextureFormat, GPURenderPipeline>()
  private targets: [GPUTexture, GPUTexture] | null = null
  private uniformPool: GPUBuffer[] = []
  private storagePool: GPUBuffer[] = []
  private storageUsed = 0
  private readonly noMask: GPUBuffer
  private readonly noPrevious: GPUTexture
  private readonly noLut: GPUTexture
  width = 0
  height = 0

  constructor(private readonly device: GPUDevice) {
    this.module = device.createShaderModule({ label: 'composite.wgsl', code: shaderSource })
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    this.noLut = device.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING })
    this.noMask = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE })
    this.noPrevious = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING })
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

  private pipeline(entryPoint: string): GPURenderPipeline {
    let pipeline = this.pipelines.get(entryPoint)
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        label: `composite ${entryPoint}`,
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vs' },
        fragment: { module: this.module, entryPoint, targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' }
      })
      this.pipelines.set(entryPoint, pipeline)
    }
    return pipeline
  }

  private effectPipeline(manifest: EffectManifest): GPURenderPipeline {
    let pipeline = this.effectPipelines.get(manifest.id)
    if (!pipeline) {
      const module = this.device.createShaderModule({ label: `effect ${manifest.id}`, code: effectShaderSource(manifest) })
      // One explicit layout for every effect, so bindings an effect doesn't use are still valid.
      this.effectLayout ??= this.device.createPipelineLayout({
        bindGroupLayouts: [
          this.device.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
              { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
              { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
              { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
              { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
              { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
            ]
          })
        ]
      })
      pipeline = this.device.createRenderPipeline({
        label: `effect ${manifest.id}`,
        layout: this.effectLayout,
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fsEffect', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' }
      })
      this.effectPipelines.set(manifest.id, pipeline)
    }
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

  /** A uniform buffer for one pass. Each pass in a frame needs its own (writes land before the frame runs). */
  private uniform(data: Float32Array): GPUBuffer {
    if (this.uniformUsed >= this.uniformPool.length) {
      this.uniformPool.push(this.device.createBuffer({ size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }))
    }
    const buffer = this.uniformPool[this.uniformUsed++]!
    this.device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }

  /** A mask's data for one pass (pooled like uniforms; grown when a mask needs more). */
  private maskBuffer(mask: GpuMask | null): GPUBuffer {
    if (!mask || mask.parts === 0) return this.noMask
    const bytes = Math.max(256, 2 ** Math.ceil(Math.log2(mask.data.byteLength)))
    let buffer = this.storagePool[this.storageUsed]
    if (!buffer || buffer.size < mask.data.byteLength) {
      buffer?.destroy()
      buffer = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      this.storagePool[this.storageUsed] = buffer
    }
    this.storageUsed++
    this.device.queue.writeBuffer(buffer, 0, mask.data)
    return buffer
  }

  /** A scratch texture from the pool (kept between frames). */
  private take(width: number, height: number): GPUTexture {
    const key = `${width}x${height}`
    const free = this.scratch.get(key)
    const texture = free?.pop()
    if (texture) return texture
    return this.device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      // COPY_DST: a stateful effect's kept output is copied in instead of running it again.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
    })
  }

  private release(texture: GPUTexture): void {
    const key = `${texture.width}x${texture.height}`
    const free = this.scratch.get(key) ?? []
    free.push(texture)
    this.scratch.set(key, free)
  }

  private layerUniform(layer: CompositeLayer, scale: number): Float32Array {
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
    return data
  }

  /** One full-screen pass of a composite.wgsl entry point into `target`. */
  private draw(encoder: GPUCommandEncoder, entryPoint: string, target: GPUTexture, resources: Partial<Record<number, GPUBindingResource>>): void {
    const pipeline = this.pipeline(entryPoint)
    const used: Record<string, number[]> = {
      fsVideo: [0, 1, 2, 3, 7],
      fsImage: [1, 2, 3, 4, 7],
      fsSourceVideo: [0, 1, 2, 7],
      fsSourceImage: [1, 2, 4, 7],
      fsAdjust: [2, 3, 4, 8]
    }
    const entries = used[entryPoint]!.map((binding) => ({ binding, resource: resources[binding]! }))
    const bindGroup = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
  }

  /**
   * Runs effects on `input` (width × height), returning the result (`input` itself if there
   * are none). `toFrame` maps the input's pixels onto the frame, where masks are drawn.
   */
  private runEffects(encoder: GPUCommandEncoder, input: GPUTexture, effects: GpuEffect[], pixelScale: number, toFrame: Affine): GPUTexture {
    let current = input
    for (const effect of effects) {
      const kept = effect.state?.kept(input.width, input.height) ?? null
      if (kept) {
        const output = this.take(input.width, input.height)
        encoder.copyTextureToTexture({ texture: kept }, { texture: output }, [input.width, input.height])
        if (current !== input) this.release(current)
        current = output
        continue
      }
      const mask = effect.mask ? { parts: effect.mask.parts, invert: effect.mask.invert, toFrame, frame: effect.mask.frame } : null
      const previous = effect.state?.previous(input.width, input.height) ?? null
      const temporal = effect.state ? { hasPrevious: previous !== null, frames: effect.state.frames } : null
      const output = this.take(input.width, input.height)
      const pipeline = this.effectPipeline(effect.manifest)
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: current.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: this.uniform(packFrame(input.width, input.height, effect.mix, effect.blend, pixelScale, mask, temporal)) } },
          { binding: 3, resource: { buffer: this.uniform(packParams(effect.manifest, effect.params, pixelScale)) } },
          { binding: 4, resource: { buffer: this.maskBuffer(effect.mask) } },
          { binding: 5, resource: (previous ?? this.noPrevious).createView() }
        ]
      })
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      effect.state?.commit(encoder, output)
      if (current !== input) this.release(current)
      current = output
    }
    return current
  }

  /**
   * Composites `steps` (bottom first) over black. `scale` is output pixels per sequence
   * pixel. Must run in the task that produced the VideoFrames (external textures expire).
   * Returns the texture holding the result.
   */
  render(steps: CompositeStep[], scale: number): GPUTexture {
    if (!this.targets) throw new Error('Compositor has no size yet')
    this.uniformUsed = 0
    this.storageUsed = 0
    const encoder = this.device.createCommandEncoder({ label: 'composite' })
    let [read, write] = this.targets
    // Start from black.
    encoder.beginRenderPass({ colorAttachments: [{ view: read.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }).end()
    const lutView = (colour: LayerColour) => (colour.conversion.kind === 'lut' ? colour.conversion.lut.texture : this.noLut).createView({ dimension: '3d' })
    const limit = this.device.limits.maxTextureDimension2D
    for (const step of steps) {
      if (isAdjustment(step)) {
        if (step.effects.length === 0) continue
        // The composite is the frame times `scale`.
        const toFrame: Affine = { a: 1 / scale, b: 0, c: 0, d: 1 / scale, e: 0, f: 0 }
        const effected = this.runEffects(encoder, read, step.effects, scale, toFrame)
        const uniform = new Float32Array(LAYER_BYTES / 4)
        uniform[9] = step.opacity
        uniform[11] = BLEND_MODES.findIndex((b) => b.id === step.blend)
        if (step.mask) {
          uniform.set([toFrame.a, toFrame.b, toFrame.c, toFrame.d, toFrame.e, toFrame.f, step.mask.frame.width, step.mask.frame.height], 0)
          uniform.set([step.mask.parts, maskAa(toFrame), step.mask.invert ? 1 : 0], 12)
        }
        this.draw(encoder, 'fsAdjust', write, { 2: { buffer: this.uniform(uniform) }, 3: read.createView(), 4: effected.createView(), 8: { buffer: this.maskBuffer(step.mask) } })
        if (effected !== read) this.release(effected)
        ;[read, write] = [write, read]
        continue
      }
      let layer = step
      let processed: GPUTexture | null = null
      if (step.effects && step.effects.length > 0) {
        // The clip at its own size (times the playback resolution), then its effects.
        const s = Math.min(scale, limit / step.width, limit / step.height)
        const source = this.take(Math.max(1, Math.round(step.width * s)), Math.max(1, Math.round(step.height * s)))
        const sourceUniform = this.uniform(this.layerUniform(step, scale))
        const resources: Partial<Record<number, GPUBindingResource>> = { 1: this.sampler, 2: { buffer: sourceUniform }, 7: lutView(step.colour) }
        if (step.source.kind === 'video') resources[0] = this.device.importExternalTexture({ source: step.source.frame })
        else resources[4] = step.source.texture.createView()
        this.draw(encoder, step.source.kind === 'video' ? 'fsSourceVideo' : 'fsSourceImage', source, resources)
        // Processed pixel → source pixel (÷ s) → frame pixel (the layer's Motion).
        const motion = invertAffine(step.inverse) ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
        const toFrame: Affine = { a: motion.a / s, b: motion.b / s, c: motion.c / s, d: motion.d / s, e: motion.e, f: motion.f }
        processed = this.runEffects(encoder, source, step.effects, s, toFrame)
        if (processed !== source) this.release(source)
        // Already decoded, converted and turned upright.
        layer = { ...step, source: { kind: 'image', texture: processed }, rotation: 0, colour: NO_COLOUR }
      }
      const resources: Partial<Record<number, GPUBindingResource>> = { 1: this.sampler, 2: { buffer: this.uniform(this.layerUniform(layer, scale)) }, 3: read.createView(), 7: lutView(layer.colour) }
      if (layer.source.kind === 'video') resources[0] = this.device.importExternalTexture({ source: layer.source.frame })
      else resources[4] = layer.source.texture.createView()
      this.draw(encoder, layer.source.kind === 'video' ? 'fsVideo' : 'fsImage', write, resources)
      if (processed) this.release(processed)
      ;[read, write] = [write, read]
    }
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
    this.storagePool.forEach((b) => b.destroy())
    this.noMask.destroy()
    this.noPrevious.destroy()
    for (const list of this.scratch.values()) list.forEach((t) => t.destroy())
    this.scratch.clear()
    this.noLut.destroy()
  }
}
