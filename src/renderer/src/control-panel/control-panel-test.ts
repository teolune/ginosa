import { MAX_BPM, beatAt } from '@engine/audio/beat-grid'
import { secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import { setBeatGrid } from '@engine/timeline/audio-edits'
import { setSequenceSettings } from '@engine/project/commands'
import { analysisController } from '../audio/analysis-controller'
import { AudioEngine } from '../playback/audio-engine'
import { player } from '../playback/player'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { changeTempo, detectTempo } from './actions'

/**
 * The Control Panel, checked for real in the app: tempo detection, the knob's range,
 * ×2 / ÷2, the metronome's clicks against the beat grid during playback, Play/Pause/Stop,
 * a new adjustment layer at the playhead, frames and the import column.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const start = performance.now()
  while (!test()) {
    if (performance.now() - start > ms) return false
    await wait(50)
  }
  return true
}

export async function controlPanelTest(testMediaFolder: string): Promise<Record<string, unknown>> {
  const reasons: string[] = []
  const check = (ok: boolean, reason: string) => {
    if (!ok) reasons.push(reason)
  }
  const grid = () => projectController.project!.sequence.beatGrid

  // 1. Automatic Detection on the mix (the 120 BPM song is on A2).
  timelineController.setPlayhead(0)
  detectTempo()
  const detected = await until(() => grid() !== null, 30_000)
  const detectedBpm = grid()?.bpm ?? null
  check(detected, 'tempo detection never set a beat grid')
  check(detectedBpm !== null && Math.abs(detectedBpm - 120) < 0.6, `detected ${detectedBpm} BPM, not 120`)
  check(analysisController.pendingTempo === null, 'detection still pending after it applied')

  // 2. The knob's range and ×2 / ÷2.
  changeTempo(130.123, 'Type Tempo')
  check(grid()?.bpm === 130.123, `typed 130.123 gave ${grid()?.bpm}`)
  changeTempo(grid()!.bpm * 2, 'Double Tempo')
  check(grid()?.bpm === 260.246, `doubling gave ${grid()?.bpm}`)
  changeTempo(grid()!.bpm / 2, 'Halve Tempo')
  check(grid()?.bpm === 130.123, `halving gave ${grid()?.bpm}`)
  changeTempo(MAX_BPM, 'Type Tempo')
  check(grid()?.bpm === 999.999, `999.999 BPM gave ${grid()?.bpm}`)
  const refused = !projectController.dispatch(setBeatGrid({ bpm: 1000 }))
  check(refused && grid()?.bpm === 999.999, '1000 BPM was accepted')
  changeTempo(detectedBpm ?? 120, 'Type Tempo')
  const bpm = grid()!.bpm

  // 3. Metronome: one click per beat while playing, a higher one on each bar, none after it's off.
  player.audio ??= new AudioEngine()
  player.audio.logging = true
  player.audio.clickLog.length = 0
  player.setMetronome(true)
  const from = secondsToTicks(2)
  timelineController.setPlayhead(from)
  player.toggle()
  await until(() => player.playing, 5000)
  await wait(3000)
  const heard = player.audio.heardTime()
  const clicks = [...player.audio.clickLog]
  player.setMetronome(false)
  const afterOff = player.audio.clickLog.length
  await wait(1500)
  const lateClicks = player.audio.clickLog.length - afterOff
  const g = grid()!
  const offGrid = clicks.filter((c) => Math.abs(beatAt(g, c.time) - Math.round(beatAt(g, c.time))) > 1e-6).length
  const wrongBars = clicks.filter((c) => c.bar !== (((Math.round(beatAt(g, c.time)) % g.beatsPerBar) + g.beatsPerBar) % g.beatsPerBar === 0)).length
  const heardBeats = Math.floor(beatAt(g, heard)) - Math.ceil(beatAt(g, from)) + 1
  const scheduledThroughHeard = clicks.filter((c) => c.time <= heard).length
  check(clicks.length > 0, 'no metronome clicks were scheduled')
  check(offGrid === 0, `${offGrid} clicks were off the beat grid`)
  check(wrongBars === 0, `${wrongBars} clicks had the wrong bar accent`)
  check(Math.abs(scheduledThroughHeard - heardBeats) <= 1, `${scheduledThroughHeard} clicks up to the heard time, expected ${heardBeats}`)
  check(lateClicks === 0, `${lateClicks} clicks were scheduled after the metronome was turned off`)
  const firstClickBeat = clicks.length ? beatAt(g, clicks[0]!.time) : null

  // 4. Stop goes back to where Play started; again, to the start. Pause stays put.
  player.stopAndReturn()
  check(Math.abs(timelineController.playhead - from) < secondsToTicks(0.001), `Stop went to ${ticksToSeconds(timelineController.playhead).toFixed(3)} s, not 2 s`)
  player.stopAndReturn()
  check(timelineController.playhead === 0, `second Stop went to ${ticksToSeconds(timelineController.playhead).toFixed(3)} s, not 0`)
  timelineController.setPlayhead(from)
  player.toggle()
  await until(() => player.playing, 5000)
  await wait(1200)
  player.toggle()
  const paused: Ticks = timelineController.playhead
  check(paused > from + secondsToTicks(0.5), `Pause left the playhead at ${ticksToSeconds(paused).toFixed(2)} s`)
  player.toggle()
  await until(() => player.playing, 5000)
  await wait(600)
  player.stopAndReturn()
  check(Math.abs(timelineController.playhead - paused) < secondsToTicks(0.001), 'Stop after Pause and Play did not go back to the pause position')
  player.audio.logging = false

  // 5. A new adjustment layer at the playhead.
  const at = secondsToTicks(4)
  timelineController.setPlayhead(at)
  const before = projectController.project!.sequence.clips.filter((c) => c.adjustment).length
  timelineController.newAdjustmentLayer()
  const layers = projectController.project!.sequence.clips.filter((c) => c.adjustment)
  check(layers.length === before + 1 && layers.some((c) => c.start === at), 'no adjustment layer at the playhead')

  // 6. Frames and the import column.
  workspaceController.setFrame('portrait')
  await wait(300)
  check(document.querySelector('.workspace-grid.frame-portrait .monitor-top') !== null, 'the portrait frame did not put the preview tools on top')
  workspaceController.toggleMedia(false)
  await wait(200)
  check(document.querySelector('.media-panel') === null, 'Close Import Folder left the media column open')
  workspaceController.toggleMedia(true)
  await wait(200)
  check(document.querySelector('.media-panel') !== null, 'Open Import Folder did not bring the media column back')

  // 7. The folder browser lists the test media folder (read only).
  const listing = await window.ginosa.media.listFolder(testMediaFolder)
  const kinds = new Set(listing.entries.map((e) => e.kind))
  check(listing.entries.length > 3 && kinds.has('video') && kinds.has('audio'), `the folder browser listed ${listing.entries.length} entries`)
  try {
    localStorage.setItem('ginosa.folder-browser', testMediaFolder)
  } catch {
    // Not remembered: the screenshot just shows the empty browser.
  }
  ;(document.querySelectorAll<HTMLButtonElement>('.media-panel .segmented button')[1])?.click()
  await wait(500)
  check(document.querySelectorAll('.folder-row').length === listing.entries.length, 'the folder view did not show the listing')
  player.setMetronome(true)

  // 8. Auto follows the sequence's shape: a 9:16 sequence gets the portrait frame by itself.
  workspaceController.setFrame('landscape')
  projectController.dispatch(setSequenceSettings({ width: 1080, height: 1920 }))
  await wait(300)
  check(document.querySelector('.workspace-grid.frame-landscape') !== null, 'Landscape did not stay landscape for a 9:16 sequence')
  workspaceController.setFrame('auto')
  await wait(300)
  check(document.querySelector('.workspace-grid.frame-portrait') !== null, 'Auto did not pick the portrait frame for a 9:16 sequence')

  return {
    verdict: reasons.length ? 'fail' : 'pass',
    reasons,
    detectedBpm,
    bpm,
    metronome: { clicks: clicks.length, heardBeats, scheduledThroughHeard, offGrid, wrongBars, lateClicks, firstClickBeat },
    pausedAt: ticksToSeconds(paused),
    folder: { entries: listing.entries.length, other: listing.other }
  }
}
