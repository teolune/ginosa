import { beatAt } from '@engine/audio/beat-grid'
import { DEFAULT_GRID } from '@engine/modulation/curve'
import { STEPS_PER_BEAT, type Sequence } from '@engine/project/model'
import { secondsToTicks } from '@engine/time'
import { strongHits } from '@engine/audio/analysis'
import { DETECT_LISTEN, sectionsFromHits } from '@engine/timeline/rack'
import { replaceRackSections, stepsFromHits } from '@engine/timeline/rack-edits'
import { sequenceEnd } from '@engine/timeline/timeline'
import { analysisController } from '../audio/analysis-controller'
import { projectController } from '../state/project-controller'

/** The 16ths of the whole sequence, from its start to its end. */
export function songSteps(sequence: Sequence): [number, number] {
  const grid = sequence.beatGrid ?? DEFAULT_GRID
  return [Math.floor(beatAt(grid, 0) * STEPS_PER_BEAT), Math.ceil(beatAt(grid, sequenceEnd(sequence)) * STEPS_PER_BEAT)]
}

/**
 * Fill from bands (M12's Auto-fill, kept for channels detection doesn't cover): each channel
 * takes its band's hits from an analysis source of the mix, snapped to the nearest 16th, then
 * the song is split into sections where the pattern changes. Null while the source is still
 * being analysed.
 */
export function fillFromBands(sourceId: string): Record<string, number[]> | null {
  const sequence = projectController.project?.sequence
  const ready = analysisController.ready(sourceId)
  if (!sequence || !ready) return null
  const grid = sequence.beatGrid ?? DEFAULT_GRID
  const [from, to] = songSteps(sequence)
  const steps: Record<string, number[]> = {}
  for (const row of sequence.rack.rows.filter((r) => r.detect)) {
    const band = ready.result.bands[row.band]
    const hits = strongHits(band, row.detect ? DETECT_LISTEN[row.detect].gate : 0).map((h) => ready.start + secondsToTicks(h / ready.result.rate))
    steps[row.id] = stepsFromHits(hits, (t) => beatAt(grid, t), from, to)
  }
  const sections = sectionsFromHits(steps, grid, to)
  return projectController.dispatch(replaceRackSections(sections, 'Detect Pattern')) ? steps : null
}
