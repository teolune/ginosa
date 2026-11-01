import { useEffect, useRef, useState } from 'react'
import { BANDS } from '@engine/audio/analysis'
import { settingAt } from '@engine/modulation/curve'
import { MODULATOR_PARAMS, NOTE_VALUES, type AudioSignal, type LfoShape, type ModSource, type Modulator, type ModulatorParam, type ResponseCurve, type TempoSignal } from '@engine/modulation/types'
import { findEffect, propertySpec } from '@engine/keyframes/properties'
import type { Sequence } from '@engine/project/model'
import { secondsToTicks, type Ticks } from '@engine/time'
import { AUDIO_SIGNAL_LABELS, addLink, addModulator, describeSource, linksTo, removeLinks, removeModulator, setModulatorAnimated, setModulatorValue, updateLink, updateModulator } from '@engine/timeline/modulation-edits'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { confirmKeyframeRemoval } from '../app/warnings'
import { modulationController } from '../audio/modulation-controller'
import { isMaskRef, modulationUi } from '../audio/modulation-ui'
import { addMaskLink, maskLinksTo, removeMaskLinks, updateMaskLink, type MaskValueRef } from '@engine/timeline/mask-edits'
import { MASK_KIND_LABELS, MASK_PARAMS } from '@engine/masks/types'
import type { ModLink } from '@engine/modulation/types'
import { maskController } from '../masks/mask-controller'
import { analysisController } from '../audio/analysis-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController as tl } from '../timeline/timeline-controller'
import { effectById } from '../../../effects/registry'
import { ScrubNumber } from './EffectControlsWindow'

/**
 * The Modulation window (M8), like FL Studio's controllers: every modulator, what it
 * listens to, how its signal is shaped (input gain, threshold and knee, attack and
 * release, response curve), its output around the playhead, and every value it drives,
 * each with its own range, mode, invert and amount.
 */

const dispatch = (command: Parameters<typeof projectController.dispatch>[0]) => projectController.dispatch(command)

function sourceName(sequence: Sequence) {
  return (id: string) => sequence.audioSources.find((s) => s.id === id)?.name ?? 'Missing source'
}

/** A keyframeable modulator setting: stopwatch, value at the playhead, previous/add/next. */
function ModParam({ m, param }: { m: Modulator; param: ModulatorParam }) {
  const spec = MODULATOR_PARAMS[param]
  const track = m.keyframes[param] ?? []
  const animated = track.length > 0
  const playhead = tl.playhead
  const value = settingAt(m, param, playhead)
  const prev = [...track].reverse().find((k) => k.time < playhead - 1)
  const next = track.find((k) => k.time > playhead + 1)
  const toggle = async () => {
    if (animated && !(await confirmKeyframeRemoval(track.length, spec.label))) return
    dispatch(setModulatorAnimated(m.id, param, !animated, playhead))
  }
  const percent = param === 'threshold' || param === 'knee' || param === 'phase'
  return (
    <div className="fx-row kf-row">
      <span className="fx-label">
        <button className={`kf-stopwatch ${animated ? 'on' : ''}`} aria-pressed={animated} title={animated ? 'Turn off animation' : 'Animate from the playhead'} onClick={() => void toggle()}>
          ⏱
        </button>
        <span className="kf-name">{spec.label}</span>
      </span>
      <span className="fx-values">
        <ScrubNumber
          label={spec.label}
          value={percent ? value * 100 : value}
          min={percent ? spec.min * 100 : spec.min}
          max={percent ? spec.max * 100 : spec.max}
          step={percent ? 0.5 : param === 'gain' ? 0.1 : 1}
          decimals={percent ? 0 : spec.decimals}
          unit={percent ? '%' : spec.unit ? ` ${spec.unit}` : ''}
          onChange={(v) => dispatch(setModulatorValue(m.id, param, percent ? v / 100 : v, playhead))}
        />
      </span>
      {animated && (
        <span className="kf-nav">
          <button className="kf-nav-button" disabled={!prev} onClick={() => prev && tl.movePlayhead(prev.time)}>
            ◀
          </button>
          <button className="kf-nav-button kf-diamond" title="Add a keyframe at the playhead" onClick={() => dispatch(setModulatorValue(m.id, param, value, playhead))}>
            ◆
          </button>
          <button className="kf-nav-button" disabled={!next} onClick={() => next && tl.movePlayhead(next.time)}>
            ▶
          </button>
        </span>
      )}
    </div>
  )
}

