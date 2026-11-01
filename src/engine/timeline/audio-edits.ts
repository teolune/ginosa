import { MAX_BPM, MIN_BPM } from '../audio/beat-grid'
import { CommandError } from '../project/commands'
import { defaultId, type AudioSource, type BeatGrid, type IdFactory } from '../project/model'
import { timelineCommand, type TimelineCommand } from './edits'

/** Analysis sources and the beat grid (M8), as undoable commands. */

export function addAudioSource(kind: AudioSource['kind'], target: string | null, name: string, newId: IdFactory = defaultId): TimelineCommand & { sourceId: string } {
  const id = newId()
  const command = timelineCommand('New Analysis Source', (draft) => {
    const sequence = draft.sequence
    if (kind === 'clip') {
      const clip = sequence.clips.find((c) => c.id === target)
      if (!clip || clip.kind !== 'audio') throw new CommandError('Pick an audio clip to analyse')
    }
    if (kind === 'track') {
      const track = sequence.tracks.find((t) => t.id === target)
      if (!track || track.kind !== 'audio') throw new CommandError('Pick an audio track to analyse')
    }
    const clean = name.trim() || 'Source'
    sequence.audioSources.push({ id, name: uniqueName(sequence.audioSources, clean), kind, target: kind === 'mix' ? null : target })
  }) as TimelineCommand & { sourceId: string }
  command.sourceId = id
  return command
}

function uniqueName(sources: AudioSource[], name: string, except: string | null = null): string {
  const taken = new Set(sources.filter((s) => s.id !== except).map((s) => s.name))
  if (!taken.has(name)) return name
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`
}

export function renameAudioSource(id: string, name: string): TimelineCommand {
  return timelineCommand('Rename Analysis Source', (draft) => {
    const source = draft.sequence.audioSources.find((s) => s.id === id)
    if (!source) throw new CommandError('That source is gone')
    const clean = name.trim()
    if (!clean) throw new CommandError('A source needs a name')
    source.name = uniqueName(draft.sequence.audioSources, clean, id)
  })
}

export function removeAudioSource(id: string): TimelineCommand {
  return timelineCommand('Remove Analysis Source', (draft) => {
    const sequence = draft.sequence
    const before = sequence.audioSources.length
    sequence.audioSources = sequence.audioSources.filter((s) => s.id !== id)
    if (sequence.audioSources.length === before) throw new CommandError('That source is gone')
    // The grid stays where it is; it just no longer remembers where it came from.
    if (sequence.beatGrid?.sourceId === id) sequence.beatGrid.sourceId = null
  })
}

export type BeatGridChanges = Partial<BeatGrid>

/**
 * Sets the beat grid (or parts of it). A run of nudges or typed changes to the same
 * values merges into one undo step.
 */
export function setBeatGrid(changes: BeatGridChanges | null, label = 'Change Tempo'): TimelineCommand {
  const command = timelineCommand(changes === null ? 'Remove Beat Grid' : label, (draft) => {
    const sequence = draft.sequence
    if (changes === null) {
      sequence.beatGrid = null
      return
    }
    const next: BeatGrid = { bpm: 120, downbeat: 0, beatsPerBar: 4, sourceId: null, ...sequence.beatGrid, ...changes }
    if (!(next.bpm >= MIN_BPM && next.bpm <= MAX_BPM)) throw new CommandError(`Tempo must be between ${MIN_BPM} and ${MAX_BPM} BPM`)
    if (!Number.isInteger(next.beatsPerBar) || next.beatsPerBar < 1 || next.beatsPerBar > 16) throw new CommandError('A bar has 1 to 16 beats')
    if (!Number.isFinite(next.downbeat)) throw new CommandError('The downbeat needs a time')
    next.bpm = Math.round(next.bpm * 1000) / 1000
    next.downbeat = Math.round(next.downbeat)
    if (next.sourceId && !sequence.audioSources.some((s) => s.id === next.sourceId)) next.sourceId = null
    sequence.beatGrid = next
  })
  command.coalesceKey = changes ? `beat-grid:${Object.keys(changes).sort().join(',')}` : undefined
  return command
}
