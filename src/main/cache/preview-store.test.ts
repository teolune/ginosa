import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CacheService } from './cache-service'
import { PreviewStore } from './preview-store'

const A = '0b5f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e'
const B = '1c6a8d2f-3e4b-4c6d-9e0f-1a2b3c4d5e6f'
const key = (n: number) => n.toString(16).padStart(16, '0')
let base: string
let cache: CacheService

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ginosa-preview-test-'))
  cache = new CacheService(join(base, 'ginosa Cache'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('PreviewStore', () => {
  it('stores, lists and reads previews by key, per project', async () => {
    const store = new PreviewStore(cache)
    await store.write(A, key(1), new Uint8Array([1, 2, 3]).buffer)
    await store.write(B, key(2), new Uint8Array([4]).buffer)
    expect(await store.list(A)).toEqual([key(1)])
    expect(new Uint8Array((await store.read(A, key(1)))!)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await store.read(A, key(2))).toBeNull()
    // A fresh store (another session) finds them on disk.
    expect(await new PreviewStore(cache).list(B)).toEqual([key(2)])
    await expect(store.write(A, '../../x', new ArrayBuffer(1))).rejects.toThrow()
  })

  it('keeps all projects within the limit, least recently used first', async () => {
    const store = new PreviewStore(cache, 1000)
    const kb = () => new Uint8Array(300).buffer
    await store.write(A, key(1), kb())
    await store.write(A, key(2), kb())
    await store.write(B, key(3), kb())
    // Make 1 the oldest, then read it: now 2 is the least recently used.
    const dirA = join(cache.rootPath, A, 'renders')
    await utimes(join(dirA, `${key(1)}.jpg`), 1, 1)
    await utimes(join(dirA, `${key(2)}.jpg`), 2, 2)
    store.forget()
    await store.read(A, key(1))
    const removed = await store.write(B, key(4), kb())
    expect(removed).toEqual([{ projectId: A, key: key(2) }])
    expect((await readdir(dirA)).sort()).toEqual([`${key(1)}.jpg`])
    expect(await store.total()).toBe(900)
  })
})
