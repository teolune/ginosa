/**
 * Photoshop's Action Descriptor format (M13), as .grd gradient libraries store it: a tree of
 * typed key/value items. This reads every value type Photoshop writes, keeps everything it
 * reads (unknown keys included), and writes it back byte for byte.
 *
 * Written from the format's public documentation (Michel Mariani's Photoshop file formats
 * pages) and checked against the MIT-licensed grdkit and psd-grd readers.
 * Numbers are big-endian. An id (key, class or enum) is a uint32 length then that many ASCII
 * bytes, or a length of 0 then four characters (a "char code").
 */

export interface Descriptor {
  /** Usually empty; strings keep Photoshop's trailing NUL. */
  name: string
  classId: string
  items: DescriptorItem[]
  /** Set when a four-character class id was stored in the long form. */
  longClassId?: boolean
}

export interface DescriptorItem {
  key: string
  value: DValue
  longKey?: boolean
}

export type DValue =
  | { type: 'bool'; value: boolean }
  | { type: 'long'; value: number }
  | { type: 'comp'; value: bigint }
  | { type: 'doub'; value: number }
  | { type: 'UntF'; unit: string; value: number }
  | { type: 'UnFl'; unit: string; values: number[] }
  | { type: 'TEXT'; value: string }
  | { type: 'enum'; enumType: string; value: string; longEnumType?: boolean; longValue?: boolean }
  | { type: 'Objc' | 'GlbO'; value: Descriptor }
  | { type: 'ObAr'; count: number; value: Descriptor }
  | { type: 'VlLs' | 'obj '; values: DValue[] }
  | { type: 'prop'; name: string; classId: string; keyId: string }
  | { type: 'Clss' | 'type' | 'GlbC'; name: string; classId: string }
  | { type: 'Enmr'; name: string; classId: string; enumType: string; value: string }
  | { type: 'rele'; name: string; classId: string; value: number }
  | { type: 'name'; name: string; classId: string; value: string }
  | { type: 'Idnt' | 'indx'; value: number }
  | { type: 'tdta' | 'alis' | 'Pth '; bytes: Uint8Array }

export class FormatError extends Error {}

/** Limits that keep a damaged or hostile file from running away. */
const MAX_DEPTH = 64
const MAX_ITEMS = 2_000_000

export class BinaryReader {
  private view: DataView
  offset: number
  private items = 0

  constructor(readonly bytes: Uint8Array, offset = 0, readonly end = bytes.length) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = offset
  }

  get remaining(): number {
    return this.end - this.offset
  }

  private need(n: number, what: string): void {
    if (n < 0 || this.offset + n > this.end) throw new FormatError(`The file ends inside ${what} (byte ${this.offset})`)
  }

  u8(): number {
    this.need(1, 'a byte')
    return this.view.getUint8(this.offset++)
  }
  u16(): number {
    this.need(2, 'a number')
    const v = this.view.getUint16(this.offset)
    this.offset += 2
    return v
  }
  i16(): number {
    this.need(2, 'a number')
    const v = this.view.getInt16(this.offset)
    this.offset += 2
    return v
  }
  u32(): number {
    this.need(4, 'a number')
    const v = this.view.getUint32(this.offset)
    this.offset += 4
    return v
  }
  i32(): number {
    this.need(4, 'a number')
    const v = this.view.getInt32(this.offset)
    this.offset += 4
    return v
  }
  u64(): number {
    this.need(8, 'a number')
    const v = this.view.getBigUint64(this.offset)
    this.offset += 8
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new FormatError('A length is too large')
    return Number(v)
  }
  i64(): bigint {
    this.need(8, 'a number')
    const v = this.view.getBigInt64(this.offset)
    this.offset += 8
    return v
  }
  f64(): number {
    this.need(8, 'a number')
    const v = this.view.getFloat64(this.offset)
    this.offset += 8
    return v
  }
  ascii(n: number): string {
    this.need(n, 'some text')
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.offset + i]!)
    this.offset += n
    return s
  }
  take(n: number): Uint8Array {
    this.need(n, 'a block of data')
    const out = this.bytes.slice(this.offset, this.offset + n)
    this.offset += n
    return out
  }
  /** Big-endian UTF-16, a uint32 count of code units first. */
  unicode(): string {
    const n = this.u32()
    this.need(n * 2, 'a name')
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint16(this.offset + i * 2))
    this.offset += n * 2
    return s
  }
  id(): { id: string; long: boolean } {
    const n = this.u32()
    if (n === 0) return { id: this.ascii(4), long: false }
    if (n > 4096) throw new FormatError(`An id of ${n} bytes isn't plausible (byte ${this.offset - 4})`)
    const id = this.ascii(n)
    return { id, long: n === 4 }
  }
  count(n: number): void {
    this.items += n
    if (this.items > MAX_ITEMS) throw new FormatError('The file holds more values than any gradient library would')
  }
}

