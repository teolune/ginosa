import type { BandId } from '../audio/analysis'
import { CommandError } from '../project/commands'
import { DEFAULT_SECTION_BARS, MAX_SECTION_BARS, defaultId, type IdFactory, type RackCube, type RackDetect, type RackRow, type RackSection, type Sequence } from '../project/model'
import { DEFAULT_GRID } from '../modulation/curve'
import { timelineCommand, type TimelineCommand } from './edits'
import { dropModulator, newModulator } from './modulation-edits'
import { maxLoopSteps } from './rack'

/**
 * The Channel Rack's commands (M12, redesigned in W3). A channel and its modulator are made
 * and removed together; the modulator keeps the channel's name. Every change is one undo step
 * (a paint stroke across cubes, or a slider drag, through its coalesce key).
 */

/** The four channels Automatic Detection fills (decision 108), with the bands M12's auto-fill listened to. */
export const STARTER_ROWS: ReadonlyArray<{ name: string; band: BandId; detect: RackDetect | null }> = [
  { name: 'Kick', band: 'bass', detect: 'kick' },
  { name: 'Clap', band: 'mid', detect: 'clap' },
  { name: 'Hi-hat', band: 'high', detect: 'hihat' },
  { name: 'Bass', band: 'lowMid', detect: 'bass' }
]

/** A cube, by where it sits. */
export interface CubeRef {
  sectionId: string
  rowId: string
  step: number
}

function row(sequence: Sequence, id: string): RackRow {
  const found = sequence.rack.rows.find((r) => r.id === id)
  if (!found) throw new CommandError('That Channel Rack channel is gone')
  return found
}

function section(sequence: Sequence, id: string): RackSection {
  const found = sequence.rack.sections.find((s) => s.id === id)
  if (!found) throw new CommandError('That Channel Rack section is gone')
  return found
}

function modulatorOf(sequence: Sequence, rowId: string) {
  const id = sequence.rack.rows.find((r) => r.id === rowId)?.modulatorId
  return id ? sequence.modulators.find((m) => m.id === id) : undefined
}

function loopLimit(sequence: Sequence): number {
  return maxLoopSteps(sequence.beatGrid ?? DEFAULT_GRID)
}

function sortCubes(cubes: RackCube[]): RackCube[] {
  return cubes.sort((a, b) => a.step - b.step)
}

function checkBars(bars: number): number {
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_SECTION_BARS) throw new CommandError(`A section is 1 to ${MAX_SECTION_BARS} bars`)
  return bars
}

/** New channels (at the bottom), each with its own modulator, which flashes and falls back in 150 ms. A rack with no sections gets section A. */
export function addRackRows(rows: ReadonlyArray<{ name: string; band?: BandId; detect?: RackDetect | null }>, newId: IdFactory = defaultId): TimelineCommand & { rowIds: string[] } {
  const rowIds = rows.map(() => newId())
  const sectionId = newId()
  const command = timelineCommand(rows.length === 1 ? `Add ${rows[0]!.name} Channel` : 'Add Channels', (draft) => {
    rows.forEach((r, i) => {
      const name = r.name.trim() || 'Channel'
      const modulatorId = newId()
      draft.sequence.rack.rows.push({ id: rowIds[i]!, name, enabled: true, swing: 0, band: r.band ?? 'mid', modulatorId, strength: 100, nudge: 0, detect: r.detect ?? null })
      draft.sequence.modulators.push(newModulator(modulatorId, name, { kind: 'pattern', rowId: rowIds[i]! }))
    })
    if (draft.sequence.rack.sections.length === 0) draft.sequence.rack.sections.push({ id: sectionId, bars: DEFAULT_SECTION_BARS, cubes: {} })
  }) as TimelineCommand & { rowIds: string[] }
  command.rowIds = rowIds
  return command
}

export function renameRackRow(rowId: string, name: string): TimelineCommand {
  return timelineCommand('Rename Channel', (draft) => {
    const r = row(draft.sequence, rowId)
    const clean = name.trim()
    if (!clean) throw new CommandError('A channel needs a name')
    r.name = clean
    const m = modulatorOf(draft.sequence, rowId)
    if (m) m.name = clean
  })
}

export type RackRowChanges = Partial<Pick<RackRow, 'enabled' | 'swing' | 'band' | 'strength' | 'nudge'>>

const LABELS: Record<keyof RackRowChanges, string> = { enabled: 'Turn Channel On or Off', swing: 'Change Swing', band: 'Change Auto-fill Band', strength: 'Change Strength', nudge: 'Nudge Channel' }

