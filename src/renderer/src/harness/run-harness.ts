import type { HarnessFrameResult, HarnessJob, HarnessReport } from '@shared/ipc'
import { collectDiagnostics, type Diagnostics } from '../diagnostics'
import { initGpu, type GpuContext } from '../gpu/gpu'
import { FramePipeline } from '../gpu/frame-pipeline'
import { createReadbackTarget, encodePng, readTexture } from '../gpu/readback'
import { Clip } from '../media/clip'

/**
 * Headless render: decode the requested frames, run them through the GPU pipeline,
 * read the result back and save PNGs plus a report.json via the main process.
 */
export async function runHarness(): Promise<void> {
  const bridge = window.ginosa
  const job = await bridge.harness.getJob()
  if (!job) {
    bridge.harness.log('No harness job was provided.')
    return
  }

  const frames: HarnessFrameResult[] = []
  let diagnostics: Diagnostics | null = null
  let clip: Clip | null = null
  let gpu: GpuContext | null = null

  const finish = async (ok: boolean, error?: string): Promise<void> => {
    const report: HarnessReport = {
      ok,
      job,
      diagnostics,
      clip: clip?.info ?? null,
      frames,
      ...(error ? { error } : {})
    }
    await bridge.harness.done(report)
  }

  try {
    let gpuError: string | undefined
    try {
      gpu = await initGpu((reason) => bridge.harness.log(`GPU device lost: ${reason}`))
    } catch (error) {
      gpuError = (error as Error).message
    }
    diagnostics = await collectDiagnostics(gpu, gpuError)
    if (!gpu) throw new Error(`WebGPU unavailable: ${gpuError ?? 'unknown reason'}`)

    clip = await Clip.open(job.inputUrl)
    const { info } = clip
    bridge.harness.log(
      `${info.container} ${info.codec} ${info.width}x${info.height} @ ${info.fps.toFixed(3)} fps, ` +
        `${info.frameCount} frames, decodable: ${info.canDecode}`
    )
    if (!info.canDecode) throw new Error(`Codec ${info.codec} can't be decoded by WebCodecs on this machine.`)

    await renderFrames(gpu, clip, job, frames)
    await finish(true)
  } catch (error) {
    await finish(false, (error as Error).message)
  } finally {
    clip?.dispose()
  }
}

async function renderFrames(gpu: GpuContext, clip: Clip, job: HarnessJob, results: HarnessFrameResult[]): Promise<void> {
  const { device } = gpu
  const pipeline = new FramePipeline(device)
  const target = createReadbackTarget(device, clip.info.width, clip.info.height)
  const bridge = window.ginosa

  for (const index of job.frames) {
    const decodeStart = performance.now()
    const decoded = await clip.frameAt(index)
    const decodeMs = performance.now() - decodeStart
    if (!decoded) throw new Error(`Frame ${index} could not be decoded (past the end of the file?)`)

    const gpuStart = performance.now()
    try {
      pipeline.draw(decoded.frame, target.createView(), 'rgba8unorm', { effect: job.effect, amount: job.amount })
    } finally {
      decoded.frame.close()
    }
    await device.queue.onSubmittedWorkDone()
    const gpuMs = performance.now() - gpuStart

    const image = await readTexture(device, target)
    const png = await encodePng(image)
    const name = `frame-${String(index).padStart(5, '0')}${job.effect === 'none' ? '' : `-${job.effect}`}.png`
    await bridge.harness.writeFile(name, png)

    results.push({ frame: index, file: name, timestamp: decoded.timestamp, decodeMs: round(decodeMs), gpuMs: round(gpuMs) })
    bridge.harness.log(`frame ${index} -> ${name} (decode ${round(decodeMs)} ms, gpu ${round(gpuMs)} ms)`)
  }

  target.destroy()
  pipeline.destroy()
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
