import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { CURVE_RATE, modulatorCurve, sourceSignal, type CurveInputs } from '../modulation/curve'
import { createProject, type RackRow } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { addLink } from './modulation-edits'
import { addRackRows, fillRackRow, removeRackRow, renameRackRow, repeatRackSteps, setRackRow, setRackSteps, STARTER_ROWS, stepsFromHits } from './rack-edits'
import type { TimelineCommand } from './edits'
import { placeMedia } from './edits'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'

let counter = 0
const ids = () => `rk-${++counter}`

function setup() {
  const history = new History(createProject({ name: 'Rack', createId: ids }))
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  return { history, run, rows: () => history.state.sequence.rack.rows }
}

const row = (steps: number[], extra: Partial<RackRow> = {}): RackRow => ({ id: 'r', name: 'Kick', enabled: true, swing: 0, steps, band: 'bass', modulatorId: null, ...extra })
const inputs = (r: RackRow, bpm = 120): CurveInputs => ({ analysis: null, analysisStart: 0, customBand: null, grid: { bpm, downbeat: 0, beatsPerBar: 4, sourceId: null }, pattern: { row: r, frameSeconds: 1 / 25 } })
const onAt = (signal: Float32Array) => signal.reduce<number[]>((out, v, i) => (v > 0 && !(signal[i - 1]! > 0) ? [...out, i] : out), [])

describe('Channel Rack rows', () => {
  it('come with their own modulators, which flash and fall back like triggers', () => {
    const { history, run, rows } = setup()
    run(addRackRows(STARTER_ROWS, ids))
    expect(rows().map((r) => [r.name, r.band])).toEqual([['Kick', 'bass'], ['Clap', 'mid'], ['Hat', 'high']])
    const mods = history.state.sequence.modulators
    expect(mods.map((m) => m.name)).toEqual(['Kick', 'Clap', 'Hat'])
    expect(mods.map((m) => m.source)).toEqual(rows().map((r) => ({ kind: 'pattern', rowId: r.id })))
    expect(rows().map((r) => r.modulatorId)).toEqual(mods.map((m) => m.id))
    expect([mods[0]!.attack, mods[0]!.release]).toEqual([0, 150])
    run(renameRackRow(rows()[0]!.id, 'Big Kick'))
    expect(history.state.sequence.modulators[0]!.name).toBe('Big Kick')
  })

  it('turns steps on and off; a paint stroke is one undo step', () => {
    const { history, run, rows } = setup()
    run(addRackRows([STARTER_ROWS[0]!], ids))
    const id = rows()[0]!.id
    run(setRackSteps(id, [0], true, 'a'))
    run(setRackSteps(id, [4], true, 'a'))
    run(setRackSteps(id, [8, 12, 4], true, 'a'))
    expect(rows()[0]!.steps).toEqual([0, 4, 8, 12])
    history.undo()
    expect(rows()[0]!.steps).toEqual([])
    history.redo()
    run(setRackSteps(id, [4], false))
    expect(rows()[0]!.steps).toEqual([0, 8, 12])
    run(setRackRow(id, { enabled: false, swing: 120 }))
    expect(rows()[0]).toMatchObject({ enabled: false, swing: 75 })
  })

  it('fills a range, repeats a bar through the song, and snaps hits to the nearest 16th', () => {
    const { run, rows } = setup()
    run(addRackRows([STARTER_ROWS[0]!], ids))
    const id = rows()[0]!.id
    run(setRackSteps(id, [1, 2, 20], true))
    run(fillRackRow(id, 0, 16, [0, 4, 8, 12, 17]))
    expect(rows()[0]!.steps).toEqual([0, 4, 8, 12, 20])
    run(repeatRackSteps([id], 0, 16, 64))
    expect(rows()[0]!.steps).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60])
    // 120 BPM: a 16th is 0.125 s.
    const beatAt = (t: number) => t / secondsToTicks(0.5)
    expect(stepsFromHits([secondsToTicks(0.004), secondsToTicks(0.24), secondsToTicks(0.31), secondsToTicks(9)], beatAt, 0, 64)).toEqual([0, 2])
  })

  it('removes a row with its modulator and the values it drove', () => {
    const { history, run, rows } = setup()
    const info: MediaInfo = { container: 'mov', durationSeconds: 10, bitRate: null, video: { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: 250, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 }, audio: null }
    const item: MediaItem = { id: 'm-a', name: 'a', kind: 'video', path: '/f/a', fingerprint: { size: 1, mtimeMs: 1, sample: 'a' }, info, binId: null, importedAt: '2026-11-04T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
    history.dispatch(importMedia([item]))
    const V1 = history.state.sequence.tracks.find((t) => t.kind === 'video')!.id
    run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: secondsToTicks(4), at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    run(addRackRows([STARTER_ROWS[0]!], ids))
    const clip = history.state.sequence.clips[0]!
    run(addLink({ clipId: clip.id, effectId: null, param: 'opacity' }, rows()[0]!.modulatorId!, 0, {}, ids))
    expect(history.state.sequence.clips[0]!.modulation['opacity']).toHaveLength(1)
    const removed = run(removeRackRow(rows()[0]!.id))
    expect(removed.notice).toMatch(/1 value/)
    expect(rows()).toHaveLength(0)
    expect(history.state.sequence.modulators).toHaveLength(0)
    expect(history.state.sequence.clips[0]!.modulation['opacity']).toBeUndefined()
  })
})