/** What the modulator listens to. */
function SourceEditor({ m, sequence }: { m: Modulator; sequence: Sequence }) {
  const set = (source: ModSource) => dispatch(updateModulator(m.id, { source }))
  const s = m.source
  const kind = (
    <select
      className="input compact"
      value={s.kind}
      onChange={(event) => {
        const k = event.target.value
        if (k === 'audio') set({ kind: 'audio', sourceId: sequence.audioSources[0]?.id ?? '', signal: 'level', band: 'bass' })
        if (k === 'tempo') set({ kind: 'tempo', signal: 'beat-trigger' })
        if (k === 'lfo') set({ kind: 'lfo', shape: 'sine', rate: '1/4', seed: 1 })
        if (k === 'random') set({ kind: 'random', seed: 1, rate: 4 })
      }}
    >
      <option value="audio">Audio</option>
      <option value="tempo">Tempo</option>
      <option value="lfo">LFO (synced to the beat)</option>
      <option value="random">Random</option>
    </select>
  )
  return (
    <>
      <div className="fx-row">
        <span className="fx-label">Source</span>
        <span className="fx-values">{kind}</span>
      </div>
      {s.kind === 'audio' && (
        <>
          <div className="fx-row">
            <span className="fx-label">From</span>
            <span className="fx-values">
              <select className="input compact" value={s.sourceId} onChange={(e) => set({ ...s, sourceId: e.target.value })}>
                {!sequence.audioSources.some((a) => a.id === s.sourceId) && <option value={s.sourceId}>(missing source)</option>}
                {sequence.audioSources.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <select className="input compact" value={s.signal} onChange={(e) => set({ ...s, signal: e.target.value as AudioSignal })}>
                {(Object.keys(AUDIO_SIGNAL_LABELS) as AudioSignal[]).map((k) => (
                  <option key={k} value={k}>
                    {AUDIO_SIGNAL_LABELS[k]}
                  </option>
                ))}
              </select>
            </span>
          </div>
          {s.signal !== 'loudness' && s.signal !== 'peak' && (
            <div className="fx-row">
              <span className="fx-label">Band</span>
              <span className="fx-values">
                <select
                  className="input compact"
                  value={typeof s.band === 'string' ? s.band : 'custom'}
                  onChange={(e) => set({ ...s, band: e.target.value === 'custom' ? { low: 100, high: 200 } : (e.target.value as (typeof BANDS)[number]['id']) })}
                >
                  {BANDS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label} ({b.low}–{b.high >= 1000 ? `${b.high / 1000}k` : b.high} Hz)
                    </option>
                  ))}
                  <option value="custom">Custom range…</option>
                </select>
                {typeof s.band !== 'string' && (
                  <>
                    <ScrubNumber label="Low" value={s.band.low} min={10} max={s.band.high - 1} step={1} decimals={0} unit=" Hz" onChange={(low) => set({ ...s, band: { low, high: (s.band as { high: number }).high } })} />
                    <ScrubNumber label="High" value={s.band.high} min={s.band.low + 1} max={24000} step={5} decimals={0} unit=" Hz" onChange={(high) => set({ ...s, band: { low: (s.band as { low: number }).low, high } })} />
                  </>
                )}
              </span>
            </div>
          )}
        </>
      )}
      {s.kind === 'tempo' && (
        <div className="fx-row">
          <span className="fx-label">Signal</span>
          <span className="fx-values">
            <select className="input compact" value={s.signal} onChange={(e) => set({ kind: 'tempo', signal: e.target.value as TempoSignal })}>
              <option value="beat-trigger">Every beat (a flash)</option>
              <option value="bar-trigger">Every bar (a flash)</option>
              <option value="beat-phase">Beat phase (0→1 each beat)</option>
              <option value="bar-phase">Bar phase (0→1 each bar)</option>
            </select>
            {!sequence.beatGrid && <span className="muted small">No beat grid: 120 BPM from the start</span>}
          </span>
        </div>
      )}
      {s.kind === 'lfo' && (
        <>
          <div className="fx-row">
            <span className="fx-label">Shape</span>
            <span className="fx-values">
              <select className="input compact" value={s.shape} onChange={(e) => set({ ...s, shape: e.target.value as LfoShape })}>
                <option value="sine">Sine</option>
                <option value="triangle">Triangle</option>
                <option value="saw">Saw</option>
                <option value="square">Square</option>
                <option value="random-steps">Random steps</option>
              </select>
              <select className="input compact" value={s.rate} onChange={(e) => set({ ...s, rate: e.target.value as keyof typeof NOTE_VALUES })}>
                {(Object.keys(NOTE_VALUES) as Array<keyof typeof NOTE_VALUES>).map((k) => (
                  <option key={k} value={k}>
                    {NOTE_VALUES[k].label}
                  </option>
                ))}
              </select>
              {s.shape === 'random-steps' && <ScrubNumber label="Seed" value={s.seed} min={0} max={9999} step={1} decimals={0} onChange={(seed) => set({ ...s, seed })} />}
            </span>
          </div>
          <ModParam m={m} param="phase" />
        </>
      )}
      {s.kind === 'random' && (
        <div className="fx-row">
          <span className="fx-label">Noise</span>
          <span className="fx-values">
            <ScrubNumber label="Rate" value={s.rate} min={0.01} max={60} step={0.05} decimals={2} unit=" per s" onChange={(rate) => set({ ...s, rate })} />
            <ScrubNumber label="Seed" value={s.seed} min={0} max={9999} step={1} decimals={0} onChange={(seed) => set({ ...s, seed })} />
          </span>
        </div>
      )}
    </>
  )
}

