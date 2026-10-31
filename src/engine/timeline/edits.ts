import type { Draft } from 'immer'
import { CommandError, type Command } from '../project/commands'
import type { MediaItem } from '../project/media'
import { defaultId, type Clip, type IdFactory, type Project, type Sequence, type TrackKind } from '../project/model'
import { secondsToTicks, type Ticks } from '../time'
import { defaultMotion } from './motion'
import {
  DEFAULT_STILL_SECONDS,
  EditContext,
  assertUnlocked,
  blockingClips,
  clearRange,
  clipEnd,
  clipsOnTrack,
  cloneClip,
  cutHead,
  cutTail,
  handles,
  emptyAfter,
  emptyBefore,
  findClip,
  findTrack,
  frameTicks,
  insertSpace,
  mediaFor,
  mediaLength,
  offsetTrack,
  removeSpace,
  sourceSpan,
  sourceTimeAt,
  splitClip,
  syncTracks,
  toFrame
} from './timeline'

/**
 * Timeline edits, as undoable commands. Each has a pure `apply…` function that edits
 * a sequence directly; the timeline uses those for live drag previews and the
 * commands for the real edit, so both always agree.
 */

export type EditMode = 'overwrite' | 'insert'
export type Edge = 'in' | 'out'

/** A command that may leave a note for the user (e.g. which clips a ripple had to split). */
export interface TimelineCommand extends Command {
  notice?: string
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function noteSplits(command: TimelineCommand, sequence: Sequence, ctx: EditContext): void {
  if (ctx.splitElsewhere.length === 0) return
  const names = [...new Set(ctx.splitElsewhere.map((c) => findTrack(sequence, c.trackId).name))].join(', ')
  command.notice = `Sync Lock split ${plural(ctx.splitElsewhere.length, 'clip')} on ${names} to keep ${ctx.splitElsewhere.length === 1 ? 'it' : 'them'} in sync. Turn off Sync Lock on a track (e.g. your song) to leave it whole.`
}

function timelineCommand(label: string, apply: (draft: Draft<Project>, command: TimelineCommand) => void): TimelineCommand {
  const command: TimelineCommand = {
    label,
    apply(draft) {
      command.notice = undefined
      apply(draft, command)
    }
  }
  return command
}

// ---- Placing media -------------------------------------------------------------------

export interface PlaceRequest {
  mediaId: string
  /** Where in the media to start, and (optionally) end; ticks. */
  sourceIn: Ticks
  sourceOut: Ticks | null
  /** Timeline time; rounded to the nearest frame. */
  at: Ticks
  /** Where the picture and the sound go; null leaves that part out. */
  videoTrackId: string | null
  audioTrackId: string | null
  mode: EditMode
}

/** Builds the clips a request would place (linked picture + sound), without adding them. */
export function clipsForPlacement(sequence: Sequence, item: MediaItem, request: PlaceRequest, newId: IdFactory): Clip[] {
  const frame = frameTicks(sequence)
  const length = mediaLength(item)
  const sourceIn = Math.max(0, request.sourceIn)
  const out = request.sourceOut ?? (length ?? sourceIn + secondsToTicks(DEFAULT_STILL_SECONDS))
  const sourceOut = length === null ? out : Math.min(out, length)
  const duration = Math.max(frame, toFrame(sourceOut - sourceIn, frame, 'floor'))
  const start = Math.max(0, toFrame(request.at, frame))
  const parts: Array<[TrackKind, string]> = []
  if (request.videoTrackId && (item.kind === 'image' || item.info.video)) parts.push(['video', request.videoTrackId])
  if (request.audioTrackId && item.kind !== 'image' && item.info.audio) parts.push(['audio', request.audioTrackId])
  if (parts.length === 0) throw new CommandError(`"${item.name}" has nothing to place on ${request.videoTrackId ? 'a video' : 'an audio'} track`)
  const linkId = parts.length > 1 ? newId() : null
  return parts.map(([kind, trackId]) => {
    const track = findTrack(sequence, trackId)
    if (track.kind !== kind) throw new CommandError(`${track.name} is not ${kind === 'video' ? 'a video' : 'an audio'} track`)
    return {
      id: newId(),
      trackId,
      mediaId: item.id,
      kind,
      name: item.name,
      start,
      duration,
      sourceIn,
      linkId,
      // New clips are set to frame size (decision 26).
      motion: defaultMotion(item, sequence.settings),
      opacity: 100,
      blendMode: 'normal' as const,
      volume: 0,
      speed: 1,
      reverse: false,
      transitionIn: null,
      transitionOut: null
    }
  })
}

export function applyPlace(sequence: Sequence, media: MediaItem[], request: PlaceRequest, ctx: EditContext): Clip[] {
  const item = media.find((m) => m.id === request.mediaId)
  if (!item) throw new CommandError('That media is no longer in the project')
  const clips = clipsForPlacement(sequence, item, request, ctx.newId)
  for (const clip of clips) assertUnlocked(findTrack(sequence, clip.trackId))
  const first = clips[0]!
  const destination = clips.map((c) => c.trackId)
  if (request.mode === 'insert') {
    insertSpace(sequence, [...destination, ...syncTracks(sequence, destination)], first.start, first.duration, ctx, new Set(destination))
  } else {
    for (const clip of clips) clearRange(sequence, clip.trackId, clip.start, clipEnd(clip), ctx)
  }
  sequence.clips.push(...clips)
  return clips
}

export function placeMedia(request: PlaceRequest, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand(request.mode === 'insert' ? 'Insert' : 'Overwrite', (draft, command) => {
    const ctx = new EditContext(newId)
    applyPlace(draft.sequence, draft.media, request, ctx)
    noteSplits(command, draft.sequence, ctx)
  })
}

// ---- Moving and copying ------------------------------------------------------------

export interface MoveRequest {
  clipIds: string[]
  /** Time offset; rounded to whole frames. */
  delta: Ticks
  /** Tracks away from the middle (V up, A down), applied to every moved clip. */
  trackOffset: number
  mode: EditMode
  /** Leave the originals where they are (Option-drag, paste). */
  copy: boolean
}

export function applyMove(sequence: Sequence, request: MoveRequest, ctx: EditContext): Clip[] {
  const frame = frameTicks(sequence)
  const delta = toFrame(request.delta, frame)
  const sources = request.clipIds.map((id) => findClip(sequence, id))
  if (sources.length === 0) return []
  const moved: Clip[] = []
  const linkMap = new Map<string, string>()
  for (const clip of sources) {
    const from = findTrack(sequence, clip.trackId)
    if (!request.copy) assertUnlocked(from)
    const to = offsetTrack(sequence, from, request.trackOffset)
    if (!to) throw new CommandError(`There's no track ${request.trackOffset > 0 ? 'beyond' : 'before'} ${from.name}`)
    assertUnlocked(to)
    const start = clip.start + delta
    if (start < 0) throw new CommandError('Clips can’t move before the start of the sequence')
    let linkId = clip.linkId
    if (request.copy && linkId) {
      linkId = linkMap.get(linkId) ?? ctx.newId()
      linkMap.set(clip.linkId!, linkId)
    }
    moved.push({ ...cloneClip(clip), id: request.copy ? ctx.newId() : clip.id, trackId: to.id, start, linkId })
  }
  if (!request.copy) {
    const ids = new Set(request.clipIds)
    sequence.clips = sequence.clips.filter((c) => !ids.has(c.id))
  }
  const destination = [...new Set(moved.map((c) => c.trackId))]
  if (request.mode === 'insert') {
    const start = Math.min(...moved.map((c) => c.start))
    const end = Math.max(...moved.map(clipEnd))
    insertSpace(sequence, [...destination, ...syncTracks(sequence, destination)], start, end - start, ctx, new Set(destination))
  } else {
    for (const clip of moved) clearRange(sequence, clip.trackId, clip.start, clipEnd(clip), ctx)
  }
  sequence.clips.push(...moved)
  return moved
}

export function moveClips(request: MoveRequest, newId: IdFactory = defaultId): TimelineCommand {
  const n = request.clipIds.length
  const label = `${request.copy ? 'Copy' : 'Move'} ${n === 1 ? 'Clip' : `${n} Clips`}`
  return timelineCommand(label, (draft, command) => {
    const ctx = new EditContext(newId)
    applyMove(draft.sequence, request, ctx)
    noteSplits(command, draft.sequence, ctx)
  })
}

// ---- Trimming ------------------------------------------------------------------------

interface Range {
  lo: Ticks
  hi: Ticks
}

function clampTo(range: Range, value: Ticks): Ticks {
  // `+ 0` turns -0 into 0.
  return Math.min(range.hi, Math.max(range.lo, value)) + 0
}

/** Limits from the clip itself: its media (no stills limit) and a one-frame minimum. */
function ownLimits(sequence: Sequence, media: MediaItem[], clip: Clip, edge: Edge): Range {
  const frame = frameTicks(sequence)
  const item = mediaFor(media, clip)
  const length = item ? mediaLength(item) : null
  const spare = handles(clip, length)
  if (edge === 'in') {
    // delta moves the in point: + shortens, - lengthens.
    return { lo: -spare.head, hi: clip.duration - frame }
  }
  return { lo: frame - clip.duration, hi: spare.tail }
}

function intersect(a: Range, b: Range): Range {
  return { lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) }
}

