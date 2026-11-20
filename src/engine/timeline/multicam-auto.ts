import { beatAt, beatTime } from '../audio/beat-grid'
import { tempoGrid } from '../audio/tempo-map'
import { DEFAULT_GRID } from '../modulation/curve'
import { CommandError } from '../project/commands'
import { defaultId, type Clip, type IdFactory, type MulticamGroup, type Sequence } from '../project/model'
import type { Ticks } from '../time'
import { shiftKeyframeMap } from '../keyframes/keyframes'
import { timelineCommand, type TimelineCommand } from './edits'
import { anglePieces, groupOf } from './multicam-edits'
import { EditContext, clearRange, clipEnd, cloneClip, frameTicks } from './timeline'

/**
 * Automatic (W5.5, decision 134): an edit made from the favourite parts you marked, cut on the
 * beat. The stretch is cut every `everyBeats` beats on the beat grid (the tempo map). For each
 * piece of it, the synced angles whose favourites cover its start are the candidates: not the
 * angle before (when there's another), then the one used least, then the one whose favourite
 * covers most of it; a favourite that ends partway cuts on the last beat before it ends, and the
 * rest is chosen again. With B-roll on, what no synced favourite covers takes B-roll favourites in
 * turn (each from where it was left), up to where the next synced favourite starts, trimmed to
 * whole beats. What's left is a gap: the last synced angle holds there (where its take has
 * pictures), and the gap is listed.
 */

export type AutoSegment =
  | { kind: 'synced'; from: Ticks; to: Ticks; angleId: string }
  | { kind: 'broll'; from: Ticks; to: Ticks; angleId: string; clipId: string; sourceIn: Ticks }
  | { kind: 'gap'; from: Ticks; to: Ticks; holdAngleId: string | null }

export interface AutoSettings {
  from: Ticks
  to: Ticks
  everyBeats: number
  bRoll: boolean
}

/** Where each synced angle's favourites are on the timeline. */
function syncedFavourites(sequence: Sequence, group: MulticamGroup): Array<{ angleId: string; from: Ticks; to: Ticks }> {
  const out: Array<{ angleId: string; from: Ticks; to: Ticks }> = []
  for (const angle of group.angles) {
    if (angle.bRoll) continue
    for (const f of angle.favourites) {
      const take = sequence.clips.find((c) => c.id === f.clipId)
      if (!take || take.speed !== 1 || take.reverse) continue
      // Inside what the take shows on the timeline.
      const from = Math.max(take.start, take.start + (f.from - take.sourceIn))
      const to = Math.min(clipEnd(take), take.start + (f.to - take.sourceIn))
      if (to > from) out.push({ angleId: angle.id, from, to })
    }
  }
  return out
}

