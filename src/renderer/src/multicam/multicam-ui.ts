import { MULTICAM_KEYS, type MulticamGroup, type Sequence } from '@engine/project/model'
import type { Ticks } from '@engine/time'
import { multicamGrid, soloView } from '@engine/timeline/multicam-grid'
import { addFavourite, addMediaToMulticam, addToMulticam, recordMulticam, removeAngle, removeFavourites, switchAngle, type Switch } from '@engine/timeline/multicam-edits'
import { applyAutomatic, cutEveryBeats, planAutomatic } from '@engine/timeline/multicam-auto'
import { syncPointPlace, placeInSync } from '@engine/timeline/sync-edits'
import { clipEnd, frameTicks, sourceTimeAt } from '@engine/timeline/timeline'
import { player } from '../playback/player'
import { programView } from '../playback/program-view'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { syncController } from './sync-controller'

/** Automatic's Cut Every choices (W5.5). */
export const CUT_LABELS: Record<string, string> = { beat: 'beat', '2beats': '2 beats', bar: 'bar', '2bars': '2 bars', '4bars': '4 bars' }

/**
 * Multi-camera in the interface (W5, decision 134; your Multi-Camera design of 20 Nov): the group
 * in use, what the preview shows (the clips in a grid, one clip soloed, or the edit), the keys,
 * recording, and marking favourite parts with M. While recording, the song plays and each key
 * cuts to its clip there; stopping writes the pieces (one undo step). Not recording, a key
 * switches the selected pieces (or the one under the playhead) to its clip; with Mark Clip on, it
 * solos that clip instead.
 */
class MulticamUi extends Observable {
  /** The group the window and the keys work on (null: the sequence's first). */
  groupId: string | null = null
  /** The preview shows every clip in a grid (on while the window is open; off: the edit). */
  view = false
  /** The Multi-Camera window is open (its preview mirrors the Program monitor's picture). */
  windowOpen = false
  /** The clip shown alone in the preview, to mark its favourite parts (one at a time). */
  solo: string | null = null
  /** Mark Clip: M marks the soloed clip's favourite parts, in then out. */
  marking = false
  /** The in-point of a favourite being marked: the soloed clip's take, and the timeline time. */
  pendingIn: { angleId: string; clipId: string; at: Ticks } | null = null
  /** The angle a recording starts on, and the one live while recording. */
  live: string | null = null
  recording: { groupId: string; from: Ticks; switches: Switch[] } | null = null
  /** A sync point being made (W5.1): the take, and its file's time at the moment marked. */
  syncMark: { clipId: string; mediaTime: Ticks } | null = null
  busy = false
  /** The favourite selected in the window (W5.4), for ⌫. */
  favourite: { angleId: string; id: string } | null = null
  /** Automatic's settings and what it left uncovered (W5.5). */
  cutEvery = 'bar'
  useBRoll = true
  gaps: Array<{ groupId: string; from: Ticks; to: Ticks; hold: string | null }> = []

  constructor() {
    super()
    player.subscribe(() => {
      // Playback stopped while recording: the recording is written.
      if (this.recording && !player.playing) this.finish()
    })
    projectController.subscribe(() => {
      const group = this.group()
      if (this.groupId && !group) this.groupId = null
      if (this.solo && !group?.angles.some((a) => a.id === this.solo)) {
        this.solo = null
        this.pendingIn = null
        this.applyPreview()
      }
      if (this.view && !group) this.setView(false)
    })
  }

  group(sequence: Sequence | undefined = projectController.project?.sequence): MulticamGroup | null {
    if (!sequence) return null
    return sequence.multicam.find((g) => g.id === this.groupId) ?? sequence.multicam[0] ?? null
  }

  choose(groupId: string): void {
    this.groupId = groupId
    this.solo = null
    this.pendingIn = null
    this.applyPreview()
    this.notify()
  }

  open(): void {
    workspaceController.open('multicam')
    workspaceController.focus('multicam')
  }