export function setRackRow(rowId: string, changes: RackRowChanges): TimelineCommand {
  const key = Object.keys(changes)[0] as keyof RackRowChanges | undefined
  const label = changes.enabled !== undefined ? (changes.enabled ? 'Turn Channel On' : 'Turn Channel Off') : key ? LABELS[key] : 'Change Channel'
  const command = timelineCommand(label, (draft) => {
    const r = row(draft.sequence, rowId)
    const number = (v: number, name: string) => {
      if (!Number.isFinite(v)) throw new CommandError(`${name} needs a number`)
      return v
    }
    if (changes.enabled !== undefined) r.enabled = changes.enabled
    if (changes.swing !== undefined) r.swing = Math.min(75, Math.max(0, number(changes.swing, 'Swing')))
    if (changes.band !== undefined) r.band = changes.band
    if (changes.strength !== undefined) r.strength = Math.round(Math.min(150, Math.max(0, number(changes.strength, 'Strength'))) * 10) / 10
    if (changes.nudge !== undefined) r.nudge = Math.round(Math.min(50, Math.max(-50, number(changes.nudge, 'Nudge'))) * 10) / 10
  })
  if (changes.enabled === undefined && key) command.coalesceKey = `rack-${key}:${rowId}`
  return command
}

/** Moves a channel up or down the rack. */
export function moveRackRow(rowId: string, to: number): TimelineCommand {
  return timelineCommand('Move Channel', (draft) => {
    const rows = draft.sequence.rack.rows
    const i = rows.findIndex((r) => r.id === rowId)
    if (i < 0) throw new CommandError('That Channel Rack channel is gone')
    const [r] = rows.splice(i, 1)
    rows.splice(Math.max(0, Math.min(rows.length, to)), 0, r!)
  })
}

/** Removes a channel, its cubes, its modulator and every link to it. */
export function removeRackRow(rowId: string): TimelineCommand {
  return timelineCommand('Remove Channel', (draft, command) => {
    const sequence = draft.sequence
    row(sequence, rowId)
    const m = modulatorOf(sequence, rowId)
    sequence.rack.rows = sequence.rack.rows.filter((r) => r.id !== rowId)
    for (const s of sequence.rack.sections) delete s.cubes[rowId]
    const links = m ? dropModulator(sequence, m.id) : 0
    if (links > 0) command.notice = `Removed it from the ${links} value${links === 1 ? '' : 's'} it moved.`
  })
}

// ---- Sections ------------------------------------------------------------------------

/** + : an empty section after `afterId` (at the end when null), 8 bars by default (decision 107). */
export function addRackSection(afterId: string | null, bars = DEFAULT_SECTION_BARS, newId: IdFactory = defaultId): TimelineCommand & { sectionId: string } {
  const sectionId = newId()
  const command = timelineCommand('Add Section', (draft) => {
    const sections = draft.sequence.rack.sections
    const at = afterId === null ? sections.length : sections.findIndex((s) => s.id === afterId) + 1
    if (at === 0) throw new CommandError('That Channel Rack section is gone')
    sections.splice(at, 0, { id: sectionId, bars: checkBars(bars), cubes: {} })
  }) as TimelineCommand & { sectionId: string }
  command.sectionId = sectionId
  return command
}

/** A section's length; the sections after it move with it. */
export function setRackSectionBars(sectionId: string, bars: number): TimelineCommand {
  return timelineCommand('Change Section Length', (draft) => {
    section(draft.sequence, sectionId).bars = checkBars(bars)
  })
}

export function removeRackSection(sectionId: string): TimelineCommand {
  return timelineCommand('Remove Section', (draft) => {
    section(draft.sequence, sectionId)
    draft.sequence.rack.sections = draft.sequence.rack.sections.filter((s) => s.id !== sectionId)
  })
}

// ---- Cubes ---------------------------------------------------------------------------

/** Makes cubes (empty amounts) or removes them, in one channel of one section. `stroke` names a paint stroke, so it's one undo step. */
export function setRackCubes(sectionId: string, rowId: string, steps: number[], on: boolean, stroke: string | null = null): TimelineCommand {
  const command = timelineCommand(on ? 'Add Cubes' : 'Delete Cubes', (draft) => {
    const s = section(draft.sequence, sectionId)
    row(draft.sequence, rowId)
    const limit = loopLimit(draft.sequence)
    const cubes = s.cubes[rowId] ?? []
    const have = new Set(cubes.map((c) => c.step))
    for (const step of steps) {
      if (!Number.isInteger(step) || step < 0 || step >= limit) throw new CommandError(`A cube sits on one of the loop's ${limit} 16ths`)
      if (on && !have.has(step)) {
        cubes.push({ step, amounts: {} })
        have.add(step)
      }
    }
    const next = on ? cubes : cubes.filter((c) => !steps.includes(c.step))
    if (next.length) s.cubes[rowId] = sortCubes(next)
    else delete s.cubes[rowId]
  })
  if (stroke) command.coalesceKey = `rack-stroke:${stroke}`
  return command
}

