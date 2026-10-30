import { describe, expect, it } from 'vitest'
import { History, replayPatches, type Patch } from './history'
import { addTrack, renameProject, renameTrack, setTrackFlag } from './project/commands'
import { createProject } from './project/model'

let counter = 0
const ids = () => `id-${++counter}`

function setup(now = () => 0) {
  counter = 0
  const project = createProject({ name: 'Test', createId: ids, now: () => new Date('2026-01-01T00:00:00Z') })
  return { project, history: new History(project, { now }) }
}

describe('History', () => {
  it('applies, undoes and redoes a command', () => {
    const { project, history } = setup()
    history.dispatch(renameProject('Night shoot'))
    expect(history.state.name).toBe('Night shoot')
    history.undo()
    expect(history.state).toEqual(project)
    history.redo()
    expect(history.state.name).toBe('Night shoot')
  })

  it('ignores commands that change nothing', () => {
    const { history } = setup()
    expect(history.dispatch(renameProject('Test'))).toBeNull()
    expect(history.canUndo).toBe(false)
  })

  it('drops the redo branch when a new command arrives', () => {
    const { history } = setup()
    history.dispatch(addTrack('video', ids))
    history.undo()
    history.dispatch(addTrack('audio', ids))
    expect(history.canRedo).toBe(false)
    expect(history.entries.map((e) => e.label)).toEqual(['Add Audio Track'])
  })

  it('merges rapid commands with the same coalesce key into one undo step', () => {
    let time = 0
    const { history } = setup(() => time)
    history.dispatch(renameProject('N'))
    time = 200
    history.dispatch(renameProject('Ni'))
    time = 400
    history.dispatch(renameProject('Night'))
    expect(history.entries).toHaveLength(1)
    history.undo()
    expect(history.state.name).toBe('Test')
  })

  it('does not merge after a pause', () => {
    let time = 0
    const { history } = setup(() => time)
    history.dispatch(renameProject('A'))
    time = 5000
    history.dispatch(renameProject('B'))
    expect(history.entries).toHaveLength(2)
  })

  it('tracks the saved point through undo and redo', () => {
    const { history } = setup()
    history.dispatch(renameProject('Saved'))
    const saved = history.marker
    history.dispatch(addTrack('video', ids))
    expect(history.marker).not.toBe(saved)
    history.undo()
    expect(history.marker).toBe(saved)
  })

  it('jumps to any point in the list', () => {
    const { project, history } = setup()
    history.dispatch(addTrack('video', ids))
    history.dispatch(addTrack('video', ids))
    history.dispatch(addTrack('audio', ids))
    history.jumpTo(0)
    expect(history.state).toEqual(project)
    history.jumpTo(2)
    expect(history.state.sequence.tracks.filter((t) => t.kind === 'video')).toHaveLength(5)
  })

  it('caps the number of entries', () => {
    counter = 0
    const project = createProject({ name: 'Cap', createId: ids })
    const history = new History(project, { limit: 3 })
    for (let i = 0; i < 5; i++) history.dispatch(addTrack('audio', ids))
    expect(history.entries).toHaveLength(3)
    history.jumpTo(0)
    expect(history.state.sequence.tracks.filter((t) => t.kind === 'audio')).toHaveLength(5)
  })

  it('reports applied patches that rebuild the same state (crash journal)', () => {
    const { project, history } = setup()
    const journal: Patch[][] = []
    history.subscribe((change) => journal.push(change.patches))
    const videoId = project.sequence.tracks[0]!.id
    history.dispatch(renameTrack(videoId, 'Hero'))
    history.dispatch(setTrackFlag(videoId, 'locked', true))
    history.undo()
    history.dispatch(addTrack('audio', ids))
    expect(replayPatches(project, journal)).toEqual(history.state)
  })
})