  /** The Control Panel's button: opens the window, or closes it. */
  toggleWindow(): void {
    if (workspaceController.isOpen('multicam')) workspaceController.close('multicam')
    else this.open()
  }

  /** The window opened or closed: its preview shows the grid while open; solo and marking end with it. */
  windowShown(open: boolean): void {
    if (this.windowOpen === open) return
    this.windowOpen = open
    if (open) this.view = true
    else {
      this.view = false
      this.solo = null
      this.marking = false
      this.pendingIn = null
    }
    this.applyPreview()
    this.notify()
  }

  // ---- Adding clips ----

  /** Add to Multi-Camera (timeline): the tracks holding these clips become clips of the group (made when there's none), synced to the song first when there is one. */
  async addClips(clipIds: readonly string[]): Promise<string | null> {
    const sequence = projectController.project?.sequence
    if (!sequence) return null
    const takes = sequence.clips.filter((c) => clipIds.includes(c.id) && c.kind === 'video' && !c.adjustment && !c.multicam)
    if (takes.length === 0) {
      projectController.showMessage('Choose video clips to add to Multi-Camera')
      return null
    }
    const group = this.group()
    if (syncController.song()) {
      // Takes already in the group stay where they are.
      const ids = takes.filter((c) => !group?.angles.some((a) => a.trackId === c.trackId)).map((c) => c.id)
      const results = ids.length ? await syncController.syncToSong(ids) : []
      if (results.length) projectController.showMessage(syncController.summary(results))
    }
    const command = addToMulticam(group?.id ?? null, { clipIds })
    if (!projectController.dispatch(command)) return null
    this.groupId = command.groupId
    this.open()
    this.notify()
    return command.groupId
  }

  /** Add Clip + › a track: its takes become a clip of the group, synced to the song first. */
  async addTrack(trackId: string): Promise<string | null> {
    const sequence = projectController.project?.sequence
    if (!sequence) return null
    const takes = sequence.clips.filter((c) => c.trackId === trackId && c.kind === 'video' && !c.adjustment && !c.multicam).map((c) => c.id)
    if (syncController.song() && takes.length) {
      const results = await syncController.syncToSong(takes)
      if (results.length) projectController.showMessage(syncController.summary(results))
    }
    const command = addToMulticam(this.group()?.id ?? null, { trackIds: [trackId] })
    if (!projectController.dispatch(command)) return null
    this.groupId = command.groupId
    this.open()
    this.notify()
    return command.groupId
  }

  /** Add to Multi-Camera (Media panel): each take on a track of its own, synced to the song on A1 by its sound. */
  async addMedia(mediaIds: readonly string[]): Promise<string | null> {
    const project = projectController.project
    if (!project) return null
    const items = project.media.filter((m) => mediaIds.includes(m.id) && m.kind === 'video')
    if (items.length === 0) {
      projectController.showMessage('Select video files to add to Multi-Camera')
      return null
    }
    const song = syncController.song()
    const songItem = song ? project.media.find((m) => m.id === song.mediaId) : undefined
    this.busy = true
    this.notify()
    try {
      const heard = songItem ? await syncController.match(songItem, items.filter((i) => i.info.audio).map((i) => ({ id: i.id, path: i.path }))) : new Map()
      const takes = items.map((i) => {
        const m = heard.get(i.id)
        return { mediaId: i.id, offset: m && m.confidence !== 'none' ? m.offset : null }
      })
      const command = addMediaToMulticam(this.group()?.id ?? null, takes, song)
      if (!projectController.dispatch(command)) return null
      this.groupId = command.groupId
      const unheard = items.filter((i) => (heard.get(i.id)?.confidence ?? 'none') === 'none').map((i) => i.name)
      const unsure = items.filter((i) => heard.get(i.id)?.confidence === 'unsure').map((i) => i.name)
      projectController.showMessage(
        [
          `${items.length - unheard.length} of ${items.length} takes in sync with the song`,
          unsure.length ? `check ${unsure.join(', ')}` : null,
          !song ? 'there’s no song on A1, so they’re at the start' : unheard.length ? `couldn’t hear the song in ${unheard.join(', ')}: line ${unheard.length > 1 ? 'them' : 'it'} up with a sync point` : null
        ]
          .filter(Boolean)
          .join('. ')
      )
      this.open()
      return command.groupId
    } finally {
      this.busy = false
      this.notify()
    }
  }

