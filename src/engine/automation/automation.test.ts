import { describe, expect, it } from 'vitest'
import { History } from '../history'
import { applyLinks } from '../modulation/apply'
import { CURVE_RATE, modulatorCurve, sourceSignal } from '../modulation/curve'
import { importMedia } from '../project/media-commands'
import type { MediaInfo, MediaItem } from '../project/media'
import { createProject, type AutomationPoint } from '../project/model'
import { parseProject, serializeProject } from '../project/serialize'
import { secondsToTicks } from '../time'
import { linkToAutomation, newAutomationClip, setAutomationPoints } from '../timeline/automation-edits'
import { deleteClips, placeMedia, splitClips, type TimelineCommand } from '../timeline/edits'
import { removeModulator } from '../timeline/modulation-edits'
import { automationValue, bend, shapeAt, stretchCount } from './curve'

const s = secondsToTicks
let counter = 0
const ids = () => `au-${++counter}`

function setup() {
  const history = new History(createProject({ name: 'Automation', createId: ids }))
  const run = <T extends TimelineCommand>(command: T): T => {
    if (!history.dispatch(command)) throw new Error(`${command.label} changed nothing`)
    return command
  }
  const info: MediaInfo = { container: 'mov', durationSeconds: 20, bitRate: null, video: { codec: 'h264', profile: null, width: 1920, height: 1080, rotation: 0, frameRate: { num: 25, den: 1 }, frameCount: 500, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: 'tv' }, hdr: null, variableFrameRate: false, keyframeInterval: 1 }, audio: null }
  const item: MediaItem = { id: 'm-v', name: 'shot', kind: 'video', path: '/f/shot', fingerprint: { size: 1, mtimeMs: 1, sample: 'v' }, info, binId: null, importedAt: '2026-11-19T00:00:00Z', marks: { in: null, out: null }, colour: { input: 'auto', lut: null } }
  history.dispatch(importMedia([item]))
  const V1 = history.state.sequence.tracks.find((t) => t.kind === 'video')!.id
  run(placeMedia({ mediaId: 'm-v', sourceIn: 0, sourceOut: s(20), at: 0, videoTrackId: V1, audioTrackId: null, mode: 'overwrite' }, ids))
  const video = () => history.state.sequence.clips.find((c) => c.kind === 'video')!
  const automations = () => history.state.sequence.clips.filter((c) => c.kind === 'automation')
  return { history, run, video, automations }
}

const pt = (time: number, value: number, shape: AutomationPoint['shape'] = 'single', tension = 0): AutomationPoint => ({ time: s(time), value, shape, tension })

describe('automation curves (W2)', () => {
  it('join points with FL’s shapes', () => {
    expect(bend(0.25, 0)).toBe(0.25)
    expect(bend(0.25, 1)).toBeGreaterThan(0.25)
    expect(bend(0.25, -1)).toBeLessThan(0.25)
    expect(shapeAt('double', 0.5, 0.7)).toBeCloseTo(0.5, 9)
    expect(shapeAt('double', 0.25, 0.7) + shapeAt('double', 0.75, 0.7)).toBeCloseTo(1, 9)
    expect([0, 0.5, 0.999, 1].map((p) => shapeAt('hold', p, 0))).toEqual([0, 0, 0, 1])
    expect(stretchCount(-1)).toBe(1)
    expect(stretchCount(0)).toBe(4)
    expect(stretchCount(1)).toBe(16)
    expect([0, 0.2, 0.3, 0.55, 0.8, 1].map((p) => shapeAt('stairs', p, 0))).toEqual([0, 0, 0.25, 0.5, 0.75, 1])
    expect(shapeAt('smooth-stairs', 0.25, 0)).toBeCloseTo(0.25, 9)
    expect([0.05, 0.2, 0.3].map((p) => shapeAt('pulse', p, 0))).toEqual([0, 1, 0])
    expect(shapeAt('wave', 0, 0)).toBeCloseTo(0, 9)
    expect(shapeAt('wave', 1, 0)).toBeCloseTo(1, 9)
  })

  it('hold the first value before the first point and the last after the last', () => {
    const points = [pt(1, 0.2), pt(3, 0.8, 'hold')]
    expect(automationValue(points, 0)).toBe(0.2)
    expect(automationValue(points, s(2))).toBeCloseTo(0.5, 9)
    expect(automationValue(points, s(5))).toBe(0.8)
  })
})

