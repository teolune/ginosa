import { BinaryReader, BinaryWriter, D, FormatError, enumValue, item, list, num, object, readDescriptor, stripNul, text, writeDescriptor, type DValue, type Descriptor } from './descriptor'
import { sourceToRgb, type Rgb, type StopColourSource } from './colour'
import { sortStops, type ColourStop, type Gradient, type GradientMethod, type NoiseGradient, type NoiseModel, type OpacityStop, type SolidGradient, type StopKind } from './gradient'

/**
 * Photoshop gradient libraries (.grd), M13.
 *
 * Version 5 (Photoshop 6 and later): `8BGR`, uint16 5, uint32 16, then an Action Descriptor
 * whose `GrdL` list holds one `Grdn` object per gradient (its `Grad` item is the gradient),
 * then optional tagged blocks: `8BIM`/`8B64`, a key, a uint32/uint64 length, the payload and
 * zero padding to 4 bytes. A `phry` block holds the preset folders: a versioned descriptor
 * whose `hierarchy` list opens (`Grup`) and closes (`groupEnd`) folders around `preset`
 * entries, which match the gradients in order.
 *
 * Version 3 (Photoshop 5): a uint16 count, then for each gradient fixed records (see readV3).
 *
 * Exports are always version 5, as Photoshop writes them.
 */

export interface GrdEntry {
  gradient: Gradient
  /** Folder path inside the library, outermost first; [] at the top. */
  folder: string[]
}

export interface GrdLibrary {
  version: 3 | 5
  entries: GrdEntry[]
  /** Every folder in the file, in order (empty ones too). */
  folders: string[][]
  /** Things that couldn't be read or shown exactly. */
  warnings: string[]
}

const MAX_GRADIENTS = 20_000

const METHOD_CODES: Record<string, GradientMethod> = { Gcls: 'classic', Perc: 'perceptual', 'Lnr ': 'linear', Smoo: 'smooth' }
const METHOD_KEY = 'gradientsInterpolationMethod'

export function readGrd(bytes: Uint8Array): GrdLibrary {
  const r = new BinaryReader(bytes)
  if (bytes.length < 6 || r.ascii(4) !== '8BGR') throw new FormatError("This isn't a Photoshop gradient file (it doesn't start with 8BGR)")
  const version = r.u16()
  if (version === 3) return readV3(r)
  if (version !== 5) throw new FormatError(`Gradient file version ${version} isn't one Photoshop writes (3 or 5)`)
  const warnings: string[] = []
  const descriptorVersion = r.u32()
  if (descriptorVersion !== 16) warnings.push(`Descriptor version ${descriptorVersion} (expected 16); read anyway`)
  const root = readDescriptor(r)
  const gradients: Gradient[] = []
  const grdl = list(root, 'GrdL')
  if (!grdl) throw new FormatError('The file has no gradient list (GrdL)')
  if (grdl.length > MAX_GRADIENTS) throw new FormatError(`${grdl.length} gradients is more than ginosa reads from one file (${MAX_GRADIENTS})`)
  grdl.forEach((value, i) => {
    if (value.type !== 'Objc' && value.type !== 'GlbO') return warnings.push(`Entry ${i + 1} isn't a gradient; skipped`)
    const wrapper = value.value
    const grad = object(wrapper, 'Grad') ?? (item(wrapper, 'GrdF') ? wrapper : null)
    if (!grad) return warnings.push(`Entry ${i + 1} has no gradient; skipped`)
    const gradient = readGradient(grad, wrapper, warnings, i)
    if (gradient) gradients.push(gradient)
  })
  const { folders, paths } = readTrailer(r, gradients.length, warnings)
  return { version: 5, entries: gradients.map((gradient, i) => ({ gradient, folder: paths[i] ?? [] })), folders, warnings }
}

