import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { createProject, type AutomationPoint, type BeatGrid, type Clip, type Rack } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks, ticksToSeconds } from '../time'
import { newAutomationClip, setAutomationPoints, setControlsTempo, setTempoRange } from '../timeline/automation-edits'
import type { TimelineCommand } from '../timeline/edits'
import { holdAt, POSTERIZE_RATES, posterizeSettings } from '../timeline/posterize'
import { channelHits, hitBeat } from '../timeline/rack'
import { clockAt } from '../timeline/render-plan'
import { beatAt, beatTime, beatsBetween, tempoAt } from './beat-grid'
import { tempoClipAt, tempoClips, tempoGrid, tempoKey } from './tempo-map'

const s = secondsToTicks
let counter = 0
const ids = () => `tm-${++counter}`
const GRID: BeatGrid = { bpm: 120, downbeat: 0, beatsPerBar: 4, sourceId: null }

function setup(grid: BeatGrid | null = GRID) {
  const history = new History(createProject({ name: 'Tempo', createId: ids }))
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  if (grid) history.dispatch({ label: 'Grid', apply: (draft) => void (draft.sequence.beatGrid = { ...grid }) })
  return { history, run, sequence: () => history.state.sequence }
}

/**
 * A tempo clip from 4 s to 12 s whose curve goes 120 → 140 BPM in a straight line over its first
 * 6 s, then holds 140 (range 60–180): the ramp of W2.3's "done when".
 */
function ramp() {
  const t = setup()
  const clip = t.run(newAutomationClip({ at: s(4), duration: s(8), tempo: true }, ids))
  const range = t.sequence().clips.find((c) => c.id === clip.clipId)!.automation!.tempo!
  const v = (bpm: number) => (bpm - range.min) / (range.max - range.min)
  const points: AutomationPoint[] = [
    { time: 0, value: v(120), shape: 'single', tension: 0 },
    { time: s(6), value: v(140), shape: 'hold', tension: 0 }
  ]
  t.run(setAutomationPoints(clip.clipId, points))
  return { ...t, clipId: clip.clipId, range }
}

/** The ramp's beats, worked out by hand: 2 a second to 4 s, then 8 + 2(t − 4) + (t − 4)²/36 to 10 s, then 140 BPM. */
function exactBeats(t: number): number {
  if (t <= 4) return 2 * t
  if (t <= 10) return 8 + 2 * (t - 4) + (t - 4) ** 2 / 36
  return 21 + ((t - 10) * 140) / 60
}
function exactTime(beat: number): number {
  if (beat <= 8) return beat / 2
  if (beat <= 21) return 4 - 36 + Math.sqrt(36 * 36 + 36 * (beat - 8))
  return 10 + ((beat - 21) * 60) / 140
}

