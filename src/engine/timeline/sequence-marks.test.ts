import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { createProject } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { markedRange, setSequenceMarks } from './sequence-marks'

const s = secondsToTicks
let counter = 0
const ids = () => `sm-${++counter}`
const frame = s(1 / 25)

describe('timeline In and Out', () => {
  it('marks on frames; a new In after the Out (or Out before In) clears the other; undoable and saved', () => {
    const history = new History(createProject({ name: 'Marks', createId: ids }))
    const marks = () => history.state.sequence.marks
    expect(marks()).toEqual({ in: null, out: null })
    expect(markedRange(history.state.sequence)).toBeNull()
    history.dispatch(setSequenceMarks({ in: s(2) + frame / 3 }))
    history.dispatch(setSequenceMarks({ out: s(5) }))
    expect(marks()).toEqual({ in: s(2), out: s(5) })
    expect(markedRange(history.state.sequence)).toEqual({ from: s(2), to: s(5) })
    history.dispatch(setSequenceMarks({ in: s(6) }))
    expect(marks()).toEqual({ in: s(6), out: null })
    history.dispatch(setSequenceMarks({ out: s(3) }))
    expect(marks()).toEqual({ in: null, out: s(3) })
    expect(markedRange(history.state.sequence)).toEqual({ from: 0, to: s(3) })
    expect(parseProject(serializeProject(history.state)).sequence.marks).toEqual(marks())
    history.undo()
    expect(marks()).toEqual({ in: s(6), out: null })
    history.dispatch(setSequenceMarks({ in: null, out: null }))
    expect(marks()).toEqual({ in: null, out: null })
  })

  it('projects from before In and Out open with none', () => {
    const project = createProject({ name: 'Old', createId: ids })
    const raw = JSON.parse(serializeProject(project)) as { schemaVersion: number; sequence: Record<string, unknown> }
    raw.schemaVersion = 10
    delete raw.sequence['marks']
    expect(parseProject(JSON.stringify(raw)).sequence.marks).toEqual({ in: null, out: null })
  })
})
