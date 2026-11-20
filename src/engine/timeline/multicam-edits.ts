import { CommandError } from '../project/commands'
import { createTrack, defaultId, MULTICAM_KEYS, type Clip, type IdFactory, type MulticamAngle, type MulticamGroup, type Sequence } from '../project/model'
import type { Ticks } from '../time'
import { shiftKeyframeMap } from '../keyframes/keyframes'
import { applyPlace, timelineCommand, type TimelineCommand } from './edits'
import { syncPlacement } from './sync-edits'
import { EditContext, assertUnlocked, clearRange, clipEnd, cloneClip, cutHead, cutTail, findTrack, frameTicks, mediaLength, tracksOf } from './timeline'

/**
 * Multi-camera (W5, decision 134). A group is a set of angles, each a video track holding one
 * camera's takes in sync with the song, and a track above them where its pieces go. A piece is
 * an ordinary clip: the stretch of the angle's take under it, copied in sync, with the take's
 * effects already on it ("baked in", still editable). So pieces play, export, trim and take
 * effects like any clip; the group remembers which angle each came from, so it can be switched.
 */

/** A group's name for an angle: its track's. */
export function angleName(sequence: Sequence, angle: MulticamAngle): string {
  return sequence.tracks.find((t) => t.id === angle.trackId)?.name ?? 'Angle'
}

export function groupOf(sequence: Sequence, groupId: string): MulticamGroup {
  const group = sequence.multicam.find((g) => g.id === groupId)
  if (!group) throw new CommandError('That multi-camera group is gone')
  return group
}

/**
 * A new group from these takes: each video track holding one of them is an angle (V1 first, on
 * 1, then 2…: up to 11, on 1–9, 0 and the comma). A new video track above all the others takes
 * its pieces. The angles' tracks are hidden and the sound of their takes muted (the song plays).
 */
export function newMulticamGroup(clipIds: readonly string[], newId: IdFactory = defaultId): TimelineCommand & { groupId: string } {
  const groupId = newId()
  const command = timelineCommand('New Multi-Camera Group', (draft) => applyNewGroup(draft.sequence, clipIds, groupId, newId)) as TimelineCommand & { groupId: string }
  command.groupId = groupId
  return command
}

function applyNewGroup(sequence: Sequence, clipIds: readonly string[], groupId: string, newId: IdFactory): void {
  const video = tracksOf(sequence, 'video')
  const chosen = new Set(sequence.clips.filter((c) => clipIds.includes(c.id) && c.kind === 'video' && !c.adjustment && !c.multicam).map((c) => c.trackId))
  const angleTracks = video.filter((t) => chosen.has(t.id))
  if (angleTracks.length === 0) throw new CommandError('Select the takes (video clips) to make a group of')
  if (angleTracks.length > MULTICAM_KEYS.length) throw new CommandError(`A group has at most ${MULTICAM_KEYS.length} angles (1–9, 0 and the comma): the takes are on ${angleTracks.length} tracks`)
  const program = createTrack('video', video.length, newId)
  program.name = `Multi-Camera ${sequence.multicam.length + 1}`
  sequence.tracks.push(program)
  const angles: MulticamAngle[] = angleTracks.map((t, i) => ({ id: newId(), trackId: t.id, key: MULTICAM_KEYS[i]!, bRoll: false, favourites: [] }))
  sequence.multicam.push({ id: groupId, name: program.name, programTrackId: program.id, angles })
  // The angles are seen only through the pieces; their own sound is off.
  const angleIds = new Set(angleTracks.map((t) => t.id))
  const links = new Set(sequence.clips.filter((c) => angleIds.has(c.trackId) && c.linkId).map((c) => c.linkId))
  const soundTracks = new Set(sequence.clips.filter((c) => c.kind === 'audio' && c.linkId && links.has(c.linkId)).map((c) => c.trackId))
  for (const t of sequence.tracks) {
    if (angleIds.has(t.id)) t.visible = false
    if (soundTracks.has(t.id)) t.muted = true
  }
}

