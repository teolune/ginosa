import { beatAt } from '../audio/beat-grid'
import { DEFAULT_SECTION_BARS, MAX_SECTION_BARS, STEPS_PER_BEAT, type BeatGrid, type IdFactory, type Rack, type RackCube, type RackDetect, type RackRow, type RackSection, type Sequence } from '../project/model'
import type { ModLink } from '../modulation/types'

/**
 * The Channel Rack's maths (W3, decisions 105–107 and 130): sections run on from bar 1, each a
 * whole number of bars, and each holds its channels' cubes for its whole length, 16 to a bar, so
 * the rack shows the song as it plays (nothing repeats). Steps here are 16ths counted from the
 * beat grid's downbeat, as M12's were, so sections follow the grid.
 */

/**
 * How Automatic Detection listens for each channel (decision 108): in which stem of the
 * separated song, at which frequencies, and how loud a hit must be against the loud hits
 * around it to count (`strongHits`), so the leak of other drums into a band drops out (the
 * hi-hats' gate is low: snares and claps are louder up there, not quieter, so it only drops
 * stray noise). A
 * kick's thump is under 150 Hz, a clap's or snare's crack 1.5–5 kHz, a hi-hat's hiss above
 * 7 kHz; the bass's notes are in the bass stem. Without separation the channels listen to
 * their bands of the whole song with the same gates.
 */
export const DETECT_LISTEN: Record<RackDetect, { stem: 'drums' | 'bass'; low: number; high: number; gate: number }> = {
  kick: { stem: 'drums', low: 30, high: 150, gate: 0.3 },
  clap: { stem: 'drums', low: 1500, high: 5000, gate: 0.45 },
  hihat: { stem: 'drums', low: 7000, high: 16000, gate: 0.1 },
  bass: { stem: 'bass', low: 30, high: 300, gate: 0.3 }
}

export function stepsPerBar(grid: BeatGrid): number {
  return grid.beatsPerBar * STEPS_PER_BEAT
}

/** A section's length in 16ths: the cubes a channel can have in it (decision 130). */
export function sectionSteps(section: Pick<RackSection, 'bars'>, grid: BeatGrid): number {
  return section.bars * stepsPerBar(grid)
}

/** Bar 1's first 16th from the downbeat: the first downbeat at or after the sequence start, as on the ruler. */
export function barOneStep(grid: BeatGrid): number {
  return Math.ceil(beatAt(grid, 0) / grid.beatsPerBar - 1e-9) * stepsPerBar(grid)
}

export interface PlacedSection {
  section: RackSection
  index: number
  /** Bars from bar 1 (0 = bar 1). */
  startBar: number
  /** Its first 16th, from the downbeat. */
  firstStep: number
  /** Its length in 16ths: its cubes are steps 0 to this. */
  steps: number
}

export function placeSections(rack: Rack, grid: BeatGrid): PlacedSection[] {
  const perBar = stepsPerBar(grid)
  let bar = 0
  const origin = barOneStep(grid)
  return rack.sections.map((section, index) => {
    const placed = { section, index, startBar: bar, firstStep: origin + bar * perBar, steps: section.bars * perBar }
    bar += section.bars
    return placed
  })
}

/** The section playing at a 16th from the downbeat (fractional is fine), or null outside them. */
export function sectionAtStep(rack: Rack, grid: BeatGrid, step: number): PlacedSection | null {
  return placeSections(rack, grid).find((p) => step >= p.firstStep && step < p.firstStep + p.steps) ?? null
}