function readGradient(grad: Descriptor, wrapper: Descriptor, warnings: string[], index: number): Gradient | null {
  const name = text(grad, 'Nm  ') ?? text(wrapper, 'Nm  ') ?? `Gradient ${index + 1}`
  const form = enumValue(grad, 'GrdF')
  if (form === 'ClNs') return readNoise(grad, name)
  if (form !== 'CstS') {
    warnings.push(`"${name}": gradient type "${form ?? '?'}" isn't one ginosa knows; skipped`)
    return null
  }
  const colourStops: ColourStop[] = []
  for (const v of list(grad, 'Clrs') ?? []) {
    if (v.type !== 'Objc') continue
    const s = v.value
    const type = enumValue(s, 'Type')
    const kind: StopKind = type === 'FrgC' ? 'foreground' : type === 'BckC' ? 'background' : 'user'
    const stop: ColourStop = { location: clampLoc(num(s, 'Lctn')), midpoint: clampMid(num(s, 'Mdpn')), colour: kind === 'background' ? [1, 1, 1] : [0, 0, 0], kind }
    const clr = object(s, 'Clr ')
    if (kind === 'user') {
      if (!clr) warnings.push(`"${name}": a stop has no colour; shown black`)
      else {
        const read = readColour(clr)
        if (!read) warnings.push(`"${name}": colour model "${clr.classId}" isn't one ginosa knows; shown grey`)
        stop.colour = read?.rgb ?? [0.5, 0.5, 0.5]
        if (read?.source) stop.source = read.source
      }
    }
    colourStops.push(stop)
  }
  if (colourStops.length === 0) {
    warnings.push(`"${name}" has no colour stops; skipped`)
    return null
  }
  const opacityStops: OpacityStop[] = []
  for (const v of list(grad, 'Trns') ?? []) {
    if (v.type !== 'Objc') continue
    const s = v.value
    opacityStops.push({ location: clampLoc(num(s, 'Lctn')), midpoint: clampMid(num(s, 'Mdpn')), opacity: Math.min(1, Math.max(0, (num(s, 'Opct') ?? 100) / 100)) })
  }
  const g: SolidGradient = {
    kind: 'solid',
    name,
    smoothness: Math.min(1, Math.max(0, (num(grad, 'Intr') ?? 4096) / 4096)),
    colourStops: sortStops(colourStops),
    opacityStops: opacityStops.length ? sortStops(opacityStops) : [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 1 }]
  }
  const method = enumValue(grad, METHOD_KEY) ?? enumValue(wrapper, METHOD_KEY)
  if (method && METHOD_CODES[method]) g.method = METHOD_CODES[method]
  return g
}

function readNoise(grad: Descriptor, name: string): NoiseGradient {
  const four = (key: string, fallback: number): [number, number, number, number] => {
    const values = (list(grad, key) ?? []).map((v) => (v.type === 'long' || v.type === 'doub' ? v.value / 100 : fallback))
    return [0, 1, 2, 3].map((i) => Math.min(1, Math.max(0, values[i] ?? fallback))) as [number, number, number, number]
  }
  const space = enumValue(grad, 'ClrS')
  const model: NoiseModel = space === 'HSBl' || space === 'HSBC' ? 'hsb' : space === 'LbCl' ? 'lab' : 'rgb'
  const bool = (key: string, fallback: boolean) => {
    const v = item(grad, key)
    return v?.type === 'bool' ? v.value : fallback
  }
  return {
    kind: 'noise',
    name,
    seed: num(grad, 'RndS') ?? 0,
    roughness: Math.min(1, Math.max(0, (num(grad, 'Smth') ?? 2048) / 4096)),
    model,
    min: four('Mnm ', 0),
    max: four('Mxm ', 1),
    transparency: bool('ShTr', false),
    restrict: bool('VctC', true)
  }
}

const clampLoc = (v: number | undefined) => Math.min(1, Math.max(0, (v ?? 0) / 4096))
const clampMid = (v: number | undefined) => Math.min(1, Math.max(0, (v ?? 50) / 100))