/** The trim delta actually possible for a regular trim (can't pass neighbours, media ends or the sequence start). */
export function limitTrim(sequence: Sequence, media: MediaItem[], clipIds: string[], edge: Edge, delta: Ticks): Ticks {
  let range: Range = { lo: Number.MIN_SAFE_INTEGER, hi: Number.MAX_SAFE_INTEGER }
  for (const id of clipIds) {
    const clip = findClip(sequence, id)
    range = intersect(range, ownLimits(sequence, media, clip, edge))
    const neighbours = clipsOnTrack(sequence, clip.trackId).filter((c) => c.id !== clip.id)
    if (edge === 'in') {
      const previousEnd = neighbours.filter((c) => clipEnd(c) <= clip.start).reduce((end, c) => Math.max(end, clipEnd(c)), 0)
      range = intersect(range, { lo: previousEnd - clip.start, hi: Number.MAX_SAFE_INTEGER })
    } else {
      const nextStart = neighbours.filter((c) => c.start >= clipEnd(clip)).reduce((start, c) => Math.min(start, c.start), Number.MAX_SAFE_INTEGER)
      range = intersect(range, { lo: Number.MIN_SAFE_INTEGER, hi: nextStart - clipEnd(clip) })
    }
  }
  if (range.lo > range.hi) return 0
  return clampTo(range, toFrame(delta, frameTicks(sequence)))
}