/** Backspace: deletes these cubes, in any channels and sections. */
export function removeRackCubes(refs: readonly CubeRef[]): TimelineCommand {
  return timelineCommand(refs.length === 1 ? 'Delete Cube' : 'Delete Cubes', (draft) => {
    for (const ref of refs) {
      const s = section(draft.sequence, ref.sectionId)
      const next = (s.cubes[ref.rowId] ?? []).filter((c) => c.step !== ref.step)
      if (next.length) s.cubes[ref.rowId] = next
      else delete s.cubes[ref.rowId]
    }
  })
}

function cubeAt(sequence: Sequence, ref: CubeRef): RackCube {
  const cube = section(sequence, ref.sectionId).cubes[ref.rowId]?.find((c) => c.step === ref.step)
  if (!cube) throw new CommandError('That cube is gone')
  return cube
}

/** A cube window slider: how far these cubes push one linked value, −100 to 100% (decision 109). */
export function setCubeAmount(refs: readonly CubeRef[], linkId: string, amount: number, stroke: string | null = null): TimelineCommand {
  const command = timelineCommand('Change Cube Amount', (draft) => {
    if (!Number.isFinite(amount)) throw new CommandError('An amount needs a number')
    const value = Math.round(Math.min(100, Math.max(-100, amount)))
    for (const ref of refs) {
      const cube = cubeAt(draft.sequence, ref)
      if (value === 100) delete cube.amounts[linkId]
      else cube.amounts[linkId] = value
    }
  })
  command.coalesceKey = stroke ? `cube-amount:${stroke}` : `cube-amount:${linkId}:${refs.map((r) => `${r.sectionId}/${r.rowId}/${r.step}`).join(',')}`
  return command
}

/** Cmd+V: cubes copied earlier, placed into a section at the same 16ths and channels (replacing what's there). */
export function pasteRackCubes(sectionId: string, cubes: ReadonlyArray<{ rowId: string; step: number; amounts: Record<string, number> }>): TimelineCommand {
  return timelineCommand(cubes.length === 1 ? 'Paste Cube' : 'Paste Cubes', (draft) => {
    const s = section(draft.sequence, sectionId)
    const limit = loopLimit(draft.sequence)
    for (const c of cubes) {
      if (!draft.sequence.rack.rows.some((r) => r.id === c.rowId)) continue
      if (!Number.isInteger(c.step) || c.step < 0 || c.step >= limit) continue
      const list = (s.cubes[c.rowId] ?? []).filter((x) => x.step !== c.step)
      list.push({ step: c.step, amounts: { ...c.amounts } })
      s.cubes[c.rowId] = sortCubes(list)
    }
  })
}

/** Cmd+Option+V: these cubes take the amounts copied from another (Premiere's Paste Attributes). */
export function pasteCubeAmounts(refs: readonly CubeRef[], amounts: Record<string, number>): TimelineCommand {
  return timelineCommand('Paste Cube Amounts', (draft) => {
    for (const ref of refs) cubeAt(draft.sequence, ref).amounts = { ...amounts }
  })
}

/**
 * Automatic Detection's result: the sections and their cubes, replacing the rack's sections
 * (channels, their settings and links stay). `cubes` are by channel id.
 */
export function replaceRackSections(sections: ReadonlyArray<{ bars: number; cubes: Record<string, number[]> }>, label = 'Detect Pattern', newId: IdFactory = defaultId): TimelineCommand {
  return timelineCommand(label, (draft) => {
    const limit = loopLimit(draft.sequence)
    const ids = new Set(draft.sequence.rack.rows.map((r) => r.id))
    draft.sequence.rack.sections = sections.map((s) => ({
      id: newId(),
      bars: checkBars(s.bars),
      cubes: Object.fromEntries(
        Object.entries(s.cubes)
          .filter(([id, steps]) => ids.has(id) && steps.length > 0)
          .map(([id, steps]) => [id, [...new Set(steps)].filter((x) => Number.isInteger(x) && x >= 0 && x < limit).sort((a, b) => a - b).map((step) => ({ step, amounts: {} }))])
      )
    }))
  })
}

/**
 * Hit times (sequence ticks) snapped to the nearest 16th on the grid, within [from, to).
 * `beatAt` places a time on the grid.
 */
export function stepsFromHits(hits: number[], beatAt: (time: number) => number, from: number, to: number): number[] {
  return [...new Set(hits.map((t) => Math.round(beatAt(t) * 4)).filter((s) => s >= from && s < to))].sort((a, b) => a - b)
}
