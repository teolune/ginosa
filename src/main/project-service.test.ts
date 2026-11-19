import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { History, replayPatches, type Patch } from '../engine/history'
import { addTrack, renameProject, setSequenceSettings } from '../engine/project/commands'
import { createProject } from '../engine/project/model'
import { parseProject, serializeProject } from '../engine/project/serialize'
import { normaliseProjectPath, OpenProjects, ProjectService, readCreatedAt, RecentProjects } from './project-service'

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

  it('Clean Up … and Autosaves deletes the autosave snapshots and nothing else', async () => {
    const service = new ProjectService()
    const json = serializeProject(createProject({ name: 'Test' }))
    await service.create(path, json)
    await service.autosave(json)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await service.autosave(json)
    await writeFile(join(path, 'autosave', 'notes.txt'), 'mine')
    expect(await service.deleteAutosaves()).toBe(2)
    expect(await readdir(join(path, 'autosave'))).toEqual(['notes.txt'])
    expect((await readdir(path)).sort()).toEqual(['autosave', 'journal.jsonl', 'project.json', 'session.lock'])
    await service.close()
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

describe('recent projects', () => {
  it('remember when each project was made, for the title screen', async () => {
    const service = new ProjectService()
    await service.create(path, serializeProject(createProject({ name: 'Test', now: () => new Date('2026-03-04T05:06:07.000Z') })))
    await service.close()
    expect(await readCreatedAt(path)).toBe('2026-03-04T05:06:07.000Z')
    expect(await readCreatedAt(join(dir, 'Missing.ginosa'))).toBeNull()
    const recent = new RecentProjects(join(dir, 'recent.json'))
    const [item] = await recent.add(path)
    expect(item).toMatchObject({ name: 'Test', createdAt: '2026-03-04T05:06:07.000Z' })
    expect((await recent.list())[0]?.createdAt).toBe('2026-03-04T05:06:07.000Z')
  })
})

describe('open projects (tabs, decision 128)', () => {
  const entry = (seq: number) => ({ seq, at: new Date().toISOString(), kind: 'do' as const, label: 'Add Track', patches: [{ op: 'add', path: ['x'], value: seq }] })

  it('keeps several projects open, each with its own lock and journal', async () => {
    const open = new OpenProjects()
    const other = join(dir, 'Other.ginosa')
    await open.create(path, serializeProject(createProject({ name: 'Test' })))
    await open.create(other, serializeProject(createProject({ name: 'Other' })))
    expect(open.paths).toEqual([path, other])
    await open.appendJournal(path, entry(1))
    await open.appendJournal(path, entry(2))
    await open.appendJournal(other, entry(1))
    expect((await readFile(join(path, 'journal.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
    expect((await readFile(join(other, 'journal.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    expect(await readdir(path)).toContain('session.lock')
    expect(await readdir(other)).toContain('session.lock')
    await open.closeAll()
  })

  it('shows the tab of a project that is open already instead of opening it twice', async () => {
    const open = new OpenProjects()
    await open.create(path, serializeProject(createProject({ name: 'Test' })))
    expect(await open.open(path)).toEqual({ path, json: '', recovery: null, alreadyOpen: true })
    await expect(open.create(path, '{}')).rejects.toThrow(/open in a tab/)
    await open.closeAll()
  })

  it('closing a tab releases its lock and clears its journal; later entries for it are dropped', async () => {
    const open = new OpenProjects()
    await open.create(path, serializeProject(createProject({ name: 'Test' })))
    await open.appendJournal(path, entry(1))
    await open.close(path)
    expect(open.has(path)).toBe(false)
    expect(await readdir(path)).not.toContain('session.lock')
    await open.appendJournal(path, entry(2))
    expect(await readFile(join(path, 'journal.jsonl'), 'utf8')).toBe('')
    // Opened again: nothing to recover.
    expect((await open.open(path)).recovery).toBeNull()
    await open.closeAll()
  })

  it('Save As moves a tab to its new folder, and refuses a folder open in another tab', async () => {
    const open = new OpenProjects()
    const other = join(dir, 'Other.ginosa')
    const moved = join(dir, 'Moved.ginosa')
    await open.create(path, serializeProject(createProject({ name: 'Test' })))
    await open.create(other, serializeProject(createProject({ name: 'Other' })))
    await expect(open.saveAs(path, other, '{}')).rejects.toThrow(/open in another tab/)
    await open.saveAs(path, moved, serializeProject(createProject({ name: 'Test' })))
    expect(open.paths.sort()).toEqual([moved, other].sort())
    expect(await readdir(path)).not.toContain('session.lock')
    expect(await readdir(moved)).toContain('session.lock')
    await open.closeAll()
  })
})
