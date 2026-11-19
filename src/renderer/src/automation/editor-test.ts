import { automationValue } from '@engine/automation/curve'
import { tensionHandle } from '@engine/automation/edit'
import { resolveClip } from '@engine/keyframes/properties'
import type { AutomationPoint, AutomationShape } from '@engine/project/model'
import { secondsToTicks, type Ticks } from '@engine/time'
import { setAutomationPoints } from '@engine/timeline/automation-edits'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { placeMedia } from '@engine/timeline/edits'
import { linksTo } from '@engine/timeline/modulation-edits'
import { modulationController } from '../audio/modulation-controller'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { RULER_HEIGHT, layoutRows, timeToX } from '../timeline/geometry'
import { timelineController } from '../timeline/timeline-controller'
import { CURVE_STROKE, editorGeometry } from './automation-draw'
import { AUTOMATION_DRAG_TYPE, automationUi } from './automation-ui'

/**
 * W2.2 "done when": every shape plays as drawn, checked point by point. A white square's Opacity
 * follows an automation clip whose eight stretches use all seven of FL's shapes. The editor is
 * opened by double-clicking the clip; the curve is read back from the editor's pixels, column by
 * column, and each column is compared with the Opacity playback gives the square at that moment.
 * Then the editor's hands: adding, snapping, dragging, tension, a shape from the menu, deleting,
 * picking a value and dragging the clip's name onto one, each checked and undone.
 */
