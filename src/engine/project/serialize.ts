import { FRAME_RATES } from '../time'
import type { AudioStreamInfo, Bin, ColourInfo, MediaInfo, MediaItem, VideoStreamInfo } from './media'
import { MAX_DIMENSION, MIN_DIMENSION, PROJECT_SCHEMA_VERSION, type Project, type Track } from './model'

/**
 * Project file format: pretty-printed JSON with a schema version. parseProject()
 * validates everything it reads, so a damaged file fails with a clear message
 * instead of half-loading. Future schema versions are upgraded in migrate().
 */

export class ProjectFormatError extends Error {}

export function serializeProject(project: Project): string {
  return `${JSON.stringify(project, null, 2)}\n`
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectString(object: Json, key: string, where: string): string {
  const value = object[key]
  if (typeof value !== 'string') throw new ProjectFormatError(`${where}.${key} should be text`)
  return value
}

function expectBoolean(object: Json, key: string, where: string): boolean {
  const value = object[key]
  if (typeof value !== 'boolean') throw new ProjectFormatError(`${where}.${key} should be true or false`)
  return value
}

function expectInteger(object: Json, key: string, where: string, min: number, max: number): number {
  const value = object[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ProjectFormatError(`${where}.${key} should be a whole number between ${min} and ${max}`)
  }
  return value
}

function migrate(raw: Json): Json {
  const version = raw['schemaVersion']
  if (typeof version !== 'number') throw new ProjectFormatError('Not a ginosa project (no schemaVersion)')
  if (version > PROJECT_SCHEMA_VERSION) {
    throw new ProjectFormatError(`This project was saved by a newer ginosa (format ${version}); this build reads up to ${PROJECT_SCHEMA_VERSION}`)
  }
  // Upgrade steps, oldest first. Each one turns version n into n + 1.
  let data = raw
  if (version < 2) data = { ...data, schemaVersion: 2, media: [], bins: [] }
  return data
}

function optionalString(object: Json, key: string): string | null {
  const value = object[key]
  return typeof value === 'string' ? value : null
}

function optionalNumber(object: Json, key: string): number | null {
  const value = object[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseColour(value: unknown): ColourInfo {
  const o = isObject(value) ? value : {}
  const range = o['range']
  return {
    primaries: optionalString(o, 'primaries'),
    transfer: optionalString(o, 'transfer'),
    matrix: optionalString(o, 'matrix'),
    range: range === 'tv' || range === 'pc' ? range : null
  }
}

function parseVideo(value: unknown, where: string): VideoStreamInfo | null {
  if (value === null || value === undefined) return null
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const rate = value['frameRate']
  const hdr = value['hdr']
  return {
    codec: expectString(value, 'codec', where),
    profile: optionalString(value, 'profile'),
    width: expectInteger(value, 'width', where, 1, 65_536),
    height: expectInteger(value, 'height', where, 1, 65_536),
    rotation: optionalNumber(value, 'rotation') ?? 0,
    frameRate:
      isObject(rate) && typeof rate['num'] === 'number' && typeof rate['den'] === 'number' && rate['den'] > 0
        ? { num: rate['num'], den: rate['den'] }
        : null,
    frameCount: optionalNumber(value, 'frameCount'),
    pixelFormat: optionalString(value, 'pixelFormat'),
    bitDepth: optionalNumber(value, 'bitDepth'),
    colour: parseColour(value['colour']),
    hdr: hdr === 'hlg' || hdr === 'pq' ? hdr : null,
    variableFrameRate: value['variableFrameRate'] === true,
    keyframeInterval: optionalNumber(value, 'keyframeInterval')
  }
}

function parseAudio(value: unknown, where: string): AudioStreamInfo | null {
  if (value === null || value === undefined) return null
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  return {
    codec: expectString(value, 'codec', where),
    sampleRate: expectInteger(value, 'sampleRate', where, 1, 1_000_000),
    channels: expectInteger(value, 'channels', where, 1, 64),
    channelLayout: optionalString(value, 'channelLayout')
  }
}

function parseMediaInfo(value: unknown, where: string): MediaInfo {
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  return {
    container: expectString(value, 'container', where),
    durationSeconds: optionalNumber(value, 'durationSeconds') ?? 0,
    bitRate: optionalNumber(value, 'bitRate'),
    video: parseVideo(value['video'], `${where}.video`),
    audio: parseAudio(value['audio'], `${where}.audio`)
  }
}

function parseMediaItem(value: unknown, index: number): MediaItem {
  const where = `media[${index}]`
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const kind = value['kind']
  if (kind !== 'video' && kind !== 'audio' && kind !== 'image') throw new ProjectFormatError(`${where}.kind is not a media kind`)
  const fingerprint = value['fingerprint']
  if (!isObject(fingerprint)) throw new ProjectFormatError(`${where}.fingerprint is missing`)
  const marks = isObject(value['marks']) ? value['marks'] : {}
  const binId = value['binId']
  return {
    id: expectString(value, 'id', where),
    name: expectString(value, 'name', where),
    kind,
    path: expectString(value, 'path', where),
    fingerprint: {
      size: expectInteger(fingerprint, 'size', `${where}.fingerprint`, 0, Number.MAX_SAFE_INTEGER),
      mtimeMs: optionalNumber(fingerprint, 'mtimeMs') ?? 0,
      sample: expectString(fingerprint, 'sample', `${where}.fingerprint`)
    },
    info: parseMediaInfo(value['info'], `${where}.info`),
    binId: typeof binId === 'string' ? binId : null,
    importedAt: expectString(value, 'importedAt', where),
    marks: { in: optionalNumber(marks, 'in'), out: optionalNumber(marks, 'out') }
  }
}

function parseBin(value: unknown, index: number): Bin {
  const where = `bins[${index}]`
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const parentId = value['parentId']
  return {
    id: expectString(value, 'id', where),
    name: expectString(value, 'name', where),
    parentId: typeof parentId === 'string' ? parentId : null
  }
}

function parseTrack(value: unknown, index: number): Track {
  const where = `sequence.tracks[${index}]`
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const kind = value['kind']
  if (kind !== 'video' && kind !== 'audio') throw new ProjectFormatError(`${where}.kind should be "video" or "audio"`)
  return {
    id: expectString(value, 'id', where),
    kind,
    name: expectString(value, 'name', where),
    muted: expectBoolean(value, 'muted', where),
    locked: expectBoolean(value, 'locked', where),
    visible: expectBoolean(value, 'visible', where)
  }
}

export function parseProject(input: string | unknown): Project {
  let raw: unknown = input
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch (error) {
      throw new ProjectFormatError(`Project file is not valid JSON: ${(error as Error).message}`)
    }
  }
  if (!isObject(raw)) throw new ProjectFormatError('Project file should contain an object')
  const data = migrate(raw)

  const sequence = data['sequence']
  if (!isObject(sequence)) throw new ProjectFormatError('sequence is missing')
  const settings = sequence['settings']
  if (!isObject(settings)) throw new ProjectFormatError('sequence.settings is missing')
  const frameRate = settings['frameRate']
  if (typeof frameRate !== 'string' || !(frameRate in FRAME_RATES)) {
    throw new ProjectFormatError(`sequence.settings.frameRate "${String(frameRate)}" is not supported`)
  }
  const tracksRaw = sequence['tracks']
  if (!Array.isArray(tracksRaw)) throw new ProjectFormatError('sequence.tracks should be a list')
  const tracks = tracksRaw.map(parseTrack)
  const ids = new Set(tracks.map((t) => t.id))
  if (ids.size !== tracks.length) throw new ProjectFormatError('Two tracks share the same id')

  const mediaRaw = data['media']
  const binsRaw = data['bins']
  if (!Array.isArray(mediaRaw)) throw new ProjectFormatError('media should be a list')
  if (!Array.isArray(binsRaw)) throw new ProjectFormatError('bins should be a list')
  const bins = binsRaw.map(parseBin)
  const binIds = new Set(bins.map((b) => b.id))
  // Anything pointing at a missing bin is shown at the top level rather than lost.
  for (const bin of bins) if (bin.parentId && !binIds.has(bin.parentId)) bin.parentId = null
  const media = mediaRaw.map(parseMediaItem)
  for (const item of media) if (item.binId && !binIds.has(item.binId)) item.binId = null

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: expectString(data, 'id', 'project'),
    name: expectString(data, 'name', 'project'),
    createdAt: expectString(data, 'createdAt', 'project'),
    sequence: {
      id: expectString(sequence, 'id', 'sequence'),
      name: expectString(sequence, 'name', 'sequence'),
      settings: {
        width: expectInteger(settings, 'width', 'sequence.settings', MIN_DIMENSION, MAX_DIMENSION),
        height: expectInteger(settings, 'height', 'sequence.settings', MIN_DIMENSION, MAX_DIMENSION),
        frameRate: frameRate as keyof typeof FRAME_RATES,
        sampleRate: expectInteger(settings, 'sampleRate', 'sequence.settings', 8_000, 192_000)
      },
      tracks
    },
    media,
    bins
  }
}
