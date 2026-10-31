import { appleLogToRec709 } from '@engine/colour/colour'
import type { ExportFormat, ExportSettings } from '@engine/export/export-settings'
import { effectiveColour } from '@engine/project/media'
import { secondsToTicks } from '@engine/time'
import { placeMedia, setClipProperties, trimClips } from '@engine/timeline/edits'
import { addEffect, moveEffect, setEffectEnabled, setEffectValues } from '@engine/timeline/effect-edits'
import { invertReference } from '../../../effects/invert/reference'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { readPixels } from './colour-probe'
import { exporter } from './exporter'
import { player } from './player'
import { REGIONS } from './speed-test'

/**
 * M5 "done when": exported files are read back with FFmpeg and checked against what
 * ginosa showed: picture/sound sync, colour values and tags, and every frame of the
 * speed/reverse/hold/dissolve timeline.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function exportTo(name: string, settings: ExportSettings) {
  const path = (await window.ginosa.snapshot.exportPath(name))!
  const result = await exporter.run(projectController.project!, settings, path)
  const state = exporter.state
  if (!result) throw new Error(state.kind === 'failed' ? state.error : `export ${state.kind}`)
  return { path, result, seconds: state.kind === 'done' ? state.seconds : 0, fps: state.kind === 'done' ? Math.round(state.fps * 10) / 10 : 0 }
}

const settingsFor = (format: ExportFormat): ExportSettings => ({
  format,
  container: format.startsWith('prores') ? 'mov' : format === 'hevc10' ? 'mov' : 'mp4',
  bitrateMbps: 40,
  keyframeSeconds: 1
})

/** Flash-and-beep: every flash frame against the beep nearest to it, in the file. */
export async function exportSyncTest() {
  const item = projectController.project!.media.find((m) => m.name === 'sync_flash_beep')!
  const tracks = projectController.project!.sequence.tracks
  projectController.dispatch(placeMedia({ mediaId: item.id, sourceIn: 0, sourceOut: null, at: 0, videoTrackId: tracks.find((t) => t.kind === 'video')!.id, audioTrackId: tracks.find((t) => t.kind === 'audio')!.id, mode: 'overwrite' }))
  const out = await exportTo('sync.mp4', settingsFor('h264'))
  const a = (await window.ginosa.snapshot.analyseExport(out.path, [960]))!
  const flashes = a.rows.flatMap((row, i) => (row[0]![0]! > 0.5 ? [a.videoStart + i / a.fps] : []))
  const beeps = a.onsets.map((t) => a.audioStart + t)
  const offsets = flashes.map((f) => {
    const nearest = beeps.reduce((best, b) => (Math.abs(b - f) < Math.abs(best - f) ? b : best), Number.POSITIVE_INFINITY)
    return Math.round((nearest - f) * 1000 * 100) / 100
  })
  const wrongFlashFrames = a.rows.filter((row, i) => (row[0]![0]! > 0.5) !== (i % 25 === 0)).length
  const worst = Math.max(...offsets.map(Math.abs))
  const reasons: string[] = []
  if (flashes.length !== 10) reasons.push(`expected 10 flashes, found ${flashes.length}`)
  if (beeps.length !== 10) reasons.push(`expected 10 beeps, found ${beeps.length}`)
  if (wrongFlashFrames > 0) reasons.push(`${wrongFlashFrames} frames had the flash in the wrong place`)
  if (!(worst <= 20)) reasons.push(`sound and picture are ${worst} ms apart (limit: half a frame, 20 ms)`)
  if (a.rows.length !== 250) reasons.push(`expected 250 frames, found ${a.rows.length}`)
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, frames: a.rows.length, offsetsMs: offsets, worstMs: worst, videoStart: a.videoStart, audioStart: a.audioStart, tags: a.tags, exportFps: out.fps, size: out.result.size }
}

