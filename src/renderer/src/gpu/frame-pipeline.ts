import type { TestEffect } from '@shared/ipc'
import shaderSource from './frame.wgsl?raw'

export interface FrameParams {
  effect: TestEffect
  amount: number
}

/**
 * Draws a VideoFrame onto a render target through the M0 test shader.
 * The frame is imported as an external texture, so it never leaves the GPU.
 */
export class FramePipeline {
  private readonly module: GPUShaderModule
  private readonly sampler: GPUSampler
  private readonly uniforms: GPUBuffer
  private readonly uniformData = new ArrayBuffer(16)
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>()

  constructor(private readonly device: GPUDevice) {
    this.module = device.createShaderModule({ label: 'frame.wgsl', code: shaderSource })
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    this.uniforms = device.createBuffer({
      label: 'frame params',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
  }

  private pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.pipelines.get(format)
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        label: `frame pipeline (${format})`,
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vs' },
        fragment: { module: this.module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' }
      })
      this.pipelines.set(format, pipeline)
    }
    return pipeline
  }

  /**
   * Encodes and submits a draw of `frame` into `target`. Must be called in the same
   * task that obtained the frame, because external textures expire at the end of it.
   */
  draw(frame: VideoFrame, target: GPUTextureView, format: GPUTextureFormat, params: FrameParams): void {
    const floats = new Float32Array(this.uniformData)
    const uints = new Uint32Array(this.uniformData)
    floats[0] = params.amount
    uints[1] = params.effect === 'invert' ? 1 : 0
    this.device.queue.writeBuffer(this.uniforms, 0, this.uniformData)

    const pipeline = this.pipelineFor(format)
    const external = this.device.importExternalTexture({ source: frame })
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: external },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniforms } }
      ]
    })

    const encoder = this.device.createCommandEncoder({ label: 'frame draw' })
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }]
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  destroy(): void {
    this.uniforms.destroy()
  }
}
