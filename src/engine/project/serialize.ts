import { FRAME_RATES } from '../time'
import type { AudioStreamInfo, Bin, ColourInfo, ColourInput, MediaColour, MediaInfo, MediaItem, VideoStreamInfo } from './media'
import { BLEND_MODES, MAX_DIMENSION, MIN_DIMENSION, PROJECT_SCHEMA_VERSION, type BlendMode, type Clip, type Marker, type Motion, type Project, type SequenceSettings, type Track, type Transition, type AudioSource, type BeatGrid } from './model'
import { defaultMotion, sourceSize } from '../timeline/motion'
import { syncLinkedRamps } from '../timeline/timeline'
import { MAX_BPM, MIN_BPM } from '../audio/beat-grid'
import { ModulationFormatError, parseModulation, parseModulators } from '../modulation/parse'
import type { ModulationMap } from '../modulation/types'
import { MaskFormatError, parseMaskRef, parseMasks } from '../masks/parse'
import { effectById } from '../../effects/registry'
import { sanitiseKeyframes, sanitiseParams, upgradeInstance } from '../effects/params'
import { normaliseTrack, type Interpolation, type Keyframe, type KeyframeMap } from '../keyframes/keyframes'
import { clampValue, propertySpec, speedKeyframeProblem, staticValue } from '../keyframes/properties'
import type { EffectInstance, ParamValue } from '../effects/types'

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
  if (version < 3) {
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    const tracks = Array.isArray(sequence['tracks']) ? sequence['tracks'] : []
    data = {
      ...data,
      schemaVersion: 3,
      sequence: {
        ...sequence,
        tracks: tracks.map((t) => (isObject(t) ? { ...t, syncLock: true, solo: false } : t)),
        clips: [],
        markers: []
      }
    }
  }
  if (version < 4) {
    // M3 showed clips fitted to the frame; keep that look as their Motion.
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    const settings = (isObject(sequence['settings']) ? sequence['settings'] : {}) as unknown as SequenceSettings
    const media = Array.isArray(data['media']) ? data['media'] : []
    const clips = Array.isArray(sequence['clips']) ? sequence['clips'] : []
    data = {
      ...data,
      schemaVersion: 4,
      sequence: {
        ...sequence,
        clips: clips.map((c) => {
          if (!isObject(c)) return c
          const item = media.find((m) => isObject(m) && m['id'] === c['mediaId'])
          let motion: Motion
          try {
            motion = defaultMotion(isObject(item) ? parseMediaItem(item, 0) : undefined, settings)
          } catch {
            motion = defaultMotion(undefined, settings)
          }
          return { ...c, motion, opacity: 100, blendMode: 'normal', volume: 0 }
        })
      }
    }
  }
  if (version < 5) {
    const media = Array.isArray(data['media']) ? data['media'] : []
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    const clips = Array.isArray(sequence['clips']) ? sequence['clips'] : []
    data = {
      ...data,
      schemaVersion: 5,
      media: media.map((m) => (isObject(m) ? { ...m, colour: { input: 'auto', lut: null } } : m)),
      sequence: { ...sequence, clips: clips.map((c) => (isObject(c) ? { ...c, speed: 1, reverse: false, transitionIn: null, transitionOut: null } : c)) }
    }
  }
  if (version < 6) {
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    const clips = Array.isArray(sequence['clips']) ? sequence['clips'] : []
    data = { ...data, schemaVersion: 6, sequence: { ...sequence, clips: clips.map((c) => (isObject(c) ? { ...c, effects: [], adjustment: false } : c)) } }
  }
  if (version < 7) {
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    const clips = Array.isArray(sequence['clips']) ? sequence['clips'] : []
    const withKeyframes = (c: unknown) =>
      isObject(c) ? { ...c, keyframes: {}, effects: Array.isArray(c['effects']) ? c['effects'].map((e) => (isObject(e) ? { ...e, keyframes: {} } : e)) : c['effects'] } : c
    data = { ...data, schemaVersion: 7, sequence: { ...sequence, clips: clips.map(withKeyframes) } }
  }
  if (version < 8) {
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    data = { ...data, schemaVersion: 8, sequence: { ...sequence, audioSources: [], beatGrid: null } }
  }
  if (version < 9) {
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    const clips = Array.isArray(sequence['clips']) ? sequence['clips'] : []
    const withModulation = (c: unknown) =>
      isObject(c) ? { ...c, modulation: {}, effects: Array.isArray(c['effects']) ? c['effects'].map((e) => (isObject(e) ? { ...e, modulation: {} } : e)) : c['effects'] } : c
    data = { ...data, schemaVersion: 9, sequence: { ...sequence, clips: clips.map(withModulation), modulators: [] } }
  }
  if (version < 10) {
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    const clips = Array.isArray(sequence['clips']) ? sequence['clips'] : []
    const withMasks = (c: unknown) =>
      isObject(c) ? { ...c, mask: null, effects: Array.isArray(c['effects']) ? c['effects'].map((e) => (isObject(e) ? { ...e, mask: null } : e)) : c['effects'] } : c
    data = { ...data, schemaVersion: 10, sequence: { ...sequence, clips: clips.map(withMasks), masks: [] } }
  }
  if (version < 11) {
    const sequence = isObject(data['sequence']) ? data['sequence'] : {}
    data = { ...data, schemaVersion: 11, sequence: { ...sequence, marks: { in: null, out: null } } }
  }
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
    marks: { in: optionalNumber(marks, 'in'), out: optionalNumber(marks, 'out') },
    colour: parseColourSetting(value['colour'], `${where}.colour`)
  }
}