/** Colour patches: the decoded file against the composite ginosa showed, for each format. */
export async function exportColourTest() {
  const project = projectController.project!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const names = ['patches_rec709', 'patches_applelog']
  names.forEach((name, i) => {
    const item = project.media.find((m) => m.name === name)!
    projectController.dispatch(placeMedia({ mediaId: item.id, sourceIn: 0, sourceOut: secondsToTicks(2), at: secondsToTicks(i * 2), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  })
  const xs = [192, 576, 960, 1344, 1728]
  // What the Program monitor showed at 0.48 s (frame 12) and 2.48 s (frame 62).
  const frames = [12, 62]
  const shown: number[][][] = []
  for (const f of frames) {
    timelineController.setPlayhead(secondsToTicks(f / 25))
    await wait(1200)
    shown.push(player.lastStill ? await readPixels(player.lastStill, xs.map((x) => [x, 540] as [number, number])) : [])
  }
  const patches: Array<[number, number, number]> = [[0.2, 0.2, 0.2], [0.502, 0.502, 0.502], [0.6, 0.251, 0.149], [0.149, 0.451, 0.702], [0.949, 0.949, 0.949]]
  const formats: ExportFormat[] = ['h264', 'hevc10', 'prores-422hq', 'prores-4444']
  const report: Record<string, unknown> = {
    expectedFromMaths: names.map((name) => {
      const item = project.media.find((m) => m.name === name)!
      return patches.map((p) => (effectiveColour(item) === 'apple-log' ? appleLogToRec709(p, 'bt2020') : p).map((v) => Math.round(v * 1000) / 1000))
    }),
    shown
  }
  const reasons: string[] = []
  for (const format of formats) {
    const out = await exportTo(`colour-${format}.${settingsFor(format).container}`, settingsFor(format))
    const a = (await window.ginosa.snapshot.analyseExport(out.path, xs))!
    const got = frames.map((f) => a.rows[f]!)
    const error = Math.max(...got.flatMap((row, fi) => row.flatMap((rgb, xi) => rgb.map((v, c) => Math.abs(v - shown[fi]![xi]![c]!)))))
    // 8-bit steps are 1/219; 10-bit 1/876. Dither averages out over the 12 pixels read.
    const limit = format === 'h264' ? 0.006 : 0.003
    if (!(error <= limit)) reasons.push(`${format}: off by ${error.toFixed(4)} from the preview (limit ${limit})`)
    const tagsOk = a.tags.primaries === 'bt709' && a.tags.transfer === 'bt709' && a.tags.matrix === 'bt709' && a.tags.range === 'tv'
    if (!tagsOk) reasons.push(`${format}: colour tags ${JSON.stringify(a.tags)}`)
    report[format] = { worstError: Math.round(error * 10000) / 10000, tags: a.tags, codec: out.result.info?.video?.codec, profile: out.result.info?.video?.profile, pixelFormat: out.result.info?.video?.pixelFormat, got, exportFps: out.fps, size: out.result.size }
  }
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, ...report }
}

/** The speed timeline: every exported frame's number, read from the file. */
export async function exportSpeedTest(build: () => boolean) {
  if (!build()) throw new Error('framecode_h264 is missing (npm run test-media)')
  const xs = Array.from({ length: 10 }, (_, b) => Math.floor((128 * b + 64) * 1.5))
  const results: Record<string, unknown> = {}
  const reasons: string[] = []
  for (const format of ['h264', 'prores-422hq'] as ExportFormat[]) {
    const out = await exportTo(`speed-${format}.${settingsFor(format).container}`, settingsFor(format))
    const a = (await window.ginosa.snapshot.analyseExport(out.path, xs))!
    const regions = REGIONS.map((r) => ({ name: r.name, checked: 0, right: 0, examples: [] as string[] }))
    a.rows.forEach((row, j) => {
      const index = REGIONS.findIndex((r) => j >= r.from && j < r.to)
      if (index < 0) return
      const shown = row.reduce((n, rgb, b) => n + (rgb[1]! > 0.5 ? 1 << b : 0), 0)
      const region = regions[index]!
      region.checked++
      if (shown === REGIONS[index]!.expected(j)) region.right++
      else if (region.examples.length < 3) region.examples.push(`frame ${j}: ${shown}, expected ${REGIONS[index]!.expected(j)}`)
    })
    const mixed = a.rows.slice(218, 233).filter((row) => row.some((rgb) => rgb[1]! > 0.15 && rgb[1]! < 0.85)).length
    for (const r of regions) if (r.right !== r.checked || r.checked === 0) reasons.push(`${format} ${r.name}: ${r.right} of ${r.checked} right`)
    if (mixed !== 15) reasons.push(`${format} dissolve: ${mixed} of 15 frames mixed`)
    if (a.rows.length !== 275) reasons.push(`${format}: ${a.rows.length} frames, expected 275`)
    results[format] = { frames: a.rows.length, regions, dissolveMixed: mixed, exportFps: out.fps, seconds: Math.round(out.seconds * 10) / 10, size: out.result.size }
  }
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, ...results }
}

/**
 * M6 "done when": Invert on an adjustment layer over five clips, reordered and toggled,
 * exports correctly. Each state is checked twice against the CPU maths applied to what the
 * five clips show without the layer: in the preview, and in the exported file.
 */
export async function exportEffectsTest() {
  const project = projectController.project!
  const v1 = project.sequence.tracks.filter((t) => t.kind === 'video')[0]!.id
  const v2 = project.sequence.tracks.filter((t) => t.kind === 'video')[1]!.id
  const names = ['patches_rec709', 'patches_applelog', 'patches_applelog2', 'sync_flash_beep', 'framecode_h264']
  names.forEach((name, i) => {
    const item = project.media.find((m) => m.name === name)
    if (!item) throw new Error(`${name} is missing (npm run test-media)`)
    projectController.dispatch(placeMedia({ mediaId: item.id, sourceIn: 0, sourceOut: secondsToTicks(1), at: secondsToTicks(i), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  })
  const xs = [192, 576, 960, 1344, 1728]
  const frames = names.map((_, i) => i * 25 + 12)
  const readFrame = async (f: number) => {
    timelineController.setPlayhead(secondsToTicks(f / 25))
    await wait(900)
    return player.lastStill ? await readPixels(player.lastStill, xs.map((x) => [x, 540] as [number, number])) : []
  }
  const underneath: number[][][] = []
  for (const f of frames) underneath.push(await readFrame(f))

  timelineController.newAdjustmentLayer(v2, 0)
  const layerId = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  projectController.dispatch(trimClips({ clipIds: [layerId], edge: 'out', delta: secondsToTicks(5) - projectController.project!.sequence.clips.find((c) => c.id === layerId)!.duration }))
  projectController.dispatch(addEffect([layerId], 'invert'))
  projectController.dispatch(addEffect([layerId], 'invert'))
  const layer = () => projectController.project!.sequence.clips.find((c) => c.id === layerId)!
  const [first, second] = layer().effects.map((e) => e.id) as [string, string]
  projectController.dispatch(setEffectValues(layerId, first, { params: { channel: 'red' } }))
  projectController.dispatch(setEffectValues(layerId, second, { params: { channel: 'luminance' } }))

  // The stack as the CPU sees it, top to bottom.
  const expectedFor = () =>
    underneath.map((points) =>
      points.map((p) =>
        layer().effects.reduce<[number, number, number]>((c, e) => (e.enabled ? invertReference(c, { amount: Number(e.params['amount']), channel: String(e.params['channel']), space: String(e.params['space']) }) : c), [p[0]!, p[1]!, p[2]!])
      )
    )
  const states: Array<{ name: string; prepare: () => void }> = [
    { name: 'red → luminance', prepare: () => undefined },
    { name: 'reordered: luminance → red', prepare: () => projectController.dispatch(moveEffect(layerId, second, 0)) },
    { name: 'toggled: red off', prepare: () => projectController.dispatch(setEffectEnabled(layerId, first, false)) },
    { name: 'layer at 50% opacity', prepare: () => projectController.dispatch(setClipProperties([layerId], { opacity: 50 })) }
  ]
  const reasons: string[] = []
  const results: Record<string, unknown> = {}
  for (const state of states) {
    state.prepare()
    let expected = expectedFor()
    if (layer().opacity !== 100) {
      const t = layer().opacity / 100
      expected = expected.map((points, fi) => points.map((c, xi) => c.map((v, k) => underneath[fi]![xi]![k]! + (v - underneath[fi]![xi]![k]!) * t) as [number, number, number]))
    }
    const preview: number[][][] = []
    for (const f of frames) preview.push(await readFrame(f))
    const out = await exportTo(`effects-${states.indexOf(state)}.mov`, settingsFor('hevc10'))
    const a = (await window.ginosa.snapshot.analyseExport(out.path, xs))!
    const exported = frames.map((f) => a.rows[f]!)
    const error = (got: number[][][]) => Math.max(...got.flatMap((points, fi) => points.flatMap((p, xi) => p.map((v, k) => Math.abs(v - expected[fi]![xi]![k]!)))))
    const previewError = error(preview)
    const exportError = error(exported)
    // The preview is 16-bit float; the file is 10-bit, so allow a couple of its steps.
    if (!(previewError <= 0.004)) reasons.push(`${state.name}: preview off by ${previewError.toFixed(4)}`)
    if (!(exportError <= 0.006)) reasons.push(`${state.name}: export off by ${exportError.toFixed(4)}`)
    results[state.name] = { stack: layer().effects.map((e) => `${e.params['channel']}${e.enabled ? '' : ' (off)'}`), opacity: layer().opacity, previewError: Math.round(previewError * 10000) / 10000, exportError: Math.round(exportError * 10000) / 10000, exportFps: out.fps }
  }
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, clips: names, results }
}
