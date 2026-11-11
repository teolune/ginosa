import { secondsToTicks, ticksPerFrame, FRAME_RATES } from '@engine/time'
import { addAdjustmentLayer, addEffect, removeEffects, setEffectEnabled, setEffectValues } from '@engine/timeline/effect-edits'
import { placeMedia } from '@engine/timeline/edits'
import { frameKeys } from '@engine/render/frame-keys'
import { modulationController } from '../audio/modulation-controller'
import { getGpu } from '../gpu/shared'
import { mediaController } from '../state/media-controller'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController as tl } from '../timeline/timeline-controller'
import { Player, player } from './player'
import { Compositor, type CompositeStep } from './compositor'
import { TemporalStore } from './temporal'
import { effectById } from '../../../effects/registry'
import type { ParamValue } from '@engine/effects/types'

/**
 * What a stack of effects costs (the "stacking makes everything slower" report). A minute of
 * the test pattern on V1 with Basic Correction and Grain, and an adjustment layer over it with
 * ten effects, Effect Controls and the Keyframe Editor open on it. Measured:
 *  - adding each kind of effect, the first time (its shaders compiled) and again: until the
 *    monitor shows it;
 *  - moving around with the stack: selecting clips, dragging a value, stepping the playhead,
 *    each once a frame, timed by the screen's frames (and the monitor's renders meanwhile);
 *  - the render cache re-keying every frame after an edit (it runs after each one);
 *  - the GPU's time for one frame of the stack, and 4 seconds of playback.
 */

const s = secondsToTicks
const FRAME = ticksPerFrame(FRAME_RATES['25'])
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (v: number) => Math.round(v * 100) / 100

const STACK = ['basic-correction', 'curves', 'levels', 'gradient-map', 'invert', 'transform', 'mosaic', 'grain', 'feedback', 'datamosh']

async function shown(): Promise<void> {
  const { device } = await getGpu()
  await wait(0)
  await player.settled()
  await device.queue.onSubmittedWorkDone()
}

/** Runs `step` once a frame; frame intervals, the work each step sets off at once, the monitor's renders. */
async function measure(count: number, step: (i: number) => void) {
  await wait(1000)
  await shown()
  await nextFrame()
  const stills = player.stillCount
  const times: number[] = []
  let work = 0
  let last = await nextFrame()
  for (let i = 0; i < count; i++) {
    const started = performance.now()
    step(i)
    for (let k = 0; k < 3; k++) await new Promise<void>((resolve) => queueMicrotask(resolve))
    work += performance.now() - started
    const now = await nextFrame()
    times.push(now - last)
    last = now
  }
  const sorted = [...times].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { meanMs: round(times.reduce((a, b) => a + b, 0) / count), p95Ms: round(at(0.95)), worstMs: round(sorted.at(-1) ?? 0), workMsEach: round(work / count), monitorRenders: player.stillCount - stills }
}

