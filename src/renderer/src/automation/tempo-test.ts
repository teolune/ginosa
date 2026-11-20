import type { ExportSettings } from '@engine/export/export-settings'
import { secondsToTicks, ticksPerFrame, FRAME_RATES, type Ticks } from '@engine/time'
import { setAutomationPoints } from '@engine/timeline/automation-edits'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { placeMedia, setClipProperties, trimClips } from '@engine/timeline/edits'
import { addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { addLink } from '@engine/timeline/modulation-edits'
import { POSTERIZE_RATES } from '@engine/timeline/posterize'
import { addRackRows, replaceRackSections, STARTER_ROWS } from '@engine/timeline/rack-edits'
import { modulationController } from '../audio/modulation-controller'
import { halfToFloat } from '../audio/modulation-test'
import { getGpu } from '../gpu/shared'
import { AudioEngine } from '../playback/audio-engine'
import { exporter } from '../playback/exporter'
import { player } from '../playback/player'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { automationUi } from './automation-ui'

/**
 * W2.3 "done when": a ramp from 120 to 140 BPM keeps the metronome, the cubes and Posterize Time
 * on the beat, in playback and export. Made the way you would: Automate BPM at 4 s, the tempo
 * clip's curve drawn up from 120 to 140 over 6 s, then held. Under it the frame-numbered clip with
 * Posterize Time at 1/4 on an adjustment layer, and a white square whose Opacity follows a Kick
 * channel with a cube on every beat. The beats are worked out here by hand (120 BPM, then a
 * straight ramp: 8 + 2(t − 4) + (t − 4)²/36 beats), not with the engine's functions; the export's
 * every frame is read back (its number, and the square), playback's frames are compared with the
 * file's, and the metronome's clicks with the beats.
 */

const s = secondsToTicks
const FPS = 25
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const FRAMES = 250
/** The frame-numbered clip's ten blocks across row 540; frames under 256 never light the last two, so the square sits on the last. */
const XS = Array.from({ length: 10 }, (_, b) => Math.floor((128 * b + 64) * 1.5))
const SQUARE = 9
const number = (row: number[][]) => row.slice(0, 8).reduce((n, rgb, b) => n + (rgb[1]! > 0.5 ? 1 << b : 0), 0)
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The beat at t seconds and the time of beat n, by hand. */
function beatOf(t: number): number {
  if (t <= 4) return 2 * t
  if (t <= 10) return 8 + 2 * (t - 4) + (t - 4) ** 2 / 36
  return 21 + ((t - 10) * 140) / 60
}
function timeOf(beat: number): number {
  if (beat <= 8) return beat / 2
  if (beat <= 21) return 4 - 36 + Math.sqrt(36 * 36 + 36 * (beat - 8))
  return 10 + ((beat - 21) * 60) / 140
}

export async function tempoAutomationTest(): Promise<Record<string, unknown>> {
  const reasons: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) reasons.push(what)
  }
  const sequence = () => projectController.project!.sequence
  const [v1, v2, v3] = sequence().tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string, string]
  const code = projectController.project!.media.find((m) => m.name === 'framecode_h264')
  const square = projectController.project!.media.find((m) => m.name === 'square_1080')
  if (!code || !square) throw new Error('framecode_h264 or square_1080 is missing (npm run test-media)')
  projectController.dispatch(setBeatGrid({ bpm: 120, downbeat: 0, beatsPerBar: 4 }))

  // The frame-numbered clip, and Posterize Time at 1/4 on the beat grid over it.
  projectController.dispatch(placeMedia({ mediaId: code.id, sourceIn: 0, sourceOut: s(10), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  timelineController.newAdjustmentLayer(v2, 0)
  const layerId = sequence().clips.find((c) => c.adjustment)!.id
  projectController.dispatch(trimClips({ clipIds: [layerId], edge: 'out', delta: s(10) - sequence().clips.find((c) => c.id === layerId)!.duration }))
  projectController.dispatch(addEffect([layerId], 'posterize-time'))
  const posterize = sequence().clips.find((c) => c.id === layerId)!.effects[0]!.id
  projectController.dispatch(setEffectValues(layerId, posterize, { params: { rate: POSTERIZE_RATES.findIndex((r) => r.id === '1/4'), tempo: 'grid', phase: 0, swing: 0, sample: 'start' } }))

  // The square, above the layer on the last block, dark until the Kick channel's cubes flash it.
  projectController.dispatch(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: s(10), at: 0, videoTrackId: v3, audioTrackId: null, mode: 'overwrite' }))
  const squareId = sequence().clips.find((c) => c.mediaId === square.id)!.id
  // At 10% the square's frame (1920 × 1080 with the square in its middle) is 192 px wide: the last block, no more.
  projectController.dispatch(setClipProperties([squareId], { opacity: 0, motion: { positionX: XS[SQUARE]!, positionY: 540, scale: 10 } }))
  const rows = addRackRows([STARTER_ROWS[0]!])
  projectController.dispatch(rows)
  const kick = rows.rowIds[0]!
  const everyBeat = Array.from({ length: 16 }, (_, i) => i * 4)
  projectController.dispatch(replaceRackSections([0, 1, 2].map(() => ({ bars: 4, cubes: { [kick]: everyBeat } })), 'Cubes on every beat'))
  const kickModulator = sequence().rack.rows.find((r) => r.id === kick)!.modulatorId!
  projectController.dispatch(addLink({ clipId: squareId, effectId: null, param: 'opacity' }, kickModulator, 0, { mode: 'add', min: [0], max: [100] }))

  // Automate BPM at 4 s, as the button does; its curve up from 120 to 140 over 6 s, then held.
  timelineController.setPlayhead(s(4))
  const tempoId = timelineController.newTempoClip()
  if (!tempoId) throw new Error(`Automate BPM failed: ${projectController.lastError}`)
  automationUi.open(tempoId)
  const tempo = () => sequence().clips.find((c) => c.id === tempoId)!
  check(tempo().automation?.tempo !== undefined && Math.abs(tempo().start - s(4)) < FRAME, 'the tempo clip isn’t at 4 s')
  const { min, max } = tempo().automation!.tempo!
  const v = (bpm: number) => (bpm - min) / (max - min)
  projectController.dispatch(
    setAutomationPoints(tempoId, [
      { time: 0, value: v(120), shape: 'single', tension: 0 },
      { time: s(6), value: v(140), shape: 'hold', tension: 0 }
    ])
  )
  modulationController.refresh()
  await wait(300)

  // Expected, by hand: Posterize Time's updates on each beat's nearest frame; the square's flashes on the frame at or after each beat.
  const updates: number[] = []
  for (let k = 0; timeOf(k) * FPS < FRAMES + 30; k++) updates.push(Math.round(timeOf(k) * FPS))
  const shown = (j: number) => updates.filter((u) => u <= j).pop() ?? 0
  const flashes: number[] = []
  for (let n = 1; timeOf(n) * FPS < FRAMES; n++) flashes.push(Math.ceil(timeOf(n) * FPS - 1e-9))

  // Export, every frame read back.
  const settings: ExportSettings = { format: 'h264', container: 'mp4', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('tempo-ramp.mp4'))!
  if (!(await exporter.run(projectController.project!, settings, path))) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : 'export failed')
  const file = (await window.ginosa.snapshot.analyseExport(path, XS))!.rows
  check(file.length === FRAMES, `${file.length} frames exported, expected ${FRAMES}`)
  const wrong: string[] = []
  let held = 0
  for (let j = 0; j < Math.min(FRAMES, file.length); j++) {
    if (number(file[j]!) === shown(j)) held++
    else if (wrong.length < 4) wrong.push(`frame ${j}: holds ${number(file[j]!)}, expected ${shown(j)}`)
  }
  check(held === FRAMES, `Posterize Time held the right frame on ${held} of ${FRAMES} frames (${wrong.join('; ')})`)
  const level = (row: number[][]) => row[SQUARE]![1]!
  const jumps = file.flatMap((row, j) => (j > 0 && level(row) - level(file[j - 1]!) > 0.3 ? [j] : []))
  check(JSON.stringify(jumps) === JSON.stringify(flashes), `the square flashed on frames ${jumps.join(' ')}; the beats are on ${flashes.join(' ')}`)
  // The ramp shows: holds get shorter (12 or 13 frames at 120 BPM, 10 or 11 at 140).
  const lengths = updates.slice(1).map((u, i) => u - updates[i]!)

  // Playback with the metronome on: every presented frame against the file's, every click against the beats.
  player.audio ??= new AudioEngine()
  player.audio.logging = true
  player.audio.clickLog.length = 0
  player.setMetronome(true)
  const { device } = await getGpu()
  player.setResolution(1)
  const readings: Array<Promise<{ j: number; row: number[][] }>> = []
  player.probe = (texture, timeline: Ticks) => {
    const j = Math.round(timeline / FRAME)
    if (j < 0 || j >= FRAMES || texture.width !== 1920) return
    const bytesPerRow = Math.ceil((texture.width * 8) / 256) * 256
    const buffer = device.createBuffer({ size: bytesPerRow, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture, origin: { x: 0, y: 540 } }, { buffer, bytesPerRow }, [texture.width, 1])
    device.queue.submit([encoder.finish()])
    readings.push(
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        const half = new Uint16Array(buffer.getMappedRange())
        const row = XS.map((x) => [0, 1, 2].map((c) => halfToFloat(half[x * 4 + c]!)))
        buffer.destroy()
        return { j, row }
      })
    )
  }
  timelineController.setPlayhead(0)
  await player.play(1, 0)
  const started = performance.now()
  while (player.playing && timelineController.playhead < s(9.9) && performance.now() - started < 15_000) await wait(40)
  player.stop()
  player.probe = null
  player.setMetronome(false)
  const clicks = [...player.audio.clickLog]
  player.audio.logging = false
  const played = await Promise.all(readings)
  let same = 0
  const playWrong: string[] = []
  for (const { j, row } of played) {
    const f = file[j]
    if (!f) continue
    if (number(row) === number(f) && Math.abs(level(row) - level(f)) < 0.05) same++
    else if (playWrong.length < 4) playWrong.push(`frame ${j}: plays ${number(row)} / ${level(row).toFixed(2)}, the file has ${number(f)} / ${level(f).toFixed(2)}`)
  }
  const compared = new Set(played.map((p) => p.j)).size
  check(compared >= FRAMES * 0.9, `playback presented only ${compared} of ${FRAMES} frames`)
  check(same === played.length, `playback differs from the file on ${played.length - same} frames (${playWrong.join('; ')})`)
  const clickErrors = clicks.map((c) => Math.abs(c.time / s(1) - timeOf(Math.round(beatOf(c.time / s(1))))))
  const worstClickMs = clickErrors.length ? Math.max(...clickErrors) * 1000 : Infinity
  const clickBeats = clicks.map((c) => Math.round(beatOf(c.time / s(1))))
  const expectedBeats = Array.from({ length: Math.floor(beatOf(9.9)) + 1 }, (_, n) => n)
  check(expectedBeats.every((n) => clickBeats.includes(n)), `the metronome clicked on beats ${clickBeats.join(' ')}`)
  check(worstClickMs < 0.05, `a click was ${worstClickMs.toFixed(3)} ms off its beat`)
  check(clicks.filter((c) => c.bar).every((c) => Math.round(beatOf(c.time / s(1))) % 4 === 0), 'a bar click wasn’t on a bar')

  timelineController.select([tempoId], 'replace')
  timelineController.setPlayhead(s(7))
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    posterize: { held, of: FRAMES, holdLengths: lengths.slice(0, 22) },
    cubes: { flashes: jumps.length, expected: flashes.length, first: jumps.slice(0, 12) },
    playback: { framesCompared: compared, same, of: played.length },
    metronome: { clicks: clicks.length, worstMs: Math.round(worstClickMs * 1000) / 1000, beats: clickBeats.slice(0, 24) }
  }
}
