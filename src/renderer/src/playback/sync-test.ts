import { FRAME_RATES, ticksPerFrame, ticksToSeconds, type Ticks } from '@engine/time'
import { getGpu } from '../gpu/shared'
import { player } from './player'

/**
 * The playback sync test (M4 "done when"). Plays the flash-and-beep clip and measures:
 * - A/V offset: for every presented frame, how far the picture is from the sound being
 *   heard at that moment (Web Audio's output clock, latency included);
 * - right frame: reading back the composite, each whole second must show the white
 *   flash and every other frame black, so the picture shows the frame for its time;
 * - clock drift between the audio clock and the system clock;
 * - dropped frames.
 */

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

export interface SyncReport {
  verdict: 'pass' | 'fail'
  reasons: string[]
  frames: number
  dropped: number
  fps: number
  avOffsetMs: { mean: number; p95: number; max: number }
  rightFrame: { checked: number; wrong: number; flashesSeen: number }
  clockDriftPpm: number
  outputLatencyMs: number | null
}

export async function runSyncTest(seconds: number, flashEvery: Ticks): Promise<SyncReport> {
  const { device } = await getGpu()
  const probes: Array<Promise<{ timeline: Ticks; brightness: number }>> = []
  player.probe = (texture, timeline) => {
    const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture, origin: { x: Math.floor(texture.width / 2), y: Math.floor(texture.height / 2) } }, { buffer, bytesPerRow: 256 }, [1, 1])
    device.queue.submit([encoder.finish()])
    probes.push(
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        const brightness = halfToFloat(new Uint16Array(buffer.getMappedRange())[0]!)
        buffer.destroy()
        return { timeline, brightness }
      })
    )
  }
  player.recording = []
  await player.play(1, 0)
  // Time the run from the first presented frame, so start-up (opening files, warming the
  // GPU and the audio device) isn't counted against playback.
  const started = performance.now()
  while (player.recording.length === 0 && performance.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 10))
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  const recorded = player.recording
  const dropped = player.stats.dropped
  const fps = player.stats.fps
  const latency = player.audio?.ctx.outputLatency
  player.stop()
  player.recording = null
  player.probe = null
  const readings = await Promise.all(probes)

  const frame = ticksPerFrame(FRAME_RATES['25'])
  // Ignore the first half second while decoders and the audio device spin up.
  const steady = recorded.filter((r) => r.at - recorded[0]!.at > 500)
  const offsets = steady.map((r) => ticksToSeconds(r.heard - (r.timeline + frame / 2)) * 1000)
  const absolute = offsets.map(Math.abs)
  let wrong = 0
  let flashesSeen = 0
  for (const reading of readings) {
    const index = Math.round(reading.timeline / frame)
    const shouldFlash = Math.round(reading.timeline) % flashEvery === 0 || index % Math.round(flashEvery / frame) === 0
    const isFlash = reading.brightness > 0.5
    if (isFlash) flashesSeen++
    if (shouldFlash !== isFlash) wrong++
  }
  // Audio clock against the system clock: slope of heard time over wall time.
  const n = steady.length
  let drift = 0
  if (n > 2) {
    const xs = steady.map((r) => r.at / 1000)
    const ys = steady.map((r) => ticksToSeconds(r.heard))
    const mx = xs.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0)
    drift = (slope - 1) * 1e6
  }
  const p95 = percentile(absolute, 95)
  const frameMs = ticksToSeconds(frame) * 1000
  const reasons: string[] = []
  if (p95 > frameMs) reasons.push(`95% of frames should be within one frame (${frameMs.toFixed(0)} ms) of the sound; the 95th percentile was ${p95.toFixed(1)} ms`)
  if (wrong > 0) reasons.push(`${wrong} presented frames showed the wrong picture for their time`)
  if (Math.abs(drift) > 2000) reasons.push(`audio and system clocks drifted ${drift.toFixed(0)} ppm`)
  if (recorded.length < seconds * 25 * 0.9) reasons.push(`only ${recorded.length} frames were presented in ${seconds} s (expected about ${seconds * 25})`)
  return {
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    frames: recorded.length,
    dropped,
    fps: Math.round(fps * 10) / 10,
    avOffsetMs: {
      mean: Math.round((offsets.reduce((a, b) => a + b, 0) / Math.max(1, offsets.length)) * 10) / 10,
      p95: Math.round(p95 * 10) / 10,
      max: Math.round(Math.max(0, ...absolute) * 10) / 10
    },
    rightFrame: { checked: readings.length, wrong, flashesSeen },
    clockDriftPpm: Math.round(drift),
    outputLatencyMs: latency === undefined ? null : Math.round(latency * 1000 * 10) / 10
  }
}