function trimEdge(clip: Clip, edge: Edge, delta: Ticks): void {
  if (edge === 'in') cutHead(clip, delta)
  else cutTail(clip, -delta)
}

export interface TrimRequest {
  clipIds: string[]
  edge: Edge
  delta: Ticks
}

export function applyTrim(sequence: Sequence, media: MediaItem[], request: TrimRequest): Ticks {
  for (const id of request.clipIds) assertUnlocked(findTrack(sequence, findClip(sequence, id).trackId))
  const delta = limitTrim(sequence, media, request.clipIds, request.edge, request.delta)
  for (const id of request.clipIds) trimEdge(findClip(sequence, id), request.edge, delta)
  return delta
}

export function trimClips(request: TrimRequest): TimelineCommand {
  return timelineCommand(request.edge === 'in' ? 'Trim In Point' : 'Trim Out Point', (draft) => {
    applyTrim(draft.sequence, draft.media, request)
  })
}

/**
 * Ripple trim (B): the clip's length changes and everything after it on its track,
 * and on sync-locked tracks, moves to follow. The clip's start never moves.
 */
function rippleEditPoint(clips: Clip[], edge: Edge): Ticks {
  return edge === 'out' ? Math.min(...clips.map(clipEnd)) : Math.min(...clips.map((c) => c.start))
}

export function limitRippleTrim(sequence: Sequence, media: MediaItem[], clipIds: string[], edge: Edge, delta: Ticks): Ticks {
  let range: Range = { lo: Number.MIN_SAFE_INTEGER, hi: Number.MAX_SAFE_INTEGER }
  const clips = clipIds.map((id) => findClip(sequence, id))
  for (const clip of clips) range = intersect(range, ownLimits(sequence, media, clip, edge))
  // Shortening removes time from sync-locked tracks; only empty time can go. Trimming a
  // head removes it just after the clip's start, trimming a tail just before its end.
  const others = syncTracks(sequence, new Set(clips.map((c) => c.trackId)))
  const point = rippleEditPoint(clips, edge)
  if (edge === 'out') range = intersect(range, { lo: -emptyBefore(sequence, others, point, Number.MAX_SAFE_INTEGER), hi: Number.MAX_SAFE_INTEGER })
  else range = intersect(range, { lo: Number.MIN_SAFE_INTEGER, hi: emptyAfter(sequence, others, point, Number.MAX_SAFE_INTEGER) })
  if (range.lo > range.hi) return 0
  return clampTo(range, toFrame(delta, frameTicks(sequence)))
}

export function applyRippleTrim(sequence: Sequence, media: MediaItem[], request: TrimRequest, ctx: EditContext): Ticks {
  const clips = request.clipIds.map((id) => findClip(sequence, id))
  for (const clip of clips) assertUnlocked(findTrack(sequence, clip.trackId))
  const delta = limitRippleTrim(sequence, media, request.clipIds, request.edge, request.delta)
  if (delta === 0) return 0
  const change = request.edge === 'out' ? delta : -delta
  const edited = [...new Set(clips.map((c) => c.trackId))]
  const point = rippleEditPoint(clips, request.edge)
  // Later clips on the edited tracks follow their own clip's end.
  const trimmed = new Set(request.clipIds)
  for (const clip of clips) {
    const end = clipEnd(clip)
    for (const other of clipsOnTrack(sequence, clip.trackId)) if (!trimmed.has(other.id) && other.start >= end) other.start += change
  }
  for (const clip of clips) {
    if (request.edge === 'in') {
      // The clip keeps its place; its content slides.
      cutHead(clip, delta)
      clip.start -= delta
    } else cutTail(clip, -delta)
  }
  const others = syncTracks(sequence, edited)
  if (change > 0) insertSpace(sequence, others, point, change, ctx, new Set(edited))
  else if (request.edge === 'out') removeSpace(sequence, others, point + change, point)
  else removeSpace(sequence, others, point, point - change)
  return delta
}

export function rippleTrimClips(request: TrimRequest, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Ripple Trim', (draft, command) => {
    const ctx = new EditContext(newId)
    applyRippleTrim(draft.sequence, draft.media, request, ctx)
    noteSplits(command, draft.sequence, ctx)
  })
}

