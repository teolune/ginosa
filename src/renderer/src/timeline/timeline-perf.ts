import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { addAdjustmentLayer, addEffect } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { player } from '../playback/player'
import { drawStats } from './draw'
import { timelineController as tl } from './timeline-controller'

/**
 * How the timeline copes (and what it costs everything else): a 4-minute song cut into
 * clips with 40 video clips over it and Datamosh on an adjustment layer, Effect Controls and
 * the Keyframe Editor open. A pinch-zoom (one zoom step a frame), a two-finger scroll and the
 * playhead moving a frame at a time (as in playback), each timed by the frames it takes:
 * the time between animation frames (the screen's own rate when nothing's slow), the
 * timeline's drawing time, and how many times the Program monitor rendered meanwhile.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (v: number) => Math.round(v * 100) / 100

function summary(intervals: number[]) {
  const sorted = [...intervals].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { frames: intervals.length, meanMs: round(intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length)), medianMs: round(at(0.5)), p95Ms: round(at(0.95)), worstMs: round(sorted.at(-1) ?? 0) }
}

/** Runs `step` once a frame, `count` times; the frame intervals, the drawing and the monitor's renders meanwhile. */
async function measure(count: number, step: (i: number) => void) {
  // Let what came before (a paused frame of 4K footage, say) finish first.
  await wait(1200)
  await nextFrame()
  const draws = drawStats.count
  const drawMs = drawStats.totalMs
  const stills = player.stillCount
  const times: number[] = []
  let work = 0
  let last = await nextFrame()
  for (let i = 0; i < count; i++) {
    // The work the step sets off at once: React re-rendering what listens, the timeline's drawing.
    const started = performance.now()
    step(i)
    for (let k = 0; k < 3; k++) await new Promise<void>((resolve) => queueMicrotask(resolve))
    work += performance.now() - started
    const now = await nextFrame()
    times.push(now - last)
    last = now
  }
  await wait(300)
  const drawn = drawStats.count - draws
  const slowest = times.indexOf(Math.max(...times))
  return { ...summary(times), slowestFrame: slowest, workMsEach: round(work / count), timelineDraws: drawn, drawMsEach: round((drawStats.totalMs - drawMs) / Math.max(1, drawn)), monitorRenders: player.stillCount - stills }
}

export async function timelinePerf(footage: string[] = []) {
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
  }
  const project = projectController.project!
  const song = project.media.find((m) => m.name === 'beat_128bpm')
  const clip = project.media.find((m) => m.name === 'testsrc_1080p24_h264')
  if (!song || !clip) throw new Error('beat_128bpm or testsrc_1080p24_h264 is missing (npm run test-media)')
  // With your footage (4K Apple Log HEVC), the clips alternate between those instead.
  const shots = footage.length ? project.media.filter((m) => footage.includes(m.name)) : [clip]
  for (let i = 0; i < 600 && !shots.every((m) => mediaController.playablePath(m)); i++) await wait(500)
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const [a1] = project.sequence.tracks.filter((t) => t.kind === 'audio').map((t) => t.id) as [string]
  // Eight 30-second pieces of the song (4 minutes), 40 six-second clips over them.
  for (let i = 0; i < 8; i++) run(placeMedia({ mediaId: song.id, sourceIn: 0, sourceOut: s(30), at: s(30 * i), videoTrackId: null, audioTrackId: a1, mode: 'overwrite' }))
  for (let i = 0; i < 40; i++) run(placeMedia({ mediaId: shots[i % shots.length]!.id, sourceIn: s((i % 4) * 0.5), sourceOut: s((i % 4) * 0.5 + 6), at: s(6 * i), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  run(addAdjustmentLayer({ trackId: v2, start: s(12), duration: s(60) }))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  run(addEffect([layer], 'datamosh'))
  workspaceController.open('effect-controls')
  workspaceController.open('keyframe-editor')
  tl.select([layer], 'replace')
  // Thumbnails and the waveform.
  for (let i = 0; i < 40 && !mediaController.get(song.id).waveform; i++) await wait(250)
  await wait(1500)
  tl.zoomToFit()
  tl.setPlayhead(s(20))
  await wait(1500)

  const width = tl.viewportWidth
  const idle = await measure(60, () => undefined)
  const zoomSteps: number[] = []
  const zoomIn = await measure(120, (i) => {
    tl.zoom(1.06, width / 2)
    zoomSteps.push(round(tl.view.pps))
  })
  const pinchedTo = round(tl.view.pps)
  const zoomOut = await measure(120, () => tl.zoom(1 / 1.06, width / 2))
  const scroll = await measure(120, () => tl.scrollBy(12, 0, 0))
  tl.zoomToFit()
  await wait(500)
  const start = tl.playhead
  const playhead = await measure(120, (i) => tl.setPlayhead(start + (i + 1) * FRAME))
  // Drawing alone at several zooms (the canvas, no React), 20 times each.
  const drawing: Record<string, number> = {}
  for (const pps of [5, 50, 500, 2400]) {
    tl.view = { pps, scroll: 20 }
    const before = drawStats.totalMs
    const count = drawStats.count
    for (let i = 0; i < 20; i++) {
      tl.scrollBy(0.5, 0, 0)
      await nextFrame()
    }
    drawing[`${pps} px/s`] = round((drawStats.totalMs - before) / Math.max(1, drawStats.count - count))
  }
  tl.zoomToFit()
  // Playback for 4 seconds: over plain clips (80 s on), then under the Datamosh layer (20 s on).
  const playFor = async (from: number) => {
    tl.setPlayhead(s(from))
    await wait(1500)
    await player.play(1, s(from))
    await wait(4000)
    const stats = { ...player.stats }
    player.stop()
    await wait(500)
    return { fps: round(stats.fps), dropped: stats.dropped, renderMs: round(stats.renderMs) }
  }
  const playback = { plain: await playFor(80), datamosh: await playFor(20) }
  return { verdict: 'pass', playback, zoomSteps, footage: shots.map((m) => m.name), screenHz: round(1000 / idle.medianMs), idle, pinchedTo, zoomIn, zoomOut, scroll, playhead, drawMsAtZoom: drawing }
}

/** The song on the timeline at a zoom (pixels a second), from `from` seconds, for a screenshot of its waveform. */
export async function waveformAt(pps: number, from: number) {
  const project = projectController.project!
  const song = project.media.find((m) => m.name === 'beat_128bpm')
  if (!song) throw new Error('beat_128bpm is missing (npm run test-media)')
  const [a1] = project.sequence.tracks.filter((t) => t.kind === 'audio').map((t) => t.id) as [string]
  projectController.dispatch(placeMedia({ mediaId: song.id, sourceIn: 0, sourceOut: s(30), at: 0, videoTrackId: null, audioTrackId: a1, mode: 'overwrite' }))
  for (let i = 0; i < 40 && !mediaController.get(song.id).waveform; i++) await wait(250)
  const wave = mediaController.get(song.id).waveform
  tl.view = { pps, scroll: from }
  tl.viewChanged()
  await wait(800)
  return { verdict: wave ? 'pass' : 'fail', levels: wave?.levels.map((l) => l.rate), seconds: wave?.duration, pps, from }
}
