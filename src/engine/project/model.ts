import type { BandId } from '../audio/analysis'
import { FRAME_RATES, type FrameRateName, type Ticks } from '../time'
import type { Bin, MediaItem } from './media'
import type { EffectInstance } from '../effects/types'
import type { KeyframeMap } from '../keyframes/keyframes'
import type { ModulationMap, Modulator } from '../modulation/types'
import type { Mask, MaskRef } from '../masks/types'

/**
 * The project document. Everything the user can undo lives here; window layouts,
 * selection, the playhead and other UI state do not.
 */

/** 1: M1 (sequence and tracks). 2: M2 adds media and bins. 3: M3 adds clips, markers, sync lock and solo. 4: M4 adds Motion, opacity, blend modes and volume. 5: colour interpretation per media file; clip speed, reverse and transitions. 6: effect stacks and adjustment layers. 7: keyframes. 8: audio analysis sources and the beat grid. 9: modulators and modulation links. 10: shared masks. 11: In and Out on the timeline. */
export const PROJECT_SCHEMA_VERSION = 12

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** Audio: silenced. Video: hidden from the output (Premiere's eye toggle is `visible`). */
  muted: boolean
  locked: boolean
  visible: boolean
  /** Ripple and insert edits elsewhere also shift this track, keeping it in sync (Premiere's sync lock). */
  syncLock: boolean
  /** When any track of a kind is soloed, only soloed tracks of that kind are seen or heard. */
  solo: boolean
}

/**
 * The Photoshop blend modes, applied to display (gamma-encoded) values, for clips,
 * adjustment layers and every effect. The order is the shader's mode number (blend.wgsl).
 */
export const BLEND_MODES = [
  { id: 'normal', label: 'Normal' },
  { id: 'darken', label: 'Darken' },
  { id: 'multiply', label: 'Multiply' },
  { id: 'color-burn', label: 'Color Burn' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'screen', label: 'Screen' },
  { id: 'color-dodge', label: 'Color Dodge' },
  { id: 'add', label: 'Linear Dodge (Add)' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'soft-light', label: 'Soft Light' },
  { id: 'hard-light', label: 'Hard Light' },
  { id: 'difference', label: 'Difference' },
  { id: 'exclusion', label: 'Exclusion' },
  { id: 'linear-burn', label: 'Linear Burn' },
  { id: 'vivid-light', label: 'Vivid Light' },
  { id: 'linear-light', label: 'Linear Light' },
  { id: 'pin-light', label: 'Pin Light' },
  { id: 'hard-mix', label: 'Hard Mix' },
  { id: 'subtract', label: 'Subtract' },
  { id: 'divide', label: 'Divide' },
  { id: 'hue', label: 'Hue' },
  { id: 'saturation', label: 'Saturation' },
  { id: 'color', label: 'Color' },
  { id: 'luminosity', label: 'Luminosity' }
] as const

/** Blend modes in Photoshop's menu order, with separators between its groups. */
export const BLEND_MENU: ReadonlyArray<BlendMode | '-'> = [
  'normal', '-',
  'darken', 'multiply', 'color-burn', 'linear-burn', '-',
  'lighten', 'screen', 'color-dodge', 'add', '-',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix', '-',
  'difference', 'exclusion', 'subtract', 'divide', '-',
  'hue', 'saturation', 'color', 'luminosity'
]

export type BlendMode = (typeof BLEND_MODES)[number]['id']

/**
 * Premiere's Motion. Position is in sequence pixels, anchor in source pixels (both the
 * centre by default). Scale is a percentage of the source's native size; Scale Width
 * stretches horizontally on top of it (100 = no stretch). Rotation is in degrees, clockwise.
 */
export interface Motion {
  positionX: number
  positionY: number
  scale: number
  scaleWidth: number
  rotation: number
  anchorX: number
  anchorY: number
}

/**
 * A piece of media on a track. Positions are integer ticks on the sequence's frame
 * grid; `sourceIn` is where in the media file the clip starts.
 */
export interface Clip {
  id: string
  trackId: string
  mediaId: string
  /** Matches the kind of its track. */
  kind: TrackKind
  name: string
  start: Ticks
  duration: Ticks
  sourceIn: Ticks
  /** Clips sharing a link id move, trim, split and delete together (a camera clip's picture and sound). */
  linkId: string | null
  /** Video clips: transform, opacity (0–100) and blend mode. */
  motion: Motion
  opacity: number
  blendMode: BlendMode
  /** Audio clips: gain in dB (0 = unchanged). */
  volume: number
  /** Playback speed: 1 = 100%; 0 = frame hold (the frame at `sourceIn` for the whole clip). */
  speed: number
  /** Plays its media backwards. */
  reverse: boolean
  /** A cross-dissolve from the clip before it (centred on the cut), or a fade in if nothing is there. */
  transitionIn: Transition | null
  /** A fade out at the clip's end (used when nothing follows the clip). */
  transitionOut: Transition | null
  /** Effects, top to bottom. A clip's run on it before its Motion; an adjustment layer's on everything below it. */
  effects: EffectInstance[]
  /** An adjustment layer: a video-track item with no media, whose effects apply to the tracks beneath it. */
  adjustment: boolean
  /**
   * Keyframes for the clip's own properties (Position, Scale, Scale Width, Rotation, Anchor
   * Point, Opacity, Volume, Speed), times in ticks from the clip's start. A property with
   * keyframes ignores its value above. Effects keep theirs in each EffectInstance.
   */
  keyframes: KeyframeMap
  /** Modulation links by property (same keys as keyframes): which modulators drive it and how. */
  modulation: ModulationMap
  /** Video clips' own mask (M9): where an adjustment layer applies, or where a clip shows (outside it, the clip is transparent). Always null on audio clips. */
  mask: MaskRef | null
}