/**
 * Rolling edit (N): moves a cut between two touching clips; one gets longer, the other
 * shorter, and nothing else moves. Linked clips with a cut at the same time roll too.
 * An edge with nothing touching it trims like a regular trim.
 */
interface RollPair {
  left: Clip | null
  right: Clip | null
}

function rollPairs(sequence: Sequence, clipId: string, edge: Edge): RollPair[] {
  const clip = findClip(sequence, clipId)
  const time = edge === 'out' ? clipEnd(clip) : clip.start
  const atCut = (c: Clip) => (edge === 'out' ? clipEnd(c) === time : c.start === time)
  // The clip, plus linked clips with the same edge at the same time.
  const group = [clip, ...sequence.clips.filter((c) => c.id !== clip.id && clip.linkId !== null && c.linkId === clip.linkId && atCut(c))]
  return group.map((c) => {
    const onTrack = clipsOnTrack(sequence, c.trackId).filter((x) => x.id !== c.id)
    return edge === 'out'
      ? { left: c, right: onTrack.find((x) => x.start === time) ?? null }
      : { left: onTrack.find((x) => clipEnd(x) === time) ?? null, right: c }
  })
}

export function limitRoll(sequence: Sequence, media: MediaItem[], clipId: string, edge: Edge, delta: Ticks): Ticks {
  let range: Range = { lo: Number.MIN_SAFE_INTEGER, hi: Number.MAX_SAFE_INTEGER }
  for (const { left, right } of rollPairs(sequence, clipId, edge)) {
    if (left) range = intersect(range, ownLimits(sequence, media, left, 'out'))
    if (right) range = intersect(range, ownLimits(sequence, media, right, 'in'))
    if (left && !right) range = intersect(range, limitRangeForTrim(sequence, left, 'out'))
    if (right && !left) range = intersect(range, limitRangeForTrim(sequence, right, 'in'))
  }
  if (range.lo > range.hi) return 0
  return clampTo(range, toFrame(delta, frameTicks(sequence)))
}

function limitRangeForTrim(sequence: Sequence, clip: Clip, edge: Edge): Range {
  const neighbours = clipsOnTrack(sequence, clip.trackId).filter((c) => c.id !== clip.id)
  if (edge === 'in') {
    const previousEnd = neighbours.filter((c) => clipEnd(c) <= clip.start).reduce((end, c) => Math.max(end, clipEnd(c)), 0)
    return { lo: previousEnd - clip.start, hi: Number.MAX_SAFE_INTEGER }
  }
  const nextStart = neighbours.filter((c) => c.start >= clipEnd(clip)).reduce((start, c) => Math.min(start, c.start), Number.MAX_SAFE_INTEGER)
  return { lo: Number.MIN_SAFE_INTEGER, hi: nextStart - clipEnd(clip) }
}

export interface RollRequest {
  clipId: string
  edge: Edge
  delta: Ticks
}

export function applyRoll(sequence: Sequence, media: MediaItem[], request: RollRequest): Ticks {
  const pairs = rollPairs(sequence, request.clipId, request.edge)
  for (const { left, right } of pairs) for (const c of [left, right]) if (c) assertUnlocked(findTrack(sequence, c.trackId))
  const delta = limitRoll(sequence, media, request.clipId, request.edge, request.delta)
  for (const { left, right } of pairs) {
    if (left) trimEdge(left, 'out', delta)
    if (right) trimEdge(right, 'in', delta)
  }
  return delta
}

export function rollEdit(request: RollRequest): TimelineCommand {
  return timelineCommand('Rolling Edit', (draft) => {
    applyRoll(draft.sequence, draft.media, request)
  })
}

// ---- Splitting -----------------------------------------------------------------------

/** Splits the given clips at `at` (those that span it). Linked halves stay linked in pairs. */
export function applySplit(sequence: Sequence, clipIds: string[], at: Ticks, ctx: EditContext): number {
  const time = toFrame(at, frameTicks(sequence))
  let count = 0
  for (const id of clipIds) {
    const clip = findClip(sequence, id)
    if (clip.start < time && clipEnd(clip) > time) {
      assertUnlocked(findTrack(sequence, clip.trackId))
      splitClip(sequence, clip, time, ctx)
      count++
    }
  }
  if (count === 0) throw new CommandError('There’s no clip to split at that point')
  return count
}

export function splitClips(clipIds: string[], at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Add Edit', (draft) => {
    applySplit(draft.sequence, clipIds, at, new EditContext(newId))
  })
}

/** Add Edit to All Tracks (Shift+Cmd+K, or Shift+click with the Razor): every unlocked track. */
export function splitAllTracks(at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Add Edit to All Tracks', (draft) => {
    const unlocked = new Set(draft.sequence.tracks.filter((t) => !t.locked).map((t) => t.id))
    const ids = draft.sequence.clips.filter((c) => unlocked.has(c.trackId)).map((c) => c.id)
    applySplit(draft.sequence, ids, at, new EditContext(newId))
  })
}

