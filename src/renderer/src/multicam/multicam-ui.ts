import { MULTICAM_KEYS, type MulticamGroup, type Sequence } from '@engine/project/model'
import type { Ticks } from '@engine/time'
import { multicamGrid } from '@engine/timeline/multicam-grid'
import { newMulticamFromMedia, newMulticamGroup, recordMulticam, removeFavourites, switchAngle, type Switch } from '@engine/timeline/multicam-edits'
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
 * Multi-camera in the interface (W5, decision 134): the group in use, the multi-camera view in
 * the Program monitor, the angle keys, and recording. While recording, the song plays and each
 * key cuts to its angle there; stopping writes the pieces (one undo step). Not recording, a key
 * switches the selected pieces (or the one under the playhead) to its angle.
 */
class MulticamUi extends Observable {
  /** The group the window and the keys work on (null: the sequence's first). */
  groupId: string | null = null
  view = false
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
      if (this.view && !group) this.setView(false)
    })
  }

  group(sequence: Sequence | undefined = projectController.project?.sequence): MulticamGroup | null {
    if (!sequence) return null
    return sequence.multicam.find((g) => g.id === this.groupId) ?? sequence.multicam[0] ?? null
  }

  choose(groupId: string): void {
    this.groupId = groupId
    if (this.view) this.setView(true)
    this.notify()
  }

  open(): void {
    workspaceController.open('multicam')
    workspaceController.focus('multicam')
  }

  /** A new group from timeline clips (each track holding one is an angle), synced to the song first when there is one. */
  async newGroupFromClips(clipIds: readonly string[]): Promise<string | null> {
    if (syncController.song()) {
      const results = await syncController.syncToSong(clipIds)
      if (results.length) projectController.showMessage(syncController.summary(results))
    }
    const command = newMulticamGroup(clipIds)
    if (!projectController.dispatch(command)) return null
    this.groupId = command.groupId
    this.open()
    this.notify()
    return command.groupId
  }

  /** A new group from media (the Media panel): each take on a track of its own, synced to the song on A1 by its sound. */
  async newGroupFromMedia(mediaIds: readonly string[]): Promise<string | null> {
    const project = projectController.project
    if (!project) return null
    const items = project.media.filter((m) => mediaIds.includes(m.id) && m.kind === 'video')
    if (items.length === 0) {
      projectController.showMessage('Select video files to make a group of')
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
      const command = newMulticamFromMedia(takes, song)
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

  /** The multi-camera view: every angle in a grid in the Program monitor. */
  setView(on: boolean): void {
    this.view = on
    programView.set(on ? (sequence, media) => {
      const group = this.group(sequence)
      return group ? multicamGrid(sequence, media, group) : sequence
    } : null)
    this.notify()
  }

  /** The piece of the group under the playhead on its track. */
  pieceAtPlayhead(group: MulticamGroup) {
    const t = timelineController.playhead
    return projectController.project?.sequence.clips.find((c) => c.trackId === group.programTrackId && c.multicam && c.start <= t && t < clipEnd(c)) ?? null
  }

  /** Record (or stop): plays from the playhead; keys cut between angles until playback stops. */
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
    if (!this.view) this.setView(true)
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
    this.setView(false)
    this.notify()
  }

  /** A key: an angle of the group. True when it was one. */
  press(key: string): boolean {
    const group = this.group()
    const angle = group?.angles.find((a) => a.key === key)
    if (!group || !angle) return false
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

  /** The keyboard: 1–9, 0 and the comma (the number pad's decimal key too) are the angles. */
  handleKey(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const group = this.group()
    if (!group) return false
    const key = event.code === 'NumpadDecimal' ? ',' : event.key
    if (!(MULTICAM_KEYS as readonly string[]).includes(key)) return false
    // The comma is Insert on the timeline, unless multi-camera is in use right now.
    if (key === ',' && !this.recording && !this.view) return false
    return this.press(key)
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
      projectController.showMessage('Mark some favourites first: drag across a take’s strip in this window')
      return
    }
    const everyBeats = cutEveryBeats(this.cutEvery, project.sequence.beatGrid?.beatsPerBar ?? 4)
    const plan = planAutomatic(project.sequence, group.id, { from: range.from, to: range.to, everyBeats, bRoll: this.useBRoll })
    if (!projectController.dispatch(applyAutomatic(group.id, plan))) return
    this.gaps = plan.flatMap((p) => (p.kind === 'gap' ? [{ groupId: group.id, from: p.from, to: p.to, hold: p.holdAngleId }] : []))
    const shots = plan.filter((p) => p.kind !== 'gap').length
    projectController.showMessage(`${shots} shots, cut every ${CUT_LABELS[this.cutEvery] ?? 'bar'}${this.gaps.length ? `. ${this.gaps.length} ${this.gaps.length === 1 ? 'stretch' : 'stretches'} nothing marked covers: flagged in red (the angle before holds there)` : ''}`)
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
