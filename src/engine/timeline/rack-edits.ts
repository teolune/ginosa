import type { BandId } from '../audio/analysis'
import { CommandError } from '../project/commands'
import { defaultId, type IdFactory, type RackRow, type Sequence } from '../project/model'
import { timelineCommand, type TimelineCommand } from './edits'
import { dropModulator, newModulator } from './modulation-edits'

/**
 * The Channel Rack's commands (M12). A row and its modulator are made and removed together;
 * the modulator keeps the row's name. Every change is one undo step (a paint stroke across
 * steps too, through its coalesce key).
 */

/** The most steps a row keeps (about 17 minutes of 16ths at 240 BPM). */
export const MAX_ROW_STEPS = 65_536

/** Kick, Clap and Hat, with the bands Auto-fill listens to for each (the plan's pairing). */
export const STARTER_ROWS: ReadonlyArray<{ name: string; band: BandId }> = [
  { name: 'Kick', band: 'bass' },
  { name: 'Clap', band: 'mid' },
  { name: 'Hat', band: 'high' }
]

function row(sequence: Sequence, id: string): RackRow {
  const found = sequence.rack.rows.find((r) => r.id === id)
  if (!found) throw new CommandError('That Channel Rack row is gone')
  return found
}

function modulatorOf(sequence: Sequence, rowId: string) {
  const id = sequence.rack.rows.find((r) => r.id === rowId)?.modulatorId
  return id ? sequence.modulators.find((m) => m.id === id) : undefined
}

const clean = (steps: Iterable<number>) => [...new Set([...steps].filter(Number.isInteger))].sort((a, b) => a - b)

/** New rows (at the bottom), each with its own modulator, which flashes and falls back in 150 ms. */
export function addRackRows(rows: ReadonlyArray<{ name: string; band: BandId }>, newId: IdFactory = defaultId): TimelineCommand & { rowIds: string[] } {
  const rowIds = rows.map(() => newId())
  const command = timelineCommand(rows.length === 1 ? `Add ${rows[0]!.name} Row` : 'Add Rows', (draft) => {
    rows.forEach((r, i) => {
      const name = r.name.trim() || 'Row'
      const modulatorId = newId()
      draft.sequence.rack.rows.push({ id: rowIds[i]!, name, enabled: true, swing: 0, steps: [], band: r.band, modulatorId })
      draft.sequence.modulators.push(newModulator(modulatorId, name, { kind: 'pattern', rowId: rowIds[i]! }))
    })
  }) as TimelineCommand & { rowIds: string[] }
  command.rowIds = rowIds
  return command
}

export function renameRackRow(rowId: string, name: string): TimelineCommand {
  return timelineCommand('Rename Row', (draft) => {
    const r = row(draft.sequence, rowId)
    const clean = name.trim()
    if (!clean) throw new CommandError('A row needs a name')
    r.name = clean
    const m = modulatorOf(draft.sequence, rowId)
    if (m) m.name = clean
  })
}

export function setRackRow(rowId: string, changes: Partial<Pick<RackRow, 'enabled' | 'swing' | 'band'>>): TimelineCommand {
  const command = timelineCommand(changes.enabled !== undefined ? (changes.enabled ? 'Turn Row On' : 'Turn Row Off') : changes.swing !== undefined ? 'Change Swing' : 'Change Auto-fill Band', (draft) => {
    const r = row(draft.sequence, rowId)
    if (changes.enabled !== undefined) r.enabled = changes.enabled
    if (changes.swing !== undefined) {
      if (!Number.isFinite(changes.swing)) throw new CommandError('Swing needs a number')
      r.swing = Math.min(75, Math.max(0, changes.swing))
    }
    if (changes.band !== undefined) r.band = changes.band
  })
  command.coalesceKey = changes.swing !== undefined ? `rack-swing:${rowId}` : undefined
  return command
}

