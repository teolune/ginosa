import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { placeMedia } from '@engine/timeline/edits'
import { clipEnd } from '@engine/timeline/timeline'
import { readRowBoxes } from '../playback/colour-probe'
import { player } from '../playback/player'
import { programView } from '../playback/program-view'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { multicamUi } from './multicam-ui'

/**
 * W5.2 and W5.3 through the app: the song on A1, and three takes made from it (make-test-media.sh:
 * take_a in sync from 5.2 s, take_b from 13.36 s, take_early starting 1.5 s before the song).
 *  - Media panel › Add to Multi-Camera: each take on a track of its own, in sync, on keys 1–3;
 *  - the multi-camera view shows each take in its cell (and nothing where a take has nothing);
 *  - recording while the song plays: keys pressed at 8, 9.6 and 14 s cut to angles 3, 1 and 2;
 *    the pieces cut there (within two frames of the press), each in sync with its take, and the
 *    Program monitor shows each piece exactly as its take on its own track;
 *  - a key switches the selected piece to another angle;
 *  - a sync point moves a take so the marked moment is at the playhead.
 */

const s = secondsToTicks
const XS = Array.from({ length: 480 }, (_, i) => i * 4)
const ROW = 300

function rowMean(a: number[][], b: number[][]): number {
  let sum = 0
  a.forEach((p, i) => p.forEach((v, c) => (sum += Math.abs(v - b[i]![c]!))))
  return sum / (a.length * 3)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function stillRow(at: number): Promise<number[][]> {
  timelineController.setPlayhead(s(at))
  await player.settled()
  return readRowBoxes(player.lastStill!, XS, ROW)
}

/** Waits until playback reaches `seconds`. */
async function until(seconds: number): Promise<number> {
  const started = performance.now()
  while (ticksToSeconds(timelineController.playhead) < seconds) {
    if (performance.now() - started > 30_000) throw new Error(`playback didn’t reach ${seconds} s`)
    await wait(5)
  }
  return ticksToSeconds(timelineController.playhead)
}

export async function multicamTest() {
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
  const takes = ['take_a', 'take_b', 'take_early'].map(item)

  // A group straight from the media, synced.
  const groupId = await multicamUi.addMedia(takes.map((t) => t.id))
  const sequence = () => projectController.project!.sequence
  const group = () => sequence().multicam.find((g) => g.id === groupId)!
  if (!groupId) return { verdict: 'fail', reasons: [`no group: ${projectController.lastError}`] }
  const takeClip = (name: string) => sequence().clips.find((c) => c.kind === 'video' && c.name === name && !c.multicam)!
  const zero = (name: string) => ticksToSeconds(takeClip(name).start - takeClip(name).sourceIn)
  const synced = { take_a: zero('take_a'), take_b: zero('take_b'), take_early: zero('take_early') }
  for (const [name, expected] of [['take_a', 5.2], ['take_b', 13.36], ['take_early', -1.5]] as const) if (Math.abs(synced[name] - expected) > 0.001) reasons.push(`${name} isn't in sync: its file starts at ${synced[name].toFixed(4)} s, not ${expected}`)
  const keys = group().angles.map((a) => [sequence().tracks.find((t) => t.id === a.trackId)?.name, a.key])
  const angleTracksHidden = group().angles.every((a) => !sequence().tracks.find((t) => t.id === a.trackId)!.visible)
  if (!angleTracksHidden) reasons.push('the angles’ tracks aren’t hidden')

  // The multi-camera view: 2 × 2 cells; at 8 s take_a (top left) and take_early (bottom left) have pictures, take_b (top right) not yet.
  multicamUi.setView(true)
  timelineController.setPlayhead(s(8))
  await player.settled()
  const cellRow = async (y: number) => readRowBoxes(player.lastStill!, XS, y)
  const top = await cellRow(270)
  const bottom = await cellRow(810)
  const level = (row: number[][], from: number, to: number) => {
    const part = row.filter((_, i) => XS[i]! >= from && XS[i]! < to)
    return part.reduce((n, p) => n + p[0]! + p[1]! + p[2]!, 0) / (part.length * 3)
  }
  const cells = { a: level(top, 40, 920), b: level(top, 1000, 1880), early: level(bottom, 40, 920), empty: level(bottom, 1000, 1880) }
  if (!(cells.a > 0.1 && cells.early > 0.1 && cells.b < 0.01 && cells.empty < 0.01)) reasons.push(`the multi-camera view at 8 s: ${JSON.stringify(cells)}`)

  // Recording: from 6 s on angle 1; keys at 8 s (3), 9.6 s (1), 14 s (2); stop at 16 s.
  multicamUi.setView(false)
  timelineController.setPlayhead(s(6))
  await player.settled()
  multicamUi.live = null
  multicamUi.record()
  const pressedAt: number[] = []
  const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  await until(8)
  key('3')
  pressedAt.push(ticksToSeconds(timelineController.playhead))
  await until(9.6)
  key('1')
  pressedAt.push(ticksToSeconds(timelineController.playhead))
  await until(14)
  key('2')
  pressedAt.push(ticksToSeconds(timelineController.playhead))
  await until(16)
  multicamUi.record()
  await wait(400)
  // The edit, not the grid (the Multi-Camera window keeps the grid while it's open).
  multicamUi.setView(false)
  const pieces = sequence().clips.filter((c) => c.trackId === group().programTrackId).sort((a, b) => a.start - b.start)
  const recorded = pieces.map((p) => ({ take: p.name, from: ticksToSeconds(p.start), to: ticksToSeconds(clipEnd(p)), inSync: Math.abs(ticksToSeconds(p.start - p.sourceIn) - zero(p.name)) < 1e-6 }))
  if (recorded.map((r) => r.take).join() !== 'take_a,take_early,take_a,take_b') reasons.push(`recorded ${recorded.map((r) => r.take).join(', ')}`)
  else {
    const cutsAt = recorded.slice(1).map((r) => r.from)
    cutsAt.forEach((c, i) => {
      if (Math.abs(c - pressedAt[i]!) > 0.081) reasons.push(`cut ${i + 1} is at ${c.toFixed(2)} s, pressed at ${pressedAt[i]!.toFixed(2)} s`)
    })
    if (Math.abs(recorded[0]!.from - 6) > 0.001) reasons.push(`the recording starts at ${recorded[0]!.from} s, not 6`)
  }
  if (!recorded.every((r) => r.inSync)) reasons.push('a piece isn’t in sync with its take')

  // Each piece shows its take exactly: the Program monitor against the take alone on its track.
  const views: Array<{ at: number; take: string; mean: number }> = []
  for (const r of recorded) {
    const at = Math.round(((r.from + r.to) / 2) * 25) / 25
    const program = await stillRow(at)
    const track = takeClip(r.take).trackId
    programView.set((seq) => ({ ...seq, tracks: seq.tracks.map((t) => (t.kind !== 'video' ? t : { ...t, visible: t.id === track })) }))
    const alone = await stillRow(at)
    programView.set(null)
    views.push({ at, take: r.take, mean: Math.round(rowMean(program, alone) * 1e5) / 1e5 })
  }
  if (!views.every((v) => v.mean < 0.002)) reasons.push(`a piece doesn’t show its take: ${JSON.stringify(views)}`)

  // A key switches the selected piece: the last (take_b) to angle 1 (take_a).
  const last = sequence().clips.filter((c) => c.trackId === group().programTrackId).sort((a, b) => b.start - a.start)[0]!
  timelineController.select([last.id], 'replace')
  key('1')
  await wait(200)
  const switched = sequence().clips.filter((c) => c.trackId === group().programTrackId).sort((a, b) => b.start - a.start)[0]!
  if (switched.name !== 'take_a' || switched.start !== last.start || clipEnd(switched) !== clipEnd(last)) reasons.push(`switching the last piece to 1 gave ${switched.name} ${ticksToSeconds(switched.start)}–${ticksToSeconds(clipEnd(switched))}`)

  // A sync point: take_early's moment at 3 s, lined up at 3.4 s, moves it 0.4 s later.
  const earlyTrack = takeClip('take_early').trackId
  timelineController.setPlayhead(s(3))
  multicamUi.markSyncPoint(earlyTrack)
  timelineController.setPlayhead(s(3.4))
  multicamUi.lineUpHere()
  const movedBy = zero('take_early') - synced.take_early
  if (Math.abs(movedBy - 0.4) > 1e-6) reasons.push(`the sync point moved take_early ${movedBy.toFixed(3)} s`)
  projectController.undo()

  timelineController.zoomToFit()
  multicamUi.setView(true)
  multicamUi.open()
  timelineController.setPlayhead(s(15))
  return { verdict: reasons.length ? 'fail' : 'pass', reasons, synced, keys, cells, pressedAt, recorded, views, switched: switched.name, syncPointMovedBy: Math.round(movedBy * 1000) / 1000 }
}