  removeAngle(angleId: string): void {
    const group = this.group()
    if (group) projectController.dispatch(removeAngle(group.id, angleId))
  }

  // ---- The preview ----

  /** What the preview shows: the soloed clip alone, every clip in a grid, or (neither) the edit. */
  private applyPreview(): void {
    const solo = this.solo
    if (solo) {
      programView.set((sequence) => {
        const group = this.group(sequence)
        const angle = group?.angles.find((a) => a.id === solo)
        return group && angle ? soloView(sequence, angle.trackId) : sequence
      })
    } else if (this.view) {
      programView.set((sequence, media) => {
        const group = this.group(sequence)
        return group ? multicamGrid(sequence, media, group) : sequence
      })
    } else programView.set(null)
  }

  /** The preview's grid of every clip (off: the edit). */
  setView(on: boolean): void {
    this.view = on
    this.applyPreview()
    this.notify()
  }

  /** Solos a clip in the preview (the same one again: none). */
  setSolo(angleId: string | null): void {
    const next = angleId === this.solo ? null : angleId
    if (this.pendingIn && this.pendingIn.angleId !== next) this.pendingIn = null
    this.solo = next
    this.applyPreview()
    this.notify()
  }

  // ---- Marking favourites (M) ----

  /** Mark Clip: on, M marks the soloed clip's favourite parts; with none soloed, the next clip with none marked is soloed. */
  toggleMarking(): void {
    if (this.marking) {
      this.marking = false
      this.pendingIn = null
      this.notify()
      return
    }
    const group = this.group()
    if (!group) return
    if (this.recording) this.record()
    if (!this.solo) {
      const next = group.angles.find((a) => a.favourites.length === 0)
      if (!next) {
        projectController.showMessage('Every clip has favourite parts marked. Solo one (its yellow button) to mark more')
        return
      }
      this.solo = next.id
      this.applyPreview()
    }
    this.marking = true
    this.notify()
  }

  /** M: the in-point at the playhead, then the out-point, which marks the favourite. */
  markKey(): void {
    const sequence = projectController.project?.sequence
    const group = this.group()
    const angle = group?.angles.find((a) => a.id === this.solo)
    if (!sequence || !group || !angle) {
      projectController.showMessage('Solo a clip to mark its favourite parts')
      return
    }
    const frame = frameTicks(sequence)
    const at = Math.round(timelineController.playhead / frame) * frame
    const pending = this.pendingIn
    if (!pending || pending.angleId !== angle.id) {
      const take = sequence.clips.find((c) => c.trackId === angle.trackId && c.kind === 'video' && !c.adjustment && c.start <= at && at < clipEnd(c))
      if (!take) {
        projectController.showMessage('This clip has no picture at the playhead')
        return
      }
      this.pendingIn = { angleId: angle.id, clipId: take.id, at }
      this.notify()
      return
    }
    const take = sequence.clips.find((c) => c.id === pending.clipId)
    this.pendingIn = null
    if (!take) return this.notify()
    const from = Math.min(pending.at, at)
    const to = Math.max(pending.at, at)
    if (to - from < frame) {
      projectController.showMessage('Move the playhead (or play) between the in and the out')
      return this.notify()
    }
    // On the take's own time (a mark past the take's end stops there).
    const source = (t: Ticks) => take.sourceIn + (t - take.start)
    const command = addFavourite(group.id, angle.id, take.id, source(Math.max(take.start, from)), source(Math.min(clipEnd(take), to)))
    if (projectController.dispatch(command)) this.favourite = { angleId: angle.id, id: command.favouriteId }
    this.notify()
  }