const COLOUR_INPUTS: ColourInput[] = ['auto', 'rec709', 'apple-log', 'apple-log-2']

function parseColourSetting(value: unknown, where: string): MediaColour {
  // Media parsed during the v3 → v4 upgrade predates colour settings.
  if (value === undefined) return { input: 'auto', lut: null }
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const input = value['input']
  if (!COLOUR_INPUTS.includes(input as ColourInput)) throw new ProjectFormatError(`${where}.input is not a colour setting`)
  const lut = value['lut']
  return {
    input: input as ColourInput,
    lut: isObject(lut) ? { name: expectString(lut, 'name', `${where}.lut`), file: expectString(lut, 'file', `${where}.lut`) } : null
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
    visible: expectBoolean(value, 'visible', where),
    syncLock: expectBoolean(value, 'syncLock', where),
    solo: expectBoolean(value, 'solo', where)
  }
}

const MAX_TICKS = Number.MAX_SAFE_INTEGER

function expectNumber(object: Json, key: string, where: string): number {
  const value = object[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProjectFormatError(`${where}.${key} should be a number`)
  return value
}

function parseMotion(value: unknown, where: string): Motion {
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  return {
    positionX: expectNumber(value, 'positionX', where),
    positionY: expectNumber(value, 'positionY', where),
    scale: expectNumber(value, 'scale', where),
    scaleWidth: expectNumber(value, 'scaleWidth', where),
    rotation: expectNumber(value, 'rotation', where),
    anchorX: expectNumber(value, 'anchorX', where),
    anchorY: expectNumber(value, 'anchorY', where)
  }
}

function parseTransition(value: unknown, where: string): Transition | null {
  if (value === null || value === undefined) return null
  if (!isObject(value) || value['kind'] !== 'cross-dissolve') throw new ProjectFormatError(`${where} is not a transition`)
  return { kind: 'cross-dissolve', duration: expectInteger(value, 'duration', where, 1, MAX_TICKS) }
}

function parseBlendMode(value: unknown, where: string): BlendMode {
  if (!BLEND_MODES.some((m) => m.id === value)) throw new ProjectFormatError(`${where} is not a blend mode`)
  return value as BlendMode
}

function parseClip(value: unknown, index: number): Clip {
  const where = `sequence.clips[${index}]`
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const kind = value['kind']
  if (kind !== 'video' && kind !== 'audio') throw new ProjectFormatError(`${where}.kind should be "video" or "audio"`)
  const linkId = value['linkId']
  return {
    id: expectString(value, 'id', where),
    trackId: expectString(value, 'trackId', where),
    mediaId: expectString(value, 'mediaId', where),
    kind,
    name: expectString(value, 'name', where),
    start: expectInteger(value, 'start', where, 0, MAX_TICKS),
    duration: expectInteger(value, 'duration', where, 1, MAX_TICKS),
    sourceIn: expectInteger(value, 'sourceIn', where, 0, MAX_TICKS),
    linkId: typeof linkId === 'string' ? linkId : null,
    motion: parseMotion(value['motion'], `${where}.motion`),
    opacity: Math.min(100, Math.max(0, expectNumber(value, 'opacity', where))),
    blendMode: parseBlendMode(value['blendMode'], `${where}.blendMode`),
    volume: expectNumber(value, 'volume', where),
    speed: Math.max(0, expectNumber(value, 'speed', where)),
    reverse: expectBoolean(value, 'reverse', where),
    transitionIn: parseTransition(value['transitionIn'], `${where}.transitionIn`),
    transitionOut: parseTransition(value['transitionOut'], `${where}.transitionOut`),
    effects: parseEffects(value['effects'], `${where}.effects`),
    adjustment: expectBoolean(value, 'adjustment', where),
    keyframes: parseKeyframes(value['keyframes'], `${where}.keyframes`),
    modulation: wrap(() => parseModulation(value['modulation'], `${where}.modulation`)),
    // Checked against the sequence's masks once they're read.
    mask: (value['mask'] ?? null) as Clip['mask']
  }
}

/** Modulation parsing reports through ProjectFormatError like everything else here. */
function wrap<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof ModulationFormatError || error instanceof MaskFormatError) throw new ProjectFormatError(error.message)
    throw error
  }
}

