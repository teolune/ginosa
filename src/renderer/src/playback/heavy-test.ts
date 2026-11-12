import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { deleteClips, placeMedia } from '@engine/timeline/edits'
import { addAdjustmentLayer, addEffect, setEffectValues } from '@engine/timeline/effect-edits'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { addLink } from '@engine/timeline/modulation-edits'
import { addRackRows, replaceRackSections, setRackCubes, STARTER_ROWS } from '@engine/timeline/rack-edits'
import { modulationController } from '../audio/modulation-controller'
import type { ExportSettings } from '@engine/export/export-settings'
import { exporter } from './exporter'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { getGpu } from '../gpu/shared'
import { timelineController as tl } from '../timeline/timeline-controller'
import { renderMixdown } from './audio-mixdown'
import { player } from './player'
import { LayerBuilder } from './layers'
import { openFiles, openMedia, stillCacheBytes, STILL_CACHE_BYTES } from './sources'
import { exactHooks } from './exact-render'

/**
 * Heavy conditions (the code review of 12 Nov): what used to break once a project got big.
 * Uses media/heavy (npm run test-media): 14 tones, 24 large stills, a 12000 px panorama.
 */

const s = secondsToTicks
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (v: number) => Math.round(v * 1000) / 1000

function run(command: Parameters<typeof projectController.dispatch>[0]): void {
  if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
}

/** Level of `freq` in a stretch of interleaved stereo (Goertzel on the left channel), 0–1. */
function toneLevel(samples: Float32Array, rate: number, from: number, to: number, freq: number): number {
  const n = Math.max(1, Math.round((to - from) * rate))
  const k = (2 * Math.PI * freq) / rate
  const c = 2 * Math.cos(k)
  let s1 = 0
  let s2 = 0
  const start = Math.round(from * rate)
  for (let i = 0; i < n; i++) {
    const x = samples[(start + i) * 2] ?? 0
    const s0 = x + c * s1 - s2
    s2 = s1
    s1 = s0
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / (n / 2)
}

/**
 * 1. Sound from more files than ginosa keeps open (12): read at once, unheld, the oldest get
 * closed under their readers (what a mixdown did); held while read, every tone comes through.
 */
async function manyFiles(reasons: string[]): Promise<Record<string, unknown>> {
  const files = (await window.ginosa.snapshot.heavyMedia()).filter((f) => /tone_\d+\.wav$/.test(f))
  if (files.length < 14) throw new Error('media/heavy is missing its tones (npm run test-media)')
  await mediaController.importPaths(files, null)
  const project = projectController.project!
  const tones = files.map((f) => project.media.find((m) => m.path === f)!)
  // The hazard itself: 14 files opened without being held, then read together.
  let cancelled = 0
  const unheld = await Promise.all(files.map((f) => openMedia(f)))
  await Promise.all(
    unheld.map(async (m) => {
      try {
        for await (const piece of m.audioSink!.buffers(0, 1)) void piece
      } catch (error) {
        if (/disposed/i.test((error as Error).message)) cancelled++
      }
    })
  )
  // The mixdown export and analysis use: all 14 one after another on A1, read at once.
  const a1 = project.sequence.tracks.find((t) => t.kind === 'audio')!.id
  tones.forEach((m, i) => run(placeMedia({ mediaId: m.id, sourceIn: 0, sourceOut: s(3), at: s(3 * i), videoTrackId: null, audioTrackId: a1, mode: 'overwrite' })))
  const sequence = projectController.project!.sequence
  const rate = 48_000
  let error: string | null = null
  let levels: number[] = []
  const peakDuring = { open: 0, inUse: 0 }
  const watch = setInterval(() => {
    const now = openFiles()
    peakDuring.open = Math.max(peakDuring.open, now.open)
    peakDuring.inUse = Math.max(peakDuring.inUse, now.inUse)
  }, 5)
  try {
    const mix = await renderMixdown(sequence, projectController.project!.media, 0, s(42), rate, (item) => mediaController.playablePath(item))
    levels = tones.map((_, i) => round(toneLevel(mix, rate, 3 * i + 0.5, 3 * i + 2.5, 220 * (i + 1))))
  } catch (e) {
    error = (e as Error).message
  } finally {
    clearInterval(watch)
  }
  await wait(50)
  const after = openFiles()
  if (error) reasons.push(`mixdown failed: ${error}`)
  const quiet = levels.map((l, i) => [i + 1, l] as const).filter(([, l]) => l < 0.15)
  if (!error && quiet.length) reasons.push(`tones missing from the mixdown: ${quiet.map(([n]) => n).join(', ')}`)
  const stillHeld = after.held.filter((path) => files.includes(path))
  if (stillHeld.length) reasons.push(`${stillHeld.length} tones still held after the mixdown`)
  if (after.open > 12) reasons.push(`${after.open} files left open (limit 12)`)
  return { unheldReadsCancelled: cancelled, mixdownError: error, toneLevels: levels, peakDuring, after: { open: after.open, inUse: after.inUse, tonesHeld: stillHeld.length } }
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return sign * 2 ** -14 * (m / 1024)
  if (e === 31) return m ? NaN : sign * Infinity
  return sign * 2 ** (e - 15) * (1 + m / 1024)
}

/** One pixel of a 16-bit float picture, as RGB. */
async function pixel(device: GPUDevice, texture: GPUTexture, x: number, y: number): Promise<number[]> {
  const buffer = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer }, [1, 1])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const half = new Uint16Array(buffer.getMappedRange().slice(0))
  buffer.unmap()
  buffer.destroy()
  return [0, 1, 2].map((i) => round(halfToFloat(half[i]!)))
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 20) {
    if (test()) return true
    await wait(20)
  }
  return test()
}