// ---- Deleting ------------------------------------------------------------------------

export function applyDelete(sequence: Sequence, clipIds: string[]): void {
  const ids = new Set(clipIds)
  for (const clip of sequence.clips) if (ids.has(clip.id)) assertUnlocked(findTrack(sequence, clip.trackId))
  sequence.clips = sequence.clips.filter((c) => !ids.has(c.id))
}

export function deleteClips(clipIds: string[]): TimelineCommand {
  return timelineCommand(clipIds.length === 1 ? 'Delete Clip' : `Delete ${clipIds.length} Clips`, (draft) => {
    applyDelete(draft.sequence, clipIds)
  })
}

/** Merges overlapping or touching time ranges. */
function mergeRanges(ranges: Array<[Ticks, Ticks]>): Array<[Ticks, Ticks]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: Array<[Ticks, Ticks]> = []
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** Ripple delete: removes the clips and closes the gap on their tracks and on sync-locked tracks. */
export function applyRippleDelete(sequence: Sequence, clipIds: string[]): void {
  const clips = clipIds.map((id) => findClip(sequence, id))
  const edited = [...new Set(clips.map((c) => c.trackId))]
  applyDelete(sequence, clipIds)
  const tracks = [...edited, ...syncTracks(sequence, edited)]
  const ranges = mergeRanges(clips.map((c) => [c.start, clipEnd(c)]))
  // Latest first, so earlier ranges keep their positions.
  for (const [start, end] of ranges.reverse()) removeSpace(sequence, tracks, start, end)
}

export function rippleDeleteClips(clipIds: string[]): TimelineCommand {
  return timelineCommand('Ripple Delete', (draft) => {
    applyRippleDelete(draft.sequence, clipIds)
  })
}

/** Ripple Delete on an empty stretch between clips. */
export function rippleDeleteGap(trackId: string, start: Ticks, end: Ticks): TimelineCommand {
  return timelineCommand('Ripple Delete Gap', (draft) => {
    const sequence = draft.sequence
    assertUnlocked(findTrack(sequence, trackId))
    if (blockingClips(sequence, [trackId], start, end).length) throw new CommandError('That stretch isn’t empty')
    removeSpace(sequence, [trackId, ...syncTracks(sequence, [trackId])], start, end)
  })
}

// ---- Linking -------------------------------------------------------------------------

export function linkClips(clipIds: string[], newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Link', (draft) => {
    if (clipIds.length < 2) throw new CommandError('Select at least two clips to link')
    const linkId = newId()
    for (const id of clipIds) findClip(draft.sequence, id).linkId = linkId
  })
}

export function unlinkClips(clipIds: string[]): TimelineCommand {
  return timelineCommand('Unlink', (draft) => {
    for (const id of clipIds) findClip(draft.sequence, id).linkId = null
  })
}

// ---- Copy and paste ------------------------------------------------------------------

/** Clips as copied: positions relative to the earliest one. */
export interface ClipboardClip {
  trackId: string
  mediaId: string
  kind: TrackKind
  name: string
  offset: Ticks
  duration: Ticks
  sourceIn: Ticks
  linkKey: string | null
  motion: Clip['motion']
  opacity: number
  blendMode: Clip['blendMode']
  volume: number
  speed: number
  reverse: boolean
  transitionIn: Clip['transitionIn']
  transitionOut: Clip['transitionOut']
}

export function copyClips(sequence: Sequence, clipIds: string[]): ClipboardClip[] {
  const clips = clipIds.map((id) => findClip(sequence, id))
  if (clips.length === 0) return []
  const first = Math.min(...clips.map((c) => c.start))
  return clips.map((c) => ({
    trackId: c.trackId,
    mediaId: c.mediaId,
    kind: c.kind,
    name: c.name,
    offset: c.start - first,
    duration: c.duration,
    sourceIn: c.sourceIn,
    linkKey: c.linkId,
    motion: { ...c.motion },
    opacity: c.opacity,
    blendMode: c.blendMode,
    volume: c.volume,
    speed: c.speed,
    reverse: c.reverse,
    transitionIn: c.transitionIn ? { ...c.transitionIn } : null,
    transitionOut: c.transitionOut ? { ...c.transitionOut } : null
  }))
}

