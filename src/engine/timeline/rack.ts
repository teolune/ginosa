import { beatAt } from '../audio/beat-grid'
import { LOOP_BARS, MAX_SECTION_BARS, STEPS_PER_BEAT, type BeatGrid, type IdFactory, type Rack, type RackCube, type RackDetect, type RackRow, type RackSection, type Sequence } from '../project/model'
import type { ModLink } from '../modulation/types'

/**
 * The Channel Rack's maths (W3, decisions 105–107): sections run on from bar 1, each a whole
 * number of bars; a channel's cubes in a section are a loop of 16ths (two bars, or the section
 * if it's shorter) that repeats to the section's end. Steps here are 16ths counted from the
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

/** The loop's length in 16ths: two bars, or the section if it's shorter. */
export function loopSteps(section: Pick<RackSection, 'bars'>, grid: BeatGrid): number {
  return Math.min(LOOP_BARS, section.bars) * stepsPerBar(grid)
}

/** The most cubes a channel can have in a section (a two-bar loop). */
export function maxLoopSteps(grid: BeatGrid): number {
  return LOOP_BARS * stepsPerBar(grid)
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
  /** Its length in 16ths. */
  steps: number
  /** Its loop's length in 16ths. */
  loop: number
}

export function placeSections(rack: Rack, grid: BeatGrid): PlacedSection[] {
  const perBar = stepsPerBar(grid)
  let bar = 0
  const origin = barOneStep(grid)
  return rack.sections.map((section, index) => {
    const placed = { section, index, startBar: bar, firstStep: origin + bar * perBar, steps: section.bars * perBar, loop: loopSteps(section, grid) }
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

/** Every hit of a channel through the song, in time order: each section's loop repeated to its end. */
export function channelHits(rack: Rack, rowId: string, grid: BeatGrid): RackHit[] {
  const out: RackHit[] = []
  for (const placed of placeSections(rack, grid)) {
    const cubes = (placed.section.cubes[rowId] ?? []).filter((c) => c.step < placed.loop)
    if (cubes.length === 0) continue
    for (let start = 0; start < placed.steps; start += placed.loop)
      for (const cube of cubes) if (start + cube.step < placed.steps) out.push({ step: placed.firstStep + start + cube.step, cube, sectionId: placed.section.id })
  }
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
 * Project format 13: M12's rows kept their steps along the whole song. They become sections:
 * two bars at a time from bar 1 (exact, since a loop is two bars), joined where the next two
 * bars repeat them, up to 16 bars. Steps before bar 1 are dropped.
 */
export function sectionsFromSteps(rows: ReadonlyArray<{ id: string; steps: readonly number[] }>, grid: BeatGrid, newId: IdFactory): RackSection[] {
  const perBar = stepsPerBar(grid)
  const loop = LOOP_BARS * perBar
  const origin = barOneStep(grid)
  let last = -1
  for (const r of rows) for (const s of r.steps) if (s >= origin) last = Math.max(last, s - origin)
  if (last < 0) return []
  const chunks = Math.floor(last / loop) + 1
  const pattern = (k: number): Record<string, number[]> =>
    Object.fromEntries(rows.map((r) => [r.id, r.steps.filter((s) => s - origin >= k * loop && s - origin < (k + 1) * loop).map((s) => s - origin - k * loop)]))
  const sections: RackSection[] = []
  let current: { bars: number; key: string; cubes: Record<string, number[]> } | null = null
  const flush = () => {
    if (!current) return
    sections.push({ id: newId(), bars: current.bars, cubes: Object.fromEntries(Object.entries(current.cubes).filter(([, s]) => s.length > 0).map(([id, s]) => [id, s.map((step) => ({ step, amounts: {} }))])) })
  }
  for (let k = 0; k < chunks; k++) {
    const cubes = pattern(k)
    const key = JSON.stringify(cubes)
    if (current && current.key === key && current.bars + LOOP_BARS <= 16) current.bars += LOOP_BARS
    else {
      flush()
      current = { bars: LOOP_BARS, key, cubes }
    }
  }
  flush()
  return sections
}

/**
 * Sections from hits along the song (Automatic Detection): the song in two-bar chunks from
 * bar 1 up to `endStep`; a chunk joins the section before it while its cubes are close to
 * that section's loop (at most `tolerance` of them differ) and the section stays within 16
 * bars; otherwise it starts a new section. A section's loop keeps the cubes hit in at least
 * half of its chunks, so one stray or missed hit doesn't split the song. Steps are 16ths from
 * the downbeat; the result's cubes are loop steps, by channel id.
 */
export function sectionsFromHits(
  steps: Record<string, readonly number[]>,
  grid: BeatGrid,
  endStep: number,
  tolerance = 0.25
): Array<{ bars: number; cubes: Record<string, number[]> }> {
  const perBar = stepsPerBar(grid)
  const loop = LOOP_BARS * perBar
  const origin = barOneStep(grid)
  const totalBars = Math.max(0, Math.ceil((endStep - origin) / perBar))
  const ids = Object.keys(steps)
  /** `span`: the chunk's 16ths that are in the song (fewer in the last one when the song ends mid-loop). */
  type Chunk = { bars: number; span: number; cubes: Map<string, Set<number>> }
  const chunks: Chunk[] = []
  for (let bar = 0; bar < totalBars; bar += LOOP_BARS) {
    const bars = Math.min(LOOP_BARS, totalBars - bar)
    const from = origin + bar * perBar
    const cubes = new Map<string, Set<number>>()
    for (const id of ids) cubes.set(id, new Set(steps[id]!.filter((s) => s >= from && s < from + bars * perBar).map((s) => s - from)))
    chunks.push({ bars, span: Math.min(bars * perBar, endStep - from), cubes })
  }
  const key = (id: string, s: number) => `${id}:${s}`
  const flat = (c: Map<string, Set<number>>, span: number) => new Set([...c].flatMap(([id, set]) => [...set].filter((s) => s < span).map((s) => key(id, s))))
  type Section = { bars: number; members: Chunk[]; loop: Map<string, Set<number>> }
  const majority = (members: Chunk[]): Map<string, Set<number>> => {
    const out = new Map<string, Set<number>>()
    for (const id of ids) {
      const counts = new Map<number, number>()
      for (const m of members) for (const s of m.cubes.get(id)!) counts.set(s, (counts.get(s) ?? 0) + 1)
      out.set(id, new Set([...counts].filter(([, n]) => n * 2 >= members.length).map(([s]) => s)))
    }
    return out
  }
  const sections: Section[] = []
  for (const chunk of chunks) {
    const current = sections.at(-1)
    // The song's last chunk may be cut short: it's compared over the part that's in the song,
    // joins the section before it when that matches, and doesn't vote on the loop.
    const whole = chunk.span === loop
    if (current && current.bars + chunk.bars <= MAX_SECTION_BARS) {
      const a = flat(current.loop, chunk.span)
      const b = flat(chunk.cubes, chunk.span)
      const union = new Set([...a, ...b])
      let differ = 0
      for (const k of union) if (a.has(k) !== b.has(k)) differ++
      if (union.size === 0 || differ / union.size <= tolerance) {
        current.bars += chunk.bars
        if (whole) {
          current.members.push(chunk)
          current.loop = majority(current.members)
        }
        continue
      }
    }
    sections.push({ bars: chunk.bars, members: [chunk], loop: new Map(chunk.cubes) })
  }
  return sections.map((s) => ({ bars: s.bars, cubes: Object.fromEntries([...s.loop].map(([id, set]) => [id, [...set].sort((x, y) => x - y)])) }))
}

/** The modulators that listen to a channel: its own, and any other with it as their source (a preset's, say). */
export function channelModulatorIds(sequence: Sequence, rowId: string): string[] {
  return sequence.modulators.filter((m) => m.source.kind === 'pattern' && m.source.rowId === rowId).map((m) => m.id)
}
