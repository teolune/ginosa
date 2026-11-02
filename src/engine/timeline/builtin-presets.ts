import { effectById } from '../../effects/registry'
import { defaultParams, sanitiseValue } from '../effects/params'
import type { EffectInstance, ParamValue } from '../effects/types'
import type { AudioSignal, BandRef, ModSource, Modulator } from '../modulation/types'
import { CommandError } from '../project/commands'
import { defaultId, type BlendMode, type IdFactory } from '../project/model'
import type { Ticks } from '../time'
import { effectImageSize } from './effect-edits'
import { timelineCommand, type TimelineCommand } from './edits'
import { applyLink, describeSource, newModulator, sameSource, type LinkSettings } from './modulation-edits'
import { assertUnlocked, findClip, findTrack } from './timeline'

/**
 * Built-in presets: starters that come with ginosa. The audio-reactive ones (M10) bring
 * their links to audio, unlike your own presets: applying one adds its effects and links
 * them to the sequence's first audio analysis source (reusing a modulator that already
 * listens the same way). With no source yet, the effects arrive unlinked and a message says
 * so. The grain looks (M11) are just settings.
 */

type ModulatorSettings = Pick<Modulator, 'gain' | 'threshold' | 'knee' | 'attack' | 'release' | 'curve'>

export interface BuiltinPreset {
  id: string
  name: string
  description: string
  effects: ReadonlyArray<{ effectId: string; params: Record<string, ParamValue>; blendMode?: BlendMode }>
  links: ReadonlyArray<{ effect: number; param: string; signal: AudioSignal; band: BandRef; modulator: ModulatorSettings; link: LinkSettings }>
}

export const BUILTIN_PREFIX = 'builtin:'

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  {
    id: 'builtin:kick-flash',
    name: 'Kick Flash',
    description: 'Basic Correction’s Exposure jumps 2 stops on each bass hit (the kick) and falls back over 200 ms.',
    effects: [{ effectId: 'basic-correction', params: {} }],
    // A hit is a one-sample (5 ms) impulse, so the attack is instant: a 5 ms attack would only reach 63%.
    links: [{ effect: 0, param: 'exposure', signal: 'hits', band: 'bass', modulator: { gain: 0, threshold: 0, knee: 0, attack: 0, release: 200, curve: 'linear' }, link: { mode: 'add', min: [0], max: [2] } }]
  },
  {
    id: 'builtin:bass-mosaic',
    name: 'Bass Mosaic',
    description: 'Mosaic cells grow with the bass level: off while the bass is quiet, up to 6% of the picture’s height at its loudest.',
    effects: [{ effectId: 'mosaic', params: { cellSize: 0 } }],
    links: [{ effect: 0, param: 'cellSize', signal: 'level', band: 'bass', modulator: { gain: 0, threshold: 0.2, knee: 0.1, attack: 5, release: 150, curve: 'linear' }, link: { mode: 'add', min: [0], max: [6] } }]
  },
  {
    id: 'builtin:hihat-grain',
    name: 'Hi-Hat Grain',
    description: 'Fine grain that thickens on the hi-hats: Grain’s Amount follows the high band, up to +30% on each hat, falling back in 80 ms.',
    effects: [{ effectId: 'grain', params: { amount: 8, size: 1, softness: 35, colourAmount: 30, blueSize: 120, shadows: 60, midtones: 100, highlights: 40 } }],
    links: [{ effect: 0, param: 'amount', signal: 'level', band: 'high', modulator: { gain: 0, threshold: 0.15, knee: 0.05, attack: 0, release: 80, curve: 'linear' }, link: { mode: 'add', min: [0], max: [30] } }]
  },
  {
    id: 'builtin:grain-35mm',
    name: 'Fine 35 mm Grain',
    description: 'Fine, soft colour grain, strongest in the midtones, like a fine-grained 35 mm stock.',
    effects: [{ effectId: 'grain', params: { amount: 12, size: 0.9, softness: 35, composite: 'film', grainType: 'colour', colourAmount: 30, redSize: 100, greenSize: 100, blueSize: 120, shadows: 60, midtones: 100, highlights: 40 } }],
    links: []
  },
  {
    id: 'builtin:grain-16mm',
    name: '16 mm Grain',
    description: 'Coarser grain with more colour in it, as 16 mm film enlarged to fill a frame.',
    effects: [{ effectId: 'grain', params: { amount: 22, size: 1.7, softness: 45, composite: 'film', grainType: 'colour', colourAmount: 40, redSize: 100, greenSize: 100, blueSize: 135, shadows: 70, midtones: 100, highlights: 45 } }],
    links: []
  },
  {
    id: 'builtin:grain-super8',
    name: 'Super 8 Grain',
    description: 'Big, soft, colourful grain: a tiny Super 8 frame blown up.',
    effects: [{ effectId: 'grain', params: { amount: 34, size: 2.8, softness: 55, composite: 'film', grainType: 'colour', colourAmount: 50, redSize: 110, greenSize: 100, blueSize: 150, shadows: 80, midtones: 100, highlights: 55 } }],
    links: []
  },
  {
    id: 'builtin:sensor-noise',
    name: 'Digital Sensor Noise',
    description: 'Per-pixel colour noise that’s strongest in the shadows, like a phone or camera at high ISO.',
    effects: [{ effectId: 'grain', params: { amount: 18, size: 0.7, softness: 15, composite: 'digital', grainType: 'colour', colourAmount: 85, redSize: 100, greenSize: 100, blueSize: 100, shadows: 100, midtones: 60, highlights: 25 } }],
    links: []
  },
  {
    id: 'builtin:heavy-noise',
    name: 'Heavy Noise',
    description: 'Strong grey noise laid over the picture in Overlay, everywhere from shadows to highlights.',
    effects: [{ effectId: 'grain', params: { amount: 60, size: 1.4, softness: 30, composite: 'layer', grainType: 'mono', shadows: 100, midtones: 100, highlights: 100 }, blendMode: 'overlay' }],
    links: []
  }
]