/** Turns steps on or off. `stroke` names a paint stroke across steps, so it's one undo step. */
export function setRackSteps(rowId: string, steps: number[], on: boolean, stroke: string | null = null): TimelineCommand {
  const command = timelineCommand(on ? 'Add Steps' : 'Remove Steps', (draft) => {
    const r = row(draft.sequence, rowId)
    const set = new Set(r.steps)
    for (const s of steps) if (Number.isInteger(s)) on ? set.add(s) : set.delete(s)
    if (set.size > MAX_ROW_STEPS) throw new CommandError(`A row can have up to ${MAX_ROW_STEPS.toLocaleString()} steps`)
    r.steps = clean(set)
  })
  if (stroke) command.coalesceKey = `rack-stroke:${stroke}`
  return command
}

/** Replaces a row's steps from `from` up to (not including) `to` with these (Auto-fill, Clear). */
export function fillRackRow(rowId: string, from: number, to: number, steps: number[], label = 'Auto-fill Row'): TimelineCommand {
  return timelineCommand(label, (draft) => {
    const r = row(draft.sequence, rowId)
    const kept = r.steps.filter((s) => s < from || s >= to)
    const next = clean([...kept, ...steps.filter((s) => s >= from && s < to)])
    if (next.length > MAX_ROW_STEPS) throw new CommandError(`A row can have up to ${MAX_ROW_STEPS.toLocaleString()} steps`)
    r.steps = next
  })
}

/**
 * Repeats the steps from `from` (for `length` steps) over and over up to `until`, on these
 * rows (Repeat to End: write a bar or two, then loop it through the song).
 */
export function repeatRackSteps(rowIds: string[], from: number, length: number, until: number): TimelineCommand {
  return timelineCommand('Repeat Pattern', (draft) => {
    if (!(length > 0) || until <= from + length) throw new CommandError('There’s nothing after these steps to repeat them into')
    for (const id of rowIds) {
      const r = row(draft.sequence, id)
      const source = r.steps.filter((s) => s >= from && s < from + length).map((s) => s - from)
      const kept = r.steps.filter((s) => s < from + length || s >= until)
      const copies: number[] = []
      for (let start = from + length; start < until; start += length) for (const s of source) if (start + s < until) copies.push(start + s)
      const next = clean([...kept, ...copies])
      if (next.length > MAX_ROW_STEPS) throw new CommandError(`A row can have up to ${MAX_ROW_STEPS.toLocaleString()} steps`)
      r.steps = next
    }
  })
}

/** Moves a row up or down the rack. */
export function moveRackRow(rowId: string, to: number): TimelineCommand {
  return timelineCommand('Move Row', (draft) => {
    const rows = draft.sequence.rack.rows
    const i = rows.findIndex((r) => r.id === rowId)
    if (i < 0) throw new CommandError('That Channel Rack row is gone')
    const [r] = rows.splice(i, 1)
    rows.splice(Math.max(0, Math.min(rows.length, to)), 0, r!)
  })
}

/** Removes a row, its modulator and every link to it. */
export function removeRackRow(rowId: string): TimelineCommand {
  return timelineCommand('Remove Row', (draft, command) => {
    const sequence = draft.sequence
    row(sequence, rowId)
    const m = modulatorOf(sequence, rowId)
    sequence.rack.rows = sequence.rack.rows.filter((r) => r.id !== rowId)
    const links = m ? dropModulator(sequence, m.id) : 0
    if (links > 0) command.notice = `Removed it from the ${links} value${links === 1 ? '' : 's'} it drove.`
  })
}

/**
 * Auto-fill's maths: hit times (sequence ticks) snapped to the nearest 16th on the grid,
 * within [from, to). `beatAt` places a time on the grid.
 */
export function stepsFromHits(hits: number[], beatAt: (time: number) => number, from: number, to: number): number[] {
  return clean(hits.map((t) => Math.round(beatAt(t) * 4)).filter((s) => s >= from && s < to))
}