describe('Channel Rack as a modulation source', () => {
  it('fires a one-frame pulse on each step, on the beat grid, swung on the odd 16ths', () => {
    // 120 BPM: steps 0, 4, 8, 12 are beats 0–3, every 0.5 s = 100 samples.
    const straight = sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(row([0, 4, 8, 12])), 400)
    expect(onAt(straight)).toEqual([0, 100, 200, 300])
    expect(Array.from(straight.slice(100, 110))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0])
    // Swing 50%: step 1 (0.125 s) moves half a 16th later: 0.1875 s = sample 37.5 → 38.
    expect(onAt(sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(row([1, 2], { swing: 50 })), 100))).toEqual([38, 50])
    // A tempo change moves the steps: at 128 BPM step 4 is at 0.46875 s.
    expect(onAt(sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(row([4]), 128), 200))).toEqual([Math.ceil(0.46875 * CURVE_RATE)])
    // A row that's off fires nothing.
    expect(onAt(sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(row([0, 4], { enabled: false })), 200))).toEqual([])
  })

  it('gives the frame at or after each step the full hit, then the release', () => {
    const m = { id: 'm', name: 'Kick', source: { kind: 'pattern' as const, rowId: 'r' }, gain: 0, threshold: 0, knee: 0, attack: 0, release: 150, curve: 'linear' as const, points: [0, 0.25, 0.5, 0.75, 1], phase: 0, keyframes: {} }
    // Step 3 at 120 BPM is 0.375 s, between frames 9 (0.36 s) and 10 (0.4 s).
    const curve = modulatorCurve(m, inputs(row([3])), 400)
    const frame = (f: number) => curve[f * 8]!
    expect(frame(9)).toBe(0)
    expect(frame(10)).toBe(1)
    expect(frame(11)).toBeLessThan(1)
    expect(frame(11)).toBeGreaterThan(0.6)
  })

  it('saves and reopens the rack, and opens older projects with an empty one', () => {
    const { history, run, rows } = setup()
    run(addRackRows(STARTER_ROWS, ids))
    run(setRackSteps(rows()[0]!.id, [0, 4, -4], true))
    run(setRackRow(rows()[1]!.id, { swing: 33, enabled: false }))
    const reopened = parseProject(serializeProject(history.state))
    expect(reopened.sequence.rack).toEqual(history.state.sequence.rack)
    expect(reopened.sequence.modulators.map((m) => m.source)).toEqual(history.state.sequence.modulators.map((m) => m.source))
    const old = JSON.parse(serializeProject(history.state))
    old.schemaVersion = 11
    delete old.sequence.rack
    old.sequence.modulators = []
    expect(parseProject(JSON.stringify(old)).sequence.rack).toEqual({ rows: [] })
  })
})
