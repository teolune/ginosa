import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { CURVE_RATE, modulatorCurve, patternLinkCurve, sourceSignal, type CurveInputs } from '../modulation/curve'
import { createProject, type Rack, type RackCube, type RackRow } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { addLink } from './modulation-edits'
import { channelHits, placeSections, sectionName, sectionsFromHits } from './rack'
import {
  addRackRows,
  addRackSection,
  pasteCubeAmounts,
  pasteRackCubes,
  removeRackCubes,
  removeRackRow,
  removeRackSection,
  renameRackRow,
  replaceRackSections,
  setCubeAmount,
  setRackCubes,
  setRackRow,
  setRackSectionBars,
  STARTER_ROWS,
  stepsFromHits
} from './rack-edits'
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
  return { history, run, rows: () => history.state.sequence.rack.rows, sections: () => history.state.sequence.rack.sections }
}

const GRID = { bpm: 120, downbeat: 0, beatsPerBar: 4, sourceId: null }
const row = (extra: Partial<RackRow> = {}): RackRow => ({ id: 'r', name: 'Kick', enabled: true, swing: 0, band: 'bass', modulatorId: null, strength: 100, nudge: 0, detect: 'kick', ...extra })
/** A rack with one channel 'r' and these sections (bars, cube steps, optional amounts by step). */
const rackOf = (sections: Array<[number, number[], Record<number, Record<string, number>>?]>, r: RackRow = row()): Rack => ({
  rows: [r],
  sections: sections.map(([bars, steps, amounts], i) => ({ id: `s${i}`, bars, cubes: (steps.length ? { r: steps.map((step) => ({ step, amounts: amounts?.[step] ?? {} })) } : {}) as Record<string, RackCube[]> }))
})
const inputs = (rack: Rack, bpm = 120): CurveInputs => ({ analysis: null, analysisStart: 0, customBand: null, grid: { ...GRID, bpm }, pattern: { row: rack.rows[0]!, rack, frameSeconds: 1 / 25 } })
const onAt = (signal: Float32Array) => signal.reduce<number[]>((out, v, i) => (v > 0 && !(signal[i - 1]! > 0) ? [...out, i] : out), [])
const KICK = { id: 'm', name: 'Kick', source: { kind: 'pattern' as const, rowId: 'r' }, gain: 0, threshold: 0, knee: 0, attack: 0, release: 150, curve: 'linear' as const, points: [0, 0.25, 0.5, 0.75, 1], phase: 0, keyframes: {} }