const INTERPOLATIONS: readonly Interpolation[] = ['hold', 'linear', 'bezier']

function parseHandle(value: unknown, where: string): Keyframe['in'] {
  if (!isObject(value) || !Array.isArray(value['v'])) throw new ProjectFormatError(`${where} should be a handle`)
  const v = value['v'].map((n, i) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new ProjectFormatError(`${where}.v[${i}] should be a number`)
    return n
  })
  return { t: expectNumber(value, 't', where), v }
}

/** Keyframes by property, as stored; values are checked against their properties once clips and effects are known. */
function parseKeyframes(value: unknown, where: string): KeyframeMap {
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const map: KeyframeMap = {}
  for (const [key, list] of Object.entries(value)) {
    if (!Array.isArray(list)) throw new ProjectFormatError(`${where}.${key} should be a list`)
    map[key] = list.map((raw, index) => {
      const at = `${where}.${key}[${index}]`
      if (!isObject(raw)) throw new ProjectFormatError(`${at} should be an object`)
      const interpolation = raw['interpolation']
      if (!INTERPOLATIONS.includes(interpolation as Interpolation)) throw new ProjectFormatError(`${at}.interpolation should be hold, linear or bezier`)
      return {
        id: expectString(raw, 'id', at),
        // Keyframes can sit before the clip's start (its head was trimmed off).
        time: expectInteger(raw, 'time', at, -MAX_TICKS, MAX_TICKS),
        value: parseParamValue(raw['value'], `${at}.value`),
        interpolation: interpolation as Interpolation,
        in: parseHandle(raw['in'], `${at}.in`),
        out: parseHandle(raw['out'], `${at}.out`)
      }
    })
  }
  return map
}

function parseParamValue(value: unknown, where: string): ParamValue {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number' && Number.isFinite(v))) return [value[0], value[1]]
  throw new ProjectFormatError(`${where} is not an effect value`)
}

/** Effects as stored; values are checked against each effect's manifest once media is known. */
function parseEffects(value: unknown, where: string): EffectInstance[] {
  if (!Array.isArray(value)) throw new ProjectFormatError(`${where} should be a list`)
  return value.map((raw, index) => {
    const at = `${where}[${index}]`
    if (!isObject(raw)) throw new ProjectFormatError(`${at} should be an object`)
    const params = raw['params']
    if (!isObject(params)) throw new ProjectFormatError(`${at}.params should be an object`)
    return {
      id: expectString(raw, 'id', at),
      effectId: expectString(raw, 'effectId', at),
      version: expectInteger(raw, 'version', at, 1, 1_000_000),
      enabled: expectBoolean(raw, 'enabled', at),
      mix: Math.min(100, Math.max(0, expectNumber(raw, 'mix', at))),
      blendMode: parseBlendMode(raw['blendMode'], `${at}.blendMode`),
      params: Object.fromEntries(Object.entries(params).map(([key, v]) => [key, parseParamValue(v, `${at}.params.${key}`)])),
      keyframes: parseKeyframes(raw['keyframes'], `${at}.keyframes`),
      modulation: wrap(() => parseModulation(raw['modulation'], `${at}.modulation`)),
      mask: (raw['mask'] ?? null) as EffectInstance['mask']
    }
  })
}

