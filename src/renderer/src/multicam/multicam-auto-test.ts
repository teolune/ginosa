import { addTrack } from '@engine/project/commands'
import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { placeMedia } from '@engine/timeline/edits'
import { addFavourite } from '@engine/timeline/multicam-edits'
import { setSequenceMarks } from '@engine/timeline/sequence-marks'
import { clipEnd } from '@engine/timeline/timeline'
import { mediaSelection } from '../media-panel/selection'
import { readRowBoxes } from '../playback/colour-probe'
import { player } from '../playback/player'
import { programView } from '../playback/program-view'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { stripLanes } from './FavouriteStrip'
import { multicamUi } from './multicam-ui'

/**
 * Your Multi-Camera design (20 Nov) and W5.4–W5.5, through the app. The song on A1 (120 BPM).
 *  - The Control Panel's Multi-Camera button opens the window (nothing in it yet), with its preview
 *    showing the same picture as the Program monitor;
 *  - Add Clip + › Selected in the Media Panel adds take_a, take_b, take_early (synced, keys 1–3);
 *    take_noise on the timeline, then right-click › Add to Multi-Camera adds it on 4;
 *  - Mark Clip solos the first clip with nothing marked (take_a): the preview shows it alone;
 *    M at 7 s and M at 11 s mark 7–11 s; 2 solos take_b; dragging the mark's end changes it (one
 *    undo step); ⌫ deletes the selected mark;
 *  - right-click › B-Roll makes take_noise B-roll;
 *  - Make the Edit, every bar between In (0) and Out (20 s): take_early 0–6, take_a 6–13,
 *    take_noise 13–14 (from its 2 s), take_b 14–17, take_noise 17–19.52 (on from 3 s), and the gap
 *    19.52–20 (take_b holds) flagged and listed; each synced piece in sync, the B-roll piece
 *    showing take_noise's own frame; one undo step;
 *  - the Control Panel's button again closes the window: the preview is the edit again.
 */

const s = secondsToTicks
const XS = Array.from({ length: 480 }, (_, i) => i * 4)
const ROW = 300
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function rowMean(a: number[][], b: number[][]): number {
  let sum = 0
  a.forEach((p, i) => p.forEach((v, c) => (sum += Math.abs(v - b[i]![c]!))))
  return sum / (a.length * 3)
}

async function stillRow(at: number): Promise<number[][]> {
  timelineController.setPlayhead(s(at))
  await player.settled()
  return readRowBoxes(player.lastStill!, XS, ROW)
}

/** A canvas's picture, read through a 2D canvas: the mean of each 16th column's middle pixel. */
function canvasRow(canvas: HTMLCanvasElement): number[] {
  const copy = document.createElement('canvas')
  copy.width = 64
  copy.height = 36
  const ctx = copy.getContext('2d')!
  ctx.drawImage(canvas, 0, 0, 64, 36)
  const data = ctx.getImageData(0, 18, 64, 1).data
  return Array.from({ length: 64 }, (_, i) => (data[i * 4]! + data[i * 4 + 1]! + data[i * 4 + 2]!) / 765)
}