/** A take for a new group from the media: where its file starts in the song's (seconds), or null when it isn't synced (it goes at the start). */
export interface TakeToPlace {
  mediaId: string
  offset: number | null
}

/**
 * A new group straight from media (the Media panel): each take on a new video track of its own
 * (its picture only: the song is the sound), in sync with `song` where it was heard, then the
 * group, all in one undo step.
 */
export function newMulticamFromMedia(takes: readonly TakeToPlace[], song: Clip | null, newId: IdFactory = defaultId): TimelineCommand & { groupId: string; clipIds: string[] } {
  const groupId = newId()
  const clipIds: string[] = []
  const command = timelineCommand('New Multi-Camera Group', (draft) => {
    const sequence = draft.sequence
    if (takes.length === 0) throw new CommandError('Select the takes (video files) to make a group of')
    if (takes.length > MULTICAM_KEYS.length) throw new CommandError(`A group has at most ${MULTICAM_KEYS.length} angles (1–9, 0 and the comma)`)
    const ctx = new EditContext(newId)
    for (const take of takes) {
      const item = draft.media.find((m) => m.id === take.mediaId)
      if (!item || !item.info.video) throw new CommandError('A take isn’t a video file in the project')
      const track = createTrack('video', tracksOf(sequence, 'video').length, newId)
      track.name = item.name
      sequence.tracks.push(track)
      const length = mediaLength(item) ?? 0
      const [clip] = applyPlace(sequence, draft.media, { mediaId: item.id, sourceIn: 0, sourceOut: length, at: 0, videoTrackId: track.id, audioTrackId: null, mode: 'overwrite' }, ctx)
      if (!clip) continue
      if (take.offset !== null && song) {
        const place = syncPlacement(sequence, draft.media, song, clip, take.offset)
        if (!('problem' in place)) Object.assign(clip, place)
      }
      clipIds.push(clip.id)
    }
    applyNewGroup(sequence, clipIds, groupId, newId)
  }) as TimelineCommand & { groupId: string; clipIds: string[] }
  command.groupId = groupId
  command.clipIds = clipIds
  return command
}

/**
 * The pieces showing `angle` over [from, to): a copy of each of its takes there, trimmed to the
 * stretch (so in sync: the same frame at the same moment), with its effects, on the group's
 * track. A stretch the angle has no take in stays empty.
 */
export function anglePieces(sequence: Sequence, group: MulticamGroup, angle: MulticamAngle, from: Ticks, to: Ticks, newId: IdFactory): Clip[] {
  const out: Clip[] = []
  for (const take of sequence.clips) {
    if (take.trackId !== angle.trackId || take.kind !== 'video' || take.adjustment) continue
    const start = Math.max(from, take.start)
    const end = Math.min(to, clipEnd(take))
    if (end <= start) continue
    const piece = { ...cloneClip(take), id: newId(), trackId: group.programTrackId, linkId: null, transitionIn: null, transitionOut: null }
    cutHead(piece, start - take.start)
    cutTail(piece, clipEnd(piece) - end)
    piece.multicam = { groupId: group.id, angleId: angle.id, angleEffects: piece.effects.map((e) => e.id) }
    out.push(piece)
  }
  return out.sort((a, b) => a.start - b.start)
}

/** A recorded switch: from `at`, `angleId` is live. */
export interface Switch {
  at: Ticks
  angleId: string
}

/**
 * Writes a recording (W5.3) over [from, to) on the group's track: what was there goes, and each
 * switch's angle runs until the next switch. One undo step.
 */