export function applyPaste(sequence: Sequence, media: MediaItem[], clipboard: ClipboardClip[], at: Ticks, mode: EditMode, ctx: EditContext): Clip[] {
  const start = toFrame(at, frameTicks(sequence))
  const links = new Map<string, string>()
  const clips: Clip[] = clipboard.map((c) => {
    if (!media.some((m) => m.id === c.mediaId)) throw new CommandError(`"${c.name}" is no longer in the project`)
    const track = findTrack(sequence, c.trackId)
    assertUnlocked(track)
    let linkId: string | null = null
    if (c.linkKey) {
      linkId = links.get(c.linkKey) ?? ctx.newId()
      links.set(c.linkKey, linkId)
    }
    return {
      id: ctx.newId(),
      trackId: c.trackId,
      mediaId: c.mediaId,
      kind: c.kind,
      name: c.name,
      start: start + c.offset,
      duration: c.duration,
      sourceIn: c.sourceIn,
      linkId,
      motion: { ...c.motion },
      opacity: c.opacity,
      blendMode: c.blendMode,
      volume: c.volume,
      speed: c.speed,
      reverse: c.reverse,
      transitionIn: c.transitionIn ? { ...c.transitionIn } : null,
      transitionOut: c.transitionOut ? { ...c.transitionOut } : null
    }
  })
  const destination = [...new Set(clips.map((c) => c.trackId))]
  if (mode === 'insert') {
    const end = Math.max(...clips.map(clipEnd))
    insertSpace(sequence, [...destination, ...syncTracks(sequence, destination)], start, end - start, ctx, new Set(destination))
  } else {
    for (const clip of clips) clearRange(sequence, clip.trackId, clip.start, clipEnd(clip), ctx)
  }
  sequence.clips.push(...clips)
  return clips
}

export function pasteClips(clipboard: ClipboardClip[], at: Ticks, mode: EditMode, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand(mode === 'insert' ? 'Paste Insert' : 'Paste', (draft, command) => {
    if (clipboard.length === 0) throw new CommandError('Nothing to paste')
    const ctx = new EditContext(newId)
    applyPaste(draft.sequence, draft.media, clipboard, at, mode, ctx)
    noteSplits(command, draft.sequence, ctx)
  })
}

// ---- Markers -------------------------------------------------------------------------

export function addMarker(at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Add Marker', (draft) => {
    const time = Math.max(0, toFrame(at, frameTicks(draft.sequence)))
    if (draft.sequence.markers.some((m) => m.time === time)) throw new CommandError('There’s already a marker there')
    draft.sequence.markers.push({ id: newId(), time, name: '' })
    draft.sequence.markers.sort((a, b) => a.time - b.time)
  })
}

export function moveMarker(id: string, at: Ticks): TimelineCommand {
  return timelineCommand('Move Marker', (draft) => {
    const marker = draft.sequence.markers.find((m) => m.id === id)
    if (!marker) throw new CommandError('That marker no longer exists')
    marker.time = Math.max(0, toFrame(at, frameTicks(draft.sequence)))
    draft.sequence.markers.sort((a, b) => a.time - b.time)
  })
}

export function renameMarker(id: string, name: string): TimelineCommand {
  const command = timelineCommand('Rename Marker', (draft) => {
    const marker = draft.sequence.markers.find((m) => m.id === id)
    if (!marker) throw new CommandError('That marker no longer exists')
    marker.name = name.trim().slice(0, 200)
  })
  command.coalesceKey = `rename-marker:${id}`
  return command
}

export function removeMarkers(ids: string[]): TimelineCommand {
  return timelineCommand(ids.length === 1 ? 'Delete Marker' : 'Delete Markers', (draft) => {
    const doomed = new Set(ids)
    draft.sequence.markers = draft.sequence.markers.filter((m) => !doomed.has(m.id))
  })
}

// ---- Clip properties (Effect Controls) ---------------------------------------------

export interface ClipPropertyChanges {
  motion?: Partial<Clip['motion']>
  opacity?: number
  blendMode?: Clip['blendMode']
  volume?: number
}

const PROPERTY_LABELS: Record<string, string> = {
  positionX: 'Position',
  positionY: 'Position',
  scale: 'Scale',
  scaleWidth: 'Scale Width',
  rotation: 'Rotation',
  anchorX: 'Anchor Point',
  anchorY: 'Anchor Point',
  opacity: 'Opacity',
  blendMode: 'Blend Mode',
  volume: 'Volume'
}

export const MAX_VOLUME_DB = 15
export const MIN_VOLUME_DB = -96

/**
 * Changes Motion, Opacity, blend mode or Volume on clips. Dragging a value sends many
 * of these; they merge into one undo step.
 */
export function setClipProperties(clipIds: string[], changes: ClipPropertyChanges): TimelineCommand {
  const keys = [...Object.keys(changes.motion ?? {}), ...Object.keys(changes).filter((k) => k !== 'motion')]
  const names = [...new Set(keys.map((k) => PROPERTY_LABELS[k] ?? k))]
  const command = timelineCommand(names.length === 1 ? `Change ${names[0]}` : 'Change Clip Properties', (draft) => {
    for (const id of clipIds) {
      const clip = findClip(draft.sequence, id)
      assertUnlocked(findTrack(draft.sequence, clip.trackId))
      if (changes.motion) {
        for (const [key, value] of Object.entries(changes.motion) as Array<[keyof Clip['motion'], number]>) {
          if (!Number.isFinite(value)) throw new CommandError(`${PROPERTY_LABELS[key]} needs a number`)
          clip.motion[key] = value
        }
      }
      if (changes.opacity !== undefined) clip.opacity = Math.min(100, Math.max(0, changes.opacity))
      if (changes.blendMode !== undefined) clip.blendMode = changes.blendMode
      if (changes.volume !== undefined) clip.volume = Math.min(MAX_VOLUME_DB, Math.max(MIN_VOLUME_DB, changes.volume))
    }
  })
  command.coalesceKey = `clip-props:${[...clipIds].sort().join(',')}:${keys.sort().join(',')}`
  return command
}

