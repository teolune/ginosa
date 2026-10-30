import type { TestEffect } from '@shared/ipc'
import type { GpuContext } from '../gpu/gpu'
import { FramePipeline } from '../gpu/frame-pipeline'
import { Clip } from './clip'

/**
 * The M0 playback test, kept as a tool window until the real monitors arrive
 * (Source Monitor in M2, Program Monitor playback in M4). No audio.
 */
export interface TestPlayerState {
  clip: Clip | null
  path: string | null
  index: number
  playing: boolean
  effect: TestEffect
  amount: number
  stats: string
  error: string | null
}

export class TestPlayer {
  state: TestPlayerState = { clip: null, path: null, index: 0, playing: false, effect: 'none', amount: 1, stats: '', error: null }
  private pipeline: FramePipeline
  private context: GPUCanvasContext | null = null
  private format: GPUTextureFormat
  private decoding = false
  private pendingIndex: number | null = null

  constructor(
    private readonly gpu: GpuContext,
    private readonly onChange: () => void
  ) {
    this.pipeline = new FramePipeline(gpu.device)
    this.format = navigator.gpu.getPreferredCanvasFormat()
  }

  attach(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('Could not create a WebGPU canvas context.')
    context.configure({ device: this.gpu.device, format: this.format, alphaMode: 'opaque' })
    this.context = context
  }

  private set(changes: Partial<TestPlayerState>): void {
    this.state = { ...this.state, ...changes }
    this.onChange()
  }

  async open(path: string, canvas: HTMLCanvasElement): Promise<void> {
    this.stop()
    this.state.clip?.dispose()
    this.set({ clip: null, path, index: 0, error: null, stats: 'Opening…' })
    try {
      const clip = await Clip.open(window.ginosa.mediaUrl(path))
      canvas.width = clip.info.width || 1920
      canvas.height = clip.info.height || 1080
      this.set({ clip, stats: '' })
      if (!clip.info.canDecode) {
        this.set({ error: `${clip.info.codec} can't be decoded by WebCodecs here; from M2 it gets an optimised copy.` })
        return
      }
      await this.showFrame(0)
    } catch (error) {
      this.set({ error: `Couldn't open the file: ${(error as Error).message}`, stats: '' })
    }
  }

  private draw(frame: VideoFrame): void {
    if (!this.context) return
    this.pipeline.draw(frame, this.context.getCurrentTexture().createView(), this.format, {
      effect: this.state.effect,
      amount: this.state.amount
    })
  }

  async showFrame(index: number): Promise<void> {
    const clip = this.state.clip
    if (!clip?.info.canDecode) return
    if (this.decoding) {
      this.pendingIndex = index
      return
    }
    this.decoding = true
    try {
      const start = performance.now()
      const decoded = await clip.frameAt(index)
      const decodeMs = performance.now() - start
      if (!decoded) return
      try {
        this.draw(decoded.frame)
      } finally {
        decoded.frame.close()
      }
      this.set({ index, stats: `Decode ${decodeMs.toFixed(1)} ms` })
    } catch (error) {
      this.set({ error: (error as Error).message })
    } finally {
      this.decoding = false
      if (this.pendingIndex !== null) {
        const next = this.pendingIndex
        this.pendingIndex = null
        void this.showFrame(next)
      }
    }
  }

  step(delta: number): void {
    const clip = this.state.clip
    if (!clip) return
    this.stop()
    const max = Math.max(0, clip.info.frameCount - 1)
    void this.showFrame(Math.min(max, Math.max(0, this.state.index + delta)))
  }

  setEffect(effect: TestEffect, amount: number): void {
    this.set({ effect, amount })
    if (!this.state.playing) void this.showFrame(this.state.index)
  }

  stop(): void {
    if (this.state.playing) this.set({ playing: false })
  }

  async play(): Promise<void> {
    const clip = this.state.clip
    if (!clip?.info.canDecode || this.state.playing) return
    this.set({ playing: true })
    const fps = clip.info.fps || 30
    const frameMs = 1000 / fps
    let startWall = 0
    let startTimestamp = 0
    let drawn = 0
    let dropped = 0
    let lastStats = performance.now()
    try {
      for await (const decoded of clip.framesFrom(this.state.index)) {
        if (!this.state.playing) {
          decoded.frame.close()
          break
        }
        const now = performance.now()
        if (startWall === 0) {
          startWall = now
          startTimestamp = decoded.timestamp
        }
        const due = startWall + (decoded.timestamp - startTimestamp) * 1000
        if (now > due + frameMs) {
          dropped++
          decoded.frame.close()
          continue
        }
        if (due > now) await new Promise((resolve) => setTimeout(resolve, due - now))
        try {
          this.draw(decoded.frame)
        } finally {
          decoded.frame.close()
        }
        drawn++
        this.state.index = decoded.index
        if (performance.now() - lastStats > 250) {
          const elapsed = (performance.now() - startWall) / 1000
          this.set({ stats: `Playback ${(drawn / elapsed).toFixed(1)} of ${fps.toFixed(2)} fps · dropped ${dropped}` })
          lastStats = performance.now()
        }
      }
    } catch (error) {
      this.set({ error: (error as Error).message })
    } finally {
      this.set({ playing: false })
    }
  }

  dispose(): void {
    this.stop()
    this.state.clip?.dispose()
    this.pipeline.destroy()
  }
}