/** The response curve: a preset, or five points you drag. */
function CurveEditor({ m }: { m: Modulator }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<number | null>(null)
  const size = 96
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ratio = window.devicePixelRatio || 1
    c.width = size * ratio
    c.height = size * ratio
    const ctx = c.getContext('2d')!
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.fillStyle = '#16171a'
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = '#2a2d33'
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1)
    ctx.strokeStyle = '#e8b04a'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let x = 0; x <= size; x++) {
      const v = curveAt(m, x / size)
      const y = size - v * size
      if (x === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    if (m.curve === 'custom') {
      ctx.fillStyle = '#ffffff'
      m.points.forEach((p, i) => {
        ctx.beginPath()
        ctx.arc((i / 4) * size, size - p * size, 3.5, 0, Math.PI * 2)
        ctx.fill()
      })
    }
  })
  const pointAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { i: Math.round(((event.clientX - rect.left) / rect.width) * 4), v: 1 - (event.clientY - rect.top) / rect.height }
  }
  return (
    <div className="fx-row mod-curve-row">
      <span className="fx-label">Curve</span>
      <span className="fx-values">
        <select className="input compact" value={m.curve} onChange={(e) => dispatch(updateModulator(m.id, { curve: e.target.value as ResponseCurve }))}>
          <option value="linear">Linear</option>
          <option value="exponential">Exponential (punchy)</option>
          <option value="logarithmic">Logarithmic (soft)</option>
          <option value="s-curve">S-curve</option>
          <option value="custom">Drawn</option>
        </select>
        <canvas
          ref={canvas}
          className="mod-curve"
          style={{ width: size, height: size, cursor: m.curve === 'custom' ? 'ns-resize' : 'default' }}
          title={m.curve === 'custom' ? 'Drag a point up or down' : 'Choose Drawn to shape it by hand'}
          onPointerDown={(event) => {
            if (m.curve !== 'custom') return
            event.currentTarget.setPointerCapture(event.pointerId)
            drag.current = pointAt(event).i
          }}
          onPointerMove={(event) => {
            if (drag.current === null) return
            const points = [...m.points]
            points[drag.current] = Math.min(1, Math.max(0, pointAt(event).v))
            dispatch(updateModulator(m.id, { points }))
          }}
          onPointerUp={() => (drag.current = null)}
        />
      </span>
    </div>
  )
}