/** A colour object (RGBC, HSBC, CMYC, LbCl, Grsc, BkCl) as display values, with its source if not RGB. */
function readColour(c: Descriptor): { rgb: Rgb; source?: StopColourSource } | null {
  const n = (key: string, fallback = 0) => num(c, key) ?? fallback
  switch (c.classId) {
    case 'RGBC': {
      // 32-bit documents can store floats instead (redFloat …, 0–1).
      if (num(c, 'Rd  ') === undefined && num(c, 'redFloat') !== undefined) return { rgb: [n('redFloat'), n('greenFloat'), n('blueFloat')].map(clamp01) as Rgb }
      return { rgb: [n('Rd  ') / 255, n('Grn ') / 255, n('Bl  ') / 255].map(clamp01) as Rgb }
    }
    case 'HSBC': {
      const source: StopColourSource = { model: 'hsb', h: n('H   '), s: n('Strt'), b: n('Brgh') }
      return { rgb: sourceToRgb(source), source }
    }
    case 'CMYC': {
      const source: StopColourSource = { model: 'cmyk', c: n('Cyn '), m: n('Mgnt'), y: n('Ylw '), k: n('Blck') }
      return { rgb: sourceToRgb(source), source }
    }
    case 'LbCl': {
      const source: StopColourSource = { model: 'lab', l: n('Lmnc'), a: n('A   '), b: n('B   ') }
      return { rgb: sourceToRgb(source), source }
    }
    case 'Grsc': {
      const source: StopColourSource = { model: 'gray', gray: n('Gry ') }
      return { rgb: sourceToRgb(source), source }
    }
    case 'BkCl': {
      const key = item(c, 'bookKey')
      const source: StopColourSource = {
        model: 'book',
        book: text(c, 'Bk  ') ?? '',
        name: text(c, 'Nm  ') ?? '',
        bookId: num(c, 'bookID') ?? null,
        bookKey: key?.type === 'tdta' ? toBase64(key.bytes) : null
      }
      return { rgb: sourceToRgb(source), source }
    }
  }
  return null
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

// ---- Tagged blocks and preset folders ----------------------------------------------------

function hasSignature(r: BinaryReader, at = 0): boolean {
  if (r.remaining < at + 4) return false
  const sig = String.fromCharCode(...r.bytes.subarray(r.offset + at, r.offset + at + 4))
  return sig === '8BIM' || sig === '8B64'
}

function readTrailer(r: BinaryReader, count: number, warnings: string[]): { folders: string[][]; paths: string[][] } {
  let folders: string[][] = []
  let paths: string[][] = []
  while (r.remaining > 0) {
    if (r.remaining < 12 || !hasSignature(r)) {
      warnings.push(`${r.remaining} bytes after the gradients weren't recognised; ignored`)
      break
    }
    const signature = r.ascii(4)
    const key = r.ascii(4)
    const length = signature === '8B64' ? r.u64() : r.u32()
    if (length > r.remaining) throw new FormatError(`The ${key} block is longer than the file`)
    const start = r.offset
    if (key === 'phry') {
      try {
        const block = new BinaryReader(r.bytes, start, start + length)
        block.u32()
        const result = readHierarchy(readDescriptor(block), count, warnings)
        folders = result.folders
        paths = result.paths
      } catch (error) {
        warnings.push(`The preset folders couldn't be read (${(error as Error).message}); gradients are shown without folders`)
      }
    }
    r.offset = start + length
    // Zero padding to 4 bytes, only when the next block (or the end) follows it.
    const pad = (4 - (length % 4)) % 4
    if (pad && r.remaining >= pad && [...r.bytes.subarray(r.offset, r.offset + pad)].every((b) => b === 0) && (r.remaining === pad || hasSignature(r, pad))) r.offset += pad
  }
  return { folders, paths }
}

function readHierarchy(root: Descriptor, count: number, warnings: string[]): { folders: string[][]; paths: string[][] } {
  const entries = list(root, 'hierarchy')
  if (!entries) {
    warnings.push('The preset folders block has no hierarchy; ignored')
    return { folders: [], paths: [] }
  }
  const folders: string[][] = []
  const paths: string[][] = []
  const stack: string[] = []
  for (const v of entries) {
    if (v.type !== 'Objc') continue
    const d = v.value
    const name = text(d, 'Nm  ') ?? text(d, 'name') ?? 'Folder'
    if (d.classId === 'Grup' || d.classId === 'group' || d.classId === 'groupStart') {
      stack.push(name)
      folders.push([...stack])
    } else if (d.classId === 'groupEnd') {
      if (stack.length) stack.pop()
      else warnings.push('The preset folders close a folder that was never opened')
    } else if (d.classId === 'preset') {
      paths.push([...stack])
    }
  }
  if (paths.length !== count) warnings.push(`The preset folders list ${paths.length} gradients but the file has ${count}; the rest are at the top`)
  return { folders, paths: paths.slice(0, count) }
}

// ---- Version 3 ---------------------------------------------------------------------------

/**
 * Version 3: uint16 count; per gradient: uint8 name length, Latin-1 name, uint16 colour stop
 * count, each stop int32 location (0–4096), int32 midpoint (%), uint16 colour model, four
 * uint16 components, uint16 type (0 user, 1 foreground, 2 background); uint16 opacity stop
 * count, each int32 location, int32 midpoint, uint16 opacity (0–255); 6 reserved bytes.
 * Components follow Photoshop's colour records: RGB and HSB use the full 16 bits, CMYK stores
 * 0 for full ink, Lab is L × 100 and signed a, b × 100, grayscale 0–10000 with 10000 white.
 */
function readV3(r: BinaryReader): GrdLibrary {
  const warnings: string[] = []
  const count = r.u16()
  const entries: GrdEntry[] = []
  for (let g = 0; g < count; g++) {
    const nameLength = r.u8()
    let name = ''
    for (const b of r.take(nameLength)) name += String.fromCharCode(b)
    name = stripNul(name)
    const colourStops: ColourStop[] = []
    const stops = r.u16()
    for (let i = 0; i < stops; i++) {
      const location = r.i32()
      const midpoint = r.i32()
      const model = r.u16()
      const c = [r.u16(), r.u16(), r.u16(), r.u16()] as const
      const type = r.u16()
      const kind: StopKind = type === 1 ? 'foreground' : type === 2 ? 'background' : 'user'
      const stop: ColourStop = { location: clampLoc(location), midpoint: clampMid(midpoint), colour: kind === 'background' ? [1, 1, 1] : [0, 0, 0], kind }
      if (kind === 'user') {
        let source: StopColourSource | null = null
        switch (model) {
          case 0:
            stop.colour = [c[0] / 65535, c[1] / 65535, c[2] / 65535]
            break
          case 1:
            source = { model: 'hsb', h: (c[0] / 65535) * 360, s: c[1] / 655.35, b: c[2] / 655.35 }
            break
          case 2:
            source = { model: 'cmyk', c: 100 - c[0] / 655.35, m: 100 - c[1] / 655.35, y: 100 - c[2] / 655.35, k: 100 - c[3] / 655.35 }
            break
          case 7:
            source = { model: 'lab', l: c[0] / 100, a: ((c[1] << 16) >> 16) / 100, b: ((c[2] << 16) >> 16) / 100 }
            break
          case 8:
            source = { model: 'gray', gray: 100 - c[0] / 100 }
            break
          default:
            warnings.push(`"${name}": colour model ${model} isn't one ginosa knows; shown grey`)
            stop.colour = [0.5, 0.5, 0.5]
        }
        if (source) {
          stop.colour = sourceToRgb(source)
          stop.source = source
        }
      }
      colourStops.push(stop)
    }
    const opacityStops: OpacityStop[] = []
    const transparencies = r.u16()
    for (let i = 0; i < transparencies; i++) opacityStops.push({ location: clampLoc(r.i32()), midpoint: clampMid(r.i32()), opacity: r.u16() / 255 })
    r.take(6)
    if (colourStops.length === 0) {
      warnings.push(`"${name}" has no colour stops; skipped`)
      continue
    }
    entries.push({
      folder: [],
      gradient: {
        kind: 'solid',
        name,
        smoothness: 1,
        colourStops: sortStops(colourStops),
        opacityStops: opacityStops.length ? sortStops(opacityStops) : [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 1 }]
      }
    })
  }
  if (r.remaining > 0) warnings.push(`${r.remaining} bytes after the gradients weren't recognised; ignored`)
  return { version: 3, entries, folders: [], warnings }
}