  /** The piece of the group under the playhead on its track. */
  pieceAtPlayhead(group: MulticamGroup) {
    const t = timelineController.playhead
    return projectController.project?.sequence.clips.find((c) => c.trackId === group.programTrackId && c.multicam && c.start <= t && t < clipEnd(c)) ?? null
  }

  // ---- Recording ----

  /** Record (or stop): plays from the playhead with every clip in the grid; keys cut between clips until playback stops. */
  record(): void {
    if (this.recording) {
      player.stop()
      return
    }
    const group = this.group()
    if (!group) return
    const sequence = projectController.project!.sequence
    const frame = frameTicks(sequence)
    const from = Math.round(timelineController.playhead / frame) * frame
    const start = this.live && group.angles.some((a) => a.id === this.live) ? this.live : (this.pieceAtPlayhead(group)?.multicam?.angleId ?? group.angles[0]!.id)
    this.live = start
    this.marking = false
    this.pendingIn = null
    this.solo = null
    this.view = true
    this.applyPreview()
    void player.play(1, from)
    this.recording = { groupId: group.id, from, switches: [{ at: from, angleId: start }] }
    this.notify()
  }

  private finish(): void {
    const rec = this.recording
    if (!rec) return
    this.recording = null
    const to = timelineController.playhead
    if (to > rec.from) projectController.dispatch(recordMulticam(rec.groupId, rec.from, to, rec.switches))
    // The grid stays while the window is open.
    this.setView(this.windowOpen)
    this.notify()
  }

  /** A key: a clip of the group. True when it was one. */
  press(key: string): boolean {
    const group = this.group()
    const angle = group?.angles.find((a) => a.key === key)
    if (!group || !angle) return false
    if (this.marking && !this.recording) {
      if (this.solo !== angle.id) this.setSolo(angle.id)
      return true
    }
    this.live = angle.id
    if (this.recording) {
      const at = timelineController.playhead
      const last = this.recording.switches[this.recording.switches.length - 1]!
      if (last.angleId !== angle.id) this.recording.switches.push({ at: Math.max(last.at, at), angleId: angle.id })
    } else {
      const sequence = projectController.project!.sequence
      const selected = sequence.clips.filter((c) => timelineController.selection.has(c.id) && c.multicam?.groupId === group.id).map((c) => c.id)
      const pieces = selected.length ? selected : [this.pieceAtPlayhead(group)?.id].filter((id): id is string => Boolean(id))
      if (pieces.length) projectController.dispatch(switchAngle(pieces, angle.id))
    }
    this.notify()
    return true
  }

  /** The keyboard: 1–9 and 0 (the number pad's too) are the clips; with Mark Clip on, M marks and Esc drops an in-point. */
  handleKey(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const group = this.group()
    if (!group) return false
    if (this.marking && !this.recording) {
      if ((event.key === 'm' || event.key === 'M') && !event.shiftKey) {
        this.markKey()
        return true
      }
      if (event.key === 'Escape' && this.pendingIn) {
        this.pendingIn = null
        this.notify()
        return true
      }
    }
    if (!(MULTICAM_KEYS as readonly string[]).includes(event.key)) return false
    return this.press(event.key)
  }

  // ---- Automatic (W5.5) ----

  /** The stretch Automatic edits: In to Out when both are set, else the song on A1, else every take of the group. */
  automaticRange(): { from: Ticks; to: Ticks; label: string } | null {
    const sequence = projectController.project?.sequence
    const group = this.group()
    if (!sequence || !group) return null
    const { in: inMark, out } = sequence.marks
    if (inMark !== null && out !== null && out > inMark) return { from: inMark, to: out, label: 'between In and Out' }
    const song = syncController.song()
    if (song) return { from: song.start, to: clipEnd(song), label: 'over the song' }
    const takes = sequence.clips.filter((c) => group.angles.some((a) => a.trackId === c.trackId && !a.bRoll))
    if (!takes.length) return null
    return { from: Math.min(...takes.map((c) => c.start)), to: Math.max(...takes.map(clipEnd)), label: 'over the takes' }
  }

