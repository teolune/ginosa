import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CacheGuardError, CacheService } from './cache-service'

const PROJECT = '0b5f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e'
let base: string
let originals: string
let cache: CacheService

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ginosa-cache-test-'))
  originals = join(base, 'Footage')
  await mkdir(originals)
  await writeFile(join(originals, 'A001_C044.mov'), 'original camera file')
  cache = new CacheService(join(base, 'ginosa Cache'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('CacheService', () => {
  it('measures each category and clears one without touching the others', async () => {
    const thumbs = await cache.categoryDir(PROJECT, 'thumbnails')
    const optimised = await cache.categoryDir(PROJECT, 'optimised')
    await writeFile(join(thumbs, 'a.jpg'), 'x'.repeat(100))
    await writeFile(join(optimised, 'a.mov'), 'x'.repeat(5000))
    await cache.registerProject(PROJECT, 'Night shoot', join(base, 'Night shoot.ginosa'))
    const [usage] = await cache.usage()
    expect(usage?.bytes.thumbnails).toBe(100)
    expect(usage?.bytes.optimised).toBe(5000)
    expect(usage?.name).toBe('Night shoot')
    expect(usage?.projectExists).toBe(false)
    await cache.remove(PROJECT, 'thumbnails')
    const [after] = await cache.usage()
    expect(after?.bytes.thumbnails).toBe(0)
    expect(after?.bytes.optimised).toBe(5000)
  })

  it('refuses anything that is not a project id', async () => {
    await expect(cache.remove('../Footage', 'all')).rejects.toThrow(CacheGuardError)
    await expect(cache.remove('Footage', 'all')).rejects.toThrow(CacheGuardError)
    expect(await readdir(originals)).toEqual(['A001_C044.mov'])
  })

  it('refuses unknown categories', async () => {
    await cache.categoryDir(PROJECT, 'thumbnails')
    await expect(cache.remove(PROJECT, '../../Footage' as never)).rejects.toThrow(CacheGuardError)
    expect(await readdir(originals)).toEqual(['A001_C044.mov'])
  })

  it('never follows a link from the cache to your media', async () => {
    const thumbs = await cache.categoryDir(PROJECT, 'thumbnails')
    await symlink(originals, join(thumbs, 'linked-footage'))
    await symlink(join(originals, 'A001_C044.mov'), join(thumbs, 'linked-file.mov'))
    await cache.remove(PROJECT, 'all')
    expect(await readdir(originals)).toEqual(['A001_C044.mov'])
  })

  it('refuses a project folder that is itself a link pointing outside the cache', async () => {
    await mkdir(cache.rootPath, { recursive: true })
    await symlink(originals, join(cache.rootPath, PROJECT))
    await expect(cache.remove(PROJECT, 'all')).rejects.toThrow(CacheGuardError)
    expect(await readdir(originals)).toEqual(['A001_C044.mov'])
  })

  it('only deletes single files that are generated cache files', async () => {
    const optimised = await cache.categoryDir(PROJECT, 'optimised')
    await writeFile(join(optimised, 'clip.partial.mov'), 'x')
    await cache.removeFile(join(optimised, 'clip.partial.mov'))
    expect(await readdir(optimised)).toEqual([])
    await expect(cache.removeFile(join(originals, 'A001_C044.mov'))).rejects.toThrow(CacheGuardError)
    await expect(cache.removeFile(join(cache.rootPath, 'index.json'))).rejects.toThrow(CacheGuardError)
    expect(await readdir(originals)).toEqual(['A001_C044.mov'])
  })

  it('always nests a chosen location in its own "ginosa Cache" folder', () => {
    expect(cache.setParentFolder('/Volumes/SSD')).toBe('/Volumes/SSD/ginosa Cache')
  })
})