export class BinaryWriter {
  private chunks: Uint8Array[] = []
  private current = new Uint8Array(65536)
  private view = new DataView(this.current.buffer)
  private used = 0
  private flushed = 0

  get length(): number {
    return this.flushed + this.used
  }

  private room(n: number): void {
    if (this.used + n <= this.current.length) return
    this.chunks.push(this.current.subarray(0, this.used))
    this.flushed += this.used
    this.current = new Uint8Array(Math.max(65536, n))
    this.view = new DataView(this.current.buffer)
    this.used = 0
  }

  u8(v: number): void {
    this.room(1)
    this.view.setUint8(this.used++, v)
  }
  u16(v: number): void {
    this.room(2)
    this.view.setUint16(this.used, v)
    this.used += 2
  }
  i16(v: number): void {
    this.room(2)
    this.view.setInt16(this.used, v)
    this.used += 2
  }
  u32(v: number): void {
    this.room(4)
    this.view.setUint32(this.used, v)
    this.used += 4
  }
  i32(v: number): void {
    this.room(4)
    this.view.setInt32(this.used, v)
    this.used += 4
  }
  u64(v: number): void {
    this.room(8)
    this.view.setBigUint64(this.used, BigInt(v))
    this.used += 8
  }
  i64(v: bigint): void {
    this.room(8)
    this.view.setBigInt64(this.used, v)
    this.used += 8
  }
  f64(v: number): void {
    this.room(8)
    this.view.setFloat64(this.used, v)
    this.used += 8
  }
  ascii(s: string): void {
    this.room(s.length)
    for (let i = 0; i < s.length; i++) this.current[this.used++] = s.charCodeAt(i) & 0xff
  }
  bytes(b: Uint8Array): void {
    this.room(b.length)
    this.current.set(b, this.used)
    this.used += b.length
  }
  unicode(s: string): void {
    this.u32(s.length)
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i))
  }
  /** Four characters are written as a char code, anything else (or `long`) in the long form. */
  id(id: string, long = false): void {
    if (id.length === 4 && !long) {
      this.u32(0)
      this.ascii(id)
    } else {
      this.u32(id.length)
      this.ascii(id)
    }
  }
  four(code: string): void {
    if (code.length !== 4) throw new Error(`"${code}" isn't a four-character code`)
    this.ascii(code)
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const c of this.chunks) {
      out.set(c, at)
      at += c.length
    }
    out.set(this.current.subarray(0, this.used), at)
    return out
  }
}

export function readDescriptor(r: BinaryReader, depth = 0): Descriptor {
  if (depth > MAX_DEPTH) throw new FormatError('Descriptors are nested too deeply')
  const name = r.unicode()
  const cls = r.id()
  const n = r.u32()
  r.count(n)
  const items: DescriptorItem[] = []
  for (let i = 0; i < n; i++) {
    const key = r.id()
    const type = r.ascii(4)
    const item: DescriptorItem = { key: key.id, value: readValue(r, type, depth) }
    if (key.long) item.longKey = true
    items.push(item)
  }
  const d: Descriptor = { name, classId: cls.id, items }
  if (cls.long) d.longClassId = true
  return d
}

function readValue(r: BinaryReader, type: string, depth: number): DValue {
  switch (type) {
    case 'bool':
      return { type, value: r.u8() !== 0 }
    case 'long':
      return { type, value: r.i32() }
    case 'comp':
      return { type, value: r.i64() }
    case 'doub':
      return { type, value: r.f64() }
    case 'UntF':
      return { type, unit: r.ascii(4), value: r.f64() }
    case 'UnFl': {
      const unit = r.ascii(4)
      const n = r.u32()
      r.count(n)
      const values: number[] = []
      for (let i = 0; i < n; i++) values.push(r.f64())
      return { type, unit, values }
    }
    case 'TEXT':
      return { type, value: r.unicode() }
    case 'enum': {
      const t = r.id()
      const v = r.id()
      const out: DValue = { type, enumType: t.id, value: v.id }
      if (t.long) out.longEnumType = true
      if (v.long) out.longValue = true
      return out
    }
    case 'Objc':
    case 'GlbO':
      return { type, value: readDescriptor(r, depth + 1) }
    case 'ObAr': {
      const count = r.u32()
      return { type, count, value: readDescriptor(r, depth + 1) }
    }
    case 'VlLs':
    case 'obj ': {
      if (depth > MAX_DEPTH) throw new FormatError('Lists are nested too deeply')
      const n = r.u32()
      r.count(n)
      const values: DValue[] = []
      for (let i = 0; i < n; i++) values.push(readValue(r, r.ascii(4), depth + 1))
      return { type, values }
    }
    case 'prop':
      return { type, name: r.unicode(), classId: r.id().id, keyId: r.id().id }
    case 'Clss':
    case 'type':
    case 'GlbC':
      return { type, name: r.unicode(), classId: r.id().id }
    case 'Enmr':
      return { type, name: r.unicode(), classId: r.id().id, enumType: r.id().id, value: r.id().id }
    case 'rele':
      return { type, name: r.unicode(), classId: r.id().id, value: r.u32() }
    case 'name':
      return { type, name: r.unicode(), classId: r.id().id, value: r.unicode() }
    case 'Idnt':
    case 'indx':
      return { type, value: r.i32() }
    case 'tdta':
    case 'alis':
    case 'Pth ':
      return { type, bytes: r.take(r.u32()) }
    default:
      throw new FormatError(`Unknown descriptor value type "${type}" (byte ${r.offset - 4})`)
  }
}

