import { resolveClip } from '@engine/keyframes/properties'
import type { ExportSettings } from '@engine/export/export-settings'
import { secondsToTicks, ticksPerFrame, FRAME_RATES, type Ticks } from '@engine/time'
import { linkToAutomation, setAutomationPoints } from '@engine/timeline/automation-edits'
import { placeMedia } from '@engine/timeline/edits'
import { edges, halfToFloat, ROW_Y, XS } from '../audio/modulation-test'
import { getGpu } from '../gpu/shared'
import { exporter } from '../playback/exporter'
import { player } from '../playback/player'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'

/**
 * W2.1 "done when": an automation clip moves values in playback and export alike. A white square
 * on V1; right-click Opacity › Create Automation Clip (as you would), its curve drawn (a curve up,
 * stairs, a hold), and Scale linked to the same clip (the drag's command). It's exported (ProRes
 * 4444) and played back in real time: every exported frame's square is measured against the
 * values the curve gives, and every frame playback presented is compared with the file's.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])

export async function automationTest() {
  const reasons: string[] = []
  const project = projectController.project!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const square = project.media.find((m) => m.name === 'square_1080')
  if (!square) throw new Error('square_1080 is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const squareId = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  // Right-click Opacity › Create Automation Clip, at the playhead (the start).
  timelineController.setPlayhead(0)
  timelineController.newAutomationClip({ clipId: squareId, effectId: null, param: 'opacity' })
  const auto = () => projectController.project!.sequence.clips.find((c) => c.kind === 'automation')
  if (!auto()) throw new Error(`Create Automation Clip failed: ${projectController.lastError}`)
  const clipId = auto()!.id
  const tracks = projectController.project!.sequence.tracks.filter((t) => t.kind === 'automation').length
  if (tracks !== 1) reasons.push(`expected 1 automation track, found ${tracks}`)
  if (!timelineController.selection.has(clipId)) reasons.push('the new automation clip isn’t selected')
  // Its curve: from 50% up a curve to 100% at 3 s, stairs down to 60% at 6 s, held, then 100% at the end
  // (the measurement needs the square at least half lit to find its edges).
  projectController.dispatch(
    setAutomationPoints(clipId, [
      { time: 0, value: 0.5, shape: 'single', tension: 0.6 },
      { time: s(3), value: 1, shape: 'stairs', tension: 0 },
      { time: s(6), value: 0.6, shape: 'hold', tension: 0 },
      { time: s(7.5), value: 1, shape: 'single', tension: 0 }
    ])
  )
  if (!projectController.dispatch(linkToAutomation({ clipId: squareId, effectId: null, param: 'scale' }, clipId))) reasons.push(`linking Scale failed: ${projectController.lastError}`)
  const clip = () => projectController.project!.sequence.clips.find((c) => c.id === squareId)!
  const links = { opacity: clip().modulation['opacity'] ?? [], scale: clip().modulation['scale'] ?? [] }
  if (links.opacity.length !== 1 || links.opacity[0]!.mode !== 'replace') reasons.push('Opacity isn’t set by the clip')
  if (links.scale.length !== 1) reasons.push('Scale isn’t linked to the clip')

  // Export.
  const settings: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('automation.mov'))!
  const result = await exporter.run(projectController.project!, settings, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  const a = (await window.ginosa.snapshot.analyseExport(path, XS))!
  const frames = a.rows.length
  if (frames !== 200) reasons.push(`expected 200 frames, found ${frames}`)
  const modulation = exporter.lastModulation!

  // Every exported frame's square against the values the curve gives.
  let edgeWorst = 0
  let levelWorst = 0
  const levels: number[] = []
  const examples: string[] = []
  for (let j = 0; j < frames; j++) {
    const resolved = resolveClip(clip(), j * FRAME, modulation)
    const half = 100 * (resolved.motion.scale / 100)
    const want = { left: resolved.motion.positionX - half, right: resolved.motion.positionX + half, level: resolved.opacity / 100 }
    levels.push(Math.round(resolved.opacity))
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
  if (!(edgeWorst <= 1.5)) reasons.push(`square edges up to ${edgeWorst.toFixed(2)} px from the curve's Scale`)
  if (!(levelWorst <= 0.006)) reasons.push(`square brightness up to ${levelWorst.toFixed(4)} from the curve's Opacity`)
  // The curve's shape, read back from the export: 50% at the start, 100% at 3 s, 4 stairs to 60%, held, then up.
  const at = (sec: number) => levels[Math.round(sec * 25)]!
  const shape = { start: at(0), at3: at(3.04), stairs: [at(3.4), at(4.2), at(4.9), at(5.6)], held: at(6.6), end: at(7.9) }
  if (shape.start !== 50 || shape.at3 < 95 || shape.held !== 60 || new Set(shape.stairs).size !== 4) reasons.push(`the exported Opacity doesn't follow the curve: ${JSON.stringify(shape)}`)

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
      const flat = [row[i - 1]!, row[i + 1]!].every((p) => p.every((v, c) => Math.abs(v - row[i]![c]!) < 0.02))
      if (!flat) continue
      points++
      worst = Math.max(worst, ...row[i]!.map((v, c) => Math.abs(v - file[i]![c]!)))
    }
  }
  const compared = new Set(played.map((p) => p.j)).size
  if (compared < frames * 0.9) reasons.push(`playback presented only ${compared} of ${frames} frames`)
  if (!(worst <= 0.006)) reasons.push(`playback and export differ by up to ${worst.toFixed(4)} (limit 0.006)`)
  timelineController.select([clipId], 'replace')
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    automationTracks: tracks,
    curveFromExport: shape,
    exportVsCurve: { frames, worstEdgePx: Math.round(edgeWorst * 100) / 100, worstLevel: Math.round(levelWorst * 10000) / 10000, examples },
    playbackVsExport: { framesCompared: compared, points, worst: Math.round(worst * 10000) / 10000 }
  }
}