const s = secondsToTicks
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const PLAN: Array<[number, number, AutomationShape, number]> = [
  [0, 0.15, 'single', 0.6],
  [1, 0.9, 'double', -0.5],
  [2, 0.15, 'hold', 0],
  [3, 0.7, 'stairs', 0],
  [4, 0.1, 'smooth-stairs', 0],
  [5, 0.85, 'pulse', 0],
  [6, 0.3, 'wave', -0.25],
  [7, 0.95, 'single', -0.7],
  [8, 0.2, 'single', 0]
]

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export async function automationEditorTest(): Promise<Record<string, unknown>> {
  const reasons: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) reasons.push(what)
  }
  const sequence = () => projectController.project!.sequence
  projectController.dispatch(setBeatGrid({ bpm: 120, downbeat: 0, beatsPerBar: 4 }))
  const v1 = sequence().tracks.find((t) => t.kind === 'video')!.id
  const square = projectController.project!.media.find((m) => m.name === 'square_1080')
  if (!square) throw new Error('square_1080 is missing (npm run test-media)')
  projectController.dispatch(placeMedia({ mediaId: square.id, sourceIn: 0, sourceOut: s(8), at: 0, videoTrackId: v1, audioTrackId: null, mode: 'overwrite' }))
  const squareId = sequence().clips.find((c) => c.kind === 'video')!.id
  timelineController.setPlayhead(0)
  timelineController.newAutomationClip({ clipId: squareId, effectId: null, param: 'opacity' })
  const auto = () => sequence().clips.find((c) => c.kind === 'automation')!
  const clipId = auto().id
  const planned: AutomationPoint[] = PLAN.map(([t, value, shape, tension]) => ({ time: s(t), value, shape, tension }))
  projectController.dispatch(setAutomationPoints(clipId, planned))
  check(auto().duration === s(8), `the clip is ${auto().duration / s(1)} s, not 4 bars at 120 BPM`)

  // Double-click the clip on the timeline: the editor opens on it.
  timelineController.zoomToFit()
  timelineController.select([], 'replace')
  await pause(300)
  const timeline = document.querySelector<HTMLCanvasElement>('.timeline-canvas')
  const row = layoutRows(sequence()).rows.find((r) => r.track.id === auto().trackId)
  if (timeline && row) {
    const rect = timeline.getBoundingClientRect()
    const x = timeToX(auto().start + auto().duration / 2, timelineController.view)
    const y = RULER_HEIGHT + row.top - timelineController.scrollY + row.height / 2
    timeline.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: rect.left + x, clientY: rect.top + y }))
  }
  await pause(500)
  const canvas = () => document.querySelector<HTMLCanvasElement>('.auto-graph canvas')
  check(automationUi.clipId === clipId && canvas() !== null, 'double-clicking the clip didn’t open the editor on it')
  // Playback's curves for this exact project (what the player and export read).
  const context = await modulationController.snapshot(projectController.project!)
  await pause(300)

  // Plays as drawn: the stroke's centre in each column against playback's Opacity at that moment.
  const shapes: Record<string, { columns: number; worst: number }> = {}
  let worst = 0
  const cv = canvas()
  if (cv) {
    const size = { width: cv.clientWidth, height: cv.clientHeight }
    const ratio = cv.width / size.width
    const g = editorGeometry(auto(), size)
    const image = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height)
    const [sr, sg, sb] = hexRgb(CURVE_STROKE)
    const points = auto().automation!.points
    const near = (x: number) =>
      points.some((p) => Math.abs(g.xOf(p.time) - x) < 8) ||
      points.some((_, i) => {
        const h = tensionHandle(points, i)
        return h !== null && Math.abs(g.xOf(h.time) - x) < 7
      })
    // The jumps (a hold's end, each stair, each pulse edge): where the curve changes by more than 1% within a millisecond.
    const jumps: number[] = []
    for (let x = g.x0; x <= g.x1; x += 0.25) {
      if (Math.abs(automationValue(points, g.timeOf(x + 0.25)) - automationValue(points, g.timeOf(x))) > 0.03) jumps.push(x + 0.125)
    }
    const square = () => sequence().clips.find((c) => c.id === squareId)!
    for (let x = Math.ceil(g.x0) + 2; x <= Math.floor(g.x1) - 2; x++) {
      // Skip the columns by a jump, and the points and handles drawn over the line.
      if (jumps.some((j) => Math.abs(j - (x + 0.5)) < 2.5) || near(x)) continue
      // The line's centre at the column's middle (x + 0.5): the screen pixels either side of it, averaged.
      const centres: number[] = []
      for (const column of [Math.round((x + 0.5) * ratio) - 1, Math.round((x + 0.5) * ratio)]) {
        let sum = 0
        let count = 0
        for (let y = Math.floor((g.y0 - 3) * ratio); y <= Math.ceil((g.y1 + 3) * ratio); y++) {
          const i = (y * cv.width + column) * 4
          const d = Math.hypot(image.data[i]! - sr, image.data[i + 1]! - sg, image.data[i + 2]! - sb)
          if (d < 40) {
            sum += y + 0.5
            count++
          }
        }
        if (count > 0) centres.push(sum / count)
      }
      if (centres.length === 0) continue
      const drawn = g.valueOf(centres.reduce((a, b) => a + b, 0) / centres.length / ratio)
      const time: Ticks = auto().start + Math.round(g.timeOf(x + 0.5)) - auto().sourceIn
      const played = (resolveClip(square(), time, context).opacity as number) / 100
      const error = Math.abs(drawn - played)
      let stretch = 0
      PLAN.forEach(([t], i) => {
        if (s(t) <= g.timeOf(x + 0.5)) stretch = i
      })
      const key = `${stretch}:${PLAN[stretch]![2]}`
      const entry = (shapes[key] ??= { columns: 0, worst: 0 })
      entry.columns++
      entry.worst = Math.max(entry.worst, Math.round(error * 10000) / 10000)
      worst = Math.max(worst, error)
    }
    // One screen pixel of the graph's height, and a little for the line's anti-aliasing.
    const tolerance = 1.5 / (g.y1 - g.y0)
    check(Object.keys(shapes).length === 8, `columns measured in ${Object.keys(shapes).length} of the 8 stretches`)
    check(Object.values(shapes).every((v) => v.columns >= 10), 'too few columns measured in a stretch')
    check(worst <= tolerance, `drawn and played differ by up to ${worst.toFixed(4)} (tolerance ${tolerance.toFixed(4)})`)
  }

  // The editor's hands, each undone after.
  const pts = () => auto().automation!.points
  const root = () => document.querySelector<HTMLElement>('.automation-editor')!
  const at = (time: number, value: number) => {
    const c = canvas()!
    const g = editorGeometry(auto(), { width: c.clientWidth, height: c.clientHeight })
    const rect = c.getBoundingClientRect()
    return { clientX: rect.left + g.xOf(time), clientY: rect.top + g.yOf(value) }
  }
  const pointer = async (type: string, where: { clientX: number; clientY: number }, extra: PointerEventInit = {}) => {
    canvas()!.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, ...where, ...extra }))
    await pause(60)
  }
  const undo = async () => {
    projectController.undo()
    await pause(120)
  }
  // Click empty space at 2.53 s: a point snapped to the 16th at 2.5 s; ⌫ deletes it.
  await pointer('pointerdown', at(s(2.53), 0.5))
  await pointer('pointerup', at(s(2.53), 0.5))
  const added = pts().find((p) => p.time > s(2) && p.time < s(3))
  check(pts().length === PLAN.length + 1 && added?.time === s(2.5), `a click added ${added ? added.time / s(1) : 'no point'} (expected one at 2.5 s)`)
  root().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
  await pause(150)
  check(pts().length === PLAN.length, '⌫ didn’t delete the selected point')
  // Drag the point at 1 s to 1.29 s and 50%: it lands on 1.25 s, in one undo step; with ⌥ it stays at 1.29.
  await pointer('pointerdown', at(s(1), 0.9))
  await pointer('pointermove', at(s(1.1), 0.7))
  await pointer('pointermove', at(s(1.29), 0.5))
  await pointer('pointerup', at(s(1.29), 0.5))
  check(pts()[1]!.time === s(1.25) && Math.abs(pts()[1]!.value - 0.5) < 0.01, `the dragged point is at ${pts()[1]!.time / s(1)} s, ${pts()[1]!.value.toFixed(3)}`)
  await undo()
  check(pts()[1]!.time === s(1) && pts()[1]!.value === 0.9, 'one undo didn’t put the dragged point back')
  await pointer('pointerdown', at(s(1), 0.9))
  await pointer('pointermove', at(s(1.29), 0.5), { altKey: true })
  await pointer('pointerup', at(s(1.29), 0.5), { altKey: true })
  check(Math.abs(pts()[1]!.time - s(1.29)) < s(0.02), `with ⌥ the point snapped anyway (${pts()[1]!.time / s(1)} s)`)
  await undo()
  // Drag the first stretch's handle up 40 px: its curve bulges up more.
  const handle = tensionHandle(pts(), 0)!
  const from = at(handle.time, handle.value)
  await pointer('pointerdown', from)
  await pointer('pointermove', { clientX: from.clientX, clientY: from.clientY - 40 })
  await pointer('pointerup', { clientX: from.clientX, clientY: from.clientY - 40 })
  check(pts()[0]!.tension > 0.6, `dragging the handle up left the tension at ${pts()[0]!.tension}`)
  await undo()
  // Right-click the hold point › Wave.
  canvas()!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...at(s(2), 0.15) }))
  await pause(150)
  ;[...document.querySelectorAll<HTMLButtonElement>('.context-menu button')].find((b) => b.textContent?.trim().startsWith('Wave'))?.click()
  await pause(150)
  check(pts()[2]!.shape === 'wave', `the menu made the hold a ${pts()[2]!.shape}`)
  await undo()
  check(JSON.stringify(pts()) === JSON.stringify(planned), 'after the undos the curve isn’t as planned')

  // Pick Scale in the editor; drag the clip's name onto Rotation in Effect Controls; unlink Rotation.
  ;[...root().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Pick a value'))?.click()
  await pause(150)
  const search = root().querySelector<HTMLInputElement>('input[aria-label="Search"]')
  if (search) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Motion')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await pause(150)
  ;[...root().querySelectorAll<HTMLButtonElement>('.channel-pick-values button')].find((b) => b.textContent?.trim() === 'Scale')?.click()
  await pause(200)
  const controls = () => linksTo(sequence(), auto().automation!.modulatorId).map((l) => l.ref.param)
  check(controls().includes('scale'), `picking Scale: the clip controls ${controls().join(', ')}`)
  timelineController.select([squareId], 'replace')
  workspaceController.open('effect-controls')
  workspaceController.focus('effect-controls')
  await pause(500)
  const rotation = [...document.querySelectorAll<HTMLElement>('.fx-row')].find((r) => r.querySelector('.kf-name')?.textContent?.trim() === 'Rotation')
  if (rotation) {
    const data = new DataTransfer()
    data.setData(AUTOMATION_DRAG_TYPE, clipId)
    rotation.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    rotation.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    await pause(200)
  }
  check(controls().includes('rotation'), `dragging the name onto Rotation${rotation ? '' : ' (its row wasn’t found)'}: the clip controls ${controls().join(', ')}`)
  root().querySelector<HTMLButtonElement>('button[aria-label="Unlink Rotation"]')?.click()
  await pause(200)
  check(!controls().includes('rotation'), 'Rotation’s × left it linked')

  // For the screenshot: the automation clip selected, its fifth point selected, the playhead at 2.5 s.
  timelineController.select([clipId], 'replace')
  automationUi.select([4])
  timelineController.setPlayhead(s(2.5))
  await pause(300)
  return { verdict: reasons.length === 0 ? 'pass' : 'fail', reasons, worst: Math.round(worst * 10000) / 10000, shapes, controls: controls() }
}
