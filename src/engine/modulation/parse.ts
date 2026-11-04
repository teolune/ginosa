import { BANDS, type BandId } from '../audio/analysis'
import { MODULATOR_PARAMS, NOTE_VALUES, type BandRef, type LinkMode, type ModLink, type ModSource, type ModulationMap, type Modulator, type ResponseCurve } from './types'

/**
 * Reading modulators and links from a project file. Anything malformed is a clear error;
 * values out of range are brought into range (as with effect values).
 */

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export class ModulationFormatError extends Error {}

function num(o: Json, key: string, where: string, fallback?: number): number {
  const v = o[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (fallback !== undefined && v === undefined) return fallback
  throw new ModulationFormatError(`${where}.${key} should be a number`)
}

function str(o: Json, key: string, where: string): string {
  const v = o[key]
  if (typeof v !== 'string') throw new ModulationFormatError(`${where}.${key} should be text`)
  return v
}

const BAND_IDS = BANDS.map((b) => b.id) as string[]

function parseBand(v: unknown, where: string): BandRef {
  if (typeof v === 'string' && BAND_IDS.includes(v)) return v as BandId
  if (isObject(v)) {
    const low = num(v, 'low', where)
    const high = num(v, 'high', where)
    if (!(low >= 10 && high > low && high <= 24_000)) throw new ModulationFormatError(`${where} should be a range between 10 Hz and 24 kHz`)
    return { low, high }
  }
  throw new ModulationFormatError(`${where} should be a band`)
}

function parseSource(v: unknown, where: string): ModSource {
  if (!isObject(v)) throw new ModulationFormatError(`${where} should be an object`)
  switch (v['kind']) {
    case 'audio': {
      const signal = v['signal']
      if (!['level', 'transient', 'hits', 'loudness', 'peak'].includes(signal as string)) throw new ModulationFormatError(`${where}.signal is not a signal`)
      return { kind: 'audio', sourceId: str(v, 'sourceId', where), signal: signal as 'level', band: parseBand(v['band'] ?? 'bass', `${where}.band`) }
    }
    case 'tempo': {
      const signal = v['signal']
      if (!['beat-phase', 'bar-phase', 'beat-trigger', 'bar-trigger'].includes(signal as string)) throw new ModulationFormatError(`${where}.signal is not a tempo signal`)
      return { kind: 'tempo', signal: signal as 'beat-phase' }
    }
    case 'lfo': {
      const shape = v['shape']
      if (!['sine', 'triangle', 'saw', 'square', 'random-steps'].includes(shape as string)) throw new ModulationFormatError(`${where}.shape is not an LFO shape`)
      const rate = v['rate']
      if (typeof rate !== 'string' || !(rate in NOTE_VALUES)) throw new ModulationFormatError(`${where}.rate is not a note value`)
      return { kind: 'lfo', shape: shape as 'sine', rate: rate as keyof typeof NOTE_VALUES, seed: Math.round(num(v, 'seed', where, 1)) }
    }
    case 'random':
      return { kind: 'random', seed: Math.round(num(v, 'seed', where)), rate: Math.min(60, Math.max(0.01, num(v, 'rate', where))) }
    case 'pattern':
      return { kind: 'pattern', rowId: str(v, 'rowId', where) }
    default:
      throw new ModulationFormatError(`${where}.kind should be audio, tempo, lfo, random or pattern`)
  }
}

const CURVES: ResponseCurve[] = ['linear', 'exponential', 'logarithmic', 's-curve', 'custom']

export function parseModulators(value: unknown, parseKeyframes: (v: unknown, where: string) => Modulator['keyframes']): Modulator[] {
  if (!Array.isArray(value)) throw new ModulationFormatError('sequence.modulators should be a list')
  const out = value.map((raw, i): Modulator => {
    const where = `sequence.modulators[${i}]`
    if (!isObject(raw)) throw new ModulationFormatError(`${where} should be an object`)
    const clamp = (key: keyof typeof MODULATOR_PARAMS, fallback: number) => Math.min(MODULATOR_PARAMS[key].max, Math.max(MODULATOR_PARAMS[key].min, num(raw, key, where, fallback)))
    const curve = raw['curve']
    const points = Array.isArray(raw['points']) && raw['points'].length === 5 && raw['points'].every((p) => typeof p === 'number' && Number.isFinite(p)) ? (raw['points'] as number[]).map((p) => Math.min(1, Math.max(0, p))) : [0, 0.25, 0.5, 0.75, 1]
    return {
      id: str(raw, 'id', where),
      name: str(raw, 'name', where),
      source: parseSource(raw['source'], `${where}.source`),
      gain: clamp('gain', 0),
      threshold: clamp('threshold', 0),
      knee: clamp('knee', 0),
      attack: clamp('attack', 0),
      release: clamp('release', 0),
      curve: CURVES.includes(curve as ResponseCurve) ? (curve as ResponseCurve) : 'linear',
      points,
      phase: clamp('phase', 0),
      keyframes: Object.fromEntries(Object.entries(parseKeyframes(raw['keyframes'] ?? {}, `${where}.keyframes`)).filter(([key]) => key in MODULATOR_PARAMS))
    }
  })
  if (new Set(out.map((m) => m.id)).size !== out.length) throw new ModulationFormatError('Two modulators share the same id')
  return out
}

const MODES: LinkMode[] = ['add', 'multiply', 'replace']

export function parseModulation(value: unknown, where: string): ModulationMap {
  if (value === undefined) return {}
  if (!isObject(value)) throw new ModulationFormatError(`${where} should be an object`)
  const map: ModulationMap = {}
  for (const [key, list] of Object.entries(value)) {
    if (!Array.isArray(list)) throw new ModulationFormatError(`${where}.${key} should be a list`)
    map[key] = list.map((raw, i): ModLink => {
      const at = `${where}.${key}[${i}]`
      if (!isObject(raw)) throw new ModulationFormatError(`${at} should be an object`)
      const numbers = (k: string) => {
        const v = raw[k]
        if (!Array.isArray(v) || v.length < 1 || v.length > 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new ModulationFormatError(`${at}.${k} should be one or two numbers`)
        return v as number[]
      }
      const mode = raw['mode']
      return {
        id: str(raw, 'id', at),
        modulatorId: str(raw, 'modulatorId', at),
        mode: MODES.includes(mode as LinkMode) ? (mode as LinkMode) : 'add',
        min: numbers('min'),
        max: numbers('max'),
        invert: raw['invert'] === true,
        amount: Math.min(100, Math.max(0, num(raw, 'amount', at, 100)))
      }
    })
    if (map[key]!.length === 0) delete map[key]
  }
  return map
}