/** Right-click › Set to Frame Size, or reset Motion entirely. */
export function resetMotion(clipIds: string[], mode: 'frame-size' | 'reset'): TimelineCommand {
  return timelineCommand(mode === 'frame-size' ? 'Set to Frame Size' : 'Reset Motion', (draft) => {
    for (const id of clipIds) {
      const clip = findClip(draft.sequence, id)
      if (clip.kind !== 'video') continue
      assertUnlocked(findTrack(draft.sequence, clip.trackId))
      const fresh = defaultMotion(draft.media.find((m) => m.id === clip.mediaId), draft.sequence.settings)
      if (mode === 'frame-size') clip.motion.scale = fresh.scale
      else clip.motion = fresh
    }
  })
}

// ---- Transitions ----------------------------------------------------------------------

export type TransitionEnd = 'in' | 'out'

/** Premiere's default transition length. */
export const DEFAULT_TRANSITION_SECONDS = 1

function videoClipForTransition(sequence: Sequence, id: string): Clip {
  const clip = findClip(sequence, id)
  if (clip.kind !== 'video') throw new CommandError('Cross-dissolves go on video clips (audio crossfades are planned)')
  assertUnlocked(findTrack(sequence, clip.trackId))
  return clip
}

/**
 * Cmd+D with clips selected: a cross-dissolve at both ends of each clip. A cut shared
 * with a neighbour becomes one dissolve between them; a free end fades.
 */
export function addCrossDissolves(clipIds: string[], duration: Ticks): TimelineCommand {
  return timelineCommand(clipIds.length === 1 ? 'Add Cross Dissolve' : 'Add Cross Dissolves', (draft) => {
    const sequence = draft.sequence
    const length = Math.max(frameTicks(sequence), toFrame(duration, frameTicks(sequence)))
    const ids = clipIds.filter((id) => findClip(sequence, id).kind === 'video')
    if (ids.length === 0) throw new CommandError('Select a video clip to add a cross-dissolve')
    for (const id of ids) {
      const clip = videoClipForTransition(sequence, id)
      clip.transitionIn = { kind: 'cross-dissolve', duration: length }
      const next = clipsOnTrack(sequence, clip.trackId).find((c) => c.start === clipEnd(clip))
      if (next && !findTrack(sequence, next.trackId).locked) {
        next.transitionIn = { kind: 'cross-dissolve', duration: length }
        clip.transitionOut = null
      } else clip.transitionOut = { kind: 'cross-dissolve', duration: length }
    }
  })
}

/** Cmd+D on a cut: a cross-dissolve where a clip starts (or a fade where one ends). */
export function addCrossDissolveAt(trackId: string, at: Ticks, duration: Ticks): TimelineCommand {
  return timelineCommand('Add Cross Dissolve', (draft) => {
    const sequence = draft.sequence
    const length = Math.max(frameTicks(sequence), toFrame(duration, frameTicks(sequence)))
    const clips = clipsOnTrack(sequence, trackId)
    const starting = clips.find((c) => c.start === at)
    const ending = clips.find((c) => clipEnd(c) === at)
    if (starting) videoClipForTransition(sequence, starting.id).transitionIn = { kind: 'cross-dissolve', duration: length }
    else if (ending) videoClipForTransition(sequence, ending.id).transitionOut = { kind: 'cross-dissolve', duration: length }
    else throw new CommandError('There’s no cut there')
  })
}

export function removeTransition(clipId: string, end: TransitionEnd): TimelineCommand {
  return timelineCommand('Delete Transition', (draft) => {
    const clip = videoClipForTransition(draft.sequence, clipId)
    if (end === 'in') clip.transitionIn = null
    else clip.transitionOut = null
  })
}

export function setTransitionDuration(clipId: string, end: TransitionEnd, duration: Ticks): TimelineCommand {
  const command = timelineCommand('Change Transition Duration', (draft) => {
    const clip = videoClipForTransition(draft.sequence, clipId)
    const transition = end === 'in' ? clip.transitionIn : clip.transitionOut
    if (!transition) throw new CommandError('That transition no longer exists')
    transition.duration = Math.max(frameTicks(draft.sequence), toFrame(duration, frameTicks(draft.sequence)))
  })
  command.coalesceKey = `transition:${clipId}:${end}`
  return command
}

// ---- Speed, reverse and frame hold -----------------------------------------------------

