import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { CommandError } from '../project/commands'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject, type BeatGrid } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { addAudioSource, removeAudioSource, renameAudioSource, setBeatGrid } from '../timeline/audio-edits'
import { moveClips, placeMedia, setClipProperties, type TimelineCommand } from '../timeline/edits'
import { snapTargets } from '../timeline/snapping'
import { frameTicks } from '../timeline/timeline'
import { setTrackFlag } from '../project/commands'
import { barNumber, barPhase, beatAt, beatPhase, beatSnapTargets, beatsBetween, normaliseDownbeat, tapTempo } from './beat-grid'
import { sourceClips, sourceKey, sourceProblem, sourceRange } from './sources'

const s = secondsToTicks
let counter = 0
const ids = () => `bg-${++counter}`

describe('beat grid maths', () => {
  const grid: BeatGrid = { bpm: 120, downbeat: s(1), beatsPerBar: 4, sourceId: null }
  it('places beats and bars both ways from the downbeat', () => {
    expect(beatAt(grid, s(1))).toBe(0)
    expect(beatAt(grid, s(2.25))).toBeCloseTo(2.5, 9)
    expect(beatAt(grid, 0)).toBeCloseTo(-2, 9)
    expect(beatPhase(grid, s(2.25))).toBeCloseTo(0.5, 9)
    expect(barPhase(grid, s(2))).toBeCloseTo(0.5, 9)
    const beats = beatsBetween(grid, 0, s(3))
    expect(beats.map((b) => b.time)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3].map(s))
    expect(beats.filter((b) => b.bar).map((b) => b.time)).toEqual([s(1), s(3)])
    // Bar 1 is the first downbeat at or after the sequence start.
    expect(barNumber(grid, s(1))).toBe(1)
    expect(barNumber(grid, s(3.1))).toBe(2)
    expect(barNumber(grid, s(0.5))).toBe(0)
    expect(normaliseDownbeat({ ...grid, downbeat: s(9) })).toBe(s(1))
  })

  it('rounds beats to frames for snapping', () => {
    const frame = s(1 / 25)
    const targets = beatSnapTargets({ bpm: 128, downbeat: s(0.4), beatsPerBar: 4, sourceId: null }, 0, s(2), frame)
    for (const t of targets) expect(t % frame).toBe(0)
    expect(targets[0]).toBe(Math.round(s(0.4) / frame) * frame)
  })

  it('works out tap tempo with a line through the taps, and starts over after a pause', () => {
    expect(tapTempo([0, 500, 1000])).toBeNull()
    expect(tapTempo([0, 500, 1010, 1490, 2000])).toBeCloseTo(120, 0)
    expect(tapTempo([0, 500, 1000, 1500, 9000, 9468.75, 9937.5, 10406.25])).toBeCloseTo(128, 1)
  })
})

