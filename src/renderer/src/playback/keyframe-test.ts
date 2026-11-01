import { evaluate, type InterpolationPreset } from '@engine/keyframes/keyframes'
import type { PropertyRef } from '@engine/keyframes/properties'
import type { ExportSettings } from '@engine/export/export-settings'
import { FRAME_RATES, secondsToTicks, ticksPerFrame, ticksToSeconds, type Ticks } from '@engine/time'
import { placeMedia, trimClips } from '@engine/timeline/edits'
import { addEffect } from '@engine/timeline/effect-edits'
import { setAnimated, setKeyframeInterpolation, setValue } from '@engine/timeline/keyframe-edits'
import { dbToGain } from '@engine/timeline/render-plan'
import { getGpu } from '../gpu/shared'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { readRowBoxes } from './colour-probe'
import { exporter } from './exporter'
import { player } from './player'

/**
 * M7 "done when": any parameter animates identically in preview and export.
 *
 * The timeline animates every kind of value, through the same commands the user's clicks
 * send: Position (bezier eases), Scale, Rotation and Opacity (with a hold) on a white
 * square; a speed ramp (eased, then linear) on the frame-numbered clip; effect parameters,
 * a choice, Mix and Transform's point on the colour patches, under an adjustment layer whose
 * Opacity is keyframed; and Volume on a 1 kHz tone. It exports as ProRes 4444 (no chroma
 * subsampling, PCM sound) and is checked four ways:
 *   1. the preview against the file, value for value, on the middle row of sampled frames;
 *   2. the square's edges and brightness in every exported frame against the keyframed
 *      Position, Scale, Rotation and Opacity;
 *   3. the frame number shown in every frame of the ramp, in the file and in real-time
 *      playback, against the ramp integrated here independently (Simpson's rule);
 *   4. the exported sound level against the Volume keyframes, in 10 ms windows.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const ROW_Y = 538
const XS = Array.from({ length: 960 }, (_, i) => i * 2)
const BLOCK_XS = Array.from({ length: 10 }, (_, b) => Math.floor((128 * b + 64) * 1.5))

interface Built {
  square: string
  ramp: string
  patches: string
  layer: string
  tone: string
}

export function buildKeyframeTimeline(): Built {
  const project = projectController.project!
  const video = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id)
  const audio = project.sequence.tracks.find((t) => t.kind === 'audio')!.id
  const item = (name: string) => {
    const found = projectController.project!.media.find((m) => m.name === name)
    if (!found) throw new Error(`${name} is missing (npm run test-media)`)
    return found
  }
  const place = (name: string, at: number, length: number, trackId: string | null, audioTrackId: string | null = null) => {
    projectController.dispatch(placeMedia({ mediaId: item(name).id, sourceIn: 0, sourceOut: s(length), at: s(at), videoTrackId: trackId, audioTrackId, mode: 'overwrite' }))
    return projectController.project!.sequence.clips.find((c) => c.trackId === (trackId ?? audioTrackId) && c.start === s(at))!.id
  }
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} did nothing${projectController.lastError ? `: ${projectController.lastError}` : ''}`)
  }
  /** Animates a value: keys are [seconds from the clip's start, value]; presets go on keyframe indexes. */
  const animate = (clipId: string, effectId: string | null, param: string, keys: Array<[number, unknown]>, presets: Array<[number, InterpolationPreset]> = []) => {
    const clip = () => projectController.project!.sequence.clips.find((c) => c.id === clipId)!
    const ref: PropertyRef = { clipId, effectId, param }
    run(setAnimated(ref, true, clip().start + s(keys[0]![0])))
    for (const [at, value] of keys) projectController.dispatch(setValue(ref, value as never, clip().start + s(at)))
    for (const [index, preset] of presets) {
      const c = clip()
      const map = effectId ? c.effects.find((e) => e.id === effectId)!.keyframes : c.keyframes
      run(setKeyframeInterpolation([{ ...ref, keyframeId: map[param]![index]!.id }], preset))
    }
  }
  const last = 3.96
  const square = place('square_1080', 0, 4, video[0]!)
  animate(square, null, 'position', [[0, [960, 540]], [2, [1400, 540]], [last, [700, 540]]], [[0, 'ease-out'], [1, 'ease-in-out']])
  animate(square, null, 'scale', [[0, 100], [last, 150]])
  animate(square, null, 'rotation', [[0, 0], [last, 30]], [[0, 'ease-out']])
  animate(square, null, 'opacity', [[0, 100], [1, 100], [2, 60], [last, 30]], [[1, 'hold'], [2, 'ease-out']])

  const ramp = place('framecode_h264', 4, 4, video[0]!)
  animate(ramp, null, 'speed', [[0, 100], [2, 300], [3, 50], [last, 50]], [[0, 'ease-out'], [1, 'ease-in']])

  const patches = place('patches_rec709', 8, 2, video[0]!)
  run(addEffect([patches], 'invert'))
  run(addEffect([patches], 'transform'))
  const [invert, transform] = projectController.project!.sequence.clips.find((c) => c.id === patches)!.effects.map((e) => e.id) as [string, string]
  animate(patches, invert, 'amount', [[0, 0], [1.96, 100]])
  animate(patches, invert, 'channel', [[0, 'rgb'], [1, 'luminance']])
  animate(patches, invert, 'mix', [[0, 100], [1.96, 40]], [[0, 'ease-in-out'], [1, 'ease-in-out']])
  animate(patches, transform, 'position', [[0, [640, 360]], [1.96, [800, 360]]], [[0, 'ease-out']])
  animate(patches, transform, 'scale', [[0, 100], [1.96, 80]])
  timelineController.newAdjustmentLayer(video[1]!, s(8))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  run(trimClips({ clipIds: [layer], edge: 'out', delta: s(2) - projectController.project!.sequence.clips.find((c) => c.id === layer)!.duration }))
  run(addEffect([layer], 'invert'))
  const layerInvert = projectController.project!.sequence.clips.find((c) => c.id === layer)!.effects[0]!.id
  projectController.dispatch(setValue({ clipId: layer, effectId: layerInvert, param: 'channel' }, 'red', s(8)))
  animate(layer, null, 'opacity', [[0, 0], [1.96, 100]])

  const tone = place('tone_1khz', 0, 8, null, audio)
  animate(tone, null, 'volume', [[0, 0], [2, -20], [4, -20], [6, -6], [7.96, -40]], [[0, 'ease-out'], [1, 'ease-in'], [4, 'ease-in']])
  return { square, ramp, patches, layer, tone }
}

