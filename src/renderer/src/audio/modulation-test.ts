import { resolveClip } from '@engine/keyframes/properties'
import type { ExportSettings } from '@engine/export/export-settings'
import { secondsToTicks, ticksPerFrame, FRAME_RATES, type Ticks } from '@engine/time'
import { addAudioSource } from '@engine/timeline/audio-edits'
import { placeMedia } from '@engine/timeline/edits'
import { linkToAudio, updateLink } from '@engine/timeline/modulation-edits'
import { getGpu } from '../gpu/shared'
import { exporter } from '../playback/exporter'
import { player } from '../playback/player'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { analysisController } from './analysis-controller'
import { modulationController } from './modulation-controller'

/**
 * M8 "done when": one source drives three parameters, and the export matches playback
 * frame for frame. "Song" (the 128 BPM drums) drives a white square: its Bass level the
 * Scale, its Loudness the Opacity, its High hits the Rotation. It's exported (ProRes 4444)
 * and played back in real time; every frame playback presented is compared with the same
 * frame of the file, and every exported frame's square is measured against the modulated
 * values (edges for Scale and Rotation, brightness for Opacity).
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const XS = Array.from({ length: 960 }, (_, i) => i * 2)
const ROW_Y = 538

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exponent = (h >> 10) & 0x1f
  const fraction = h & 0x3ff
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024)
  if (exponent === 31) return fraction ? NaN : sign * Infinity
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024)
}

function edges(row: number[][]): { left: number; right: number; level: number } | null {
  const g = row.map((rgb) => rgb[1]!)
  const level = Math.max(...g)
  if (!(level > 0.1)) return null
  const thr = level / 2
  const first = g.findIndex((v) => v >= thr)
  let last = g.length - 1
  while (last > 0 && g[last]! < thr) last--
  if (first <= 0 || last >= g.length - 1) return null
  const cross = (i: number, j: number) => XS[i]! + ((thr - g[i]!) / (g[j]! - g[i]!)) * (XS[j]! - XS[i]!)
  const mid = g.slice(first + 4, last - 3)
  return { left: cross(first - 1, first) + 0.5, right: cross(last, last + 1) + 0.5, level: mid.length ? mid.reduce((a, b) => a + b, 0) / mid.length : level }
}

export async function modulationTest() {
  const project = projectController.project!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const a1 = project.sequence.tracks.find((t) => t.kind === 'audio')!.id
  const item = (name: string) => {
    const found = projectController.project!.media.find((m) => m.name === name)
    if (!found) throw new Error(`${name} is missing (npm run test-media)`)
    return found
  }
  projectController.dispatch(placeMedia({ mediaId: item('square_1080').id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  projectController.dispatch(placeMedia({ mediaId: item('beat_128bpm').id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: null, audioTrackId: a1, mode: 'overwrite' }))
  const square = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  const added = addAudioSource('track', a1, 'Song')
  projectController.dispatch(added)
  analysisController.useDetectedTempo(added.sourceId)
  const link = (param: string, signal: 'level' | 'loudness' | 'hits', band: 'bass' | 'high') => {
    if (!projectController.dispatch(linkToAudio({ clipId: square, effectId: null, param }, added.sourceId, signal, band, s(1)))) throw new Error(`Link to Audio on ${param} failed: ${projectController.lastError}`)
  }
  link('scale', 'level', 'bass')
  link('opacity', 'loudness', 'bass')
  link('rotation', 'hits', 'high')
  // Bigger moves than the defaults, so they're easy to see and measure.
  const clip = () => projectController.project!.sequence.clips.find((c) => c.id === square)!
  projectController.dispatch(updateLink({ clipId: square, effectId: null, param: 'scale' }, clip().modulation['scale']![0]!.id, { max: [40] }))
  projectController.dispatch(updateLink({ clipId: square, effectId: null, param: 'rotation' }, clip().modulation['rotation']![0]!.id, { max: [20] }))
  await analysisController.settle()
  modulationController.refresh()
  const reasons: string[] = []
  const mods = projectController.project!.sequence.modulators
  if (mods.length !== 3) reasons.push(`expected 3 modulators from one source, found ${mods.length}`)
  if (!mods.every((m) => m.source.kind === 'audio' && m.source.sourceId === added.sourceId)) reasons.push('not every modulator listens to the one source')

  // Export.
  const settings: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('modulation.mov'))!
  const result = await exporter.run(projectController.project!, settings, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  const a = (await window.ginosa.snapshot.analyseExport(path, XS))!
  const frames = a.rows.length
  if (frames !== 200) reasons.push(`expected 200 frames, found ${frames}`)
  const modulation = exporter.lastModulation!

  // Every exported frame's square against the modulated values.
  let edgeWorst = 0
  let levelWorst = 0
  const examples: string[] = []
  const scales: number[] = []
  let rotated = 0
  for (let j = 0; j < frames; j++) {
    const resolved = resolveClip(clip(), j * FRAME, modulation)
    const scale = resolved.motion.scale / 100
    const rotation = (resolved.motion.rotation * Math.PI) / 180
    scales.push(resolved.motion.scale)
    if (resolved.motion.rotation > 1) rotated++
    const half = (100 * scale) / Math.cos(rotation)
    const want = { left: resolved.motion.positionX - half, right: resolved.motion.positionX + half, level: resolved.opacity / 100 }
    const got = edges(a.rows[j]!)
    if (!got) {
      edgeWorst = Infinity
      if (examples.length < 4) examples.push(`frame ${j}: no square`)
      continue
    }
    const e = Math.max(Math.abs(got.left - want.left), Math.abs(got.right - want.right))
    const l = Math.abs(got.level - want.level)
    if ((e > 1.5 || l > 0.006) && examples.length < 4) examples.push(`frame ${j}: edges ${got.left.toFixed(1)}–${got.right.toFixed(1)} vs ${want.left.toFixed(1)}–${want.right.toFixed(1)}, level ${got.level.toFixed(3)} vs ${want.level.toFixed(3)}`)
    edgeWorst = Math.max(edgeWorst, e)
    levelWorst = Math.max(levelWorst, l)
  }
  if (!(edgeWorst <= 1.5)) reasons.push(`square edges up to ${edgeWorst.toFixed(2)} px from the modulated Scale and Rotation`)
  if (!(levelWorst <= 0.006)) reasons.push(`square brightness up to ${levelWorst.toFixed(4)} from the modulated Opacity`)
  const scaleRange = Math.max(...scales) - Math.min(...scales)
  if (scaleRange < 10) reasons.push(`Scale only moved ${scaleRange.toFixed(1)}: the bass isn't driving it`)
  if (rotated < 10) reasons.push(`Rotation moved in only ${rotated} frames: the hits aren't driving it`)

  // Real-time playback, compared frame for frame with the file.
  const { device } = await getGpu()
  player.setResolution(1)
  const readings: Array<Promise<{ j: number; row: number[][] }>> = []
  player.probe = (texture, timeline: Ticks) => {
    const j = Math.round(timeline / FRAME)
    if (j < 0 || j >= frames || texture.width !== 1920) return
    const bytesPerRow = Math.ceil((texture.width * 8) / 256) * 256
    const buffer = device.createBuffer({ size: bytesPerRow * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture, origin: { x: 0, y: ROW_Y } }, { buffer, bytesPerRow }, [texture.width, 4])
    device.queue.submit([encoder.finish()])
    readings.push(
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        const half = new Uint16Array(buffer.getMappedRange())
        const perRow = bytesPerRow / 2
        const row = XS.map((x) => {
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
  while (player.playing && timelineController.playhead < s(7.96) && performance.now() - started < 15_000) await new Promise((r) => setTimeout(r, 40))
  player.stop()
  player.recording = null
  player.probe = null
  const played = await Promise.all(readings)
  let worst = 0
  let points = 0
  for (const { j, row } of played) {
    const file = a.rows[j]
    if (!file) continue
    for (let i = 1; i < XS.length - 1; i++) {
      // Flat stretches only: at an edge a 3 × 4 box straddles it and 10-bit rounding moves the mean.
      const flat = [row[i - 1]!, row[i + 1]!].every((p) => p.every((v, c) => Math.abs(v - row[i]![c]!) < 0.02))
      if (!flat) continue
      points++
      worst = Math.max(worst, ...row[i]!.map((v, c) => Math.abs(v - file[i]![c]!)))
    }
  }
  const compared = new Set(played.map((p) => p.j)).size
  if (compared < frames * 0.9) reasons.push(`playback presented only ${compared} of ${frames} frames`)
  if (!(worst <= 0.006)) reasons.push(`playback and export differ by up to ${worst.toFixed(4)} (limit 0.006)`)
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    modulators: mods.map((m) => m.name),
    grid: projectController.project!.sequence.beatGrid,
    exportVsValues: { frames, worstEdgePx: Math.round(edgeWorst * 100) / 100, worstLevel: Math.round(levelWorst * 10000) / 10000, scaleRange: Math.round(scaleRange * 10) / 10, rotatedFrames: rotated, examples },
    playbackVsExport: { framesCompared: compared, points, worst: Math.round(worst * 10000) / 10000 }
  }
}