function keepLinks(map: ModulationMap, modulators: Set<string>, allowed: (key: string) => boolean): ModulationMap {
  const out: ModulationMap = {}
  for (const [key, links] of Object.entries(map)) {
    if (!allowed(key)) continue
    const kept = links.filter((l) => modulators.has(l.modulatorId))
    if (kept.length > 0) out[key] = kept
  }
  return out
}

function parseAudioSource(value: unknown, index: number): AudioSource {
  const where = `sequence.audioSources[${index}]`
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const kind = value['kind']
  if (kind !== 'clip' && kind !== 'track' && kind !== 'mix') throw new ProjectFormatError(`${where}.kind should be clip, track or mix`)
  const target = value['target']
  return { id: expectString(value, 'id', where), name: expectString(value, 'name', where), kind, target: typeof target === 'string' ? target : null }
}

function parseBeatGrid(value: unknown): BeatGrid | null {
  if (value === null || value === undefined) return null
  const where = 'sequence.beatGrid'
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  const bpm = expectNumber(value, 'bpm', where)
  if (!(bpm >= MIN_BPM && bpm <= MAX_BPM)) throw new ProjectFormatError(`${where}.bpm should be between ${MIN_BPM} and ${MAX_BPM}`)
  const sourceId = value['sourceId']
  return {
    bpm,
    downbeat: expectInteger(value, 'downbeat', where, -MAX_TICKS, MAX_TICKS),
    beatsPerBar: expectInteger(value, 'beatsPerBar', where, 1, 16),
    sourceId: typeof sourceId === 'string' ? sourceId : null
  }
}

/** The timeline's In and Out; a mark that isn't a time is dropped, and an Out before the In too. */
function parseSequenceMarks(value: unknown): { in: number | null; out: number | null } {
  if (!isObject(value)) return { in: null, out: null }
  const time = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TICKS ? v : null)
  const marks = { in: time(value['in']), out: time(value['out']) }
  if (marks.in !== null && marks.out !== null && marks.out <= marks.in) marks.out = null
  return marks
}

