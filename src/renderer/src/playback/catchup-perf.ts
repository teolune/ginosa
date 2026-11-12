import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { applyBuiltinPreset } from '@engine/timeline/builtin-presets'
import { placeMedia } from '@engine/timeline/edits'
import { addLink } from '@engine/timeline/modulation-edits'
import { addRackRows, replaceRackSections, setRackCubes, STARTER_ROWS } from '@engine/timeline/rack-edits'
import { placeSections } from '@engine/timeline/rack'
import { modulationController } from '../audio/modulation-controller'
import { getGpu } from '../gpu/shared'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { timelineController as tl } from '../timeline/timeline-controller'
import { ExactFrames, exactStats } from './exact-render'
import { player } from './player'
import { useMedia } from './sources'

/**
 * Catching up stateful effects on your 4K Apple Log clips (your "very slow" recording of
 * 11 Nov): both clips cut together, Datamosh (Freeze & Drift) on each, 167 BPM, a Kick channel
 * in 2-bar sections moving Datamosh's Strength. Measured:
 *  - decoding alone, in order, as catching up reads the clip;
 *  - a cold catch-up to 10.5 s (nothing kept): per frame, split into waiting for decoded
 *    frames, recording the GPU work and the GPU itself;
 *  - after a cube edit in the section just before the playhead, catching up again;
 *  - Play from 10.5 s after such an edit: how long until the picture moves;
 *  - Play, Pause and Play again quickly (as in the recording): catch-ups at once, restarts.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const BPM = 167
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (v: number) => Math.round(v * 100) / 100

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return sign * 2 ** -14 * (m / 1024)
  if (e === 31) return m ? NaN : sign * Infinity
  return sign * 2 ** (e - 15) * (1 + m / 1024)
}

/** The paused frame as floats (the compositor's 16-bit float picture). */
async function readFrame(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
  const { width, height } = texture
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height])
  device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const half = new Uint16Array(buffer.getMappedRange())
  const out = new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let i = 0; i < width * 4; i++) out[y * width * 4 + i] = halfToFloat(half[y * (bytesPerRow / 2) + i]!)
  buffer.unmap()
  buffer.destroy()
  return out
}

