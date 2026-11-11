import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkFile, classifyImportPaths, fingerprintFile, listFolder, searchForMoved } from './media-files'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ginosa-files-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('media files', () => {
  it('fingerprints identical content identically, wherever it lives', async () => {
    await writeFile(join(dir, 'a.mov'), Buffer.alloc(3 * 1024 * 1024, 7))
    await mkdir(join(dir, 'elsewhere'))
    await writeFile(join(dir, 'elsewhere', 'a.mov'), Buffer.alloc(3 * 1024 * 1024, 7))
    const a = await fingerprintFile(join(dir, 'a.mov'))
    const b = await fingerprintFile(join(dir, 'elsewhere', 'a.mov'))
    expect(a.sample).toBe(b.sample)
    await writeFile(join(dir, 'elsewhere', 'a.mov'), Buffer.alloc(3 * 1024 * 1024, 8))
    expect((await fingerprintFile(join(dir, 'elsewhere', 'a.mov'))).sample).not.toBe(a.sample)
  })

  it('reports online, changed and offline files', async () => {
    const path = join(dir, 'clip.mp4')
    await writeFile(path, 'x'.repeat(100))
    const fingerprint = await fingerprintFile(path)
    expect(await checkFile(path, fingerprint)).toBe('online')
    await writeFile(path, 'x'.repeat(50))
    expect(await checkFile(path, fingerprint)).toBe('changed')
    await rm(path)
    expect(await checkFile(path, fingerprint)).toBe('offline')
  })

  it('finds moved files by name and size when you point at a folder', async () => {
    await mkdir(join(dir, 'Old'))
    await writeFile(join(dir, 'Old', 'A001_C044.mov'), 'x'.repeat(1234))
    await writeFile(join(dir, 'Old', 'song.wav'), 'y'.repeat(99))
    await mkdir(join(dir, 'SSD', 'Shoot', 'Day 1'), { recursive: true })
    await rename(join(dir, 'Old', 'A001_C044.mov'), join(dir, 'SSD', 'Shoot', 'Day 1', 'A001_C044.mov'))
    await writeFile(join(dir, 'SSD', 'song.wav'), 'different size')
    const matches = await searchForMoved(join(dir, 'SSD'), [
      { id: 'clip', fileName: 'A001_C044.mov', size: 1234 },
      { id: 'song', fileName: 'song.wav', size: 99 }
    ])
    expect(matches).toEqual([{ id: 'clip', path: join(dir, 'SSD', 'Shoot', 'Day 1', 'A001_C044.mov') }])
  })

  it('turns dropped folders into bins and ignores non-media files', async () => {
    await mkdir(join(dir, 'B-roll', 'nested'), { recursive: true })
    await writeFile(join(dir, 'B-roll', 'one.mp4'), 'x')
    await writeFile(join(dir, 'B-roll', 'nested', 'two.mov'), 'x')
    await writeFile(join(dir, 'B-roll', 'notes.txt'), 'x')
    await writeFile(join(dir, 'B-roll', '.hidden.mp4'), 'x')
    await writeFile(join(dir, 'loose.wav'), 'x')
    await writeFile(join(dir, 'readme.pdf'), 'x')
    const result = await classifyImportPaths([join(dir, 'B-roll'), join(dir, 'loose.wav'), join(dir, 'readme.pdf')])
    expect(result.files).toEqual([join(dir, 'loose.wav')])
    expect(result.folders).toEqual([{ name: 'B-roll', files: [join(dir, 'B-roll', 'nested', 'two.mov'), join(dir, 'B-roll', 'one.mp4')] }])
  })
})

describe('the folder browser', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ginosa-folder-'))
    await mkdir(join(root, 'Shots'))
    await writeFile(join(root, 'clip 10.mov'), 'x')
    await writeFile(join(root, 'clip 2.MP4'), 'xx')
    await writeFile(join(root, 'song.wav'), 'xxx')
    await writeFile(join(root, 'cover.png'), 'xxxx')
    await writeFile(join(root, 'notes.txt'), 'not media')
    await writeFile(join(root, '.DS_Store'), '')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists subfolders first, then media files by name, and only counts the rest', async () => {
    const listing = await listFolder(root)
    expect(listing.path).toBe(root)
    expect(listing.parent).toBeTruthy()
    expect(listing.entries.map((e) => [e.name, e.kind])).toEqual([
      ['Shots', 'folder'],
      ['clip 2.MP4', 'video'],
      ['clip 10.mov', 'video'],
      ['cover.png', 'image'],
      ['song.wav', 'audio']
    ])
    expect(listing.entries.find((e) => e.name === 'song.wav')?.size).toBe(3)
    expect(listing.other).toBe(1)
  })

  it('needs an absolute path', async () => {
    await expect(listFolder('relative/folder')).rejects.toThrow(/absolute/)
  })
})