// ---- Writing (version 5) -----------------------------------------------------------------

const loc = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 4096)
const mid = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100)

function colourObject(stop: ColourStop): DValue {
  const s = stop.source
  switch (s?.model) {
    case 'hsb':
      return D.obj('HSBC', [['H   ', D.unit('#Ang', s.h)], ['Strt', D.doub(s.s)], ['Brgh', D.doub(s.b)]], '\u0000')
    case 'cmyk':
      return D.obj('CMYC', [['Cyn ', D.doub(s.c)], ['Mgnt', D.doub(s.m)], ['Ylw ', D.doub(s.y)], ['Blck', D.doub(s.k)]], '\u0000')
    case 'lab':
      return D.obj('LbCl', [['Lmnc', D.doub(s.l)], ['A   ', D.doub(s.a)], ['B   ', D.doub(s.b)]], '\u0000')
    case 'gray':
      return D.obj('Grsc', [['Gry ', D.doub(s.gray)]], '\u0000')
    case 'book': {
      const items: Array<[string, DValue]> = [['Bk  ', D.text(s.book)], ['Nm  ', D.text(s.name)]]
      if (s.bookId !== null) items.push(['bookID', D.long(s.bookId)])
      if (s.bookKey !== null) items.push(['bookKey', { type: 'tdta', bytes: fromBase64(s.bookKey) }])
      return D.obj('BkCl', items, '\u0000')
    }
    default:
      return D.obj('RGBC', [['Rd  ', D.doub(stop.colour[0] * 255)], ['Grn ', D.doub(stop.colour[1] * 255)], ['Bl  ', D.doub(stop.colour[2] * 255)]], '\u0000')
  }
}

