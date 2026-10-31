import { frameBytes, type RawPixelFormat } from '@engine/export/export-settings'
import shader from './yuv.wgsl?raw'

const FORMAT_CODES: Record<RawPixelFormat, number> = { nv12: 0, p010le: 1, 'yuv422p10le': 2, 'yuv444p10le': 3 }
const MAX_GROUPS = 65535

/**
 * Converts composites to raw Y'CbCr frames for FFmpeg on the GPU (yuv.wgsl), then reads
 * them back. Two read-back buffers let the next frame render while one is being read.
 */
export class YuvConverter {
  private readonly pipeline: GPUComputePipeline
  private readonly params: GPUBuffer
  private readonly output: GPUBuffer
  private readonly readback: GPUBuffer[]
  private next = 0
  readonly bytes: number
  private readonly words: number

  constructor(
    private readonly device: GPUDevice,
    private readonly format: RawPixelFormat,
    private readonly width: number,
    private readonly height: number
  ) {
    this.bytes = frameBytes(format, width, height)
    this.words = Math.ceil(this.bytes / 4)
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' } })
    this.params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.output = device.createBuffer({ size: this.words * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    this.readback = [0, 1].map(() => device.createBuffer({ size: this.words * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }))
  }

  /** Converts `texture` (the composite) and resolves with the frame's bytes. */
  async convert(texture: GPUTexture, frame: number): Promise<Uint8Array> {
    const groups = Math.ceil(this.words / 256)
    const groupsX = Math.min(groups, MAX_GROUPS)
    const groupsY = Math.ceil(groups / groupsX)
    this.device.queue.writeBuffer(this.params, 0, new Uint32Array([this.width, this.height, FORMAT_CODES[this.format], frame, this.words, groupsX, 0, 0]))
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: this.output } },
        { binding: 2, resource: { buffer: this.params } }
      ]
    })
    const target = this.readback[this.next]!
    this.next = 1 - this.next
    const encoder = this.device.createCommandEncoder({ label: 'yuv' })
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(groupsX, groupsY)
    pass.end()
    encoder.copyBufferToBuffer(this.output, 0, target, 0, this.words * 4)
    this.device.queue.submit([encoder.finish()])
    await target.mapAsync(GPUMapMode.READ)
    const bytes = new Uint8Array(target.getMappedRange(0, this.words * 4).slice(0, this.bytes))
    target.unmap()
    return bytes
  }

  destroy(): void {
    this.params.destroy()
    this.output.destroy()
    this.readback.forEach((b) => b.destroy())
  }
}