export function builtinPreset(id: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id)
}

/** Applies a built-in preset to video clips and adjustment layers (one undo step). `at` is the playhead. */
export function applyBuiltinPreset(clipIds: string[], presetId: string, at: Ticks, newId: IdFactory = defaultId): TimelineCommand {
  const preset = builtinPreset(presetId)
  return timelineCommand(`Apply Preset “${preset?.name ?? 'Preset'}”`, (draft, command) => {
    if (!preset) throw new CommandError('ginosa doesn’t have that built-in preset')
    const sequence = draft.sequence
    const clips = [...new Set(clipIds)].map((id) => findClip(sequence, id)).filter((c) => c.kind === 'video')
    if (clips.length === 0) throw new CommandError('Select a video clip or adjustment layer to apply a preset to')
    for (const clip of clips) assertUnlocked(findTrack(sequence, clip.trackId))
    const audio = sequence.audioSources[0] ?? null
    const modulatorIds = preset.links.map((l) => {
      if (!audio) return null
      const source: ModSource = { kind: 'audio', sourceId: audio.id, signal: l.signal, band: l.band }
      const same = sequence.modulators.find((m) => sameSource(m.source, source) && Object.keys(m.keyframes).length === 0 && (Object.keys(l.modulator) as Array<keyof ModulatorSettings>).every((k) => m[k] === l.modulator[k]))
      if (same) return same.id
      const made: Modulator = { ...newModulator(newId(), `${preset.name}: ${describeSource(source, () => audio.name)}`, source), ...l.modulator }
      sequence.modulators.push(made)
      return made.id
    })
    for (const clip of clips) {
      const size = effectImageSize(clip, draft.media, sequence)
      const added: EffectInstance[] = preset.effects.map((e) => {
        const manifest = effectById(e.effectId)
        if (!manifest) throw new CommandError(`ginosa doesn't have an effect called "${e.effectId}"`)
        const params = defaultParams(manifest, size)
        for (const [id, value] of Object.entries(e.params)) {
          const spec = manifest.params.find((p) => p.id === id)
          if (spec) params[id] = sanitiseValue(spec, value, size)
        }
        return { id: newId(), effectId: e.effectId, version: manifest.version, enabled: true, mix: 100, blendMode: e.blendMode ?? 'normal', params, keyframes: {}, modulation: {}, mask: null }
      })
      clip.effects.push(...added)
      preset.links.forEach((l, i) => {
        const modulatorId = modulatorIds[i]
        if (modulatorId) applyLink(clip, { clipId: clip.id, effectId: added[l.effect]!.id, param: l.param }, modulatorId, at, l.link, newId)
      })
    }
    if (preset.links.length === 0) return
    command.notice = audio
      ? `${preset.name} follows “${audio.name}” (the first source in Audio Analysis). Change it in the Modulation window.`
      : `${preset.name}: there’s no audio to follow yet, so the effect was added without its link. Add a source in Audio Analysis, then apply the preset again.`
  })
}