export async function catchUpPerf(): Promise<Record<string, unknown>> {
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
  }
  const { device } = await getGpu()
  const files = (await window.ginosa.snapshot.referenceClips()).slice(0, 2)
  if (files.length < 2) throw new Error('The Apple Log clips aren’t in Reference Materials/AppleLogClips')
  await mediaController.importPaths(files, null)
  for (let i = 0; i < 600; i++) {
    const media = projectController.project?.media ?? []
    if (media.length === 2 && media.every((m) => mediaController.playablePath(m))) break
    await wait(500)
  }
  const project = projectController.project!
  const [one, two] = [...project.media].sort((a, b) => a.name.localeCompare(b.name))
  if (!one || !two) throw new Error('The clips never became playable')
  const lengthOf = (m: typeof one) => s(Math.floor((m.info.video?.frameCount ?? 250) / 25) - 0.2)
  const v1 = project.sequence.tracks.find((t) => t.kind === 'video')!.id
  run(placeMedia({ mediaId: one.id, sourceIn: 0, sourceOut: lengthOf(one), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  run(placeMedia({ mediaId: two.id, sourceIn: 0, sourceOut: lengthOf(two), at: lengthOf(one), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const clips = () => projectController.project!.sequence.clips.filter((c) => c.kind === 'video')
  run(applyBuiltinPreset(clips().map((c) => c.id), 'builtin:mosh-freeze-drift', 0))
  run(setBeatGrid({ bpm: BPM, downbeat: 0 }))
  run(addRackRows(STARTER_ROWS))
  const kick = projectController.project!.sequence.rack.rows[0]!
  // 2-bar sections like yours, a kick on every beat.
  run(replaceRackSections(Array.from({ length: 8 }, () => ({ bars: 2, cubes: { [kick.id]: [0, 4, 8, 12, 16, 20, 24, 28] } }))))
  for (const c of clips()) {
    const effect = c.effects.find((e) => e.effectId === 'datamosh')!
    run(addLink({ clipId: c.id, effectId: effect.id, param: 'strength' }, kick.modulatorId!, 0))
  }
  modulationController.refresh()

  const report: Record<string, unknown> = { clips: [one.name, two.name], codec: one.info.video ? `${one.info.video.codec} ${one.info.video.width}x${one.info.video.height} ${one.info.video.pixelFormat}` : null }

  // 1. Decoding alone: 250 frames in order.
  {
    const frames = new ExactFrames(await useMedia(mediaController.playablePath(one)!), clips()[0]!)
    const started = performance.now()
    let n = 0
    for (; n < 250; n++) if (!(await frames.frameAt(n / 25))) break
    report['decodeOnlyMsPerFrame'] = round((performance.now() - started) / Math.max(1, n))
    frames.close()
  }

  // Deep in the first clip (it ends at 9.8 s): 235 frames from Datamosh's reset at its start.
  const target = s(9.4)
  const exactAt = async (time: number) => {
    tl.setPlayhead(time)
    await wait(0)
    await player.settled()
    await device.queue.onSubmittedWorkDone()
    return player.lastCatchUp
  }
  const statsBefore = () => ({ ...player.catchUp!.stats, restarts: exactStats.restarts })
  const partsSince = (b: ReturnType<typeof statsBefore>, ms: number) => {
    const a = player.catchUp!.stats
    const frames = Math.max(1, a.frames - b.frames)
    return {
      frames: a.frames - b.frames,
      msPerFrame: round(ms / frames),
      decodeWaitMs: round((a.decodeMs - b.decodeMs) / frames),
      recordMs: round((a.renderMs - b.renderMs) / frames),
      planMs: round((a.planMs - b.planMs) / frames),
      restarts: exactStats.restarts - b.restarts
    }
  }

  // 2. Cold: nothing kept.
  await exactAt(s(0.2))
  player.temporal!.clear()
  {
    const b = statsBefore()
    const started = performance.now()
    const catchUp = await exactAt(target)
    report['cold'] = { ...partsSince(b, catchUp?.ms ?? performance.now() - started), wallMs: Math.round(performance.now() - started) }
  }
  // 3. Warm: the same frame again after looking elsewhere.
  await exactAt(s(3))
  {
    const b = statsBefore()
    const catchUp = await exactAt(target)
    report['warm'] = { frames: catchUp?.frames ?? null, restarts: exactStats.restarts - b.restarts }
  }
  // 4. A cube edit in the section under the playhead (bars 7–8, from 8.62 s).
  const grid = projectController.project!.sequence.beatGrid!
  const placed = () => placeSections(projectController.project!.sequence.rack, grid)
  const sectionAt = (seconds: number) => placed().filter((p) => p.firstStep / 4 <= (seconds * BPM) / 60).at(-1)!
  // Toggles an extra kick (16th 2) in the section under `seconds`.
  const editNear = (seconds: number) => {
    const p = sectionAt(seconds)
    const has = (p.section.cubes[kick.id] ?? []).some((c) => c.step === 2)
    run(setRackCubes(p.section.id, kick.id, [2], !has))
    modulationController.refresh()
    return round((p.firstStep / 4) * (60 / BPM))
  }
  {
    const editedFrom = editNear(9.0)
    const b = statsBefore()
    const started = performance.now()
    const catchUp = await exactAt(target)
    report['afterEdit'] = { editedFromSeconds: editedFrom, ...partsSince(b, catchUp?.ms ?? performance.now() - started), wallMs: Math.round(performance.now() - started) }
    // The frame from the states kept from before the edit, against the same frame replayed from the clip's start.
    const carried = await readFrame(device, player.lastStill!)
    player.temporal!.clear()
    await exactAt(s(3))
    await exactAt(target)
    const replayed = await readFrame(device, player.lastStill!)
    let worst = 0
    let differing = 0
    for (let i = 0; i < carried.length; i++) {
      const d = Math.abs(carried[i]! - replayed[i]!)
      if (d > 0) differing++
      worst = Math.max(worst, d)
    }
    report['carriedVsReplayed'] = { values: carried.length, differing, worst }
  }
  // 5. Play from 10.5 s after an edit: until the first frame is shown.
  const untilShown = async (limitMs: number) => {
    const shownBefore = player.framesShown
    const started = performance.now()
    while (player.framesShown === shownBefore && performance.now() - started < limitMs) await wait(5)
    return Math.round(performance.now() - started)
  }
  {
    editNear(9.0)
    tl.setPlayhead(target)
    await wait(50)
    const b = statsBefore()
    player.maxCatchUpsRunning = 0
    void player.play(1)
    const ms = await untilShown(120_000)
    await wait(1500)
    report['playAfterEdit'] = { msUntilPicture: ms, catchUpFrames: player.catchUp!.stats.frames - b.frames, restarts: exactStats.restarts - b.restarts, fps: round(player.stats.fps) }
    player.stop()
    await wait(300)
  }
  // 6. Play, Pause, Play quickly after an edit (as in the recording).
  {
    editNear(9.0)
    tl.setPlayhead(target)
    await wait(50)
    const b = statsBefore()
    player.maxCatchUpsRunning = 0
    player.toggle()
    await wait(150)
    player.toggle()
    await wait(150)
    player.toggle()
    const ms = await untilShown(120_000)
    await wait(1500)
    report['playPausePlay'] = { msUntilPicture: ms, catchUpFrames: player.catchUp!.stats.frames - b.frames, catchUpsAtOnce: player.maxCatchUpsRunning, restarts: exactStats.restarts - b.restarts, fps: round(player.stats.fps) }
    player.stop()
    await wait(300)
  }
  // 7. The same cold catch-up at half playback resolution (the monitor's 1/2).
  {
    player.setResolution(0.5)
    await exactAt(s(0.2))
    player.temporal!.clear()
    const started = performance.now()
    const catchUp = await exactAt(target)
    report['coldAtHalf'] = { frames: catchUp?.frames ?? null, wallMs: Math.round(performance.now() - started) }
    player.setResolution(1)
  }
  report['catchUps'] = player.catchUpLog.slice(-20)
  report['resets'] = player.temporal!.stats
  report['verdict'] = 'measured'
  return report
}