function parseMarker(value: unknown, index: number): Marker {
  const where = `sequence.markers[${index}]`
  if (!isObject(value)) throw new ProjectFormatError(`${where} should be an object`)
  return {
    id: expectString(value, 'id', where),
    time: expectInteger(value, 'time', where, 0, MAX_TICKS),
    name: typeof value['name'] === 'string' ? value['name'] : ''
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

  const clipsRaw = sequence['clips']
  const markersRaw = sequence['markers']
  if (!Array.isArray(clipsRaw)) throw new ProjectFormatError('sequence.clips should be a list')
  if (!Array.isArray(markersRaw)) throw new ProjectFormatError('sequence.markers should be a list')
  const trackKinds = new Map(tracks.map((t) => [t.id, t.kind]))
  const mediaIds = new Set(media.map((m) => m.id))
  const clips = clipsRaw.map(parseClip)
  if (new Set(clips.map((c) => c.id)).size !== clips.length) throw new ProjectFormatError('Two clips share the same id')
  for (const clip of clips) {
    if (trackKinds.get(clip.trackId) !== clip.kind) throw new ProjectFormatError(`Clip "${clip.name}" is on a missing or wrong-kind track`)
    if (clip.adjustment) {
      if (clip.kind !== 'video') throw new ProjectFormatError(`Adjustment layer "${clip.name}" is on an audio track`)
    } else if (!mediaIds.has(clip.mediaId)) throw new ProjectFormatError(`Clip "${clip.name}" points at media that isn't in the project`)
    // Effects made with an older version of their effect are upgraded; values are checked.
    // An effect this version of ginosa doesn't know is kept as it is (shown as missing).
    const settingsForSize = { width: expectInteger(settings, 'width', 'sequence.settings', MIN_DIMENSION, MAX_DIMENSION), height: expectInteger(settings, 'height', 'sequence.settings', MIN_DIMENSION, MAX_DIMENSION) }
    const size = clip.adjustment ? settingsForSize : sourceSize(media.find((m) => m.id === clip.mediaId), { ...settingsForSize, frameRate: '25', sampleRate: 48_000 })
    clip.effects = clip.effects.map((effect) => {
      const manifest = effectById(effect.effectId)
      if (!manifest) return effect
      const upgraded = upgradeInstance(manifest, effect, size)
      return { ...upgraded, params: sanitiseParams(manifest, upgraded.params, size), keyframes: sanitiseKeyframes(manifest, upgraded.keyframes, size) }
    })
    // The clip's own keyframes: only properties it has, with valid values.
    const keyframes: KeyframeMap = {}
    for (const [param, track] of Object.entries(clip.keyframes)) {
      const spec = propertySpec(clip, null, param)
      if (!spec || track.length === 0 || (param === 'speed' && speedKeyframeProblem(clip))) continue
      const fallback = staticValue(clip, null, param)
      keyframes[param] = normaliseTrack(track, (v) => clampValue(spec, v) ?? fallback, false)
    }
    clip.keyframes = keyframes
  }
  const markers = markersRaw.map(parseMarker)
  const sourcesRaw = sequence['audioSources']
  if (!Array.isArray(sourcesRaw)) throw new ProjectFormatError('sequence.audioSources should be a list')
  const audioSources = sourcesRaw.map(parseAudioSource)
  if (new Set(audioSources.map((s) => s.id)).size !== audioSources.length) throw new ProjectFormatError('Two audio sources share the same id')
  const beatGrid = parseBeatGrid(sequence['beatGrid'])
  if (beatGrid?.sourceId && !audioSources.some((s) => s.id === beatGrid.sourceId)) beatGrid.sourceId = null
  const modulators = wrap(() => parseModulators(sequence['modulators'], parseKeyframes))
  // Links to modulators that aren't there are dropped; Speed and choices can't be modulated.
  const modulatorIds = new Set(modulators.map((m) => m.id))
  for (const clip of clips) {
    clip.modulation = keepLinks(clip.modulation, modulatorIds, (key) => key !== 'speed' && propertySpec(clip, null, key)?.kind !== undefined && propertySpec(clip, null, key)?.kind !== 'stepped')
    for (const effect of clip.effects) {
      const manifest = effectById(effect.effectId)
      effect.modulation = keepLinks(effect.modulation, modulatorIds, (key) => key === 'mix' || !manifest || manifest.params.some((p) => p.id === key && p.type !== 'choice' && p.type !== 'toggle' && p.type !== 'curve'))
    }
  }
  // Masks: their links to missing modulators are dropped, as are references to missing masks.
  const masks = wrap(() => parseMasks(sequence['masks'], parseKeyframes, parseModulation))
  for (const mask of masks) for (const shape of mask.shapes) shape.modulation = keepLinks(shape.modulation, modulatorIds, () => true)
  const maskIds = new Set(masks.map((m) => m.id))
  clips.forEach((clip, i) => {
    // Video clips and adjustment layers have a mask of their own; Follow clip only where there's Motion.
    clip.mask = clip.kind === 'video' ? wrap(() => parseMaskRef(clip.mask, `sequence.clips[${i}].mask`, maskIds)) : null
    if (clip.mask && clip.adjustment) delete clip.mask.followClip
    clip.effects.forEach((effect, j) => (effect.mask = wrap(() => parseMaskRef(effect.mask, `sequence.clips[${i}].effects[${j}].mask`, maskIds))))
  })
  // Linked sound's copy of a speed ramp is rebuilt from its picture (decision 41).
  const marks = parseSequenceMarks(sequence['marks'])
  syncLinkedRamps({ id: '', name: '', settings: { width: 1, height: 1, frameRate: '25', sampleRate: 48_000 }, tracks, clips, markers, audioSources, beatGrid, modulators, masks, marks })

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
      tracks,
      clips,
      markers,
      audioSources,
      beatGrid,
      modulators,
      masks,
      marks
    },
    media,
    bins
  }
}