function media(name: string, seconds = 30): MediaItem {
  const info: MediaInfo = { container: 'wav', durationSeconds: seconds, bitRate: null, video: null, audio: { codec: 'pcm_s24le', sampleRate: 48_000, channels: 2, channelLayout: 'stereo' } }
  return { id: `m-${name}`, name, kind: 'audio', path: `/f/${name}.wav`, fingerprint: { size: 1, mtimeMs: 1, sample: name }, info, binId: null, importedAt: '2026-11-01T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
}

function setup() {
  const history = new History(createProject({ name: 'Beats', createId: ids }))
  history.dispatch(importMedia([media('song'), media('drums')]))
  const audio = history.state.sequence.tracks.filter((t) => t.kind === 'audio').map((t) => t.id)
  const run = (command: TimelineCommand) => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  run(placeMedia({ mediaId: 'm-song', sourceIn: 0, sourceOut: s(20), at: s(2), videoTrackId: null, audioTrackId: audio[0]!, mode: 'overwrite' }, ids))
  run(placeMedia({ mediaId: 'm-drums', sourceIn: 0, sourceOut: s(10), at: s(4), videoTrackId: null, audioTrackId: audio[1]!, mode: 'overwrite' }, ids))
  return { history, run, audio }
}

describe('analysis sources', () => {
  it('a track source takes its clips even when muted; the mix takes what is heard', () => {
    const { history, run, audio } = setup()
    run(setTrackFlag(audio[1]!, 'muted', true))
    const seq = history.state.sequence
    const drums = sourceClips(seq, { id: 'a', name: 'Drums', kind: 'track', target: audio[1]! })
    expect(drums.map((c) => c.mediaId)).toEqual(['m-drums'])
    const mix = sourceClips(seq, { id: 'b', name: 'Mix', kind: 'mix', target: null })
    expect(mix.map((c) => c.mediaId)).toEqual(['m-song'])
    expect(sourceRange(drums)).toEqual({ from: s(4), to: s(14) })
    expect(sourceProblem(seq, { id: 'c', name: 'X', kind: 'track', target: 'gone' })).toMatch(/no longer/)
  })

  it("a source's key changes only when its sound does", () => {
    const { history, run, audio } = setup()
    const source = { id: 'a', name: 'Song', kind: 'track' as const, target: audio[0]! }
    const key = () => sourceKey(history.state.sequence, history.state.media, source)
    const first = key()
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    // Editing another track, or renaming, leaves it alone.
    const drums = history.state.sequence.clips.find((c) => c.mediaId === 'm-drums')!
    run(setClipProperties([drums.id], { volume: -6 }))
    expect(key()).toBe(first)
    // Moving the song, or changing its volume, changes it.
    const song = history.state.sequence.clips.find((c) => c.mediaId === 'm-song')!
    run(setClipProperties([song.id], { volume: -3 }))
    const second = key()
    expect(second).not.toBe(first)
    run(moveClips({ clipIds: [song.id], delta: s(1), trackOffset: 0, mode: 'overwrite', copy: false }, ids))
    expect(key()).not.toBe(second)
  })

  it('adds, renames and removes sources, and keeps the beat grid in the project', () => {
    const { history, run, audio } = setup()
    const added = run(addAudioSource('track', audio[0]!, 'Song', ids)) as ReturnType<typeof addAudioSource>
    run(addAudioSource('track', audio[1]!, 'Song', ids))
    expect(history.state.sequence.audioSources.map((x) => x.name)).toEqual(['Song', 'Song 2'])
    run(renameAudioSource(added.sourceId, 'Drums'))
    expect(() => history.dispatch(addAudioSource('clip', 'nope', 'X', ids))).toThrow(CommandError)
    run(setBeatGrid({ bpm: 128, downbeat: s(2.4), beatsPerBar: 4, sourceId: added.sourceId }, 'Detect Tempo'))
    expect(() => history.dispatch(setBeatGrid({ bpm: 1000 }))).toThrow(/between/)
    run(setBeatGrid({ bpm: 64 }, 'Halve Tempo'))
    expect(history.state.sequence.beatGrid).toEqual({ bpm: 64, downbeat: s(2.4), beatsPerBar: 4, sourceId: added.sourceId })
    const reopened = parseProject(serializeProject(history.state))
    expect(reopened.sequence.beatGrid).toEqual(history.state.sequence.beatGrid)
    expect(reopened.sequence.audioSources).toEqual(history.state.sequence.audioSources)
    run(removeAudioSource(added.sourceId))
    expect(history.state.sequence.beatGrid!.sourceId).toBeNull()
    // Older projects open with no sources and no grid.
    const v7 = JSON.parse(serializeProject(history.state)) as Record<string, unknown> & { sequence: Record<string, unknown> }
    v7['schemaVersion'] = 7
    delete v7.sequence['audioSources']
    delete v7.sequence['beatGrid']
    const migrated = parseProject(JSON.stringify(v7))
    expect(migrated.sequence.audioSources).toEqual([])
    expect(migrated.sequence.beatGrid).toBeNull()
  })

  it('beats become snapping targets, on the frame grid', () => {
    const { history, run } = setup()
    run(setBeatGrid({ bpm: 128, downbeat: s(0.4), beatsPerBar: 4, sourceId: null }))
    const frame = frameTicks(history.state.sequence)
    const targets = snapTargets(history.state.sequence, { playhead: null, exclude: new Set() })
    expect(targets).toContain(Math.round(s(0.4 + 60 / 128) / frame) * frame)
  })
})