export function planAutomatic(sequence: Sequence, groupId: string, settings: AutoSettings): AutoSegment[] {
  const group = groupOf(sequence, groupId)
  const frame = frameTicks(sequence)
  const grid = tempoGrid(sequence) ?? DEFAULT_GRID
  const snap = (t: Ticks) => Math.round(t / frame) * frame
  const from = snap(settings.from)
  const to = snap(settings.to)
  if (to <= from) return []
  // The cut points: every `everyBeats` beats, and every beat (for favourites that end partway).
  const beats: Ticks[] = []
  for (let b = Math.ceil(beatAt(grid, from) - 1e-9); ; b++) {
    const t = snap(beatTime(grid, b))
    if (t >= to) break
    if (t > from && beats[beats.length - 1] !== t) beats.push(t)
  }
  const cuts = new Set<Ticks>()
  for (let k = Math.ceil(beatAt(grid, from) / settings.everyBeats - 1e-9); ; k++) {
    const t = snap(beatTime(grid, k * settings.everyBeats))
    if (t >= to) break
    if (t > from) cuts.add(t)
  }
  const nextCut = (t: Ticks) => {
    let best = to
    for (const c of cuts) if (c > t && c < best) best = c
    return best
  }
  const lastBeatBefore = (t: Ticks, after: Ticks) => {
    let best: Ticks | null = null
    for (const b of beats) if (b > after && b <= t) best = b
    return best
  }
  /** The first beat after `t`, or the end. */
  const nextBeat = (t: Ticks) => beats.find((b) => b > t) ?? to
  /** The first beat at or after `t` (or the end): shots start on the beat. */
  const beatFrom = (t: Ticks) => beats.find((b) => b >= t) ?? to
  const favourites = syncedFavourites(sequence, group)
  // B-roll favourites, in turn: each with how much of it is used.
  const bRoll = settings.bRoll
    ? group.angles
        .filter((a) => a.bRoll)
        .flatMap((a) => a.favourites.filter((f) => sequence.clips.some((c) => c.id === f.clipId && c.speed === 1 && !c.reverse)).map((f) => ({ angleId: a.id, clipId: f.clipId, from: f.from, to: f.to, used: f.from })))
    : []
  let bRollTurn = 0
  const beatLength = (t: Ticks) => Math.max(frame, snap(beatTime(grid, beatAt(grid, t) + 1)) - t)
  const used = new Map<string, number>()
  const out: AutoSegment[] = []
  let previous: string | null = null
  let lastSynced: string | null = null
  let t = from
  while (t < to) {
    const end = nextCut(t)
    // A favourite counts here if it covers at least to the next beat.
    const candidates = favourites.filter((f) => f.from <= t && f.to >= Math.min(end, nextBeat(t)))
    if (candidates.length) {
      const pool = candidates.some((c) => c.angleId !== previous) ? candidates.filter((c) => c.angleId !== previous) : candidates
      pool.sort((a, b) => (used.get(a.angleId) ?? 0) - (used.get(b.angleId) ?? 0) || Math.min(b.to, end) - Math.min(a.to, end) || group.angles.findIndex((x) => x.id === a.angleId) - group.angles.findIndex((x) => x.id === b.angleId))
      const pick = pool[0]!
      // A favourite that ends partway cuts on the last beat before it ends (or where it ends, if there's none).
      let stop = end
      if (pick.to < end) stop = lastBeatBefore(pick.to, t) ?? snap(pick.to)
      if (stop <= t) stop = Math.min(end, Math.max(t + frame, snap(pick.to)))
      out.push({ kind: 'synced', from: t, to: stop, angleId: pick.angleId })
      used.set(pick.angleId, (used.get(pick.angleId) ?? 0) + 1)
      previous = pick.angleId
      lastSynced = pick.angleId
      t = stop
      continue
    }
    // Nothing synced here, up to the beat where the next favourite can start (or the cut).
    const nextFavourite = Math.min(end, ...favourites.filter((f) => f.from > t).map((f) => f.from))
    const uncovered = Math.max(t + frame, nextFavourite < end ? Math.min(end, beatFrom(nextFavourite)) : end)
    // B-roll there, in turn, each from where it was left, in whole beats.
    let placed = false
    for (let tries = 0; tries < bRoll.length && !placed; tries++) {
      const b = bRoll[(bRollTurn + tries) % bRoll.length]!
      const wanted = uncovered - t
      let length = Math.min(wanted, b.to - b.used)
      if (length < wanted) {
        const stop = lastBeatBefore(t + length, t)
        length = stop !== null ? stop - t : 0
        if (length < beatLength(t)) continue
      }
      out.push({ kind: 'broll', from: t, to: t + length, angleId: b.angleId, clipId: b.clipId, sourceIn: b.used })
      b.used += length
      bRollTurn = (bRollTurn + tries + 1) % bRoll.length
      previous = b.angleId
      t += length
      placed = true
    }
    if (placed) continue
    // A gap: the last synced angle holds there (where its take has pictures).
    const last = out[out.length - 1]
    if (last?.kind === 'gap' && last.to === t) last.to = uncovered
    else out.push({ kind: 'gap', from: t, to: uncovered, holdAngleId: lastSynced })
    t = uncovered
  }
  // Pieces next to each other that run on in the same take are one.
  const merged: AutoSegment[] = []
  for (const s of out) {
    const last = merged[merged.length - 1]
    if (last && last.kind === 'synced' && s.kind === 'synced' && last.angleId === s.angleId && last.to === s.from) last.to = s.to
    else if (last && last.kind === 'broll' && s.kind === 'broll' && last.clipId === s.clipId && last.to === s.from && last.sourceIn + (last.to - last.from) === s.sourceIn) last.to = s.to
    else merged.push({ ...s })
  }
  return merged
}

/** Writes Automatic's plan over its stretch of the group's track (what was there goes), in one undo step. */
export function applyAutomatic(groupId: string, segments: readonly AutoSegment[], newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Automatic Multi-Camera', (draft) => {
    const sequence = draft.sequence
    const group = groupOf(sequence, groupId)
    if (segments.length === 0) throw new CommandError('Nothing to edit: mark some favourites first')
    const from = Math.min(...segments.map((s) => s.from))
    const to = Math.max(...segments.map((s) => s.to))
    clearRange(sequence, group.programTrackId, from, to, new EditContext(newId))
    for (const s of segments) {
      if (s.kind === 'synced' || (s.kind === 'gap' && s.holdAngleId)) {
        const angle = group.angles.find((a) => a.id === (s.kind === 'synced' ? s.angleId : s.holdAngleId))
        if (angle) sequence.clips.push(...anglePieces(sequence, group, angle, s.from, s.to, newId))
      } else if (s.kind === 'broll') {
        const take = sequence.clips.find((c) => c.id === s.clipId)
        if (!take) continue
        const piece: Clip = { ...cloneClip(take), id: newId(), trackId: group.programTrackId, linkId: null, transitionIn: null, transitionOut: null, start: s.from, duration: s.to - s.from, sourceIn: s.sourceIn }
        // Keyframes are from the clip's start: they follow the take's picture.
        shiftKeyframeMap(piece.keyframes, take.sourceIn - s.sourceIn)
        for (const e of piece.effects) shiftKeyframeMap(e.keyframes, take.sourceIn - s.sourceIn)
        piece.multicam = { groupId: group.id, angleId: s.angleId, angleEffects: piece.effects.map((e) => e.id) }
        sequence.clips.push(piece)
      }
    }
  })
}

/** Beats for each Cut Every choice. */
export function cutEveryBeats(id: string, beatsPerBar: number): number {
  return id === 'beat' ? 1 : id === '2beats' ? 2 : id === '2bars' ? 2 * beatsPerBar : id === '4bars' ? 4 * beatsPerBar : beatsPerBar
}