/** A, B, … Z, AA, AB … */
export function sectionName(index: number): string {
  let n = index
  let name = ''
  do {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return name
}

export interface RackHit {
  /** The 16th it sits on, from the downbeat. */
  step: number
  cube: RackCube
  sectionId: string
}

/** Every hit of a channel through the song, in time order: each cube once, where it is (decision 130). */
export function channelHits(rack: Rack, rowId: string, grid: BeatGrid): RackHit[] {
  const out: RackHit[] = []
  for (const placed of placeSections(rack, grid))
    for (const cube of placed.section.cubes[rowId] ?? []) if (cube.step < placed.steps) out.push({ step: placed.firstStep + cube.step, cube, sectionId: placed.section.id })
  return out
}

/** The beat a hit fires on: its 16th, later by the swing on every second 16th, then nudged (decision 106). */
export function hitBeat(step: number, row: Pick<RackRow, 'swing' | 'nudge'>): number {
  const sixteenth = 1 / STEPS_PER_BEAT
  return step * sixteenth + (Math.abs(step % 2) === 1 ? (row.swing / 100) * sixteenth : 0) + (row.nudge / 100) * sixteenth
}

/** How far a cube pushes a linked value: −1 to 1 (a link it doesn't list: 1, decision 109). */
export function cubeAmount(cube: RackCube, linkId: string): number {
  const a = cube.amounts[linkId]
  return a === undefined ? 1 : a / 100
}

/** Every modulation link to a modulator, wherever it lives (clips, effects, masks). */
export function allLinksTo(sequence: Sequence, modulatorId: string): ModLink[] {
  const out: ModLink[] = []
  const scan = (map: Record<string, ModLink[]>) => {
    for (const links of Object.values(map)) for (const link of links) if (link.modulatorId === modulatorId) out.push(link)
  }
  for (const clip of sequence.clips) {
    scan(clip.modulation)
    for (const effect of clip.effects) scan(effect.modulation)
  }
  for (const mask of sequence.masks) for (const shape of mask.shapes) scan(shape.modulation)
  return out
}

/**
 * Project format 13: M12's rows kept their steps along the whole song. They become sections of
 * 8 bars from bar 1 (the last one what's left), each with its steps where they are. Steps before
 * bar 1 are dropped.
 */
export function sectionsFromSteps(rows: ReadonlyArray<{ id: string; steps: readonly number[] }>, grid: BeatGrid, newId: IdFactory): RackSection[] {
  const perBar = stepsPerBar(grid)
  const origin = barOneStep(grid)
  let last = -1
  for (const r of rows) for (const s of r.steps) if (s >= origin) last = Math.max(last, s - origin)
  if (last < 0) return []
  return sectionsFromHits(Object.fromEntries(rows.map((r) => [r.id, r.steps])), grid, origin + (Math.floor(last / perBar) + 1) * perBar).map((s) => ({
    id: newId(),
    bars: s.bars,
    cubes: Object.fromEntries(Object.entries(s.cubes).filter(([, steps]) => steps.length > 0).map(([id, steps]) => [id, steps.map((step) => ({ step, amounts: {} }))]))
  }))
}

/**
 * Sections from hits along the song (Automatic Detection, decision 130): the song from bar 1 up
 * to `endStep` in sections of `bars` (8 by default, like a new section; the last one is what's
 * left), each with every hit where it is. Steps are 16ths from the downbeat; the result's cubes
 * are steps in their section, by channel id, and `doubtful` the ones only one check heard.
 */
export function sectionsFromHits(
  steps: Record<string, readonly number[]>,
  grid: BeatGrid,
  endStep: number,
  bars = DEFAULT_SECTION_BARS,
  doubtful: Record<string, readonly number[]> = {}
): Array<{ bars: number; cubes: Record<string, number[]>; doubtful: Record<string, number[]> }> {
  const perBar = stepsPerBar(grid)
  const origin = barOneStep(grid)
  const totalBars = Math.max(0, Math.ceil((endStep - origin) / perBar))
  const ids = Object.keys(steps)
  const sections: Array<{ bars: number; cubes: Record<string, number[]>; doubtful: Record<string, number[]> }> = []
  for (let first = 0; first < totalBars; first += bars) {
    const length = Math.min(bars, totalBars - first)
    const from = origin + first * perBar
    const to = Math.min(from + length * perBar, endStep)
    const cubes: Record<string, number[]> = {}
    const unsure: Record<string, number[]> = {}
    for (const id of ids) {
      const doubts = new Set(doubtful[id] ?? [])
      const here = [...new Set(steps[id]!.filter((s) => s >= from && s < to))].sort((x, y) => x - y)
      cubes[id] = here.map((s) => s - from)
      const marked = here.filter((s) => doubts.has(s)).map((s) => s - from)
      if (marked.length) unsure[id] = marked
    }
    sections.push({ bars: length, cubes, doubtful: unsure })
  }
  return sections
}

/** The modulators that listen to a channel: its own, and any other with it as their source (a preset's, say). */
export function channelModulatorIds(sequence: Sequence, rowId: string): string[] {
  return sequence.modulators.filter((m) => m.source.kind === 'pattern' && m.source.rowId === rowId).map((m) => m.id)
}
