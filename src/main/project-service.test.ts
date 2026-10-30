import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { History, replayPatches, type Patch } from '../engine/history'
import { addTrack, renameProject, setSequenceSettings } from '../engine/project/commands'
import { createProject } from '../engine/project/model'
import { parseProject, serializeProject } from '../engine/project/serialize'
import { normaliseProjectPath, ProjectService } from './project-service'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ginosa-test-'))
  path = join(dir, 'Test.ginosa')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Simulates the renderer: every change goes to the journal, as ProjectController does. */
function journaled(service: ProjectService, history: History) {
  let seq = 0
  history.subscribe((change) => {
    if (change.kind === 'reset') return
    void service.appendJournal({ seq: ++seq, at: new Date().toISOString(), kind: change.kind, label: change.label, patches: change.patches })
  })
}

async function crash(projectPath: string) {
  // A lock left by a process that no longer exists is exactly what a crash or force quit leaves behind.
  await writeFile(join(projectPath, 'session.lock'), JSON.stringify({ pid: 999_999, openedAt: new Date().toISOString() }))
}

describe('ProjectService', () => {
  it('creates a project folder with project.json and a session lock', async () => {
    const service = new ProjectService()
    await service.create(path, serializeProject(createProject({ name: 'Test' })))
    expect((await readdir(path)).sort()).toEqual(['autosave', 'journal.jsonl', 'project.json', 'session.lock'])
    await service.close()
    expect(await readdir(path)).not.toContain('session.lock')
  })

  it('opens a cleanly closed project without offering recovery', async () => {
    const service = new ProjectService()
    await service.create(path, serializeProject(createProject({ name: 'Test' })))
    await service.close()
    const opened = await new ProjectService().open(path)
    expect(opened.recovery).toBeNull()
    expect(parseProject(opened.json).name).toBe('Test')
  })

  it('recovers every change made after the last save when the app crashes', async () => {
    const service = new ProjectService()
    const project = createProject({ name: 'Test' })
    await service.create(path, serializeProject(project))
    const history = new History(project)
    journaled(service, history)
    history.dispatch(renameProject('Night shoot'))
    history.dispatch(setSequenceSettings({ width: 1080, height: 1920 }))
    history.dispatch(addTrack('audio'))
    history.undo()
    await service.appendJournal({ seq: 99, at: new Date().toISOString(), kind: 'do', label: 'flush', patches: [] })
    await crash(path)

    const opened = await new ProjectService().open(path)
    expect(opened.recovery).not.toBeNull()
    const base = parseProject(opened.recovery!.baseJson)
    const recovered = replayPatches(base, opened.recovery!.journal as Patch[][])
    expect(recovered).toEqual(history.state)
  })

  it('recovers from the newest autosave plus later changes', async () => {
    const service = new ProjectService()
    const project = createProject({ name: 'Test' })
    await service.create(path, serializeProject(project))
    const history = new History(project)
    journaled(service, history)
    history.dispatch(renameProject('Before autosave'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await service.autosave(serializeProject(history.state))
    history.dispatch(addTrack('video'))
    await service.appendJournal({ seq: 99, at: new Date().toISOString(), kind: 'do', label: 'flush', patches: [] })
    await crash(path)

    const opened = await new ProjectService().open(path)
    const recovered = replayPatches(parseProject(opened.recovery!.baseJson), opened.recovery!.journal as Patch[][])
    expect(recovered).toEqual(history.state)
  })

  it('ignores a journal line cut off by the crash', async () => {
    const service = new ProjectService()
    const project = createProject({ name: 'Test' })
    await service.create(path, serializeProject(project))
    const history = new History(project)
    journaled(service, history)
    history.dispatch(renameProject('Kept'))
    await service.appendJournal({ seq: 99, at: new Date().toISOString(), kind: 'do', label: 'flush', patches: [] })
    const journal = join(path, 'journal.jsonl')
    await writeFile(journal, `${await readFile(journal, 'utf8')}{"seq":3,"patc`)
    await crash(path)
    const opened = await new ProjectService().open(path)
    const recovered = replayPatches(parseProject(opened.recovery!.baseJson), opened.recovery!.journal as Patch[][])
    expect(recovered.name).toBe('Kept')
  })

  it('saving clears the journal so nothing is replayed twice', async () => {
    const service = new ProjectService()
    const project = createProject({ name: 'Test' })
    await service.create(path, serializeProject(project))
    const history = new History(project)
    journaled(service, history)
    history.dispatch(renameProject('Saved name'))
    await service.save(serializeProject(history.state))
    expect(await readFile(join(path, 'journal.jsonl'), 'utf8')).toBe('')
    await crash(path)
    const opened = await new ProjectService().open(path)
    expect(opened.recovery).toBeNull()
    expect(parseProject(opened.json).name).toBe('Saved name')
  })

  it('keeps only the newest 20 autosaves', async () => {
    const service = new ProjectService()
    await service.create(path, serializeProject(createProject({ name: 'Test' })))
    for (let i = 0; i < 24; i++) {
      await service.autosave(serializeProject(createProject({ name: `v${i}` })))
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect((await readdir(join(path, 'autosave'))).filter((f) => f.endsWith('.json'))).toHaveLength(20)
  })

  it('refuses to turn an unrelated existing folder into a project', async () => {
    const other = join(dir, 'Holiday photos.ginosa')
    await (await import('node:fs/promises')).mkdir(other)
    await writeFile(join(other, 'photo.jpg'), 'x')
    await expect(new ProjectService().create(other, '{}')).rejects.toThrow(/not a ginosa project/)
    expect(await readdir(other)).toEqual(['photo.jpg'])
  })
})

describe('normaliseProjectPath', () => {
  it('adds the .ginosa extension and accepts project.json inside a project', () => {
    expect(normaliseProjectPath('/a/My film')).toBe('/a/My film.ginosa')
    expect(normaliseProjectPath('/a/My film.ginosa/project.json')).toBe('/a/My film.ginosa')
  })
})