/** The ramp's media time `t` ticks into the clip, by Simpson's rule on the speed curve (independent of the engine's exact integral). */
function rampMediaTime(t: Ticks): number {
  const clip = projectController.project!.sequence.clips.find((c) => c.keyframes['speed'])!
  const track = clip.keyframes['speed']!
  const n = 4000
  const h = t / n
  let sum = 0
  for (let i = 0; i <= n; i++) sum += (Number(evaluate(track, i * h, 100)) / 100) * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2)
  return clip.sourceIn + (sum * h) / 3
}

/** The frame number the ramp should show at timeline frame j (100–199), or null right on a frame boundary. */
function rampExpected(j: number): number | null {
  const media = rampMediaTime((j - 100) * FRAME) / FRAME
  if (Math.abs(media - Math.round(media)) < 1e-4) return null
  return Math.floor(media)
}

/** The square's expected edges and brightness at timeline frame j (0–99). */
function squareExpected(j: number) {
  const clip = projectController.project!.sequence.clips.find((c) => c.name === 'square_1080')!
  const t = j * FRAME
  const k = clip.keyframes
  const position = evaluate(k['position']!, t, [960, 540]) as [number, number]
  const scale = Number(evaluate(k['scale']!, t, 100)) / 100
  const rotation = (Number(evaluate(k['rotation']!, t, 0)) * Math.PI) / 180
  const opacity = Number(evaluate(k['opacity']!, t, 100)) / 100
  const half = (100 * scale) / Math.cos(rotation)
  return { left: position[0] - half, right: position[0] + half, level: opacity }
}