describe('the tempo map (W2.3)', () => {
  it('makes a tempo clip from the tempo where it starts, 60 BPM either side, and a 120 BPM grid if there was none', () => {
    const { run, sequence } = setup(null)
    const clip = run(newAutomationClip({ at: s(2), tempo: true }, ids))
    const made = sequence().clips.find((c) => c.id === clip.clipId)!
    expect(sequence().beatGrid).toMatchObject({ bpm: 120, downbeat: 0 })
    expect(made.name).toBe('Tempo')
    expect(made.automation!.tempo).toEqual({ min: 60, max: 180 })
    expect(made.automation!.points[0]!.value).toBeCloseTo(0.5, 9)
    // 4 bars at 120 BPM.
    expect(made.duration).toBe(s(8))
    // A flat tempo clip changes nothing.
    const grid = tempoGrid(sequence())!
    expect(grid.map).toBeDefined()
    expect(Math.abs(beatAt(grid, s(30)) - 60)).toBeLessThan(1e-6)
  })

  it('counts beats through a ramp exactly: 120 → 140 BPM, each beat within a microsecond of the sums by hand', () => {
    const { sequence } = ramp()
    const grid = tempoGrid(sequence())!
    let worstBeat = 0
    for (let t = 0; t <= 20; t += 0.0137) worstBeat = Math.max(worstBeat, Math.abs(beatAt(grid, s(t)) - exactBeats(t)))
    let worstTime = 0
    for (let b = 0; b <= 45; b += 0.25) worstTime = Math.max(worstTime, Math.abs(ticksToSeconds(beatTime(grid, b)) - exactTime(b)))
    expect(worstBeat).toBeLessThan(1e-6)
    expect(worstTime).toBeLessThan(1e-6)
    expect(tempoAt(grid, s(2))).toBe(120)
    expect(tempoAt(grid, s(7))).toBeCloseTo(130, 6)
    expect(tempoAt(grid, s(11))).toBeCloseTo(140, 6)
    // After the clip ends (12 s) its last tempo holds.
    expect(tempoAt(grid, s(30))).toBeCloseTo(140, 6)
    // The metronome's beats, and the bars.
    const clicks = beatsBetween(grid, s(3.9), s(10.1))
    expect(clicks.map((c) => c.beat)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])
    expect(clicks.filter((c) => c.bar).map((c) => c.beat)).toEqual([8, 12, 16, 20])
    for (const c of clicks) expect(Math.abs(ticksToSeconds(c.time) - exactTime(c.beat))).toBeLessThan(1e-6)
  })

  it('puts Channel Rack hits, Posterize Time updates and effects’ beat clock on the ramp’s beats', () => {
    const { sequence } = ramp()
    const grid = tempoGrid(sequence())!
    const rack: Rack = { rows: [{ id: 'r', name: 'Kick', enabled: true, swing: 0, band: 'bass', modulatorId: null, strength: 100, nudge: 0, detect: 'kick' }], sections: [0, 1, 2].map((k) => ({ id: `s${k}`, bars: 4, cubes: { r: Array.from({ length: 16 }, (_, i) => ({ step: i * 4, amounts: {} })) } })) }
    const hits = channelHits(rack, 'r', grid).map((h) => ticksToSeconds(beatTime(grid, hitBeat(h.step, rack.rows[0]!))))
    expect(hits).toHaveLength(48)
    hits.forEach((t, n) => expect(Math.abs(t - exactTime(n))).toBeLessThan(1e-6))
    // Posterize Time at 1/4: an update on each beat, on the nearest frame (25 fps).
    const frame = s(0.04)
    const settings = posterizeSettings({ rate: POSTERIZE_RATES.findIndex((r) => r.id === '1/4') })
    for (let f = 0; f < 500; f++) {
      const hold = holdAt(settings, grid, frame, f)!
      const k = Math.round(beatAt(grid, hold.start * frame))
      expect(hold.start).toBe(Math.round(exactTime(k) * 25))
      expect(hold.end).toBe(Math.round(exactTime(k + 1) * 25))
    }
    // The clock effects read (Grain's pattern, say): its beats per frame follow the tempo there.
    expect(clockAt(sequence(), s(2)).beatsPerFrame).toBeCloseTo(0.08, 6)
    expect(clockAt(sequence(), s(11)).beatsPerFrame).toBeCloseTo((140 / 60) * 0.04, 6)
  })

  it('holds the last tempo after a clip, jumps where a hold ends, ignores muted clips and keeps the map until a tempo clip changes', () => {
    const { history, run, sequence, clipId, range } = ramp()
    const v = (bpm: number) => (bpm - range.min) / (range.max - range.min)
    // A hold at 120, then a jump to 160 at 2 s into the clip (6 s).
    run(setAutomationPoints(clipId, [
      { time: 0, value: v(120), shape: 'hold', tension: 0 },
      { time: s(2), value: v(160), shape: 'hold', tension: 0 }
    ]))
    const grid = tempoGrid(sequence())!
    // 12 beats to 6 s, then 160 BPM: beat 20 is 3 s later.
    expect(Math.abs(ticksToSeconds(beatTime(grid, 20)) - 9)).toBeLessThan(0.0002)
    expect(tempoAt(grid, s(5.99))).toBe(120)
    expect(tempoAt(grid, s(6.01))).toBeCloseTo(160, 6)
    expect(tempoClipAt(sequence(), s(3))).toBeNull()
    expect(tempoClipAt(sequence(), s(30))).toBe(clipId)
    // Kept: the same grid until something it depends on changes.
    expect(tempoGrid(sequence())).toBe(grid)
    expect(tempoKey(sequence())).not.toBe('')
    // A muted automation track: back to the steady grid.
    const track = sequence().clips.find((c) => c.id === clipId)!.trackId
    history.dispatch({ label: 'Mute', apply: (draft) => void (draft.sequence.tracks.find((t) => t.id === track)!.muted = true) })
    expect(tempoGrid(sequence())).toBe(sequence().beatGrid)
    expect(tempoClips(sequence())).toEqual([])
  })

  it('changes a tempo clip’s range keeping its tempos, turns tempo on and off, and saves it', () => {
    const { history, run, sequence, clipId } = ramp()
    const bpms = () => {
      const c = sequence().clips.find((x) => x.id === clipId)!
      return c.automation!.points.map((p) => Math.round(c.automation!.tempo!.min + (c.automation!.tempo!.max - c.automation!.tempo!.min) * p.value))
    }
    expect(bpms()).toEqual([120, 140])
    run(setTempoRange(clipId, 100, 200))
    expect(bpms()).toEqual([120, 140])
    expect(() => history.dispatch(setTempoRange(clipId, 150, 140))).toThrow(/top above its bottom/)
    const saved = parseProject(serializeProject(history.state)).sequence.clips.find((c: Clip) => c.id === clipId)!
    expect(saved.automation!.tempo).toEqual({ min: 100, max: 200 })
    run(setControlsTempo(clipId, false))
    expect(sequence().clips.find((c) => c.id === clipId)!.automation!.tempo).toBeUndefined()
    expect(tempoGrid(sequence())).toBe(sequence().beatGrid)
    run(setControlsTempo(clipId, true))
    expect(sequence().clips.find((c) => c.id === clipId)!.automation!.tempo).toEqual({ min: 60, max: 180 })
  })
})
