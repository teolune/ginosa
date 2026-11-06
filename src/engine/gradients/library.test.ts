import { describe, expect, it } from 'vitest'
import { readGrd } from './grd'
import { solid } from './gradient'
import { addFolder, addGradient, BASICS, countIn, exportGrd, gradientsIn, importGrd, moveGradients, parseLibrary, removeFolder, removeGradients, renameFolder, subfolders } from './library'

const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { readFileSync(path: URL): Uint8Array }
const fixture = (name: string) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))

const ids = () => {
  let n = 0
  return () => `g${++n}`
}

describe('gradient library', () => {
  it('starts with the Basics, and keeps what it can of a damaged file', () => {
    const empty = parseLibrary(null, ids())
    expect(empty.folders).toEqual([BASICS])
    expect(gradientsIn(empty, BASICS).map((i) => i.gradient.name)).toEqual(['Foreground to Background', 'Black, White', 'Violet, Orange', 'Blue, Red, Yellow', 'Copper', 'Spectrum'])
    const lib = parseLibrary({ version: 1, folders: [['A', 'B']], items: [{ id: 'x', folder: ['C'], gradient: solid('One', [[0, [0, 0, 0]], [1, [1, 1, 1]]]) }, { id: 'x', gradient: { kind: 'nope' } }, 'junk'] }, ids())
    expect(lib.items.map((i) => [i.id, i.gradient.name])).toEqual([['x', 'One']])
    expect(lib.folders).toEqual([['A'], ['A', 'B'], ['C']])
  })

  it('imports a .grd into a folder named after the file, with notes on what isn’t exact', () => {
    let lib = parseLibrary(null, ids())
    const newId = ids()
    const kiwi = importGrd(lib, 'kiwi.grd', fixture('kiwi.grd'), newId)
    expect(kiwi.folder).toEqual(['kiwi'])
    expect(kiwi.added).toBe(1)
    expect(kiwi.warnings).toEqual([])
    lib = kiwi.library
    const again = importGrd(lib, 'kiwi.grd', fixture('kiwi.grd'), newId)
    expect(again.folder).toEqual(['kiwi 2'])
    const nine = importGrd(again.library, 'nine.grd', fixture('nine.grd'), newId)
    expect(nine.added).toBe(3397)
    expect(countIn(nine.library, ['nine'])).toBe(3397)
    expect(nine.warnings.some((w) => w.startsWith('Noise gradient') && w.endsWith('(435 gradients)'))).toBe(true)
    expect(nine.warnings.some((w) => w.startsWith('CMYK stops'))).toBe(true)
    expect(nine.warnings.some((w) => w.startsWith('Book colours'))).toBe(true)
  })

  it('exports a folder (subfolders kept, relative to it) that reads back the same', () => {
    const newId = ids()
    let lib = parseLibrary(null, newId)
    lib = addFolder(lib, [], 'Looks').library
    lib = addFolder(lib, ['Looks'], 'Warm').library
    lib = addFolder(lib, ['Looks'], 'Empty').library
    lib = addGradient(lib, ['Looks'], solid('Teal', [[0, [0, 0.2, 0.3]], [1, [0.9, 1, 1]]]), newId).library
    lib = addGradient(lib, ['Looks', 'Warm'], solid('Amber', [[0, [0.2, 0.05, 0]], [1, [1, 0.8, 0.4]]]), newId).library
    const back = readGrd(exportGrd(lib, ['Looks']))
    expect(back.entries.map((e) => [e.gradient.name, e.folder])).toEqual([['Teal', []], ['Amber', ['Warm']]])
    expect(back.folders).toEqual([['Warm'], ['Empty']])
    // Everything: the Basics too.
    expect(readGrd(exportGrd(lib, null)).entries).toHaveLength(8)
  })

  it('renames, moves and removes folders and gradients', () => {
    const newId = ids()
    let lib = parseLibrary(null, newId)
    lib = addFolder(lib, [], 'Mine').library
    expect(addFolder(lib, [], 'Mine').folder).toEqual(['Mine 2'])
    const { library, id } = addGradient(lib, ['Mine'], solid('A', [[0, [0, 0, 0]], [1, [1, 1, 1]]]), newId)
    lib = renameFolder(library, ['Mine'], 'Basics')
    expect(subfolders(lib, []).map((f) => f[0])).toEqual(['Basics', 'Basics 2'])
    expect(gradientsIn(lib, ['Basics 2']).map((i) => i.id)).toEqual([id])
    lib = moveGradients(lib, [id], BASICS)
    expect(gradientsIn(lib, BASICS).map((i) => i.id)).toContain(id)
    lib = removeGradients(lib, [id])
    expect(lib.items.some((i) => i.id === id)).toBe(false)
    lib = removeFolder(lib, BASICS)
    expect(countIn(lib, [])).toBe(0)
    expect(lib.folders).toEqual([['Basics 2']])
  })
})
