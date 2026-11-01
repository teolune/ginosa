import { secondsToTicks, ticksPerFrame, FRAME_RATES, type Ticks } from '@engine/time'
import { getGpu } from '../gpu/shared'
import { timelineController } from '../timeline/timeline-controller'
import { player } from './player'

/**
 * Real-time playback, captured for comparing with an export: one row of every presented
 * frame (3 × 4 pixel boxes at `xs`, as the export analyser reads them), by frame number.
 */

const FRAME = ticksPerFrame(FRAME_RATES['25'])

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}

export async function capturePlayback(xs: number[], rowY: number, frames: number, untilSeconds: number): Promise<Array<{ j: number; row: number[][] }>> {
  const { device } = await getGpu()
  player.setResolution(1)
  const readings: Array<Promise<{ j: number; row: number[][] }>> = []
  player.probe = (texture, timeline: Ticks) => {
    const j = Math.round(timeline / FRAME)
    if (j < 0 || j >= frames || texture.width !== 1920) return
    const bytesPerRow = Math.ceil((texture.width * 8) / 256) * 256
    const buffer = device.createBuffer({ size: bytesPerRow * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture, origin: { x: 0, y: rowY } }, { buffer, bytesPerRow }, [texture.width, 4])
    device.queue.submit([encoder.finish()])
    readings.push(
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        const half = new Uint16Array(buffer.getMappedRange())
        const perRow = bytesPerRow / 2
        const row = xs.map((x) => {
          const sum = [0, 0, 0]
          for (let r = 0; r < 4; r++)
            for (let dx = -1; dx <= 1; dx++) {
              const px = Math.min(1919, Math.max(0, x + dx))
              for (let c = 0; c < 3; c++) sum[c] = sum[c]! + halfToFloat(half[r * perRow + px * 4 + c]!)
            }
          return sum.map((v) => v / 12)
        })
        buffer.destroy()
        return { j, row }
      })
    )
  }
  player.recording = []
  await player.play(1, 0)
  const started = performance.now()
  while (player.playing && timelineController.playhead < secondsToTicks(untilSeconds) && performance.now() - started < (untilSeconds + 7) * 1000) await new Promise((r) => setTimeout(r, 40))
  player.stop()
  player.recording = null
  player.probe = null
  return Promise.all(readings)
}

/** Playback rows against the file's, on flat stretches only (at an edge, 10-bit rounding moves a box's mean). */
export function comparePlayback(played: Array<{ j: number; row: number[][] }>, file: number[][][]): { compared: number; points: number; worst: number } {
  let worst = 0
  let points = 0
  for (const { j, row } of played) {
    const fileRow = file[j]
    if (!fileRow) continue
    for (let i = 1; i < row.length - 1; i++) {
      const flat = [row[i - 1]!, row[i + 1]!].every((p) => p.every((v, c) => Math.abs(v - row[i]![c]!) < 0.02))
      if (!flat) continue
      points++
      worst = Math.max(worst, ...row[i]!.map((v, c) => Math.abs(v - fileRow[i]![c]!)))
    }
  }
  return { compared: new Set(played.map((p) => p.j)).size, points, worst }
}