function curveAt(m: Modulator, x: number): number {
  switch (m.curve) {
    case 'exponential':
      return (Math.exp(3 * x) - 1) / (Math.exp(3) - 1)
    case 'logarithmic':
      return Math.log(1 + 19 * x) / Math.log(20)
    case 's-curve':
      return x * x * (3 - 2 * x)
    case 'custom': {
      const at = x * 4
      const i = Math.min(3, Math.floor(at))
      return m.points[i]! + (m.points[i + 1]! - m.points[i]!) * (at - i)
    }
    default:
      return x
  }
}

/** The modulator's input (faint) and output around the playhead. */
function OutputPreview({ m, sequence }: { m: Modulator; sequence: Sequence }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [])
  const height = 84
  useEffect(() => {
    const c = canvas.current
    if (!c || width === 0) return
    const ratio = window.devicePixelRatio || 1
    c.width = width * ratio
    c.height = height * ratio
    const ctx = c.getContext('2d')!
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.fillStyle = '#16171a'
    ctx.fillRect(0, 0, width, height)
    const span = secondsToTicks(6)
    const from = tl.playhead - span / 2
    const timeAt = (x: number): Ticks => from + (x / width) * span
    const grid = sequence.beatGrid
    if (grid) {
      ctx.fillStyle = 'rgba(232,176,74,0.18)'
      const beat = secondsToTicks(60 / grid.bpm)
      for (let n = Math.ceil((from - grid.downbeat) / beat); grid.downbeat + n * beat < from + span; n++) ctx.fillRect(Math.round(((grid.downbeat + n * beat - from) / span) * width), 0, 1, height)
    }
    const plot = (get: (t: Ticks) => number | null, colour: string, fill: boolean) => {
      ctx.beginPath()
      ctx.moveTo(0, height)
      for (let x = 0; x <= width; x++) ctx.lineTo(x, height - 4 - (get(timeAt(x)) ?? 0) * (height - 8))
      if (fill) {
        ctx.lineTo(width, height)
        ctx.closePath()
        ctx.fillStyle = colour
        ctx.fill()
      } else {
        ctx.strokeStyle = colour
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
    plot((t) => modulationController.rawAt(m.id, t), 'rgba(255,255,255,0.12)', true)
    plot((t) => modulationController.valueAt(m.id, t), '#e8b04a', false)
    ctx.fillStyle = '#ff5d5d'
    ctx.fillRect(Math.round(width / 2), 0, 1, height)
    const now = modulationController.valueAt(m.id, tl.playhead)
    ctx.fillStyle = '#c8cad0'
    ctx.font = '10.5px -apple-system, BlinkMacSystemFont, sans-serif'
    ctx.textBaseline = 'top'
    ctx.fillText(now === null ? 'Waiting for analysis…' : `Output ${(now * 100).toFixed(0)}%`, 6, 4)
  })
  return (
    <div ref={box} className="mod-preview" title="Input (grey) and output (gold), 3 s either side of the playhead">
      <canvas ref={canvas} style={{ width, height }} />
    </div>
  )
}

/** One driven value as the Links list shows it: where it is, its link, how to change and show it. */
interface DrivenValue {
  link: ModLink
  name: string
  unit: string
  update(changes: Parameters<typeof updateLink>[2]): void
  remove(): void
  show(): void
}

/** Everything a modulator drives: clip and effect values, then mask settings. */
function drivenValues(sequence: Sequence, modulatorId: string): DrivenValue[] {
  const values: DrivenValue[] = linksTo(sequence, modulatorId).map(({ ref, link, clip }) => {
    const spec = propertySpec(clip, ref.effectId, ref.param)
    const effect = ref.effectId ? findEffect(clip, ref.effectId) : null
    return {
      link,
      name: `${clip.name} › ${effect ? `${effectById(effect.effectId)?.name ?? 'Effect'} › ` : ''}${spec?.label ?? ref.param}`,
      unit: spec?.unit ? ` ${spec.unit}` : '',
      update: (changes) => dispatch(updateLink(ref, link.id, changes)),
      remove: () => dispatch(removeLinks(ref, link.id)),
      show: () => (tl.select([clip.id], 'replace'), workspaceController.focus('effect-controls'))
    }
  })
  for (const { ref, link, mask, shape } of maskLinksTo(sequence, modulatorId)) {
    const spec = MASK_PARAMS[ref.param]
    values.push({
      link,
      name: `${mask.name} › ${MASK_KIND_LABELS[shape.kind]} › ${spec.label}`,
      unit: spec.unit ? ` ${spec.unit}` : '',
      update: (changes) => dispatch(updateMaskLink(ref, link.id, changes)),
      remove: () => dispatch(removeMaskLinks(ref, link.id)),
      show: () => (maskController.select(mask.id, shape.id), maskController.edit(mask.id), maskController.selectShape(shape.id))
    })
  }
  return values
}

/** Every value the modulator drives, each with its own mapping. */
function Links({ m, sequence }: { m: Modulator; sequence: Sequence }) {
  const links = drivenValues(sequence, m.id)
  if (links.length === 0) return <p className="muted small mod-empty">It doesn't drive anything yet. Right-click a value in Effect Controls or the Masks window › Modulate Parameter…, or Link to Audio.</p>
  return (
    <div className="mod-links">
      {links.map(({ link, name, unit, update, remove, show }) => {
        const range = (which: 'min' | 'max') =>
          link[which].map((v, c) => (
            <ScrubNumber
              key={`${which}${c}`}
              label={`${which} ${c}`}
              value={v}
              step={link.mode === 'multiply' ? 0.01 : 0.5}
              decimals={link.mode === 'multiply' ? 2 : 1}
              unit={link.mode === 'multiply' ? '×' : unit}
              onChange={(next) => update({ [which]: link[which].map((x, i) => (i === c ? next : x)) })}
            />
          ))
        return (
          <div key={link.id} className="mod-link">
            <div className="mod-link-head">
              <button className="link-button" title="Show it" onClick={show}>
                {name}
              </button>
              <span className="spacer" />
              <button className="icon-button" title="Stop modulating this value" onClick={remove}>
                ✕
              </button>
            </div>
            <div className="mod-link-body">
              <select className="input compact" value={link.mode} onChange={(e) => update({ mode: e.target.value as 'add' })}>
                <option value="add">Add</option>
                <option value="multiply">Multiply</option>
                <option value="replace">Replace</option>
              </select>
              <span className="muted small">from</span>
              {range('min')}
              <span className="muted small">to</span>
              {range('max')}
              <label className="mod-check">
                <input type="checkbox" checked={link.invert} onChange={(e) => update({ invert: e.target.checked })} /> Invert
              </label>
              <ScrubNumber label="Amount" value={link.amount} min={0} max={100} step={0.5} decimals={0} unit="%" onChange={(amount) => update({ amount })} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function clipTargetLabel(sequence: Sequence, ref: { clipId: string; effectId: string | null; param: string }): string | null {
  const clip = sequence.clips.find((c) => c.id === ref.clipId)
  return clip ? `${clip.name} › ${propertySpec(clip, ref.effectId, ref.param)?.label ?? ref.param}` : null
}

function maskTargetLabel(sequence: Sequence, ref: MaskValueRef): string | null {
  const mask = sequence.masks.find((m) => m.id === ref.maskId)
  const shape = mask?.shapes.find((s) => s.id === ref.shapeId)
  return mask && shape ? `${mask.name} › ${MASK_KIND_LABELS[shape.kind]} › ${MASK_PARAMS[ref.param].label}` : null
}

export function ModulationWindow() {
  useObservable(projectController)
  useObservable(tl)
  useObservable(modulationController)
  useObservable(modulationUi)
  useObservable(analysisController)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const project = projectController.project
  if (!project) return null
  const sequence = project.sequence
  const mods = sequence.modulators
  const current = mods.find((m) => m.id === modulationUi.selected) ?? mods[0] ?? null
  const names = sourceName(sequence)
  const make = (source: ModSource, name: string) => {
    const command = addModulator(source, name)
    if (dispatch(command)) modulationUi.select(command.modulatorId)
  }
  const target = modulationUi.target
  const targetLabel = !target ? null : isMaskRef(target) ? maskTargetLabel(sequence, target) : clipTargetLabel(sequence, target)
  const newItems: MenuEntry[] = [
    ...sequence.audioSources.map((a): MenuEntry => ({ label: `${a.name} · Bass level`, onSelect: () => make({ kind: 'audio', sourceId: a.id, signal: 'level', band: 'bass' }, `${a.name} · Bass`) })),
    ...(sequence.audioSources.length === 0 ? [{ label: 'Audio (add a source in Audio Analysis first)', disabled: true, onSelect: () => undefined }] : []),
    'separator',
    { label: 'Every Beat', onSelect: () => make({ kind: 'tempo', signal: 'beat-trigger' }, 'Every beat') },
    { label: 'Every Bar', onSelect: () => make({ kind: 'tempo', signal: 'bar-trigger' }, 'Every bar') },
    { label: 'Beat Phase', onSelect: () => make({ kind: 'tempo', signal: 'beat-phase' }, 'Beat phase') },
    'separator',
    { label: 'LFO', onSelect: () => make({ kind: 'lfo', shape: 'sine', rate: '1/4', seed: 1 }, 'LFO') },
    { label: 'Random', onSelect: () => make({ kind: 'random', seed: Math.floor(Math.random() * 9999), rate: 4 }, 'Random') }
  ]
  return (
    <div className="modulation-window">
      <div className="mod-list">
        <div className="aa-sources-head">
          <span className="fx-title">Modulators</span>
          <span className="spacer" />
          <button className="button compact" onClick={(event) => setMenu({ x: event.clientX, y: event.clientY })}>
            + New
          </button>
        </div>
        {mods.length === 0 && <p className="muted small aa-hint">A modulator turns a signal (your song's bass, the beat, an LFO) into movement. Right-click any value › Link to Audio is the quickest start.</p>}
        {mods.map((m) => {
          const v = modulationController.valueAt(m.id, tl.playhead)
          const count = linksTo(sequence, m.id).length + maskLinksTo(sequence, m.id).length
          return (
            <div key={m.id} className={`aa-source ${current?.id === m.id ? 'selected' : ''}`} onClick={() => modulationUi.select(m.id)}>
              <div className="aa-source-name">{m.name}</div>
              {describeSource(m.source, names) !== m.name && <div className="muted small">{describeSource(m.source, names)}</div>}
              <div className="mod-meter">
                <div style={{ width: `${Math.round((v ?? 0) * 100)}%` }} />
              </div>
              <div className="muted small">{count === 0 ? 'Drives nothing yet' : `Drives ${count} value${count === 1 ? '' : 's'}`}</div>
            </div>
          )
        })}
      </div>
      <div className="mod-editor">
        {target && (
          <div className="mod-target">
            <span>
              Choose what drives <strong>{targetLabel ?? 'that value'}</strong>: pick a modulator and press Link, or make a new one.
            </span>
            <span className="spacer" />
            <button
              className="button compact primary"
              disabled={!current}
              onClick={() => current && dispatch(isMaskRef(target) ? addMaskLink(target, current.id, tl.playhead) : addLink(target, current.id, tl.playhead)) && modulationUi.modulate(null)}
            >
              Link
            </button>
            <button className="button compact" onClick={() => modulationUi.modulate(null)}>
              Cancel
            </button>
          </div>
        )}
        {!current ? (
          <div className="empty-state">
            <p className="muted">No modulators yet.</p>
          </div>
        ) : (
          <div className="mod-editor-body">
            <div className="fx-row">
              <span className="fx-label">Name</span>
              <span className="fx-values">
                <input key={current.id} className="input compact" defaultValue={current.name} onBlur={(e) => e.target.value.trim() && e.target.value !== current.name && dispatch(updateModulator(current.id, { name: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
                <span className="spacer" />
                <button className="button compact" title="Remove it, and its links" onClick={() => dispatch(removeModulator(current.id))}>
                  Remove
                </button>
              </span>
            </div>
            <SourceEditor m={current} sequence={sequence} />
            <ModParam m={current} param="gain" />
            <ModParam m={current} param="threshold" />
            <ModParam m={current} param="knee" />
            <ModParam m={current} param="attack" />
            <ModParam m={current} param="release" />
            <CurveEditor m={current} />
            <OutputPreview m={current} sequence={sequence} />
            <div className="fx-stack-head">
              <span className="fx-title">Drives</span>
            </div>
            <Links m={current} sequence={sequence} />
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={newItems} onClose={() => setMenu(null)} />}
    </div>
  )
}