function gradientObject(g: Gradient): DValue {
  if (g.kind === 'noise') {
    const four = (v: readonly number[]) => D.list(v.map((x) => D.long(x * 100)))
    const space = g.model === 'hsb' ? 'HSBl' : g.model === 'lab' ? 'LbCl' : 'RGBC'
    return D.obj(
      'Grdn',
      [
        ['Nm  ', D.text(g.name)],
        ['GrdF', D.enum('GrdF', 'ClNs')],
        ['ShTr', D.bool(g.transparency)],
        ['VctC', D.bool(g.restrict)],
        ['ClrS', D.enum('ClrS', space)],
        ['RndS', D.long(g.seed)],
        ['Smth', D.long(g.roughness * 4096)],
        ['Mnm ', four(g.min)],
        ['Mxm ', four(g.max)]
      ],
      'Gradient\u0000'
    )
  }
  const items: Array<[string, DValue]> = [
    ['Nm  ', D.text(g.name)],
    ['GrdF', D.enum('GrdF', 'CstS')],
    ['Intr', D.doub(Math.round(g.smoothness * 4096))],
    [
      'Clrs',
      D.list(
        g.colourStops.map((s) => {
          const type = s.kind === 'foreground' ? 'FrgC' : s.kind === 'background' ? 'BckC' : 'UsrS'
          const stop: Array<[string, DValue]> = []
          if (s.kind === 'user') stop.push(['Clr ', colourObject(s)])
          stop.push(['Type', D.enum('Clry', type)], ['Lctn', D.long(loc(s.location))], ['Mdpn', D.long(mid(s.midpoint))])
          return D.obj('Clrt', stop, '\u0000')
        })
      )
    ],
    ['Trns', D.list(g.opacityStops.map((s) => D.obj('TrnS', [['Opct', D.unit('#Prc', s.opacity * 100)], ['Lctn', D.long(loc(s.location))], ['Mdpn', D.long(mid(s.midpoint))]], '\u0000')))]
  ]
  // Only newer Photoshop writes the method; older versions ignore keys they don't know.
  if (g.method && g.method !== 'classic') {
    const code = Object.entries(METHOD_CODES).find(([, m]) => m === g.method)![0]
    items.push([METHOD_KEY, { type: 'enum', enumType: 'gradientInterpolationMethodType', value: code }])
  }
  return D.obj('Grdn', items, 'Gradient\u0000')
}