export async function multicamAutoTest() {
  const reasons: string[] = []
  const project = projectController.project!
  const audio = project.sequence.tracks.filter((t) => t.kind === 'audio').map((t) => t.id)
  const item = (name: string) => {
    const found = projectController.project!.media.find((m) => m.name === name)
    if (!found) throw new Error(`${name} is missing (npm run test-media)`)
    return found
  }
  const song = item('multicam_song')
  projectController.dispatch(placeMedia({ mediaId: song.id, sourceIn: 0, sourceOut: s(40), at: 0, videoTrackId: null, audioTrackId: audio[0]!, mode: 'overwrite' }))
  projectController.dispatch(setBeatGrid({ bpm: 120, downbeat: 0, beatsPerBar: 4 }))
  const sequence = () => projectController.project!.sequence
  const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(text) || b.getAttribute('aria-label') === text)

  // ---- Opening: the Control Panel's button ----
  button(document.querySelector('.control-panel')!, 'Multi-Camera')?.click()
  await wait(500)
  const win = () => document.querySelector<HTMLElement>('.multicam-window')
  const opened = Boolean(win()) && multicamUi.windowOpen
  const emptyHint = win()?.querySelector('.mc-empty')?.textContent ?? ''
  if (!opened || !emptyHint.includes('Add to Multi-Camera')) reasons.push(`the Control Panel button: window ${opened}, hint “${emptyHint.slice(0, 60)}”`)

  // ---- Add Clip + › Selected in the Media Panel ----
  mediaSelection.ids = ['take_a', 'take_b', 'take_early'].map((n) => item(n).id)
  button(win()!, 'Add Clip +')!.click()
  await wait(150)
  const fromMedia = [...document.querySelectorAll<HTMLButtonElement>('.context-menu button')].find((b) => b.textContent?.includes('Selected in the Media Panel (3)'))
  if (!fromMedia) reasons.push('Add Clip + has no “Selected in the Media Panel (3)”')
  fromMedia?.click()
  for (let i = 0; i < 100 && !sequence().multicam.length; i++) await wait(100)
  await wait(400)
  const group = () => sequence().multicam[0]!
  if (!sequence().multicam.length) return { verdict: 'fail', reasons: [...reasons, `no group: ${projectController.lastError}`] }
  const take = (name: string) => sequence().clips.find((c) => c.kind === 'video' && c.name === name && !c.multicam)!
  const zero = (name: string) => take(name).start - take(name).sourceIn

  // ---- take_noise on the timeline, then right-click › Add to Multi-Camera ----
  projectController.dispatch(addTrack('video'))
  const noiseTrack = sequence().tracks.filter((t) => t.kind === 'video').at(-1)!.id
  projectController.dispatch(placeMedia({ mediaId: item('take_noise').id, sourceIn: 0, sourceOut: s(10), at: 0, videoTrackId: noiseTrack, audioTrackId: null, mode: 'overwrite' }))
  await multicamUi.addClips([take('take_noise').id])
  await wait(300)
  const angleOf = (name: string) => group().angles.find((a) => a.trackId === take(name).trackId)!
  const keys = Object.fromEntries(['take_a', 'take_b', 'take_early', 'take_noise'].map((n) => [n, angleOf(n)?.key]))
  if (JSON.stringify(keys) !== JSON.stringify({ take_a: '1', take_b: '2', take_early: '3', take_noise: '4' })) reasons.push(`keys ${JSON.stringify(keys)}`)
  if (sequence().tracks.find((t) => t.id === noiseTrack)!.visible) reasons.push('take_noise’s track isn’t hidden')
  const labels = [...win()!.querySelectorAll('.mc-clip-name')].map((e) => e.textContent)
  const row = (name: string) => [...win()!.querySelectorAll<HTMLElement>('.mc-clip')][group().angles.findIndex((a) => a.id === angleOf(name).id)]!
  const strip = (name: string) => row(name).querySelector<HTMLElement>('.favourite-strip')!

  // ---- The preview mirrors the Program monitor ----
  // Both canvases read as the frame is shown (a WebGPU canvas can be read only in that task).
  let seen: { main: number[]; mirror: number[]; same: boolean } | null = null
  const mirrorCanvas = win()!.querySelector<HTMLCanvasElement>('.mc-preview canvas')!
  player.mirrorProbe = (monitor, other) => {
    seen = { main: canvasRow(monitor), mirror: canvasRow(other), same: other === mirrorCanvas }
  }
  timelineController.setPlayhead(s(8.2))
  await player.settled()
  await wait(100)
  player.mirrorProbe = null
  const { main, mirror } = seen ?? { main: [0], mirror: [1] }
  if (!seen || !(seen as { same: boolean }).same) reasons.push('no frame was shown on the window’s preview')
  const mirrorDiff = Math.round((main.reduce((n, v, i) => n + Math.abs(v - mirror[i]!), 0) / main.length) * 1e4) / 1e4
  const mirrorLit = Math.round((mirror.reduce((n, v) => n + v, 0) / mirror.length) * 1e3) / 1e3
  if (!(mirrorDiff < 0.02 && mirrorLit > 0.05)) reasons.push(`the window’s preview isn’t the Program monitor’s picture (difference ${mirrorDiff}, brightness ${mirrorLit})`)

  // ---- Mark Clip: take_a soloed (nothing marked yet) ----
  button(win()!, 'Mark Clip')!.click()
  await wait(200)
  const soloedFirst = multicamUi.solo === angleOf('take_a').id && multicamUi.marking
  if (!soloedFirst) reasons.push(`Mark Clip soloed ${multicamUi.solo} (marking ${multicamUi.marking}), not take_a`)
  // The preview shows take_a alone: as take_a on its own track.
  const soloed = await stillRow(8)
  const aTrack = take('take_a').trackId
  const alone = await (async () => {
    multicamUi.setSolo(null)
    programView.set((seq) => ({ ...seq, tracks: seq.tracks.map((t) => (t.kind !== 'video' ? t : { ...t, visible: t.id === aTrack })) }))
    const row = await stillRow(8)
    programView.set(null)
    multicamUi.setSolo(angleOf('take_a').id)
    return row
  })()
  const soloMean = Math.round(rowMean(soloed, alone) * 1e5) / 1e5
  if (!(soloMean < 0.002)) reasons.push(`the soloed preview isn’t take_a alone (mean ${soloMean})`)
  // M at 7 s, M at 11 s.
  const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  timelineController.setPlayhead(s(7))
  key('m')
  await wait(60)
  const pendingAt = multicamUi.pendingIn ? ticksToSeconds(multicamUi.pendingIn.at) : null
  timelineController.setPlayhead(s(11))
  key('m')
  await wait(150)
  const marked = angleOf('take_a').favourites.map((f) => [ticksToSeconds(f.from + zero('take_a')), ticksToSeconds(f.to + zero('take_a'))])
  if (pendingAt !== 7 || marked.length !== 1 || Math.abs(marked[0]![0]! - 7) > 1e-6 || Math.abs(marked[0]![1]! - 11) > 1e-6) reasons.push(`M at 7 s then 11 s marked ${JSON.stringify(marked)} (in at ${pendingAt})`)
  const markers = sequence().markers.length
  if (markers !== 0) reasons.push(`M also added ${markers} timeline markers`)
  // 2 solos take_b while marking.
  key('2')
  await wait(100)
  const twoSolos = multicamUi.solo === angleOf('take_b').id
  if (!twoSolos) reasons.push('2 didn’t solo take_b while marking')
  key('1')
  await wait(100)

  // Dragging the mark's end on take_a's strip, 11 → 12.5 s: one undo step.
  const { span } = stripLanes(sequence(), group(), angleOf('take_a'))
  const box = strip('take_a').getBoundingClientRect()
  const xAt = (seconds: number) => box.left + ((s(seconds) - span!.from) / (span!.to - span!.from)) * box.width
  const secondsPerPx = ticksToSeconds(span!.to - span!.from) / box.width
  const pointer = async (type: string, seconds: number) => {
    strip('take_a').dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 9, clientX: xAt(seconds), clientY: box.top + box.height / 2 }))
    await wait(40)
  }
  await pointer('pointerdown', 11)
  await pointer('pointermove', 12)
  await pointer('pointermove', 12.5)
  await pointer('pointerup', 12.5)
  const changed = angleOf('take_a').favourites.map((f) => ticksToSeconds(f.to + zero('take_a')))
  const tolerance = 1.5 * secondsPerPx + 0.04
  if (changed.length !== 1 || Math.abs(changed[0]! - 12.5) > tolerance) reasons.push(`dragging the end to 12.5 s gave ${JSON.stringify(changed)}`)
  projectController.undo()
  const undone = angleOf('take_a').favourites.map((f) => ticksToSeconds(f.to + zero('take_a')))
  if (undone.length !== 1 || Math.abs(undone[0]! - 11) > 1e-6) reasons.push(`one undo after the end drag gave ${JSON.stringify(undone)}`)
  // Clicking the empty strip moves the playhead.
  await pointer('pointerdown', 15)
  await pointer('pointerup', 15)
  const scrubbed = ticksToSeconds(timelineController.playhead)
  if (Math.abs(scrubbed - 15) > tolerance) reasons.push(`clicking the strip at 15 s put the playhead at ${scrubbed.toFixed(2)} s`)
  // Selected (a click on it), ⌫ deletes it and nothing else.
  const before = sequence().clips.length
  await pointer('pointerdown', 9)
  await pointer('pointerup', 9)
  strip('take_a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
  await wait(150)
  if (angleOf('take_a').favourites.length !== 0) reasons.push('⌫ didn’t delete the selected mark')
  if (sequence().clips.length !== before) reasons.push(`⌫ changed the clips too (${before} → ${sequence().clips.length})`)
  button(win()!, 'Mark Clip')!.click()
  multicamUi.setSolo(null)
  await wait(100)

  // ---- Right-click › B-Roll ----
  row('take_noise').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))
  await wait(150)
  ;[...document.querySelectorAll<HTMLButtonElement>('.context-menu button')].find((b) => b.textContent?.trim() === 'B-Roll')?.click()
  await wait(150)
  if (!angleOf('take_noise').bRoll || !strip('take_noise').classList.contains('b-roll')) reasons.push('right-click › B-Roll didn’t make take_noise B-roll')

  // ---- Automatic ----
  // Favourite parts (song time; take_noise's own time), exact.
  const mark = (name: string, from: number, to: number, own = false) => {
    const off = own ? 0 : zero(name)
    projectController.dispatch(addFavourite(group().id, angleOf(name).id, take(name).id, s(from) - off, s(to) - off))
  }
  mark('take_early', 0, 6.3)
  mark('take_a', 6, 13.2)
  mark('take_b', 13.6, 17)
  mark('take_noise', 2, 5.5, true)
  projectController.dispatch(setSequenceMarks({ in: 0, out: s(20) }))
  await wait(200)
  if (multicamUi.cutEvery !== 'bar') reasons.push(`Cut Every starts on ${multicamUi.cutEvery}, not a bar`)
  const undoLabel = () => projectController.historyView?.undoLabel ?? null
  const labelBefore = undoLabel()
  button(win()!.querySelector('.multicam-auto')!, 'Make the Edit')?.click()
  await wait(400)
  const pieces = sequence().clips.filter((c) => c.trackId === group().programTrackId && c.kind === 'video').sort((a, b) => a.start - b.start)
  const made = pieces.map((p) => [p.name, ticksToSeconds(p.start), ticksToSeconds(clipEnd(p)), Math.round(ticksToSeconds(p.sourceIn) * 100) / 100])
  const expected = [
    ['take_early', 0, 6],
    ['take_a', 6, 13],
    ['take_noise', 13, 14, 2],
    ['take_b', 14, 17],
    ['take_noise', 17, 19.52, 3],
    ['take_b', 19.52, 20]
  ]
  const matches = made.length === expected.length && expected.every((e, i) => e[0] === made[i]![0] && Math.abs((e[1] as number) - (made[i]![1] as number)) < 1e-6 && Math.abs((e[2] as number) - (made[i]![2] as number)) < 1e-6 && (e[3] === undefined || Math.abs((e[3] as number) - (made[i]![3] as number)) < 1e-6))
  if (!matches) reasons.push(`Automatic made ${JSON.stringify(made)}`)
  if (!pieces.filter((p) => p.name !== 'take_noise').every((p) => p.start - p.sourceIn === zero(p.name))) reasons.push('a synced piece isn’t in sync with its take')
  const gaps = multicamUi.gaps.map((g) => [ticksToSeconds(g.from), ticksToSeconds(g.to)])
  const listed = document.querySelectorAll('.multicam-gaps .button.gap').length
  const flagged = multicamUi.flags().length
  if (gaps.length !== 1 || Math.abs(gaps[0]![0]! - 19.52) > 1e-6 || gaps[0]![1] !== 20 || listed !== 1 || flagged !== 1) reasons.push(`gaps ${JSON.stringify(gaps)}, listed ${listed}, flagged ${flagged}`)

  // The B-roll piece at 13.48 s shows take_noise's frame at its own 2.48 s (the edit, not the grid).
  multicamUi.setView(false)
  const program = await stillRow(13.48)
  programView.set((seq) => ({ ...seq, tracks: seq.tracks.map((t) => (t.kind !== 'video' ? t : { ...t, visible: t.id === noiseTrack })) }))
  const noiseAlone = await stillRow(ticksToSeconds(zero('take_noise')) + 2.48)
  programView.set(null)
  const bRollMean = Math.round(rowMean(program, noiseAlone) * 1e5) / 1e5
  if (!(bRollMean < 0.002)) reasons.push(`the B-roll piece doesn’t show take_noise at 2.48 s (mean ${bRollMean})`)

  // One undo step.
  const labelAfter = undoLabel()
  projectController.undo()
  const left = sequence().clips.filter((c) => c.trackId === group().programTrackId).length
  if (left !== 0 || undoLabel() !== labelBefore) reasons.push(`one undo left ${left} pieces (undo label ${undoLabel()})`)
  projectController.redo()

  // ---- The Control Panel's button closes the window: the preview is the edit again ----
  button(document.querySelector('.control-panel')!, 'Multi-Camera')?.click()
  await wait(300)
  const closed = !win() && !multicamUi.windowOpen && !programView.active
  if (!closed) reasons.push(`closing: window ${Boolean(win())}, open ${multicamUi.windowOpen}, preview filtered ${programView.active}`)

  // Open again for the picture.
  multicamUi.open()
  await wait(300)
  workspaceController.focus('multicam')
  timelineController.zoomToFit()
  multicamUi.setSolo(angleOf('take_a').id)
  multicamUi.toggleMarking()
  timelineController.setPlayhead(s(8))
  key('m')
  timelineController.setPlayhead(s(9.6))
  await wait(400)
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, opened, keys, labels, mirrorDiff, mirrorLit, soloMean, pendingAt, marked, changed, scrubbed, made, gaps, listed, flagged, bRollMean, labelAfter, closed, tolerance }
}