/** Where a row of green values crosses half its peak, rising and falling, with sub-pixel interpolation. */
function edges(row: number[][]): { left: number; right: number; level: number } | null {
  const g = row.map((rgb) => rgb[1]!)
  const level = Math.max(...g)
  if (!(level > 0.1)) return null
  const thr = level / 2
  const first = g.findIndex((v) => v >= thr)
  let lastIndex = g.length - 1
  while (lastIndex > 0 && g[lastIndex]! < thr) lastIndex--
  if (first <= 0 || lastIndex >= g.length - 1) return null
  const cross = (i: number, j: number) => XS[i]! + ((thr - g[i]!) / (g[j]! - g[i]!)) * (XS[j]! - XS[i]!)
  // The middle of the plateau, away from the edges, is the square's brightness.
  const mid = g.slice(first + 4, lastIndex - 3)
  return { left: cross(first - 1, first) + 0.5, right: cross(lastIndex, lastIndex + 1) + 0.5, level: mid.length > 0 ? mid.reduce((a, b) => a + b, 0) / mid.length : level }
}

function blocksToNumber(row: number[][]): number {
  return row.reduce((n, rgb, b) => n + (rgb[1]! > 0.5 ? 1 << b : 0), 0)
}

async function previewRow(frame: number, xs: number[]): Promise<number[][]> {
  timelineController.setPlayhead(frame * FRAME)
  await wait(900)
  if (!player.lastStill) throw new Error('the Program monitor showed nothing')
  return readRowBoxes(player.lastStill, xs, ROW_Y)
}

/** Real-time playback of the ramp: the frame number in every presented frame. */
async function playRamp(): Promise<{ checked: number; right: number; late: number; wrong: number; examples: string[]; presented: number }> {
  const { device } = await getGpu()
  const readings: Array<Promise<{ j: number; shown: number }>> = []
  player.probe = (texture, timeline: Ticks) => {
    const j = Math.round(timeline / FRAME)
    if (j < 100 || j >= 200) return
    const rowBytes = Math.ceil((texture.width * 8) / 256) * 256
    const buffer = device.createBuffer({ size: rowBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture, origin: { x: 0, y: Math.floor(texture.height / 2) } }, { buffer, bytesPerRow: rowBytes }, [texture.width, 1])
    device.queue.submit([encoder.finish()])
    const scale = texture.width / 1280
    readings.push(
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        const half = new Uint16Array(buffer.getMappedRange())
        const shown = Array.from({ length: 10 }, (_, b) => half[Math.floor((128 * b + 64) * scale) * 4 + 1]!).reduce((n, h, b) => n + ((h & 0x7fff) > 0x3800 ? 1 << b : 0), 0)
        buffer.destroy()
        return { j, shown }
      })
    )
  }
  player.recording = []
  await player.play(1, s(3.5))
  const started = performance.now()
  while (player.playing && timelineController.playhead < s(8.2) && performance.now() - started < 12_000) await wait(40)
  player.stop()
  const presented = player.recording?.length ?? 0
  player.recording = null
  player.probe = null
  const results = await Promise.all(readings)
  const stats = { checked: 0, right: 0, late: 0, wrong: 0, examples: [] as string[], presented }
  for (const { j, shown } of results) {
    const expected = rampExpected(j)
    if (expected === null) continue
    stats.checked++
    if (shown === expected) stats.right++
    else {
      let late = false
      for (let back = 1; back <= 6 && j - back >= 100; back++) if (rampExpected(j - back) === shown) late = true
      if (late) stats.late++
      else stats.wrong++
      if (stats.examples.length < 4) stats.examples.push(`frame ${j}: showed ${shown}, expected ${expected}`)
    }
  }
  return stats
}