  /** Makes the edit from the favourites, cut on the beat; gaps are listed and flagged on the timeline. */
  automatic(): void {
    const project = projectController.project
    const group = this.group()
    const range = this.automaticRange()
    if (!project || !group || !range) return
    if (!group.angles.some((a) => a.favourites.length)) {
      projectController.showMessage('Mark some favourite parts first: Mark Clip, then M at the start and M at the end')
      return
    }
    const everyBeats = cutEveryBeats(this.cutEvery, project.sequence.beatGrid?.beatsPerBar ?? 4)
    const plan = planAutomatic(project.sequence, group.id, { from: range.from, to: range.to, everyBeats, bRoll: this.useBRoll })
    if (!projectController.dispatch(applyAutomatic(group.id, plan))) return
    this.gaps = plan.flatMap((p) => (p.kind === 'gap' ? [{ groupId: group.id, from: p.from, to: p.to, hold: p.holdAngleId }] : []))
    const shots = plan.filter((p) => p.kind !== 'gap').length
    projectController.showMessage(`${shots} shots, cut every ${CUT_LABELS[this.cutEvery] ?? 'bar'}${this.gaps.length ? `. ${this.gaps.length} ${this.gaps.length === 1 ? 'stretch' : 'stretches'} nothing marked covers: flagged in red (the last clip holds there)` : ''}`)
    this.notify()
  }

  /** Automatic's gaps, for the timeline (on the group's track). */
  flags(): Array<{ trackId: string; from: Ticks; to: Ticks }> {
    const sequence = projectController.project?.sequence
    if (!sequence || this.gaps.length === 0) return []
    return this.gaps.flatMap((g) => {
      const group = sequence.multicam.find((x) => x.id === g.groupId)
      return group ? [{ trackId: group.programTrackId, from: g.from, to: g.to }] : []
    })
  }

  setCutEvery(id: string): void {
    this.cutEvery = id in CUT_LABELS ? id : 'bar'
    this.notify()
  }

  setUseBRoll(on: boolean): void {
    this.useBRoll = on
    this.notify()
  }

  clearGaps(): void {
    this.gaps = []
    this.notify()
  }

  // ---- Favourites (W5.4) ----

  selectFavourite(angleId: string, id: string | null): void {
    this.favourite = id ? { angleId, id } : null
    this.notify()
  }

  deleteSelectedFavourite(): boolean {
    const group = this.group()
    const f = this.favourite
    if (!group || !f) return false
    this.favourite = null
    return projectController.dispatch(removeFavourites(group.id, f.angleId, [f.id]))
  }

  // ---- Sync points (W5.1, by hand) ----

  /** Marks the moment the take on this angle shows at the playhead (a clap, say). */
  markSyncPoint(trackId: string): void {
    const sequence = projectController.project?.sequence
    const t = timelineController.playhead
    const take = sequence?.clips.find((c) => c.trackId === trackId && c.kind === 'video' && c.start <= t && t < clipEnd(c))
    if (!sequence || !take) {
      projectController.showMessage('Put the playhead over the take, on the moment to sync (a clap, a beat)')
      return
    }
    this.syncMark = { clipId: take.id, mediaTime: sourceTimeAt(take, t, frameTicks(sequence)) }
    this.notify()
  }

  /** Moves the marked take so its marked moment is at the playhead (where the song has it). */
  lineUpHere(): void {
    const project = projectController.project
    const mark = this.syncMark
    const take = mark && project?.sequence.clips.find((c) => c.id === mark.clipId)
    if (!project || !mark || !take) return
    const place = syncPointPlace(project.sequence, take, mark.mediaTime, timelineController.playhead)
    if ('problem' in place) projectController.showMessage(`Can’t line it up: ${place.problem}`)
    else projectController.dispatch(placeInSync([{ clipId: take.id, ...place }]))
    this.syncMark = null
    this.notify()
  }
}

export const multicamUi = new MulticamUi()