/**
 * A version 5 library. Folders go in a `phry` block (only when there are any), with every
 * folder in `folders` (so empty ones survive) and each gradient placed in its own. Photoshop
 * matches the block's presets to the gradients by position, so the gradients are written in
 * the block's order: a folder's own gradients, then its subfolders, in turn.
 */
export function writeGrd(entries: readonly GrdEntry[], folders: readonly string[][] = []): Uint8Array {
  const foldered = entries.some((e) => e.folder.length) || folders.length > 0
  const tree: DValue[] = []
  const ordered: GrdEntry[] = []
  if (foldered) {
    walkFolders(entries, folders, {
      gradient: (e) => {
        ordered.push(e)
        tree.push(D.obj('preset', [['Nm  ', D.text(e.gradient.name)]], '\u0000'))
      },
      open: (name) => tree.push(D.obj('Grup', [['Nm  ', D.text(name)]], '\u0000')),
      close: () => tree.push(D.obj('groupEnd', [], '\u0000'))
    })
  } else ordered.push(...entries)
  const w = new BinaryWriter()
  w.ascii('8BGR')
  w.u16(5)
  w.u32(16)
  const root: Descriptor = {
    name: '\u0000',
    classId: 'null',
    items: [{ key: 'GrdL', value: D.list(ordered.map((e) => D.obj('Grdn', [['Grad', gradientObject(e.gradient)]], 'Gradient\u0000'))) }]
  }
  writeDescriptor(w, root)
  if (foldered) {
    const block = new BinaryWriter()
    block.u32(16)
    writeDescriptor(block, { name: '\u0000', classId: 'null', items: [{ key: 'hierarchy', value: D.list(tree) }] })
    const payload = block.finish()
    w.ascii('8BIM')
    w.ascii('phry')
    w.u32(payload.length)
    w.bytes(payload)
    for (let i = payload.length; i % 4 !== 0; i++) w.u8(0)
  }
  return w.finish()
}

/** Visits a library in the order its folders are written: a folder's gradients, then each subfolder (listed folders first, in order). */
export function walkFolders(entries: readonly GrdEntry[], folders: readonly string[][], visit: { gradient(e: GrdEntry): void; open(name: string): void; close(): void }): void {
  const order: string[][] = []
  const seen = new Set<string>()
  const add = (path: readonly string[]) => {
    for (let i = 1; i <= path.length; i++) {
      const p = path.slice(0, i)
      const key = JSON.stringify(p)
      if (!seen.has(key)) {
        seen.add(key)
        order.push(p)
      }
    }
  }
  folders.forEach(add)
  entries.forEach((e) => add(e.folder))
  const emit = (path: string[]) => {
    const here = JSON.stringify(path)
    for (const e of entries) if (JSON.stringify(e.folder) === here) visit.gradient(e)
    for (const child of order.filter((p) => p.length === path.length + 1 && JSON.stringify(p.slice(0, -1)) === here)) {
      visit.open(child[child.length - 1]!)
      emit(child)
      visit.close()
    }
  }
  emit([])
}
