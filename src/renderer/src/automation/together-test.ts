import type { ExportSettings } from '@engine/export/export-settings'
import { resolveClip } from '@engine/keyframes/properties'
import { secondsToTicks, ticksPerFrame, FRAME_RATES, type Ticks } from '@engine/time'
import { linkToAutomation, setAutomationPoints } from '@engine/timeline/automation-edits'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { placeMedia, setClipProperties } from '@engine/timeline/edits'
import { addLink, linksTo } from '@engine/timeline/modulation-edits'
import { addRackRows, replaceRackSections, STARTER_ROWS } from '@engine/timeline/rack-edits'
import { modulationController } from '../audio/modulation-controller'
import { edges, halfToFloat, ROW_Y, XS } from '../audio/modulation-test'
import { getGpu } from '../gpu/shared'
import { AudioEngine } from '../playback/audio-engine'
import { exporter } from '../playback/exporter'
import { player } from '../playback/player'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { automationUi } from './automation-ui'

/**
 * W2.4 "done when": one automation clip moves the tempo and an effect, and that plays and exports
 * alike. Made as you would: Automate BPM at the start, then + Pick a value… › the square's Scale,
 * so one clip sets both; its curve rises over 6 s (120 → 140 BPM, Scale 100% → 133%), then holds.
 * The square also flashes on a Kick channel's cube on every beat. Worked out here by hand: the
 * beats (2t + t²/36 through the ramp) and the Scale; read back from every exported frame (the
 * square's width and its flashes), from every frame real-time playback shows, and from the
 * metronome's clicks.
 */

const s = secondsToTicks
const FPS = 25
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const FRAMES = 250
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const beatOf = (t: number) => (t <= 6 ? 2 * t + (t * t) / 36 : 13 + ((t - 6) * 140) / 60)
const timeOf = (b: number) => (b <= 13 ? -36 + Math.sqrt(1296 + 36 * b) : 6 + ((b - 13) * 60) / 140)
const scaleOf = (t: number) => 100 + (100 / 3) * (Math.min(t, 6) / 6)