export function recordMulticam(groupId: string, from: Ticks, to: Ticks, switches: readonly Switch[], newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Record Multi-Camera', (draft) => {
    const sequence = draft.sequence
    const group = groupOf(sequence, groupId)
    assertUnlocked(findTrack(sequence, group.programTrackId))
    const frame = frameTicks(sequence)
    const snap = (t: Ticks) => Math.round(t / frame) * frame
    const start = snap(from)
    const end = snap(to)
    if (end <= start) throw new CommandError('Nothing was recorded')
    const cuts = [...switches].map((s) => ({ ...s, at: Math.min(end, Math.max(start, snap(s.at))) })).sort((a, b) => a.at - b.at)
    if (cuts.length === 0 || cuts[0]!.at > start) throw new CommandError('A recording starts on an angle')
    clearRange(sequence, group.programTrackId, start, end, new EditContext(newId))
    cuts.forEach((cut, i) => {
      const until = i + 1 < cuts.length ? cuts[i + 1]!.at : end
      const angle = group.angles.find((a) => a.id === cut.angleId)
      if (!angle) throw new CommandError('A switch is to an angle that isn’t in the group')
      if (until > cut.at) sequence.clips.push(...anglePieces(sequence, group, angle, cut.at, until, newId))
    })
  })
}

/**
 * Switches pieces to another angle (W5.2): each is replaced by that angle over the same stretch.
 * Effects that came with the old angle go; any added to the piece stay, on top of the new
 * angle's. One undo step.
 */
export function switchAngle(pieceIds: readonly string[], angleId: string, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Switch Angle', (draft) => {
    const sequence = draft.sequence
    const pieces = sequence.clips.filter((c) => pieceIds.includes(c.id) && c.multicam)
    if (pieces.length === 0) throw new CommandError('Select multi-camera pieces to switch')
    for (const piece of pieces) {
      const group = groupOf(sequence, piece.multicam!.groupId)
      const angle = group.angles.find((a) => a.id === angleId)
      if (!angle) throw new CommandError('That angle isn’t in the piece’s group')
      if (piece.multicam!.angleId === angleId) continue
      const added = piece.effects.filter((e) => !piece.multicam!.angleEffects.includes(e.id))
      sequence.clips = sequence.clips.filter((c) => c.id !== piece.id)
      const replacements = anglePieces(sequence, group, angle, piece.start, clipEnd(piece), newId)
      for (const r of replacements) {
        // The piece's own effects, keyframes kept where they were in the sequence.
        const extra = added.map((e) => {
          const copy = { ...e, id: newId(), keyframes: Object.fromEntries(Object.entries(e.keyframes).map(([k, t]) => [k, t.map((kf) => ({ ...kf }))])) }
          shiftKeyframeMap(copy.keyframes, piece.start - r.start)
          return copy
        })
        r.effects.push(...extra)
        r.opacity = piece.opacity
        r.blendMode = piece.blendMode
      }
      sequence.clips.push(...replacements)
    }
  })
}

/** Moves a group's angle to another key (the one there takes the angle's old key). */
export function setAngleKey(groupId: string, angleId: string, key: string): TimelineCommand {
  return timelineCommand('Change Angle Key', (draft) => {
    const group = groupOf(draft.sequence, groupId)
    if (!(MULTICAM_KEYS as readonly string[]).includes(key)) throw new CommandError('Angles go on 1–9, 0 and the comma')
    const angle = group.angles.find((a) => a.id === angleId)
    if (!angle) throw new CommandError('That angle isn’t in the group')
    const other = group.angles.find((a) => a.key === key && a.id !== angleId)
    if (other) other.key = angle.key
    angle.key = key
  })
}

/** Removes a group: its pieces stay as ordinary clips, its angles' tracks as they are. */
export function removeMulticamGroup(groupId: string): TimelineCommand {
  return timelineCommand('Remove Multi-Camera Group', (draft) => {
    const sequence = draft.sequence
    groupOf(sequence, groupId)
    sequence.multicam = sequence.multicam.filter((g) => g.id !== groupId)
    for (const c of sequence.clips) if (c.multicam?.groupId === groupId) delete c.multicam
  })
}