export async function effectsPerf() {
  const run = (command: Parameters<typeof projectController.dispatch>[0]) => {
    if (!projectController.dispatch(command)) throw new Error(`${command.label} failed: ${projectController.lastError}`)
  }
  const { device } = await getGpu()
  const clipItem = projectController.project!.media.find((m) => m.name === 'testsrc_1080p24_h264')
  if (!clipItem) throw new Error('testsrc_1080p24_h264 is missing (npm run test-media)')
  for (let i = 0; i < 40 && !mediaController.playablePath(clipItem); i++) await wait(250)
  const [v1, v2] = projectController.project!.sequence.tracks.filter((t) => t.kind === 'video').map((t) => t.id) as [string, string]
  for (let i = 0; i < 6; i++) run(placeMedia({ mediaId: clipItem.id, sourceIn: 0, sourceOut: s(10), at: s(10 * i), videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const clips = () => projectController.project!.sequence.clips.filter((c) => c.trackId === v1)
  run(addAdjustmentLayer({ trackId: v2, start: 0, duration: s(60) }))
  const layer = projectController.project!.sequence.clips.find((c) => c.adjustment)!.id
  const effectsOf = (id: string) => projectController.project!.sequence.clips.find((c) => c.id === id)!.effects
  tl.select([layer], 'replace')
  workspaceController.open('effect-controls')
  workspaceController.open('keyframe-editor')
  tl.setPlayhead(s(5))
  await wait(1500)
  await shown()

  // Adding each effect: the first time (shaders compiled) and, after removing it, again; until the
  // monitor first shows it (a preview, for stateful effects) and until it's exact.
  const adding: Record<string, { firstMs: number; againMs: number; exactMs: number; worstFrameMs: number }> = {}
  for (const id of STACK) {
    const add = async () => {
      let worst = 0
      let last = performance.now()
      let watching = true
      const watch = async () => {
        while (watching) {
          const now = await nextFrame()
          worst = Math.max(worst, now - last)
          last = now
        }
      }
      void watch()
      const started = performance.now()
      run(addEffect([layer], id))
      while (player.lastStillAt < started) await wait(1)
      const ms = player.lastStillAt - started
      await shown()
      const exactMs = performance.now() - started
      watching = false
      await nextFrame()
      return { ms, exactMs, worst }
    }
    const first = await add()
    run(removeEffects(layer, [effectsOf(layer).at(-1)!.id]))
    await shown()
    const again = await add()
    adding[id] = { firstMs: round(first.ms), againMs: round(again.ms), exactMs: round(first.exactMs), worstFrameMs: round(Math.max(first.worst, again.worst)) }
  }
  for (const c of clips()) {
    run(addEffect([c.id], 'basic-correction'))
    run(addEffect([c.id], 'grain'))
  }
  tl.select([layer], 'replace')
  await wait(1500)
  await shown()

  // Moving around with the stack.
  const ids = [layer, ...clips().map((c) => c.id)]
  const selecting = await measure(60, (i) => tl.select([ids[i % ids.length]!], 'replace'))
  tl.select([layer], 'replace')
  const basic = effectsOf(layer)[0]!.id
  const dragging = await measure(60, (i) => projectController.dispatch(setEffectValues(layer, basic, { params: { exposure: (i % 30) / 10 } })))
  const released = performance.now()
  await shown()
  const exactAfterDragMs = performance.now() - released
  const start = tl.playhead
  const stepping = await measure(60, (i) => tl.setPlayhead(start + (i + 1) * FRAME))

  // Catching up exactly after an edit beneath Feedback and Datamosh (125 frames from the layer's
  // start), per frame: with the whole stack, then with only the stateful effects switched on.
  const catchUp = async () => {
    tl.setPlayhead(s(5))
    await shown()
    const value = Math.random()
    projectController.dispatch(setEffectValues(layer, basic, { params: { exposure: value } }))
    const started = performance.now()
    await shown()
    return round((performance.now() - started - 250) / 125)
  }
  const s0 = { ...player.catchUp!.stats }
  const catchUpWholeStack = await catchUp()
  const s1 = player.catchUp!.stats
  const per = (k: 'planMs' | 'decodeMs' | 'renderMs') => round((s1[k] - s0[k]) / Math.max(1, s1.frames - s0.frames))
  const catchUpParts = { frames: s1.frames - s0.frames, planMs: per('planMs'), decodeWaitMs: per('decodeMs'), recordMs: per('renderMs') }
  const toggled: Array<[string, string]> = []
  for (const c of [layer, ...clips().map((c) => c.id)])
    for (const e of effectsOf(c)) if (e.enabled && !['feedback', 'datamosh', 'basic-correction'].includes(e.effectId)) toggled.push([c, e.id])
  for (const [c, e] of toggled) projectController.dispatch(setEffectEnabled(c, e, false))
  const catchUpStatefulOnly = await catchUp()
  for (const [c, e] of toggled) projectController.dispatch(setEffectEnabled(c, e, true))

  // One catch-up frame of the whole stack, start to finish on the GPU (30 frames, one at a time),
  // and the same 30 queued back to back (as catching up does between its pauses).
  const sequence = projectController.project!.sequence
  const media = projectController.project!.media
  player.temporal!.mode = 'exact'
  let single = 0
  for (let n = 0; n < 30; n++) {
    const started = performance.now()
    await player.catchUp!.render(sequence, media, s(6) + n * FRAME, modulationController.context, 1)
    await device.queue.onSubmittedWorkDone()
    single += performance.now() - started
  }
  const queuedStarted = performance.now()
  for (let n = 30; n < 60; n++) await player.catchUp!.render(sequence, media, s(6) + n * FRAME, modulationController.context, 1)
  await device.queue.onSubmittedWorkDone()
  const stackFrame = { oneAtATimeMs: round(single / 30), queuedMs: round((performance.now() - queuedStarted) / 30) }

  // Each effect's GPU time on a 1080p picture, alone, with its default settings (stateful ones running).
  const gpuMsPerEffect: Record<string, number> = {}
  {
    const compositor = new Compositor(device)
    compositor.resize(1920, 1080)
    const canvas = new OffscreenCanvas(1920, 1080)
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createLinearGradient(0, 0, 1920, 1080)
    gradient.addColorStop(0, '#203050')
    gradient.addColorStop(1, '#e0a040')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 1920, 1080)
    const picture = compositor.imageTexture(await createImageBitmap(canvas))
    const store = new TemporalStore(device, 25)
    const time = async (manifestId: string | null) => {
      const manifest = manifestId ? effectById(manifestId)! : null
      const params = manifest ? (Object.fromEntries(manifest.params.map((q) => [q.id, q.default])) as Record<string, ParamValue>) : {}
      const step = (n: number): CompositeStep => ({
        source: { kind: 'image', texture: picture },
        inverse: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        width: 1920,
        height: 1080,
        rotation: 0,
        opacity: 1,
        blend: 'normal',
        colour: { undoMacDisplay: false, conversion: { kind: 'none' } },
        effects: manifest ? [{ manifest, params, mix: 1, blend: 'normal', mask: null, state: manifest.time === 'stateful' ? store.state(manifest.id, 'k', n) : null, clock: { frame: n, beat: 0, beatsPerFrame: 0.08, beatsPerBar: 4 }, sinceCut: n }] : []
      })
      compositor.render([step(0)], 1)
      compositor.render([step(1)], 1)
      await device.queue.onSubmittedWorkDone()
      const started = performance.now()
      for (let n = 2; n < 32; n++) compositor.render([step(n)], 1)
      await device.queue.onSubmittedWorkDone()
      return (performance.now() - started) / 30
    }
    const base = await time(null)
    gpuMsPerEffect['(no effect)'] = round(base)
    for (const id of STACK) gpuMsPerEffect[id] = round((await time(id)) - base)
    store.clear()
    picture.destroy()
    compositor.destroy()
  }

  // Re-keying the render cache after an edit (main thread).
  const project = projectController.project!
  const keyStarted = performance.now()
  frameKeys(project.sequence, project.media, modulationController.context)
  const rekeyMs = performance.now() - keyStarted

  // The GPU's time for the stack: the paused frame rendered 20 times.
  tl.setPlayhead(s(30))
  await shown()
  const gpuStarted = performance.now()
  for (let i = 0; i < 20; i++) {
    player.requestStill()
    await shown()
  }
  const stillMs = (performance.now() - gpuStarted) / 20

  // Playback.
  await player.play(1, s(10))
  await wait(4000)
  const stats = { ...player.stats }
  player.stop()

  return {
    verdict: 'pass',
    stack: STACK,
    addEffect: adding,
    selecting,
    dragging,
    stepping,
    exactAfterDragMs: round(exactAfterDragMs),
    gpuMsPerEffect,
    stackFrame,
    catchUpMsPerFrame: { wholeStack: catchUpWholeStack, statefulOnly: catchUpStatefulOnly, parts: catchUpParts },
    rekeyAfterEditMs: round(rekeyMs),
    warmed: Player.warmed,
    frames: Math.round(60 * 25),
    pausedFrameMs: round(stillMs),
    playback: { fps: round(stats.fps), dropped: stats.dropped, renderMs: round(stats.renderMs) },
    device: { maxTextureDimension2D: device.limits.maxTextureDimension2D }
  }
}
