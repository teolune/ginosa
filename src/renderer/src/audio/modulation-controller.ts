import { frameTicks } from '@engine/timeline/timeline'
import { hashText } from '@engine/audio/sources'
import { CURVE_RATE, curveValue, modulatorCurve, patternLinkCurve, sourceSignal, type CurveInputs } from '@engine/modulation/curve'
import { allLinksTo } from '@engine/timeline/rack'
import type { Modulator, ModulationContext } from '@engine/modulation/types'
import type { Project } from '@engine/project/model'
import { secondsToTicks, ticksToSeconds } from '@engine/time'
import { sequenceEnd } from '@engine/timeline/timeline'
import { Observable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { analysisController } from './analysis-controller'

/**
 * Every modulator's output curve, worked out in advance for the whole sequence (M8). The
 * player, export and the windows all read these same curves, so what reacts in playback is
 * what exports. Curves are rebuilt only when a modulator, its source's analysis or the beat
 * grid changes.
 */

interface Entry {
  key: string
  curve: Float32Array
  /** The source signal before shaping (for the windows). */
  raw: Float32Array
  /** False while its audio source is still being analysed. */
  ready: boolean
  /** A Channel Rack channel's curve for each value linked to it (each follows its cubes' amounts), by link id. */
  links?: Map<string, { key: string; curve: Float32Array }>
}

/** Curves cover the sequence plus this much, so a trim past the end still has values. */
const MARGIN_SECONDS = 30

function inputsFor(project: Project, m: Modulator): { inputs: CurveInputs; ready: boolean; key: string } {
  const grid = project.sequence.beatGrid
  if (m.source.kind === 'pattern') {
    const id = m.source.rowId
    const rack = project.sequence.rack
    const row = rack.rows.find((r) => r.id === id) ?? null
    const frameSeconds = ticksToSeconds(frameTicks(project.sequence))
    const cubes = rack.sections.map((s) => [s.bars, s.cubes[id] ?? []])
    return { inputs: { analysis: null, analysisStart: 0, customBand: null, grid, pattern: { row, rack, frameSeconds } }, ready: true, key: JSON.stringify([row, cubes, frameSeconds]) }
  }
  if (m.source.kind !== 'audio') return { inputs: { analysis: null, analysisStart: 0, customBand: null, grid }, ready: true, key: '' }
  const source = m.source
  const state = analysisController.state(source.sourceId)
  const ready = analysisController.ready(source.sourceId)
  const custom = typeof source.band === 'string' ? null : analysisController.band(source.sourceId, source.band.low, source.band.high)
  const needsCustom = typeof source.band !== 'string' && (source.signal === 'level' || source.signal === 'transient' || source.signal === 'hits')
  return {
    inputs: { analysis: ready?.result ?? null, analysisStart: ready?.start ?? 0, customBand: custom, grid },
    ready: ready !== null && (!needsCustom || custom !== null),
    key: `${state.key ?? 'none'}:${ready ? 'r' : 'n'}:${custom ? 'c' : '-'}:${ready?.start ?? 0}`
  }
}

/** Curves for a project, computed now (export takes these as a fixed snapshot). */
export function computeCurves(project: Project, previous: Map<string, Entry> = new Map()): Map<string, Entry> {
  const frames = Math.ceil((ticksToSeconds(sequenceEnd(project.sequence)) + MARGIN_SECONDS) * CURVE_RATE)
  const out = new Map<string, Entry>()
  for (const m of project.sequence.modulators) {
    const { inputs, ready, key: inputKey } = inputsFor(project, m)
    const key = JSON.stringify([m, project.sequence.beatGrid, inputKey, frames])
    const old = previous.get(m.id)
    const entry = old && old.key === key ? { ...old } : { key, curve: modulatorCurve(m, inputs, frames), raw: sourceSignal(m.source, inputs, frames), ready }
    if (m.source.kind === 'pattern') {
      // Each linked value follows its own amounts (the cubes' sliders); unchanged ones are kept.
      const links = new Map<string, { key: string; curve: Float32Array }>()
      for (const link of allLinksTo(project.sequence, m.id)) {
        const k = `${key}|${link.id}`
        const before = old?.links?.get(link.id)
        links.set(link.id, before && before.key === k ? before : { key: k, curve: patternLinkCurve(m, inputs, frames, link.id) })
      }
      entry.links = links
    }
    out.set(m.id, entry)
  }
  return out
}

/** A modulation context over fixed curves: modulators still waiting for analysis give nothing (null). */
export function contextOf(curves: Map<string, Entry>): ModulationContext {
  return {
    value: (id, time) => {
      const entry = curves.get(id)
      return entry && entry.ready ? curveValue(entry.curve, time) : null
    },
    linkValue: (link, time) => {
      const curve = curves.get(link.modulatorId)?.links?.get(link.id)?.curve
      return curve ? curveValue(curve, time) : null
    },
    id: hashText(JSON.stringify([...curves].map(([id, e]) => [id, e.key, e.ready, e.links ? [...e.links.keys()] : null])))
  }
}

class ModulationController extends Observable {
  private curves = new Map<string, Entry>()
  private timer: number | null = null
  context: ModulationContext = contextOf(this.curves)

  constructor() {
    super()
    const schedule = () => {
      if (this.timer !== null) return
      this.timer = window.setTimeout(() => {
        this.timer = null
        this.refresh()
      }, 0)
    }
    projectController.subscribe(schedule)
    analysisController.subscribe(schedule)
  }

  refresh(): void {
    const project = projectController.project
    this.curves = project ? computeCurves(project, this.curves) : new Map()
    this.context = contextOf(this.curves)
    this.notify()
  }

  entry(id: string): Entry | null {
    return this.curves.get(id) ?? null
  }

  /** A modulator's output at a time (null while waiting for analysis). */
  valueAt(id: string, time: number): number | null {
    return this.context.value(id, time)
  }

  rawAt(id: string, time: number): number | null {
    const entry = this.curves.get(id)
    return entry && entry.ready ? curveValue(entry.raw, time) : null
  }

  /** Waits for analysis, then returns curves for this exact project (export renders with these, unchanged). */
  async snapshot(project: Project): Promise<ModulationContext> {
    await analysisController.settle()
    return contextOf(computeCurves(project))
  }
}

export const modulationController = new ModulationController()
export { CURVE_RATE, secondsToTicks }
