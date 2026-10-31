import { FRAME_RATES, secondsToTicks, ticksPerFrame, type Ticks } from '@engine/time'
import { addCrossDissolveAt, addFrameHold, placeMedia, setClipSpeed } from '@engine/timeline/edits'
import { projectController } from '../state/project-controller'
import { getGpu } from '../gpu/shared'
import { player } from './player'

/**
 * Speed, reverse, frame hold and cross-dissolve playback test (M4 part 2). The timeline
 * is built from framecode_h264.mp4, whose ten black/white blocks spell out each frame's
 * number. For every presented frame, the number read back from the composite is
 * compared with what that moment should show, worked out here independently of the
 * render plan:
 *   0–2 s    forwards        frame j
 *   2–4 s    reversed        frames 99 → 50
 *   4–6 s    200%            frames 100, 102 … 198
 *   6–7 s    frame hold      frame 225
 *   7–8.5 s  reversed 200%   frames 298, 296 … (the 200% frames, backwards)
 *   8.5–9.5  cross-dissolve  a mix of both clips (checked 8.72–9.28 s)
 *   9.5–11 s forwards        frame j − 225
 */

export interface SpeedReport {
  verdict: 'pass' | 'fail'
  reasons: string[]
  presented: number
  regions: Array<{ name: string; checked: number; right: number; late: number; wrong: number; examples: string[] }>
  dissolve: { checked: number; mixed: number }
  dropped: number
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}

export const REGIONS: Array<{ name: string; from: number; to: number; expected: (j: number) => number }> = [
  { name: 'forwards', from: 0, to: 50, expected: (j) => j },
  { name: 'reversed', from: 50, to: 100, expected: (j) => 149 - j },
  { name: '200%', from: 100, to: 150, expected: (j) => 100 + 2 * (j - 100) },
  { name: 'frame hold', from: 150, to: 175, expected: () => 225 },
  { name: 'reversed 200%', from: 175, to: 213, expected: (j) => 298 - 2 * (j - 175) },
  { name: 'after dissolve', from: 238, to: 275, expected: (j) => j - 225 }
]

export async function runSpeedTest(width: number): Promise<SpeedReport> {
  const { device } = await getGpu()
  const frame = ticksPerFrame(FRAME_RATES['25'])
  const readings: Array<Promise<{ j: number; blocks: number[] }>> = []
  const rowBytes = Math.ceil((width * 8) / 256) * 256
  player.probe = (texture, timeline: Ticks) => {
    const buffer = device.createBuffer({ size: rowBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture, origin: { x: 0, y: Math.floor(texture.height / 2) } }, { buffer, bytesPerRow: rowBytes }, [texture.width, 1])
    device.queue.submit([encoder.finish()])
    const scale = texture.width / 1280
    readings.push(
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        const half = new Uint16Array(buffer.getMappedRange())
        // Green channel at the middle of each block.
        const blocks = Array.from({ length: 10 }, (_, b) => halfToFloat(half[Math.floor((128 * b + 64) * scale) * 4 + 1]!))
        buffer.destroy()
        return { j: Math.round(timeline / frame), blocks }
      })
    )
  }
  player.recording = []
  await player.play(1, 0)
  const started = performance.now()
  while (player.playing && performance.now() - started < 20_000) await new Promise((resolve) => setTimeout(resolve, 50))
  const dropped = player.stats.dropped
  player.stop()
  const presented = player.recording.length
  player.recording = null
  player.probe = null
  const results = await Promise.all(readings)

  const regions = REGIONS.map((r) => ({ name: r.name, checked: 0, right: 0, late: 0, wrong: 0, examples: [] as string[] }))
  const dissolve = { checked: 0, mixed: 0 }
  for (const { j, blocks } of results) {
    if (j >= 213 && j < 238) {
      // Only the middle of the dissolve is clearly a mix of both pictures.
      if (j < 218 || j > 232) continue
      dissolve.checked++
      if (blocks.some((v) => v > 0.15 && v < 0.85)) dissolve.mixed++
      continue
    }
    const index = REGIONS.findIndex((r) => j >= r.from && j < r.to)
    if (index < 0) continue
    const region = REGIONS[index]!
    const stats = regions[index]!
    const shown = blocks.reduce((n, v, b) => n + (v > 0.5 ? 1 << b : 0), 0)
    stats.checked++
    if (shown === region.expected(j)) stats.right++
    else {
      // A frame this region showed a moment ago (decoding fell behind) is late, not wrong.
      let late = false
      for (let back = 1; back <= 6 && j - back >= region.from; back++) if (region.expected(j - back) === shown) late = true
      if (late) stats.late++
      else stats.wrong++
      if (stats.examples.length < 4) stats.examples.push(`frame ${j}: showed ${shown}, expected ${region.expected(j)}`)
    }
  }
  const reasons: string[] = []
  for (const r of regions) {
    if (r.checked === 0) reasons.push(`${r.name}: no frames were checked`)
    if (r.wrong > 0) reasons.push(`${r.name}: ${r.wrong} frames showed the wrong picture`)
    if (r.late > r.checked * 0.05) reasons.push(`${r.name}: ${r.late} of ${r.checked} frames were late`)
  }
  if (dissolve.checked === 0 || dissolve.mixed < dissolve.checked * 0.8) reasons.push(`cross-dissolve: only ${dissolve.mixed} of ${dissolve.checked} frames showed a mix`)
  if (presented < 275 * 0.9) reasons.push(`only ${presented} of 275 frames were presented`)
  return { verdict: reasons.length === 0 ? 'pass' : 'fail', reasons, presented, regions, dissolve, dropped }
}

/** The speed-test timeline: forwards, reversed, 200%, hold, reversed 200%, cross-dissolve (see speed-test.ts). */
export function buildSpeedTimeline(): boolean {
  const project = projectController.project
  const item = project?.media.find((m) => m.name === 'framecode_h264')
  if (!project || !item) return false
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const s = secondsToTicks
  const place = (at: number, inS: number, outS: number) => {
    projectController.dispatch(placeMedia({ mediaId: item.id, sourceIn: s(inS), sourceOut: s(outS), at: s(at), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
    const clips = projectController.project!.sequence.clips
    return clips.find((c) => c.trackId === v1 && c.start === s(at))!.id
  }
  const media = () => projectController.project!.media
  place(0, 0, 2)
  projectController.dispatch(setClipSpeed({ clipIds: [place(2, 2, 4)], speed: 1, reverse: true, ripple: false }, media()))
  projectController.dispatch(setClipSpeed({ clipIds: [place(4, 4, 8)], speed: 2, reverse: false, ripple: false }, media()))
  projectController.dispatch(addFrameHold([place(6, 9, 10)], s(6)))
  // 4 s of media at 200% reversed fills 7–9 s; the next clip starts at 9 s.
  projectController.dispatch(setClipSpeed({ clipIds: [place(7, 8, 12)], speed: 2, reverse: true, ripple: false }, media()))
  place(9, 0, 2)
  projectController.dispatch(addCrossDissolveAt(v1, s(9), s(1)))
  return true
}