export async function automationTogetherTest(): Promise<Record<string, unknown>> {
  const reasons: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) reasons.push(what)
  }
  const sequence = () => projectController.project!.sequence
  const v1 = sequence().tracks.find((t) => t.kind === 'video')!.id
  const square = projectController.project!.media.find((m) => m.name === 'square_1080')
  if (!square) throw new Error('square_1080 is missing (npm run test-media)')
  projectController.dispatch(setBeatGrid({ bpm: 120, downbeat: 0, beatsPerBar: 4 }))
  projectController.dispatch(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: s(10), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const squareId = sequence().clips.find((c) => c.mediaId === square.id)!.id
  // Its brightness: 30%, and up to 100% on each beat from a Kick channel with a cube on every beat.
  projectController.dispatch(setClipProperties([squareId], { opacity: 30 }))
  const rows = addRackRows([STARTER_ROWS[0]!])
  projectController.dispatch(rows)
  const kick = rows.rowIds[0]!
  projectController.dispatch(replaceRackSections([0, 1, 2, 3].map(() => ({ bars: 4, cubes: { [kick]: Array.from({ length: 16 }, (_, i) => i * 4) } })), 'Cubes on every beat'))
  projectController.dispatch(addLink({ clipId: squareId, effectId: null, param: 'opacity' }, sequence().rack.rows[0]!.modulatorId!, 0, { mode: 'add', min: [0], max: [70] }))

  // One clip for both: Automate BPM at the start, then the square's Scale picked in its editor.
  timelineController.setPlayhead(0)
  const clipId = timelineController.newTempoClip()
  if (!clipId) throw new Error(`Automate BPM failed: ${projectController.lastError}`)
  automationUi.open(clipId)
  check(projectController.dispatch(linkToAutomation({ clipId: squareId, effectId: null, param: 'scale' }, clipId)), `picking Scale failed: ${projectController.lastError}`)
  const auto = () => sequence().clips.find((c) => c.id === clipId)!
  const { min, max } = auto().automation!.tempo!
  const v = (bpm: number) => (bpm - min) / (max - min)
  projectController.dispatch(
    setAutomationPoints(clipId, [
      { time: 0, value: v(120), shape: 'single', tension: 0 },
      { time: s(6), value: v(140), shape: 'hold', tension: 0 }
    ])
  )
  const scaleLink = linksTo(sequence(), auto().automation!.modulatorId).find((l) => l.ref.param === 'scale')?.link
  check(scaleLink?.mode === 'replace' && scaleLink.min[0] === 0 && scaleLink.max[0] === 200, `Scale's link: ${JSON.stringify(scaleLink)}`)
  check(min === 60 && max === 180, `the tempo clip's range is ${min}–${max} BPM`)
  modulationController.refresh()
  await wait(300)

  // Export: every frame's square against the Scale and the beats worked out by hand.
  const settings: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('automation-together.mov'))!
  if (!(await exporter.run(projectController.project!, settings, path))) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : 'export failed')
  const file = (await window.ginosa.snapshot.analyseExport(path, XS))!.rows
  check(file.length === FRAMES, `${file.length} frames exported, expected ${FRAMES}`)
  let widthWorst = 0
  const levels: number[] = []
  const examples: string[] = []
  for (let j = 0; j < file.length; j++) {
    const got = edges(file[j]!)
    if (!got) {
      widthWorst = Infinity
      if (examples.length < 4) examples.push(`frame ${j}: no square`)
      levels.push(0)
      continue
    }
    const want = 2 * scaleOf(j / FPS)
    const error = Math.abs(got.right - got.left - want)
    if (error > 1.5 && examples.length < 4) examples.push(`frame ${j}: ${(got.right - got.left).toFixed(1)} px wide, Scale says ${want.toFixed(1)}`)
    widthWorst = Math.max(widthWorst, error)
    levels.push(got.level)
  }
  check(widthWorst <= 1.5, `the square's width is up to ${widthWorst.toFixed(2)} px from the Scale by hand (${examples.join('; ')})`)
  const flashes = levels.flatMap((l, j) => (j > 0 && l - levels[j - 1]! > 0.3 ? [j] : []))
  const beats: number[] = []
  for (let n = 1; timeOf(n) * FPS < FRAMES; n++) beats.push(Math.ceil(timeOf(n) * FPS - 1e-9))
  check(JSON.stringify(flashes) === JSON.stringify(beats), `the square flashed on frames ${flashes.join(' ')}; the beats by hand are on ${beats.join(' ')}`)
  // The values export used, against the hand: Scale at a few moments.
  const modulation = exporter.lastModulation!
  const usedScale = [0, 3, 6, 9].map((t) => Math.round(resolveClip(sequence().clips.find((c) => c.id === squareId)!, s(t), modulation).motion.scale * 100) / 100)

  // Real-time playback with the metronome: every frame against the file's, every click against the beats.
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
          return sum.map((value) => value / 12)
        })
        buffer.destroy()
        return { j, row }
      })
    )
  }
  await player.play(1, 0)
  const started = performance.now()
  while (player.playing && timelineController.playhead < s(9.92) && performance.now() - started < 15_000) await wait(40)
  player.stop()
  player.probe = null
  player.setMetronome(false)
  const clicks = [...player.audio.clickLog]
  player.audio.logging = false
  const played = await Promise.all(readings)
  let worst = 0
  let points = 0
  for (const { j, row } of played) {
    const f = file[j]
    if (!f) continue
    for (let i = 1; i < XS.length - 1; i++) {
      const flat = [row[i - 1]!, row[i + 1]!].every((p) => p.every((value, c) => Math.abs(value - row[i]![c]!) < 0.02))
      if (!flat) continue
      points++
      worst = Math.max(worst, ...row[i]!.map((value, c) => Math.abs(value - f[i]![c]!)))
    }
  }
  const compared = new Set(played.map((p) => p.j)).size
  check(compared >= FRAMES * 0.9, `playback presented only ${compared} of ${FRAMES} frames`)
  check(worst <= 0.006, `playback and export differ by up to ${worst.toFixed(4)} (limit 0.006)`)
  const clickBeats = clicks.map((c) => Math.round(beatOf(c.time / s(1))))
  const worstClickMs = clicks.length ? Math.max(...clicks.map((c) => Math.abs(c.time / s(1) - timeOf(Math.round(beatOf(c.time / s(1))))))) * 1000 : Infinity
  check(Array.from({ length: Math.floor(beatOf(9.9)) + 1 }, (_, n) => n).every((n) => clickBeats.includes(n)), `the metronome clicked on beats ${clickBeats.join(' ')}`)
  check(worstClickMs < 0.05, `a click was ${worstClickMs.toFixed(3)} ms off its beat`)

  // For the screenshot: the clip in its editor, the playhead in the ramp.
  timelineController.select([clipId], 'replace')
  timelineController.setPlayhead(s(4.5))
  automationUi.select([1])
  await wait(300)
  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    controls: ['tempo', ...linksTo(sequence(), auto().automation!.modulatorId).map((l) => l.ref.param)],
    exportVsHand: { frames: file.length, worstWidthPx: Math.round(widthWorst * 100) / 100, flashes: flashes.length, beats: beats.length, scaleAt0369: usedScale },
    playbackVsExport: { framesCompared: compared, points, worst: Math.round(worst * 10000) / 10000 },
    metronome: { clicks: clicks.length, worstMs: Math.round(worstClickMs * 1000) / 1000 }
  }
}
