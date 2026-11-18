import { hashText } from '@engine/audio/sources'
import { songGrid, type SongGrid } from '@engine/audio/song-beats'
import type { Clip } from '@engine/project/model'
import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { speedRamp, timeForMedia } from '@engine/timeline/timeline'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'

/**
 * The tempo and bar 1 of the song on A1 from Beat This! (W4.5, decision 123), when detection is
 * set up: the song file's beats and downbeats, laid out as one steady grid, counted twice as fast
 * below 90 BPM (as your DAW counts your songs), with bar 1 on the first bar line where the music
 * starts. The song clip is the first on A1, played forwards at one speed; otherwise (or when it
 * isn't set up) the Control Panel's own detection listens to the mix.
 */
class SongTempo extends Observable {
  busy = false
  /** What the last detection found, for the message and the bench (seconds in the song file). */
  last: (SongGrid & { clipId: string }) | null = null

  songClip(): Clip | null {
    const sequence = projectController.project?.sequence
    const a1 = sequence?.tracks.find((t) => t.kind === 'audio')
    if (!sequence || !a1) return null
    const clip = sequence.clips.filter((c) => c.trackId === a1.id && c.kind === 'audio').sort((a, b) => a.start - b.start)[0]
    if (!clip || clip.reverse || speedRamp(clip)) return null
    return clip
  }

  /** Sets the grid from the song on A1; false when it can't (not set up, no song there), so the mix is used. */
  async detect(): Promise<boolean> {
    const project = projectController.project
    const clip = this.songClip()
    const item = clip && project?.media.find((m) => m.id === clip.mediaId)
    if (!project || !clip || !item || this.busy) return false
    if (!(await window.ginosa.stems.status()).beats) return false
    this.busy = true
    this.notify()
    try {
      const heard = await window.ginosa.stems.beats(project.id, item.path, hashText(JSON.stringify(['beats', item.fingerprint])))
      // The music starts where the clip does, if that's later in the file.
      const grid = songGrid({ ...heard, firstSound: Math.max(heard.firstSound, ticksToSeconds(clip.sourceIn)) })
      if (!grid) {
        projectController.showMessage('Beat This! found no steady beat in the song on A1; listening to the mix instead.')
        return false
      }
      if (projectController.project?.id !== project.id) return true
      this.last = { ...grid, clipId: clip.id }
      const bpm = Math.round(grid.bpm * clip.speed * 1000) / 1000
      return projectController.dispatch(setBeatGrid({ bpm, downbeat: timeForMedia(clip, secondsToTicks(grid.downbeat)), beatsPerBar: 4, sourceId: null }, 'Detect Tempo'))
    } catch (error) {
      projectController.showMessage(`Beat This! couldn’t listen to the song on A1 (${(error as Error).message}); listening to the mix instead.`)
      return false
    } finally {
      this.busy = false
      this.notify()
    }
  }
}

export const songTempo = new SongTempo()
