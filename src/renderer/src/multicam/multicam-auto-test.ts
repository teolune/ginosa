import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { placeMedia } from '@engine/timeline/edits'
import { addFavourite } from '@engine/timeline/multicam-edits'
import { setSequenceMarks } from '@engine/timeline/sequence-marks'
import { clipEnd } from '@engine/timeline/timeline'
import { readRowBoxes } from '../playback/colour-probe'
import { player } from '../playback/player'
import { programView } from '../playback/program-view'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { stripLanes } from './FavouriteStrip'
import { multicamUi } from './multicam-ui'

/**
 * W5.4 and W5.5 through the app: the song on A1 (120 BPM), a group of take_a, take_b, take_early
 * (synced) and take_noise (the song isn't in it: B-roll).
 *  - dragging across take_a's strip marks a favourite there (the playhead follows, and the
 *    multi-camera view is on while you drag); dragging its end changes it (one undo step);
 *    ⌫ deletes the selected one and nothing else;
 *  - the B-Roll button makes take_noise B-roll;
 *  - Make the Edit, every bar between In (0) and Out (20 s): take_early 0–6, take_a 6–13,
 *    take_noise 13–14 (from its 2 s), take_b 14–17, take_noise 17–19.52 (on from 3 s), and the
 *    gap 19.52–20 (take_b holds) flagged and listed; each synced piece in sync with its take, the
 *    B-roll piece showing take_noise's own frame; one undo step.
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
  const groupId = await multicamUi.newGroupFromMedia(['take_a', 'take_b', 'take_early', 'take_noise'].map((n) => item(n).id))
  if (!groupId) return { verdict: 'fail', reasons: [`no group: ${projectController.lastError}`] }
  multicamUi.open()
  multicamUi.setView(false)
  await wait(600)
  const sequence = () => projectController.project!.sequence
  const group = () => sequence().multicam.find((g) => g.id === groupId)!
  const take = (name: string) => sequence().clips.find((c) => c.kind === 'video' && c.name === name && !c.multicam)!
  const angleOf = (name: string) => group().angles.find((a) => a.trackId === take(name).trackId)!
  const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.multicam-angle')][group().angles.findIndex((a) => a.id === angleOf(name).id)]!
  const strip = (name: string) => row(name).querySelector<HTMLElement>('.favourite-strip')!
  const zero = (name: string) => take(name).start - take(name).sourceIn

  // ---- Marking by dragging (take_a's strip, song time) ----
  const { span } = stripLanes(sequence(), group(), angleOf('take_a'))
  if (!span) return { verdict: 'fail', reasons: ['take_a’s strip has no span'] }
  const box = strip('take_a').getBoundingClientRect()
  const xAt = (seconds: number) => box.left + ((s(seconds) - span.from) / (span.to - span.from)) * box.width
  const secondsPerPx = ticksToSeconds(span.to - span.from) / box.width
  const pointer = async (type: string, seconds: number) => {
    strip('take_a').dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 9, clientX: xAt(seconds), clientY: box.top + box.height / 2 }))
    await wait(40)
  }
  const undoDepth = () => projectController.historyView?.undoLabel ?? null
  const before = sequence().clips.length
  await pointer('pointerdown', 7)
  await pointer('pointermove', 9)
  const viewWhileDragging = multicamUi.view
  await pointer('pointermove', 11)
  const playheadWhileDragging = ticksToSeconds(timelineController.playhead)
  await pointer('pointerup', 11)
  const viewAfter = multicamUi.view
  const marked = angleOf('take_a').favourites.map((f) => ({ from: ticksToSeconds(f.from + zero('take_a')), to: ticksToSeconds(f.to + zero('take_a')) }))
  const tolerance = 1.5 * secondsPerPx + 0.04
  if (marked.length !== 1 || Math.abs(marked[0]!.from - 7) > tolerance || Math.abs(marked[0]!.to - 11) > tolerance) reasons.push(`dragging 7–11 s marked ${JSON.stringify(marked)}`)
  if (!viewWhileDragging || viewAfter) reasons.push(`the multi-camera view while dragging: ${viewWhileDragging}, after: ${viewAfter}`)
  if (Math.abs(playheadWhileDragging - 11) > tolerance) reasons.push(`the playhead didn’t follow the drag: ${playheadWhileDragging.toFixed(2)} s`)
  // Its end, dragged from 11 to 12.5 s: one undo step.
  await pointer('pointerdown', marked[0]?.to ?? 11)
  await pointer('pointermove', 12)
  await pointer('pointermove', 12.5)
  await pointer('pointerup', 12.5)
  const changed = angleOf('take_a').favourites.map((f) => ticksToSeconds(f.to + zero('take_a')))
  if (changed.length !== 1 || Math.abs(changed[0]! - 12.5) > tolerance) reasons.push(`dragging its end to 12.5 s gave ${JSON.stringify(changed)}`)
  const labelAfterEdge = undoDepth()
  projectController.undo()
  const undone = angleOf('take_a').favourites.map((f) => ticksToSeconds(f.to + zero('take_a')))
  if (undone.length !== 1 || Math.abs(undone[0]! - (marked[0]?.to ?? 11)) > 1e-6) reasons.push(`one undo after the end drag gave ${JSON.stringify(undone)}`)
  // Selected (a click in its middle), ⌫ deletes it and nothing else.
  await pointer('pointerdown', 9)
  await pointer('pointerup', 9)
  strip('take_a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
  await wait(150)
  if (angleOf('take_a').favourites.length !== 0) reasons.push('⌫ didn’t delete the selected favourite')
  if (sequence().clips.length !== before) reasons.push(`⌫ changed the clips too (${before} → ${sequence().clips.length})`)

  // ---- B-roll ----
  const bRollButton = [...row('take_noise').querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'B-Roll')
  bRollButton?.click()
  await wait(150)
  if (!angleOf('take_noise').bRoll || !strip('take_noise').classList.contains('b-roll')) reasons.push('the B-Roll button didn’t make take_noise B-roll')

  // ---- Automatic ----
  // Favourites (song time; take_noise's own time), exact: marked here by command, the drags were checked above.
  const mark = (name: string, from: number, to: number, own = false) => {
    const off = own ? 0 : zero(name)
    projectController.dispatch(addFavourite(groupId, angleOf(name).id, take(name).id, s(from) - off, s(to) - off))
  }
  mark('take_early', 0, 6.3)
  mark('take_a', 6, 13.2)
  mark('take_b', 13.6, 17)
  mark('take_noise', 2, 5.5, true)
  projectController.dispatch(setSequenceMarks({ in: 0, out: s(20) }))
  await wait(200)
  const makeButton = [...document.querySelectorAll<HTMLButtonElement>('.multicam-auto button')].find((b) => b.textContent?.includes('Make the Edit'))
  if (multicamUi.cutEvery !== 'bar') reasons.push(`Cut Every starts on ${multicamUi.cutEvery}, not a bar`)
  const labelBefore = undoDepth()
  makeButton?.click()
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
  const inSync = pieces.filter((p) => p.name !== 'take_noise').every((p) => p.start - p.sourceIn === zero(p.name))
  if (!inSync) reasons.push('a synced piece isn’t in sync with its take')
  const gaps = multicamUi.gaps.map((g) => [ticksToSeconds(g.from), ticksToSeconds(g.to)])
  const listed = document.querySelectorAll('.multicam-gaps .button.gap').length
  const flagged = multicamUi.flags().length
  if (gaps.length !== 1 || Math.abs(gaps[0]![0]! - 19.52) > 1e-6 || gaps[0]![1] !== 20 || listed !== 1 || flagged !== 1) reasons.push(`gaps ${JSON.stringify(gaps)}, listed ${listed}, flagged ${flagged}`)

  // The B-roll piece at 13.5 s shows take_noise's frame at its own 2.5 s.
  const program = await stillRow(13.48)
  const noiseTrack = take('take_noise').trackId
  programView.set((seq) => ({ ...seq, tracks: seq.tracks.map((t) => (t.kind !== 'video' ? t : { ...t, visible: t.id === noiseTrack })) }))
  const alone = await stillRow(ticksToSeconds(take('take_noise').start - take('take_noise').sourceIn) + 2.48)
  programView.set(null)
  const bRollMean = Math.round(rowMean(program, alone) * 1e5) / 1e5
  if (!(bRollMean < 0.002)) reasons.push(`the B-roll piece doesn’t show take_noise at 2.48 s (mean ${bRollMean})`)

  // One undo step.
  const labelAfter = undoDepth()
  projectController.undo()
  const left = sequence().clips.filter((c) => c.trackId === group().programTrackId).length
  if (left !== 0 || undoDepth() !== labelBefore) reasons.push(`one undo left ${left} pieces (undo label ${undoDepth()})`)
  projectController.redo()

  timelineController.zoomToFit()
  multicamUi.setView(true)
  timelineController.setPlayhead(s(13.5))
  await wait(300)
  const favourites = group().angles.map((a) => a.favourites.map((f) => { const c = sequence().clips.find((x) => x.id === f.clipId)!; return [c.name, ticksToSeconds(f.from), ticksToSeconds(f.to), ticksToSeconds(c.start), ticksToSeconds(c.sourceIn)] }))
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, grid: sequence().beatGrid, favourites, marked, changed, labelAfterEdge, made, gaps, listed, flagged, bRollMean, labelAfter, tolerance }
}