/**
 * 2. The GPU device lost (here: destroyed, as when its memory runs out or it resets): the
 * monitor starts again on a new device with the same picture, paused and while playing.
 */
async function deviceLoss(reasons: string[]): Promise<Record<string, unknown>> {
  const files = (await window.ginosa.snapshot.testMedia()).filter((f) => /testsrc_1080p24_h264\.mp4$/.test(f))
  await mediaController.importPaths(files, null)
  const project = projectController.project!
  const clip = project.media.find((m) => m.name === 'testsrc_1080p24_h264')!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  run(placeMedia({ mediaId: clip.id, sourceIn: 0, sourceOut: s(8), at: s(50), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  tl.setPlayhead(s(52))
  await wait(50)
  await player.settled()
  const where = [960, 300] as const
  const before = await pixel((await getGpu()).device, player.lastStill!, ...where)
  // Paused.
  const resets = player.gpuResets
  ;(await getGpu()).device.destroy()
  const recovered = await until(() => player.gpuResets === resets + 1 && player.lastStill !== null, 5000)
  await wait(100)
  await player.settled()
  const after = player.lastStill ? await pixel((await getGpu()).device, player.lastStill, ...where) : null
  const message = projectController.lastError
  if (!recovered) reasons.push('the monitor never started again after the GPU device was lost')
  if (!after || after.some((v, i) => Math.abs(v - before[i]!) > 0.01)) reasons.push(`the picture differs after the reset: ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  if (!message?.includes('graphics card')) reasons.push('nothing said the graphics card was reset')
  // Playing.
  tl.setPlayhead(s(50.5))
  await wait(50)
  void player.play(1)
  await until(() => player.framesShown > 0 && player.playing, 3000)
  await wait(500)
  const shownBefore = player.framesShown
  ;(await getGpu()).device.destroy()
  await until(() => player.gpuResets === resets + 2, 5000)
  const carriedOn = await until(() => player.playing && player.framesShown > shownBefore + 20, 5000)
  player.stop()
  if (!carriedOn) reasons.push('playback did not carry on after the GPU device was lost')
  return { before, after, message, resets: player.gpuResets - resets, playbackCarriedOn: carriedOn }
}

/**
 * 3. A photo montage: 24 stills of 4000 × 3000 (1.15 GB on the GPU) stay within the caches'
 * budgets, a still let go of comes back the same, and a 12000 px panorama draws.
 */
async function stills(reasons: string[]): Promise<Record<string, unknown>> {
  const files = (await window.ginosa.snapshot.heavyMedia()).filter((f) => /(photo_\d+|panorama_12000)\.png$/.test(f))
  await mediaController.importPaths(files, null)
  const project = projectController.project!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const photos = files.filter((f) => /photo_/.test(f)).map((f) => project.media.find((m) => m.path === f)!)
  const panorama = project.media.find((m) => m.name === 'panorama_12000')!
  const start = 100
  photos.forEach((m, i) => run(placeMedia({ mediaId: m.id, sourceIn: 0, sourceOut: s(0.4), at: s(start + 0.4 * i), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' })))
  run(placeMedia({ mediaId: panorama.id, sourceIn: 0, sourceOut: s(1), at: s(130), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const show = async (seconds: number) => {
    tl.setPlayhead(s(seconds))
    await wait(30)
    await player.settled()
  }
  // Inside the photo (a 4:3 picture fitted to 16:9 starts at x = 240), off its white square.
  const at = [400, 540] as const
  let peakGpu = 0
  let peakDecoded = 0
  let first: number[] | null = null
  for (let i = 0; i < photos.length; i++) {
    await show(start + 0.4 * i + 0.1)
    if (i === 0) first = await pixel((await getGpu()).device, player.lastStill!, ...at)
    peakGpu = Math.max(peakGpu, player.stillBytes())
    peakDecoded = Math.max(peakDecoded, stillCacheBytes())
    await wait(120)
  }
  // Past the grace period, the next still trims both caches to their budgets.
  await wait(2200)
  await show(130.5)
  const panoramaCentre = await pixel((await getGpu()).device, player.lastStill!, 960, 540)
  const gpuAfter = player.stillBytes()
  const decodedAfter = stillCacheBytes()
  await wait(2200)
  await show(start + 0.1)
  const firstAgain = await pixel((await getGpu()).device, player.lastStill!, ...at)
  const limit = (await getGpu()).device.limits.maxTextureDimension2D
  const mb = (b: number) => Math.round(b / 1048576)
  if (gpuAfter > LayerBuilder.STILL_TEXTURE_BYTES) reasons.push(`${mb(gpuAfter)} MB of stills on the GPU (budget ${mb(LayerBuilder.STILL_TEXTURE_BYTES)})`)
  if (decodedAfter > STILL_CACHE_BYTES) reasons.push(`${mb(decodedAfter)} MB of decoded stills (budget ${mb(STILL_CACHE_BYTES)})`)
  if (!first || first.every((v) => v === 0)) reasons.push('the first photo drew black')
  if (!first || firstAgain.some((v, i) => Math.abs(v - first![i]!) > 0.002)) reasons.push(`the first photo came back different: ${JSON.stringify(first)} → ${JSON.stringify(firstAgain)}`)
  if (panoramaCentre.some((v) => v < 0.9)) reasons.push(`the 12000 px panorama didn't draw (centre ${JSON.stringify(panoramaCentre)})`)
  return { photos: photos.length, peakGpuMB: mb(peakGpu), peakDecodedMB: mb(peakDecoded), gpuAfterMB: mb(gpuAfter), decodedAfterMB: mb(decodedAfter), first, firstAgain, panoramaCentre, maxTextureDimension2D: limit }
}

/**
 * 4. Exporting 8 s of Datamosh at 1080p: export renders every frame in order, so each effect
 * needs only the state of the frame before; checkpoints (a state a second, 2 GB at most) are
 * never used there. Runs first, on an empty timeline, and leaves it empty.
 */
async function exportMemory(reasons: string[]): Promise<Record<string, unknown>> {
  const files = (await window.ginosa.snapshot.testMedia()).filter((f) => /testsrc_1080p24_h264\.mp4$/.test(f))
  await mediaController.importPaths(files, null)
  await wait(2500)
  const project = projectController.project!
  const footage = project.media.find((m) => m.name === 'testsrc_1080p24_h264')!
  const [v1, v2] = project.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  const seconds = 8
  run(placeMedia({ mediaId: footage.id, sourceIn: 0, sourceOut: s(seconds), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  run(addAdjustmentLayer({ trackId: v2, start: 0, duration: s(seconds) }))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  run(addEffect([layer], 'datamosh'))
  const settings: ExportSettings = { format: 'h264', container: 'mp4', bitrateMbps: 20, keyframeSeconds: 1 }
  const path = (await window.ginosa.snapshot.exportPath('heavy-mosh.mp4'))!
  const started = performance.now()
  const result = await exporter.run(projectController.project!, settings, path)
  const ms = Math.round(performance.now() - started)
  const { peakStateBytes, peakStates } = exporter.memory
  run(deleteClips(projectController.project!.sequence.clips.map((c) => c.id)))
  const mb = Math.round(peakStateBytes / 1048576)
  if (!result) reasons.push(`the export failed: ${exporter.state.kind === 'failed' ? exporter.state.error : exporter.state.kind}`)
  // The frame being made and the one before it (both briefly, as one replaces the other).
  if (peakStates > 2) reasons.push(`the export held ${peakStates} Datamosh states (${mb} MB); it needs only the frame before`)
  return { frames: seconds * 25, peakStates, peakStateMB: mb, ms }
}

/** Loudness of what's playing (dB), every 15 ms while the playhead is between `from` and `to` seconds. */
async function loudness(analyser: AnalyserNode, from: number, to: number): Promise<number[]> {
  const data = new Float32Array(analyser.fftSize)
  const out: number[] = []
  await until(() => tl.playhead >= s(from), 10_000)
  while (tl.playhead < s(to) && player.playing) {
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const v of data) sum += v * v
    out.push(10 * Math.log10(sum / data.length + 1e-12))
    await wait(15)
  }
  return out
}

/**
 * 5. Edits while playing. Datamosh on the test pattern and three tones, all moved by the Kick
 * row (8ths at 120 BPM: the Volume ducks 12 dB on each). While playing, switching the cubes off
 * and on and changing Datamosh's Momentum carry on playing (no restart, no catch-up, the
 * picture keeps coming), and the Volume follows the cubes at once, on the tone playing and the
 * next one (already being read). Deleting a sound starts playback again from where it was.
 */
async function editsWhilePlaying(reasons: string[]): Promise<Record<string, unknown>> {
  const files = (await window.ginosa.snapshot.heavyMedia()).filter((f) => /tone_0[123]\.wav$/.test(f)).sort()
  await mediaController.importPaths(files, null)
  const project = projectController.project!
  const footage = project.media.find((m) => m.name === 'testsrc_1080p24_h264')!
  const tones = files.map((f) => project.media.find((m) => m.path === f)!)
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  const a1 = project.sequence.tracks.find((t) => t.kind === 'audio')!.id
  run(setBeatGrid({ bpm: 120, downbeat: 0 }))
  run(addRackRows(STARTER_ROWS))
  const kick = projectController.project!.sequence.rack.rows[0]!
  const eighths = Array.from({ length: 16 }, (_, i) => i * 2)
  run(replaceRackSections([{ bars: 2, cubes: { [kick.id]: eighths } }, { bars: 2, cubes: { [kick.id]: eighths } }]))
  run(placeMedia({ mediaId: footage.id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const picture = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  run(addEffect([picture], 'datamosh'))
  const mosh = projectController.project!.sequence.clips.find((c) => c.id === picture)!.effects[0]!.id
  run(addLink({ clipId: picture, effectId: mosh, param: 'strength' }, kick.modulatorId!, 0))
  tones.forEach((m, i) => run(placeMedia({ mediaId: m.id, sourceIn: 0, sourceOut: s(3), at: s(3 * i), videoTrackId: null, audioTrackId: a1, mode: 'overwrite' })))
  const sounds = projectController.project!.sequence.clips.filter((c) => c.kind === 'audio').sort((a, b) => a.start - b.start)
  for (const c of sounds) run(addLink({ clipId: c.id, effectId: null, param: 'volume' }, kick.modulatorId!, 0))
  modulationController.refresh()
  const cubes = (on: boolean) => {
    for (const section of projectController.project!.sequence.rack.sections) run(setRackCubes(section.id, kick.id, eighths, on))
    modulationController.refresh()
  }

  tl.setPlayhead(0)
  await wait(50)
  await player.settled()
  void player.play(1)
  const started = await until(() => player.playing && player.framesShown > 0 && tl.playhead > 0, 10_000)
  const shown0 = player.framesShown
  const starts = player.playStarts
  const catchUps = player.catchUpLog.length
  const analyser = player.audio!.tap()
  const spread = (db: number[]) => (db.length > 10 ? round(Math.max(...db) - Math.min(...db)) : null)
  const pumping = spread(await loudness(analyser, 0.3, 1.25))
  await until(() => tl.playhead >= s(1.3), 5000)
  cubes(false)
  const offNow = spread(await loudness(analyser, 1.5, 2.8))
  const offNext = spread(await loudness(analyser, 3.3, 4.2))
  await until(() => tl.playhead >= s(4.3), 5000)
  cubes(true)
  const onAgain = spread(await loudness(analyser, 4.6, 5.7))
  await until(() => tl.playhead >= s(5.8), 5000)
  run(setEffectValues(picture, mosh, { params: { momentum: 70 } }))
  await until(() => tl.playhead >= s(6.3), 5000)
  const carried = { starts: player.playStarts - starts, catchUps: player.catchUpLog.length - catchUps, frames: player.framesShown - shown0, seconds: round(ticksToSeconds(tl.playhead)), playing: player.playing }
  // A sound deleted: it starts again, from where it was.
  const at = tl.playhead
  const startsBefore = player.playStarts
  run(deleteClips([sounds[2]!.id]))
  const restarted = await until(() => player.playStarts === startsBefore + 1, 2000)
  const shownBefore = player.framesShown
  const carriedOnAfter = await until(() => player.playing && player.framesShown > shownBefore + 10, 10_000)
  const resumedAt = round(ticksToSeconds(at))
  player.stop()
  run(deleteClips(projectController.project!.sequence.clips.map((c) => c.id)))
  run(setBeatGrid(null))

  if (!started) reasons.push('playback never started')
  if (!(pumping !== null && pumping > 4)) reasons.push(`the Kick row didn't move the Volume before the edit (${pumping} dB)`)
  if (!(offNow !== null && offNow < 1.5)) reasons.push(`with the cubes off, the tone playing still pumps (${offNow} dB): the Volume kept the old curve`)
  if (!(offNext !== null && offNext < 1.5)) reasons.push(`with the cubes off, the next tone still pumps (${offNext} dB)`)
  if (!(onAgain !== null && onAgain > 4)) reasons.push(`with the cubes back on, the Volume didn't pump again (${onAgain} dB)`)
  if (carried.starts !== 0) reasons.push(`playback started again ${carried.starts} times for cube and effect edits`)
  if (carried.catchUps !== 0) reasons.push(`${carried.catchUps} catch-ups ran while playing through the edits`)
  if (!carried.playing || carried.frames < 0.8 * 25 * (carried.seconds - 0.1)) reasons.push(`only ${carried.frames} frames shown in ${carried.seconds} s of playing through the edits`)
  if (!restarted) reasons.push('deleting a sound while playing didn’t start playback again')
  if (!carriedOnAfter) reasons.push('playback didn’t carry on after deleting a sound')
  return { loudnessSpreadDb: { pumping, offNow, offNext, onAgain }, throughEdits: carried, deleteRestarted: restarted, carriedOnAfter, resumedAt }
}

/**
 * 11. A catch-up whose frame never comes (as behind a decoder that has stopped) holds up
 * nothing: Play, and a paused frame elsewhere, go ahead within a few seconds; on its own it
 * gives up (here after 1.5 s), says so, and shows the nearest state as a preview.
 */
async function stuckCatchUp(reasons: string[]): Promise<Record<string, unknown>> {
  const project = projectController.project!
  const footage = project.media.find((m) => m.name === 'testsrc_1080p24_h264')!
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  run(placeMedia({ mediaId: footage.id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const picture = projectController.project!.sequence.clips.find((c) => c.kind === 'video')!.id
  run(addEffect([picture], 'datamosh'))
  const releases: Array<() => void> = []
  const stall = () => (exactHooks.stallNext = new Promise<void>((resolve) => releases.push(resolve)))
  const stuckAt = async (seconds: number) => {
    player.temporal?.clear()
    stall()
    const left = player.catchUpsLeftBehind
    tl.setPlayhead(s(seconds))
    // The exact frame follows a moment after the playhead stops; its catch-up waits on the stall.
    const stuck = await until(() => player.catchUpsRunning > 0 && exactHooks.stallNext === null, 3000)
    await wait(300)
    return { stuck, left }
  }
  const settled = (ms: number) => Promise.race([player.settled().then(() => true), wait(ms).then(() => false)])
  const timed = async (done: () => Promise<boolean>) => {
    const started = performance.now()
    const ok = await done()
    return { ok, ms: Math.round(performance.now() - started) }
  }

  // Play while the paused frame's catch-up is stuck.
  const a = await stuckAt(4)
  const shown = player.framesShown
  void player.play(1)
  const play = await timed(() => until(() => player.playing && player.framesShown > shown + 5, 10_000))
  player.stop()
  await settled(10_000)
  // A jump while it's stuck.
  const b = await stuckAt(6)
  tl.setPlayhead(s(7))
  const jump = await timed(() => settled(10_000))
  const jumpExact = !player.approximate
  // Stuck on its own: it gives up.
  player.catchUpFrameMs = 1500
  const c = await stuckAt(5)
  const message = projectController.lastError
  const alone = await timed(() => settled(10_000))
  const aloneMessage = projectController.lastError !== message ? projectController.lastError : null
  const aloneAsPreview = player.approximate
  player.catchUpFrameMs = 15_000
  const leftBehind = player.catchUpsLeftBehind - a.left
  // The stalls end (the frames come after all): the catch-ups left behind finish quietly.
  releases.forEach((r) => r())
  await wait(300)
  tl.setPlayhead(s(3))
  await wait(50)
  const recovered = (await settled(10_000)) && !player.approximate && player.lastCatchUp !== null
  run(deleteClips(projectController.project!.sequence.clips.map((c) => c.id)))
  await wait(50)
  await settled(10_000)

  if (!a.stuck || !b.stuck || !c.stuck) reasons.push(`a catch-up never got stuck on the stall (${a.stuck}, ${b.stuck}, ${c.stuck}), so this proves nothing`)
  if (!play.ok) reasons.push('Play never started while a catch-up was stuck')
  if (!jump.ok) reasons.push('a jump never showed its frame while a catch-up was stuck')
  else if (!jumpExact) reasons.push('the frame after the jump was left a preview')
  if (!alone.ok) reasons.push(`a catch-up stuck on its own never gave up (limit ${1500} ms)`)
  else if (!aloneMessage?.includes("Couldn't catch up")) reasons.push(`nothing said the catch-up gave up (${aloneMessage})`)
  else if (!aloneAsPreview) reasons.push('the frame after giving up wasn’t shown as a preview')
  if (leftBehind !== 3) reasons.push(`${leftBehind} catch-ups left behind (expected 3)`)
  if (!recovered) reasons.push('catching up didn’t work again after the stalls')
  return { play, jump: { ...jump, exact: jumpExact }, alone: { ...alone, message: aloneMessage, preview: aloneAsPreview }, leftBehind, recovered }
}

export async function heavyTest(): Promise<Record<string, unknown>> {
  const reasons: string[] = []
  const report: Record<string, unknown> = {}
  report['exportMemory'] = await exportMemory(reasons)
  report['editsWhilePlaying'] = await editsWhilePlaying(reasons)
  report['stuckCatchUp'] = await stuckCatchUp(reasons)
  report['manyFiles'] = await manyFiles(reasons)
  report['deviceLoss'] = await deviceLoss(reasons)
  report['stills'] = await stills(reasons)
  // Nothing is left holding a file once things are quiet (a catch-up's decoders go after 10 s).
  await until(() => openFiles().inUse === 0, 11_000)
  const held = openFiles().held.map((path) => path.split('/').pop())
  if (held.length) reasons.push(`files still held at the end: ${held.join(', ')}`)
  report['heldAtEnd'] = held
  report['verdict'] = reasons.length ? 'fail' : 'pass'
  report['reasons'] = reasons
  return report
}
