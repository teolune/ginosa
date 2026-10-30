import { FRAME_RATES } from '../time'
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
  // Version 1 is the first format; later versions add upgrade steps here, oldest first.
  return raw
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
    }
  }
}
