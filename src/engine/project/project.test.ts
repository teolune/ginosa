import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { addTrack, CommandError, removeTrack, setSequenceSettings, setTrackFlag } from './commands'
import { createProject, tracksOfKind } from './model'
import { parseProject, ProjectFormatError, serializeProject } from './serialize'

let counter = 0
const ids = () => `id-${++counter}`

describe('createProject', () => {
  it('starts with three video and three audio tracks at 1080p25', () => {
    const project = createProject({ name: 'New', createId: ids })
    expect(tracksOfKind(project.sequence, 'video').map((t) => t.name)).toEqual(['V1', 'V2', 'V3'])
    expect(tracksOfKind(project.sequence, 'audio').map((t) => t.name)).toEqual(['A1', 'A2', 'A3'])
    expect(project.sequence.settings).toEqual({ width: 1920, height: 1080, frameRate: '25', sampleRate: 48_000 })
  })
})

describe('commands', () => {
  it('names new tracks after the existing ones', () => {
    const history = new History(createProject({ name: 'P', createId: ids }))
    history.dispatch(addTrack('video', ids))
    expect(tracksOfKind(history.state.sequence, 'video').at(-1)?.name).toBe('V4')
  })

  it('refuses to delete the last track of a kind', () => {
    const history = new History(createProject({ name: 'P', createId: ids }))
    const audio = tracksOfKind(history.state.sequence, 'audio')
    history.dispatch(removeTrack(audio[0]!.id))
    history.dispatch(removeTrack(audio[1]!.id))
    expect(() => history.dispatch(removeTrack(audio[2]!.id))).toThrow(CommandError)
    expect(tracksOfKind(history.state.sequence, 'audio')).toHaveLength(1)
  })

  it('rejects invalid frame sizes without changing the project', () => {
    const history = new History(createProject({ name: 'P', createId: ids }))
    expect(() => history.dispatch(setSequenceSettings({ width: 1919 }))).toThrow(CommandError)
    expect(() => history.dispatch(setSequenceSettings({ height: 0 }))).toThrow(CommandError)
    expect(history.state.sequence.settings.width).toBe(1920)
    expect(history.canUndo).toBe(false)
  })

  it('switches to a vertical frame and back with undo', () => {
    const history = new History(createProject({ name: 'P', createId: ids }))
    history.dispatch(setSequenceSettings({ width: 1080, height: 1920 }))
    expect(history.state.sequence.settings.height).toBe(1920)
    history.undo()
    expect(history.state.sequence.settings.height).toBe(1080)
  })
})

describe('project files', () => {
  it('round-trips through JSON', () => {
    const history = new History(createProject({ name: 'Round trip', createId: ids }))
    history.dispatch(setTrackFlag(history.state.sequence.tracks[0]!.id, 'muted', true))
    history.dispatch(setSequenceSettings({ frameRate: '23.976' }))
    expect(parseProject(serializeProject(history.state))).toEqual(history.state)
  })

  it('explains what is wrong with a damaged file', () => {
    const good = JSON.parse(serializeProject(createProject({ name: 'X', createId: ids })))
    expect(() => parseProject('{ not json')).toThrow(/not valid JSON/)
    expect(() => parseProject({ ...good, schemaVersion: 99 })).toThrow(/newer ginosa/)
    const badRate = structuredClone(good)
    badRate.sequence.settings.frameRate = '17'
    expect(() => parseProject(badRate)).toThrow(ProjectFormatError)
    const badTrack = structuredClone(good)
    badTrack.sequence.tracks[0].kind = 'midi'
    expect(() => parseProject(badTrack)).toThrow(/kind/)
  })
})
