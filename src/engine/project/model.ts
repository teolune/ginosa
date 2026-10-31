import { FRAME_RATES, type FrameRateName, type Ticks } from '../time'
import type { Bin, MediaItem } from './media'

/**
 * The project document. Everything the user can undo lives here; window layouts,
 * selection, the playhead and other UI state do not.
 */

/** 1: M1 (sequence and tracks). 2: M2 adds media and bins. 3: M3 adds clips, markers, sync lock and solo. 4: M4 adds Motion, opacity, blend modes and volume. 5: colour interpretation per media file; clip speed, reverse and transitions. */
export const PROJECT_SCHEMA_VERSION = 5

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

/** Photoshop/Premiere blend modes, applied to display (gamma-encoded) values. */
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
  { id: 'exclusion', label: 'Exclusion' }
] as const

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
      markers: []
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
