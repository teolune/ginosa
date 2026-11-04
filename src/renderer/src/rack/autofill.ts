import { beatAt } from '@engine/audio/beat-grid'
import { DEFAULT_GRID } from '@engine/modulation/curve'
import { STEPS_PER_BEAT, type RackRow, type Sequence } from '@engine/project/model'
import { secondsToTicks } from '@engine/time'
import { fillRackRow, stepsFromHits } from '@engine/timeline/rack-edits'
import { sequenceEnd } from '@engine/timeline/timeline'
import { analysisController } from '../audio/analysis-controller'
import { projectController } from '../state/project-controller'

/** The steps of the whole sequence, from its start to its end (for Auto-fill whole song and Repeat to End). */
export function songSteps(sequence: Sequence): [number, number] {
  const grid = sequence.beatGrid ?? DEFAULT_GRID
  return [Math.floor(beatAt(grid, 0) * STEPS_PER_BEAT), Math.ceil(beatAt(grid, sequenceEnd(sequence)) * STEPS_PER_BEAT)]
}

/**
 * Auto-fill (M12): the row's band's hits from an analysis source, snapped to the nearest 16th
 * on the beat grid, replacing the row's steps from `from` to `to`. Null while the source is
 * still being analysed.
 */
export function autofillRow(row: RackRow, sourceId: string, from: number, to: number): number[] | null {
  const sequence = projectController.project?.sequence
  const ready = analysisController.ready(sourceId)
  if (!sequence || !ready) return null
  const grid = sequence.beatGrid ?? DEFAULT_GRID
  const hits = ready.result.bands[row.band].hits.map((h) => ready.start + secondsToTicks(h / ready.result.rate))
  const steps = stepsFromHits(hits, (t) => beatAt(grid, t), from, to)
  return projectController.dispatch(fillRackRow(row.id, from, to, steps, `Auto-fill ${row.name}`)) ? steps : null
}