export interface SpeedRequest {
  clipIds: string[]
  /** 1 = 100%. */
  speed: number
  reverse: boolean
  /** Shift later clips (and sync-locked tracks) to follow the new length, as Premiere's "Ripple Edit, Shifting Trailing Clips". */
  ripple: boolean
}

export const MIN_SPEED = 0.01
export const MAX_SPEED = 100

/**
 * Premiere's Speed/Duration: the clip keeps the same media and its length changes to
 * match (200% = half as long). Without ripple, a clip can't grow into the next one, so
 * it stops at it. Linked picture and sound change together.
 */
export function setClipSpeed(request: SpeedRequest, media: MediaItem[], newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Speed/Duration', (draft, command) => {
    const sequence = draft.sequence
    const frame = frameTicks(sequence)
    if (!(request.speed >= MIN_SPEED && request.speed <= MAX_SPEED)) throw new CommandError(`Speed must be between ${MIN_SPEED * 100}% and ${MAX_SPEED * 100}%`)
    const clips = [...new Set(request.clipIds)].map((id) => findClip(sequence, id))
    if (clips.length === 0) throw new CommandError('Select a clip to change its speed')
    for (const clip of clips) assertUnlocked(findTrack(sequence, clip.trackId))
    const ctx = new EditContext(newId)
    const selectedTracks = new Set(clips.map((c) => c.trackId))
    // Linked picture and sound with the same timing are one edit.
    const groups = new Map<string, Clip[]>()
    for (const clip of clips) {
      const key = clip.linkId ? `${clip.linkId}:${clip.start}:${clip.duration}` : clip.id
      groups.set(key, [...(groups.get(key) ?? []), clip])
    }
    // Latest first, so rippling one doesn't move a clip we haven't handled yet.
    for (const group of [...groups.values()].sort((a, b) => b[0]!.start - a[0]!.start)) {
      const first = group[0]!
      let span = first.speed === 0 ? first.duration : sourceSpan(first)
      if (first.speed === 0) {
        // A hold has no length in its media; give it what's left after the held frame.
        const item = mediaFor(media, first)
        const length = item ? mediaLength(item) : null
        if (length !== null) span = Math.max(frame, Math.min(span, length - first.sourceIn))
      }
      const wanted = Math.max(frame, toFrame(span / request.speed, frame, 'floor'))
      const end = clipEnd(first)
      let change = wanted - first.duration
      if (change > 0 && !request.ripple) {
        for (const clip of group) {
          const next = clipsOnTrack(sequence, clip.trackId).find((c) => c.id !== clip.id && c.start >= end)
          if (next) change = Math.min(change, next.start - end)
        }
      }
      for (const clip of group) {
        if (request.ripple && change !== 0) {
          for (const other of clipsOnTrack(sequence, clip.trackId)) if (other.id !== clip.id && other.start >= end) other.start += change
        }
        clip.speed = request.speed
        clip.reverse = request.reverse
        clip.duration += change
      }
      if (request.ripple && change !== 0) {
        const others = syncTracks(sequence, selectedTracks)
        if (change > 0) insertSpace(sequence, others, end, change, ctx)
        else removeSpace(sequence, others, end + change, end)
      }
    }
    noteSplits(command, sequence, ctx)
    const notes: string[] = []
    if (command.notice) notes.push(command.notice)
    if (clips.some((c) => c.kind === 'audio')) {
      if (request.reverse) notes.push('Reversed sound is silent for now; reversed audio playback is planned.')
      else if (request.speed !== 1) notes.push('Sound at this speed changes pitch, like tape; Maintain Audio Pitch is planned.')
    }
    command.notice = notes.length > 0 ? notes.join(' ') : undefined
  })
}

/**
 * Add Frame Hold: from `at` to the clip's end, the picture holds the frame at `at`. The
 * clip (and its linked sound, which keeps playing) is split there, like a razor cut.
 */
export function addFrameHold(clipIds: string[], at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand('Add Frame Hold', (draft) => {
    const sequence = draft.sequence
    const time = toFrame(at, frameTicks(sequence))
    const ctx = new EditContext(newId)
    let count = 0
    for (const id of new Set(clipIds)) {
      const clip = findClip(sequence, id)
      if (clip.kind !== 'video' || clip.start > time || clipEnd(clip) <= time) continue
      assertUnlocked(findTrack(sequence, clip.trackId))
      const held = sourceTimeAt(clip, time, frameTicks(sequence))
      let target = clip
      if (clip.start < time) {
        const partners = clip.linkId
          ? sequence.clips.filter((c) => c.id !== clip.id && c.linkId === clip.linkId && c.start < time && clipEnd(c) > time && !findTrack(sequence, c.trackId).locked)
          : []
        target = splitClip(sequence, clip, time, ctx)
        for (const partner of partners) splitClip(sequence, partner, time, ctx)
      }
      target.sourceIn = held
      target.speed = 0
      target.reverse = false
      count++
    }
    if (count === 0) throw new CommandError('Put the playhead over a selected video clip to hold its frame')
  })
}
