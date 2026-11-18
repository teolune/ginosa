import { addAudioSource, setBeatGrid } from '@engine/timeline/audio-edits'
import { analysisController } from '../audio/analysis-controller'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { songTempo } from './song-tempo'

/** The Control Panel's tempo actions (also used by its tests). */

export function changeTempo(bpm: number, label: string): void {
  const grid = projectController.project?.sequence.beatGrid
  // A new grid starts at the playhead, like everything the Control Panel adds.
  projectController.dispatch(setBeatGrid(grid ? { bpm } : { bpm, downbeat: timelineController.playhead }, label))
}

/**
 * Automatic Detection: the tempo and bar 1 of the song on A1 from Beat This! when detection is set
 * up (W4.5), else of the grid's source or the full mix (added as an analysis source). `method`
 * picks one (the detection bench compares them).
 */
export function detectTempo(options: { method?: 'beats' | 'analysis' } = {}): void {
  void detectTempoNow(options)
}

async function detectTempoNow(options: { method?: 'beats' | 'analysis' }): Promise<void> {
  if (options.method !== 'analysis' && (await songTempo.detect())) return
  if (options.method === 'beats') return
  const sequence = projectController.project?.sequence
  if (!sequence) return
  let sourceId = sequence.beatGrid?.sourceId ?? sequence.audioSources[0]?.id ?? null
  if (!sourceId) {
    if (!sequence.clips.some((c) => c.kind === 'audio')) {
      projectController.showMessage('Put the music on an audio track first, then detect its tempo.')
      return
    }
    const command = addAudioSource('mix', null, 'Mix')
    if (!projectController.dispatch(command)) return
    sourceId = command.sourceId
  }
  analysisController.useDetectedTempo(sourceId)
}