describe('automation clips (W2)', () => {
  it('Create Automation Clip from a value: its own track and modulator, linked to set the value across its range from where it is', () => {
    const { history, run, video, automations } = setup()
    const made = run(newAutomationClip({ at: s(2), duration: s(4), target: { clipId: video().id, effectId: null, param: 'opacity' } }, ids))
    const sequence = history.state.sequence
    expect(sequence.tracks.filter((t) => t.kind === 'automation').map((t) => t.name)).toEqual(['Auto 1'])
    const clip = automations()[0]!
    expect(clip.id).toBe(made.clipId)
    expect(clip.automation).toEqual({ modulatorId: made.modulatorId, points: [{ time: 0, value: 1, shape: 'single', tension: 0 }] })
    expect(sequence.modulators.find((m) => m.id === made.modulatorId)!.source).toEqual({ kind: 'automation' })
    expect(video().modulation['opacity']).toEqual([expect.objectContaining({ modulatorId: made.modulatorId, mode: 'replace', min: [0], max: [100], amount: 100 })])
    // A second clip over the same time goes on a second automation track.
    run(newAutomationClip({ at: s(3) }, ids))
    expect(history.state.sequence.tracks.filter((t) => t.kind === 'automation')).toHaveLength(2)
    expect(automations()[1]!.automation!.points[0]!.value).toBe(0.5)
  })

  it('set the value while they play, hold the last point after, and leave it alone before', () => {
    const { history, run, video } = setup()
    const made = run(newAutomationClip({ at: s(2), duration: s(4), target: { clipId: video().id, effectId: null, param: 'opacity' } }, ids))
    run(setAutomationPoints(made.clipId, [pt(0, 0), pt(4, 1)]))
    const m = history.state.sequence.modulators.find((x) => x.id === made.modulatorId)!
    const clips = history.state.sequence.clips.filter((c) => c.automation?.modulatorId === m.id).map((c) => ({ start: c.start, duration: c.duration, sourceIn: c.sourceIn, points: c.automation!.points }))
    const frames = 10 * CURVE_RATE
    const curve = modulatorCurve(m, { analysis: null, analysisStart: 0, customBand: null, grid: null, automation: { clips } }, frames)
    expect(curve).toEqual(sourceSignal(m.source, { analysis: null, analysisStart: 0, customBand: null, grid: null, automation: { clips } }, frames))
    expect(Number.isNaN(curve[1 * CURVE_RATE]!)).toBe(true)
    expect(curve[4 * CURVE_RATE]).toBeCloseTo(0.5, 2)
    expect(curve[9 * CURVE_RATE]).toBe(1)
    // Through the link: opacity follows the clip, and is its own (100) before it.
    const link = video().modulation['opacity']!
    const ctx = { value: (_id: string, t: number) => curve[Math.round((t / s(1)) * CURVE_RATE)]! }
    expect(applyLinks([100], link, ctx, s(1))).toEqual([100])
    expect(applyLinks([100], link, ctx, s(4))[0]).toBeCloseTo(50, 0)
    expect(applyLinks([100], link, ctx, s(9))[0]).toBe(100)
  })

  it('split into halves that share the modulator and continue the curve; the last one deleted takes its links with it', () => {
    const { history, run, video, automations } = setup()
    const made = run(newAutomationClip({ at: s(2), duration: s(4), target: { clipId: video().id, effectId: null, param: 'opacity' } }, ids))
    run(setAutomationPoints(made.clipId, [pt(0, 0), pt(4, 1)]))
    run(splitClips([made.clipId], s(4), ids))
    const [left, right] = [...automations()].sort((a, b) => a.start - b.start)
    expect(right!.automation!.modulatorId).toBe(made.modulatorId)
    expect(right!.sourceIn).toBe(s(2))
    expect(automationValue(right!.automation!.points, right!.sourceIn)).toBeCloseTo(automationValue(left!.automation!.points, left!.duration), 9)
    // removeModulator refuses while clips carry it.
    expect(() => history.dispatch(removeModulator(made.modulatorId))).toThrow(/automation clip/)
    run(deleteClips([left!.id]))
    expect(history.state.sequence.modulators.some((m) => m.id === made.modulatorId)).toBe(true)
    run(deleteClips([right!.id]))
    expect(history.state.sequence.modulators.some((m) => m.id === made.modulatorId)).toBe(false)
    expect(video().modulation['opacity']).toBeUndefined()
    history.undo()
    expect(video().modulation['opacity']).toHaveLength(1)
  })

  it('link more values by dragging the clip onto them, and save and open with the project', () => {
    const { history, run, video } = setup()
    const made = run(newAutomationClip({ at: 0, duration: s(4) }, ids))
    run(linkToAutomation({ clipId: video().id, effectId: null, param: 'rotation' }, made.clipId, ids))
    expect(video().modulation['rotation']).toEqual([expect.objectContaining({ modulatorId: made.modulatorId, mode: 'replace' })])
    // Scale's range is 0–10,000%: the clip sweeps it from 0 to twice where it is.
    run(linkToAutomation({ clipId: video().id, effectId: null, param: 'scale' }, made.clipId, ids))
    expect(video().modulation['scale']).toEqual([expect.objectContaining({ min: [0], max: [200] })])
    run(setAutomationPoints(made.clipId, [pt(0, 0.25, 'stairs', 0.5), pt(2, 0.75, 'wave', -0.5), pt(4, 0.5)]))
    const reopened = parseProject(serializeProject(history.state))
    const clip = reopened.sequence.clips.find((c) => c.kind === 'automation')!
    expect(clip.automation).toEqual(history.state.sequence.clips.find((c) => c.kind === 'automation')!.automation)
    expect(reopened.sequence.tracks.some((t) => t.kind === 'automation')).toBe(true)
    // An automation clip whose modulator is missing is a damaged project.
    const broken = JSON.parse(serializeProject(history.state))
    broken.sequence.modulators = broken.sequence.modulators.filter((m: { id: string }) => m.id !== made.modulatorId)
    expect(() => parseProject(JSON.stringify(broken))).toThrow(/no automation modulator/)
  })
})