export interface Transition {
  kind: 'cross-dissolve'
  duration: Ticks
}

export interface Marker {
  id: string
  time: Ticks
  name: string
}

export interface SequenceSettings {
  width: number
  height: number
  frameRate: FrameRateName
  sampleRate: number
}

export interface Sequence {
  id: string
  name: string
  settings: SequenceSettings
  /** All tracks; video and audio are told apart by `kind`. Order within a kind is V1, V2… / A1, A2… */
  tracks: Track[]
  /** Every clip on every track, in no particular order. */
  clips: Clip[]
  markers: Marker[]
  /** Sounds analysed for tempo and (from M8 part 2) modulation, each with a name such as "Song" or "Drums". */
  audioSources: AudioSource[]
  /** The tempo grid: beats and bars on the ruler, and snapping targets. Null until set. */
  beatGrid: BeatGrid | null
  /** Modulators: signals (audio, tempo, LFO, random) shaped into 0–1 movement for linked values. */
  modulators: Modulator[]
  /** Shared masks (M9), used by effects and adjustment layers. */
  masks: Mask[]
  /** The timeline's In and Out (decision 59): Enter renders between them. Out is the end of its frame. */
  marks: { in: Ticks | null; out: Ticks | null }
  /** The drum sequencer (M12, the Channel Rack): rows of steps that fire effects. */
  rack: Rack
}

/**
 * One row of the Channel Rack (M12), e.g. Kick. Its steps are 16th notes counted from the beat
 * grid's downbeat (both ways), so they cover the whole song and follow tempo changes. Each row
 * drives a modulator of its own (source `pattern`), which links to any values.
 */
export interface RackRow {
  id: string
  name: string
  /** The light: a row that's off fires nothing (its steps are kept). */
  enabled: boolean
  /** 0–75%: every second 16th fires later by this share of a 16th. */
  swing: number
  /** The 16ths that fire, sorted, no repeats. */
  steps: number[]
  /** Where Auto-fill takes hits from. */
  band: BandId
  /** The modulator made with the row (renamed and removed with it). Others can listen to the row too. */
  modulatorId: string | null
}

export interface Rack {
  rows: RackRow[]
}

/** 16th notes to a beat. */
export const STEPS_PER_BEAT = 4

/**
 * A sound to analyse: one audio clip, every clip on a track (even a muted one, used as a
 * sidechain), or the mix as heard. Analysis results live in the cache; this is just the
 * choice, so clearing the cache loses nothing.
 */
export interface AudioSource {
  id: string
  name: string
  kind: 'clip' | 'track' | 'mix'
  /** The clip or track; null for the mix. */
  target: string | null
}

/** A constant tempo. Your corrections (BPM, downbeat) live here, in the project, never in the cache. */
export interface BeatGrid {
  bpm: number
  /** Sequence time of the first beat of a bar (any bar: the grid runs both ways from it). */
  downbeat: Ticks
  beatsPerBar: number
  /** The source whose detected tempo this started from, or null when entered by hand. */
  sourceId: string | null
}

export interface Project {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  id: string
  name: string
  createdAt: string
  sequence: Sequence
  media: MediaItem[]
  bins: Bin[]
}

export const RESOLUTION_PRESETS = [
  { label: 'HD 1080p (16:9)', width: 1920, height: 1080 },
  { label: 'Vertical 1080 × 1920 (9:16)', width: 1080, height: 1920 },
  { label: 'Square 1080 × 1080', width: 1080, height: 1080 },
  { label: 'Portrait 1080 × 1350 (4:5)', width: 1080, height: 1350 },
  { label: 'UHD 4K (16:9)', width: 3840, height: 2160 }
] as const

export const MIN_DIMENSION = 16
export const MAX_DIMENSION = 8192

export type IdFactory = () => string

export const defaultId: IdFactory = () => globalThis.crypto.randomUUID()

export function createTrack(kind: TrackKind, index: number, createId: IdFactory = defaultId): Track {
  return {
    id: createId(),
    kind,
    name: `${kind === 'video' ? 'V' : 'A'}${index + 1}`,
    muted: false,
    locked: false,
    visible: true,
    syncLock: true,
    solo: false
  }
}

export interface NewProjectOptions {
  name: string
  settings?: Partial<SequenceSettings>
  createId?: IdFactory
  now?: () => Date
}

/** A new project: one sequence with three video and three audio tracks, like Premiere's default. */
export function createProject({ name, settings, createId = defaultId, now = () => new Date() }: NewProjectOptions): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: createId(),
    name,
    createdAt: now().toISOString(),
    sequence: {
      id: createId(),
      name: 'Sequence 1',
      settings: {
        width: settings?.width ?? 1920,
        height: settings?.height ?? 1080,
        frameRate: settings?.frameRate ?? '25',
        sampleRate: settings?.sampleRate ?? 48_000
      },
      tracks: [
        createTrack('video', 0, createId),
        createTrack('video', 1, createId),
        createTrack('video', 2, createId),
        createTrack('audio', 0, createId),
        createTrack('audio', 1, createId),
        createTrack('audio', 2, createId)
      ],
      clips: [],
      markers: [],
      audioSources: [],
      beatGrid: null,
      modulators: [],
      masks: [],
      marks: { in: null, out: null },
      rack: { rows: [] }
    },
    media: [],
    bins: []
  }
}

export function tracksOfKind(sequence: Sequence, kind: TrackKind): Track[] {
  return sequence.tracks.filter((track) => track.kind === kind)
}

export function frameRateOf(settings: SequenceSettings) {
  return FRAME_RATES[settings.frameRate]
}