export function writeDescriptor(w: BinaryWriter, d: Descriptor): void {
  w.unicode(d.name)
  w.id(d.classId, d.longClassId)
  w.u32(d.items.length)
  for (const item of d.items) {
    w.id(item.key, item.longKey)
    w.four(item.value.type)
    writeValue(w, item.value)
  }
}

function writeValue(w: BinaryWriter, v: DValue): void {
  switch (v.type) {
    case 'bool':
      return w.u8(v.value ? 1 : 0)
    case 'long':
      return w.i32(v.value)
    case 'comp':
      return w.i64(v.value)
    case 'doub':
      return w.f64(v.value)
    case 'UntF':
      w.four(v.unit)
      return w.f64(v.value)
    case 'UnFl':
      w.four(v.unit)
      w.u32(v.values.length)
      for (const x of v.values) w.f64(x)
      return
    case 'TEXT':
      return w.unicode(v.value)
    case 'enum':
      w.id(v.enumType, v.longEnumType)
      return w.id(v.value, v.longValue)
    case 'Objc':
    case 'GlbO':
      return writeDescriptor(w, v.value)
    case 'ObAr':
      w.u32(v.count)
      return writeDescriptor(w, v.value)
    case 'VlLs':
    case 'obj ':
      w.u32(v.values.length)
      for (const x of v.values) {
        w.four(x.type)
        writeValue(w, x)
      }
      return
    case 'prop':
      w.unicode(v.name)
      w.id(v.classId)
      return w.id(v.keyId)
    case 'Clss':
    case 'type':
    case 'GlbC':
      w.unicode(v.name)
      return w.id(v.classId)
    case 'Enmr':
      w.unicode(v.name)
      w.id(v.classId)
      w.id(v.enumType)
      return w.id(v.value)
    case 'rele':
      w.unicode(v.name)
      w.id(v.classId)
      return w.u32(v.value)
    case 'name':
      w.unicode(v.name)
      w.id(v.classId)
      return w.unicode(v.value)
    case 'Idnt':
    case 'indx':
      return w.i32(v.value)
    case 'tdta':
    case 'alis':
    case 'Pth ':
      w.u32(v.bytes.length)
      return w.bytes(v.bytes)
  }
}

// ---- Reading helpers ---------------------------------------------------------------------

export function item(d: Descriptor, key: string): DValue | undefined {
  return d.items.find((i) => i.key === key)?.value
}

export function num(d: Descriptor, key: string): number | undefined {
  const v = item(d, key)
  if (!v) return undefined
  if (v.type === 'long' || v.type === 'doub' || v.type === 'UntF') return v.value
  return undefined
}

export function text(d: Descriptor, key: string): string | undefined {
  const v = item(d, key)
  return v?.type === 'TEXT' ? stripNul(v.value) : undefined
}

export function enumValue(d: Descriptor, key: string): string | undefined {
  const v = item(d, key)
  return v?.type === 'enum' ? v.value : undefined
}

export function object(d: Descriptor, key: string): Descriptor | undefined {
  const v = item(d, key)
  return v?.type === 'Objc' || v?.type === 'GlbO' ? v.value : undefined
}

export function list(d: Descriptor, key: string): DValue[] | undefined {
  const v = item(d, key)
  return v?.type === 'VlLs' ? v.values : undefined
}

export function stripNul(s: string): string {
  return s.endsWith('\u0000') ? s.slice(0, -1) : s
}

// ---- Building helpers --------------------------------------------------------------------

export const D = {
  obj: (classId: string, items: Array<[string, DValue]>, name = ''): DValue => ({ type: 'Objc', value: descriptor(classId, items, name) }),
  long: (value: number): DValue => ({ type: 'long', value: Math.round(value) }),
  doub: (value: number): DValue => ({ type: 'doub', value }),
  unit: (unit: string, value: number): DValue => ({ type: 'UntF', unit, value }),
  text: (value: string): DValue => ({ type: 'TEXT', value: value.endsWith('\u0000') ? value : `${value}\u0000` }),
  enum: (enumType: string, value: string): DValue => ({ type: 'enum', enumType, value }),
  bool: (value: boolean): DValue => ({ type: 'bool', value }),
  list: (values: DValue[]): DValue => ({ type: 'VlLs', values })
}

export function descriptor(classId: string, items: Array<[string, DValue]>, name = ''): Descriptor {
  return { name, classId, items: items.map(([key, value]) => ({ key, value })) }
}