export async function exportKeyframesTest() {
  const built = buildKeyframeTimeline()
  const reasons: string[] = []
  const report: Record<string, unknown> = {}

  // 1. Preview frames (the paused Program monitor), sampled across every animated stretch.
  const sampled = [0, 12, 30, 49, 50, 62, 75, 99, 100, 125, 150, 175, 199, 200, 212, 225, 237, 249]
  const preview = new Map<number, number[][]>()
  for (const f of sampled) preview.set(f, await previewRow(f, XS))
  const blockPreview = new Map<number, number>()
  for (const f of [100, 125, 150, 175, 199]) blockPreview.set(f, blocksToNumber((await previewRow(f, BLOCK_XS)).map((p) => p)))

  // Export (ProRes 4444: no chroma subsampling, uncompressed sound).
  const settings: ExportSettings = { format: 'prores-4444', container: 'mov', bitrateMbps: 40, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('keyframes.mov'))!
  const started = performance.now()
  const result = await exporter.run(projectController.project!, settings, path)
  if (!result) throw new Error(exporter.state.kind === 'failed' ? exporter.state.error : `export ${exporter.state.kind}`)
  const exportSeconds = (performance.now() - started) / 1000
  const a = (await window.ginosa.snapshot.analyseExport(path, XS))!
  const b = (await window.ginosa.snapshot.analyseExport(path, BLOCK_XS))!
  if (a.rows.length !== 250) reasons.push(`expected 250 frames, found ${a.rows.length}`)

  // 1. Preview against the file, where the picture is flat enough that a 3 × 4 box means the same in both.
  let worst = 0
  let compared = 0
  let changed = 0
  for (const f of sampled) {
    const shown = preview.get(f)!
    const file = a.rows[f]
    if (!file) continue
    for (let i = 1; i < XS.length - 1; i++) {
      const flat = [shown[i - 1]!, shown[i]!, shown[i + 1]!].every((p) => p.every((v, c) => Math.abs(v - shown[i]![c]!) < 0.02))
      if (!flat) continue
      compared++
      worst = Math.max(worst, ...shown[i]!.map((v, c) => Math.abs(v - file[i]![c]!)))
    }
  }
  for (const [x, y] of [[0, 99], [100, 199], [200, 249]] as const) {
    const d = Math.max(...a.rows[x]!.flatMap((p, i) => p.map((v, c) => Math.abs(v - a.rows[y]![i]![c]!))))
    if (d > 0.2) changed++
  }
  if (!(worst <= 0.006)) reasons.push(`preview and export differ by up to ${worst.toFixed(4)} (limit 0.006: two 10-bit steps)`)
  if (compared < 5000) reasons.push(`only ${compared} points could be compared`)
  if (changed !== 3) reasons.push(`only ${changed} of 3 animated stretches changed between their first and last frames`)
  report['previewVsExport'] = { frames: sampled.length, points: compared, worst: Math.round(worst * 10000) / 10000 }

  // 2. The square: edges (Position, Scale, Rotation) and brightness (Opacity), every frame.
  let edgeWorst = 0
  let levelWorst = 0
  const edgeExamples: string[] = []
  const checkSquare = (row: number[][], j: number, where: string) => {
    const got = edges(row)
    const want = squareExpected(j)
    if (!got) {
      edgeWorst = Infinity
      edgeExamples.push(`${where} frame ${j}: no square found`)
      return
    }
    const e = Math.max(Math.abs(got.left - want.left), Math.abs(got.right - want.right))
    const l = Math.abs(got.level - want.level)
    if ((e > 1.5 || l > 0.006) && edgeExamples.length < 5) edgeExamples.push(`${where} frame ${j}: edges ${got.left.toFixed(1)}–${got.right.toFixed(1)} vs ${want.left.toFixed(1)}–${want.right.toFixed(1)}, level ${got.level.toFixed(3)} vs ${want.level.toFixed(3)}`)
    edgeWorst = Math.max(edgeWorst, e)
    levelWorst = Math.max(levelWorst, l)
  }
  for (let j = 0; j < 100; j++) checkSquare(a.rows[j]!, j, 'export')
  for (const f of sampled.filter((f) => f < 100)) checkSquare(preview.get(f)!, f, 'preview')
  if (!(edgeWorst <= 1.5)) reasons.push(`square edges off by up to ${edgeWorst.toFixed(2)} px from the keyframes (limit 1.5)`)
  if (!(levelWorst <= 0.006)) reasons.push(`square brightness off by up to ${levelWorst.toFixed(4)} from the Opacity keyframes`)
  report['square'] = { frames: 100, worstEdgePx: Math.round(edgeWorst * 100) / 100, worstLevel: Math.round(levelWorst * 10000) / 10000, examples: edgeExamples }

  // 3. The speed ramp: every exported frame's number, the preview's, and real-time playback.
  const ramp = { checked: 0, right: 0, examples: [] as string[] }
  for (let j = 100; j < 200; j++) {
    const expected = rampExpected(j)
    if (expected === null) continue
    ramp.checked++
    const shown = blocksToNumber(b.rows[j]!)
    if (shown === expected) ramp.right++
    else if (ramp.examples.length < 4) ramp.examples.push(`frame ${j}: ${shown}, expected ${expected}`)
  }
  for (const [f, shown] of blockPreview) {
    const expected = rampExpected(f)
    if (expected !== null && shown !== expected) reasons.push(`preview frame ${f} showed ${shown}, expected ${expected}`)
  }
  if (ramp.right !== ramp.checked || ramp.checked < 90) reasons.push(`speed ramp: ${ramp.right} of ${ramp.checked} exported frames right`)
  const playback = await playRamp()
  if (playback.wrong > 0) reasons.push(`speed ramp playback: ${playback.wrong} frames showed the wrong picture`)
  if (playback.checked < 80 || playback.late > playback.checked * 0.05) reasons.push(`speed ramp playback: ${playback.late} of ${playback.checked} frames late`)
  report['speedRamp'] = { export: ramp, playback, mediaUsedSeconds: Math.round(ticksToSeconds(rampMediaTime(4 * 25 * FRAME - FRAME)) * 1000) / 1000 }

  // 4. Volume keyframes: the file's level in 10 ms windows against the curve, relative to the start.
  const tone = projectController.project!.sequence.clips.find((c) => c.id === built.tone)!
  const track = tone.keyframes['volume']!
  const expectedDb = (w: number) => {
    let sum = 0
    for (let i = 0; i < 48; i++) {
      const g = dbToGain(Number(evaluate(track, s((w + (i + 0.5) / 48) * 0.01), 0)))
      sum += g * g
    }
    return 10 * Math.log10(sum / 48)
  }
  const env = a.envelope
  const reference = 2
  let volumeWorst = 0
  let windows = 0
  for (let w = 1; w < Math.min(env.length, 799); w++) {
    const want = expectedDb(w) - expectedDb(reference)
    if (want < -45) continue
    const got = 20 * Math.log10(env[w]! / env[reference]!)
    volumeWorst = Math.max(volumeWorst, Math.abs(got - want))
    windows++
  }
  if (windows < 700) reasons.push(`only ${windows} sound windows could be checked (the file has ${env.length})`)
  if (!(volumeWorst <= 0.1)) reasons.push(`sound level off by up to ${volumeWorst.toFixed(3)} dB from the Volume keyframes (limit 0.1)`)
  report['volume'] = { windows, worstDb: Math.round(volumeWorst * 1000) / 1000, at1s: Math.round(20 * Math.log10(env[100]! / env[reference]!) * 100) / 100, at3s: Math.round(20 * Math.log10(env[300]! / env[reference]!) * 100) / 100 }

  report['export'] = { seconds: Math.round(exportSeconds * 10) / 10, size: result.size, tags: a.tags }
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, ...report }
}