describe('Channel Rack channels', () => {
  it('come with their own modulators and a first section of 8 bars', () => {
    const { history, run, rows, sections } = setup()
    run(addRackRows(STARTER_ROWS, ids))
    expect(rows().map((r) => [r.name, r.detect, r.strength, r.nudge])).toEqual([
      ['Kick', 'kick', 100, 0],
      ['Clap', 'clap', 100, 0],
      ['Hi-hat', 'hihat', 100, 0],
      ['Bass', 'bass', 100, 0]
    ])
    const mods = history.state.sequence.modulators
    expect(mods.map((m) => m.source)).toEqual(rows().map((r) => ({ kind: 'pattern', rowId: r.id })))
    expect([mods[0]!.attack, mods[0]!.release]).toEqual([0, 150])
    expect(sections().map((s) => s.bars)).toEqual([8])
    run(renameRackRow(rows()[0]!.id, 'Big Kick'))
    expect(history.state.sequence.modulators[0]!.name).toBe('Big Kick')
    run(setRackRow(rows()[0]!.id, { strength: 180 }))
    run(setRackRow(rows()[0]!.id, { nudge: -70 }))
    run(setRackRow(rows()[0]!.id, { enabled: false, swing: 120 }))
    expect(rows()[0]).toMatchObject({ strength: 150, nudge: -50, enabled: false, swing: 75 })
  })

  it('makes and deletes cubes; a paint stroke is one undo step', () => {
    const { history, run, rows, sections } = setup()
    run(addRackRows([STARTER_ROWS[0]!], ids))
    const id = rows()[0]!.id
    const sec = sections()[0]!.id
    run(setRackCubes(sec, id, [0], true, 'a'))
    run(setRackCubes(sec, id, [4], true, 'a'))
    run(setRackCubes(sec, id, [12, 8, 4], true, 'a'))
    expect(sections()[0]!.cubes[id]!.map((c) => c.step)).toEqual([0, 4, 8, 12])
    history.undo()
    expect(sections()[0]!.cubes[id]).toBeUndefined()
    history.redo()
    run(removeRackCubes([{ sectionId: sec, rowId: id, step: 4 }, { sectionId: sec, rowId: id, step: 12 }]))
    expect(sections()[0]!.cubes[id]!.map((c) => c.step)).toEqual([0, 8])
    expect(() => history.dispatch(setRackCubes(sec, id, [32], true))).toThrow(/16ths/)
  })

  it('sets how far each cube pushes a linked value, and copies cubes and amounts', () => {
    const { run, rows, sections } = setup()
    run(addRackRows([STARTER_ROWS[0]!], ids))
    const id = rows()[0]!.id
    const sec = sections()[0]!.id
    run(setRackCubes(sec, id, [0, 4], true))
    const a = { sectionId: sec, rowId: id, step: 0 }
    const b = { sectionId: sec, rowId: id, step: 4 }
    run(setCubeAmount([a], 'link-1', -140))
    run(setCubeAmount([a], 'link-2', 35))
    expect(sections()[0]!.cubes[id]![0]!.amounts).toEqual({ 'link-1': -100, 'link-2': 35 })
    run(setCubeAmount([a], 'link-2', 100))
    expect(sections()[0]!.cubes[id]![0]!.amounts).toEqual({ 'link-1': -100 })
    run(pasteCubeAmounts([b], { 'link-1': -100 }))
    expect(sections()[0]!.cubes[id]![1]!.amounts).toEqual({ 'link-1': -100 })
    const next = run(addRackSection(sec, 8, ids))
    run(pasteRackCubes(next.sectionId, [{ rowId: id, step: 2, amounts: { 'link-1': 50 } }]))
    expect(sections()[1]!.cubes[id]).toEqual([{ step: 2, amounts: { 'link-1': 50 } }])
  })

  it('removes a channel with its cubes, its modulator and the values it moved', () => {
    const { history, run, rows } = setup()
    const info: MediaInfo = { container: 'mov', durationSeconds: 10, bitRate: null, video: { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: 250, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 }, audio: null }
    const item: MediaItem = { id: 'm-a', name: 'a', kind: 'video', path: '/f/a', fingerprint: { size: 1, mtimeMs: 1, sample: 'a' }, info, binId: null, importedAt: '2026-11-04T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
    history.dispatch(importMedia([item]))
    const V1 = history.state.sequence.tracks.find((t) => t.kind === 'video')!.id
    run(placeMedia({ mediaId: 'm-a', sourceIn: 0, sourceOut: secondsToTicks(4), at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
    run(addRackRows([STARTER_ROWS[0]!], ids))
    run(setRackCubes(history.state.sequence.rack.sections[0]!.id, rows()[0]!.id, [0], true))
    const clip = history.state.sequence.clips[0]!
    run(addLink({ clipId: clip.id, effectId: null, param: 'opacity' }, rows()[0]!.modulatorId!, 0, {}, ids))
    expect(history.state.sequence.clips[0]!.modulation['opacity']).toHaveLength(1)
    const removed = run(removeRackRow(rows()[0]!.id))
    expect(removed.notice).toMatch(/1 value/)
    expect(rows()).toHaveLength(0)
    expect(history.state.sequence.rack.sections[0]!.cubes).toEqual({})
    expect(history.state.sequence.modulators).toHaveLength(0)
    expect(history.state.sequence.clips[0]!.modulation['opacity']).toBeUndefined()
  })
})

describe('Channel Rack sections', () => {
  it('run on from bar 1, each with its own length; + adds an empty one after the one shown', () => {
    const { history, run, sections } = setup()
    run(addRackRows([STARTER_ROWS[0]!], ids))
    const a = sections()[0]!.id
    const c = run(addRackSection(null, 4, ids))
    const b = run(addRackSection(a, 8, ids))
    expect(sections().map((s) => s.id)).toEqual([a, b.sectionId, c.sectionId])
    run(setRackSectionBars(a, 2))
    expect(() => history.dispatch(setRackSectionBars(a, 17))).toThrow(/1 to 16 bars/)
    expect(() => history.dispatch(setRackSectionBars(a, 1.5))).toThrow(/1 to 16 bars/)
    const placed = placeSections(history.state.sequence.rack, GRID)
    expect(placed.map((p) => [p.startBar, p.firstStep, p.steps, p.loop])).toEqual([
      [0, 0, 32, 32],
      [2, 32, 128, 32],
      [10, 160, 64, 32]
    ])
    run(removeRackSection(b.sectionId))
    expect(sections()).toHaveLength(2)
    expect([0, 25, 26, 27, 701].map(sectionName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ'])
  })

  it('repeat each loop to the section end; a 1-bar section uses the first bar; bar 1 follows the grid', () => {
    const rack = rackOf([[8, [0, 20]], [1, [4, 20]], [3, [0]]])
    expect(channelHits(rack, 'r', GRID).map((h) => h.step)).toEqual([0, 20, 32, 52, 64, 84, 96, 116, 132, 144, 176])
    // Downbeat 1.25 s at 120 BPM: beat −2.5 is the start, so bar 1 is the first downbeat at or after it (beat 0, step 0 from the downbeat).
    expect(channelHits(rackOf([[1, [0]]]), 'r', { ...GRID, downbeat: secondsToTicks(1.25) }).map((h) => h.step)).toEqual([0])
    // Downbeat 3 s: the start is beat −6, so bar 1 starts a bar before the downbeat.
    expect(channelHits(rackOf([[1, [0]]]), 'r', { ...GRID, downbeat: secondsToTicks(3) }).map((h) => h.step)).toEqual([-16])
  })

  it('split a song into sections where the pattern changes, ignoring a stray hit', () => {
    const fourOnFloor = (bars: number, from = 0) => Array.from({ length: bars * 4 }, (_, i) => from + i * 4)
    const kick = [...fourOnFloor(8), ...fourOnFloor(4, 128).filter((s) => s % 8 === 0)]
    const stray = [...kick, 37]
    const sections = sectionsFromHits({ kick: stray, clap: [] }, GRID, 192)
    expect(sections.map((s) => s.bars)).toEqual([8, 4])
    expect(sections[0]!.cubes['kick']).toEqual([0, 4, 8, 12, 16, 20, 24, 28])
    expect(sections[1]!.cubes['kick']).toEqual([0, 8, 16, 24])
    expect(sectionsFromHits({ kick: fourOnFloor(40) }, GRID, 640).map((s) => s.bars)).toEqual([16, 16, 8])
    // A song that ends two-thirds into its 11th bar: the last, short chunk joins the section, and its loop stays whole.
    const shortEnd = sectionsFromHits({ kick: fourOnFloor(10).concat([160, 164, 168]) }, GRID, 170)
    expect(shortEnd.map((s) => s.bars)).toEqual([11])
    expect(shortEnd[0]!.cubes['kick']).toEqual([0, 4, 8, 12, 16, 20, 24, 28])
  })
})

describe('Channel Rack as a modulation source', () => {
  it('fires a one-frame pulse on each hit, on the grid, swung on the odd 16ths and nudged', () => {
    // 120 BPM: 16ths 0, 4, 8, 12 are beats 0–3, every 0.5 s = 100 samples.
    const straight = sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(rackOf([[8, [0, 4, 8, 12]]])), 400)
    expect(onAt(straight)).toEqual([0, 100, 200, 300])
    expect(Array.from(straight.slice(100, 110))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0])
    // Swing 50%: 16th 1 (0.125 s) half a 16th later: 0.1875 s = sample 37.5 → 38.
    expect(onAt(sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(rackOf([[8, [1, 2]]], row({ swing: 50 }))), 100))).toEqual([38, 50])
    // Nudge −20%: 16th 2 (0.25 s) a fifth of a 16th earlier: 0.225 s = sample 45.
    expect(onAt(sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(rackOf([[8, [2]]], row({ nudge: -20 }))), 100))).toEqual([45])
    // A tempo change moves the hits: at 128 BPM 16th 4 is at 0.46875 s.
    expect(onAt(sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(rackOf([[8, [4]]]), 128), 200))).toEqual([Math.ceil(0.46875 * CURVE_RATE)])
    // A channel that's off fires nothing.
    expect(onAt(sourceSignal({ kind: 'pattern', rowId: 'r' }, inputs(rackOf([[8, [0, 4]]], row({ enabled: false }))), 200))).toEqual([])
  })

  it('gives the frame at or after each hit the full hit, then the fall, times the strength', () => {
    // 16th 3 at 120 BPM is 0.375 s, between frames 9 (0.36 s) and 10 (0.4 s).
    const curve = modulatorCurve(KICK, inputs(rackOf([[8, [3]]])), 400)
    const frame = (c: Float32Array, f: number) => c[f * 8]!
    expect(frame(curve, 9)).toBe(0)
    expect(frame(curve, 10)).toBe(1)
    expect(frame(curve, 11)).toBeLessThan(1)
    expect(frame(curve, 11)).toBeGreaterThan(0.6)
    const strong = modulatorCurve(KICK, inputs(rackOf([[8, [3]]], row({ strength: 150 }))), 400)
    expect(frame(strong, 10)).toBeCloseTo(1.5, 6)
  })

  it('pushes each linked value by its cube’s amount, up or down (decision 109)', () => {
    const rack = rackOf([[8, [0, 4, 8], { 4: { up: 50, down: -100 }, 8: { up: 0 } }]], row({ strength: 120 }))
    const up = patternLinkCurve(KICK, inputs(rack), 400, 'up')
    const down = patternLinkCurve(KICK, inputs(rack), 400, 'down')
    // 16ths 0, 4, 8 are samples 0, 100, 200. 'up': 100%, 50%, 0% (× 1.2), so only the 50% hit's tail is left at 200; 'down': 100%, −100%, 100%.
    expect([up[0], up[100]].map((v) => Math.round(v! * 1000) / 1000)).toEqual([1.2, 0.6])
    expect(up[200]!).toBeLessThan(0.05)
    // Each hit reaches its own amount, up or down, whatever came before it.
    expect([down[0], down[100], down[200]].map((v) => Math.round(v! * 1000) / 1000)).toEqual([1.2, -1.2, 1.2])
    // Each push falls back to zero with the channel's release.
    expect(down[130]!).toBeGreaterThan(-1.2)
    expect(down[130]!).toBeLessThan(0)
  })

  it('saves and reopens the rack; format 12 rows become exact sections; older projects get an empty rack', () => {
    const { history, run, rows, sections } = setup()
    run(addRackRows(STARTER_ROWS, ids))
    run(setRackCubes(sections()[0]!.id, rows()[0]!.id, [0, 4], true))
    run(setCubeAmount([{ sectionId: sections()[0]!.id, rowId: rows()[0]!.id, step: 4 }], 'some-link', -25))
    run(setRackRow(rows()[1]!.id, { swing: 33, enabled: false }))
    run(setRackRow(rows()[2]!.id, { strength: 140 }))
    const reopened = parseProject(serializeProject(history.state))
    expect(reopened.sequence.rack).toEqual(history.state.sequence.rack)
    // Format 12: steps along the song. Two-bar chunks, joined while they repeat: bars 1–4 the same, bars 5–6 different.
    const old = JSON.parse(serializeProject(history.state))
    old.schemaVersion = 12
    old.sequence.rack = { rows: old.sequence.rack.rows.map((r: Record<string, unknown>, i: number) => ({ id: r['id'], name: r['name'], enabled: true, swing: 0, band: 'bass', modulatorId: r['modulatorId'], steps: i === 0 ? [-4, 0, 16, 32, 48, 64, 70] : [] })) }
    const migrated = parseProject(JSON.stringify(old)).sequence.rack
    expect(migrated.rows[0]).toMatchObject({ strength: 100, nudge: 0, detect: null })
    expect(migrated.sections.map((s) => [s.bars, s.cubes[rows()[0]!.id]?.map((c) => c.step)])).toEqual([
      [4, [0, 16]],
      [2, [0, 6]]
    ])
    const older = JSON.parse(serializeProject(history.state))
    older.schemaVersion = 11
    delete older.sequence.rack
    older.sequence.modulators = []
    expect(parseProject(JSON.stringify(older)).sequence.rack).toEqual({ rows: [], sections: [] })
  })

  it('snaps hits to the nearest 16th and replaces the sections with detection’s', () => {
    // 120 BPM: a 16th is 0.125 s.
    const beatAt = (t: number) => t / secondsToTicks(0.5)
    expect(stepsFromHits([secondsToTicks(0.004), secondsToTicks(0.24), secondsToTicks(0.31), secondsToTicks(9)], beatAt, 0, 64)).toEqual([0, 2])
    const { run, rows, sections } = setup()
    run(addRackRows([STARTER_ROWS[0]!], ids))
    run(replaceRackSections([{ bars: 4, cubes: { [rows()[0]!.id]: [8, 0, 0, 40] } }, { bars: 2, cubes: { gone: [1] } }], 'Detect Pattern', ids))
    expect(sections().map((s) => [s.bars, s.cubes])).toEqual([
      [4, { [rows()[0]!.id]: [{ step: 0, amounts: {} }, { step: 8, amounts: {} }] }],
      [2, {}]
    ])
  })
})
