import { memo, useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { BLEND_MENU, BLEND_MODES, type BlendMode, type Clip, type Motion } from '@engine/project/model'
import type { CurveParam, EffectInstance, EffectManifest, GradientParam, ParamSpec, ParamValue } from '@engine/effects/types'
import { BLACK_WHITE, GRADIENT_METHODS, parseGradient, type GradientMethod } from '@engine/gradients/gradient'
import { gradientController } from '../gradients/gradient-controller'
import { GradientPopover, gradientCss } from '../gradients/GradientViews'
import { IDENTITY_CURVE, parseCurve } from '@engine/effects/curves'
import { CHANNEL_COLOURS, CurveEditor } from './CurveEditor'
import { StepsKnob } from './StepsKnob'
import { LutControl } from './LutControl'
import { TrackControl } from './TrackControl'
import { addEffect, moveEffect, removeEffects, resetEffect, setEffectEnabled, setEffectValues } from '@engine/timeline/effect-edits'
import { effectById } from '../../../effects/registry'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { EFFECT_DRAG_TYPE, PRESET_DRAG_TYPE, STACK_DRAG_TYPE, effectsController } from '../effects/effects-controller'
import { MAX_VOLUME_DB, MIN_VOLUME_DB, resetMotion, setClipProperties, type ClipPropertyChanges } from '@engine/timeline/edits'
import { MAX_SPEED_PERCENT, clampValue, keyframesOf, linksOf, modulatable, modulatedValueAt, propertySpec, speedKeyframeProblem, valueAt, type PropertyRef } from '@engine/keyframes/properties'
import { addLink, removeLinks } from '@engine/timeline/modulation-edits'
import { modulationUi } from '../audio/modulation-ui'
import { modulationController } from '../audio/modulation-controller'
import { defaultValueOf } from '../audio/default-values'
import { LinkToAudioDialog } from './LinkToAudioDialog'
import { addKeyframe, removeKeyframes, resetValues, setAnimated, setValue } from '@engine/timeline/keyframe-edits'
import { clipEnd, toFrame } from '@engine/timeline/timeline'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { keyframeController } from '../keyframes/keyframe-controller'
import { confirmKeyframeRemoval } from '../app/warnings'
import { workspaceController } from '../state/workspace'
import { defaultMotion } from '@engine/timeline/motion'
import { COLOUR_LABELS, effectiveColour } from '@engine/project/media'
import { Icon } from '../app/Icon'
import { PLAYHEAD_THROTTLE, STATE_AND_PLAYHEAD, useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { addMaskTo, setClipMask, setEffectMask } from '@engine/timeline/mask-edits'
import type { MaskRef } from '@engine/masks/types'
import { maskController } from '../masks/mask-controller'

interface ScrubProps {
  value: number
  onChange(value: number): void
  step?: number
  decimals?: number
  unit?: string
  min?: number
  max?: number
  disabled?: boolean
  label: string
}

/**
 * A Premiere-style number: drag left/right to change it (Shift = ×10, Option = ÷10),
 * or click to type. A drag is one undo step.
 */
export function ScrubNumber({ value, onChange, step = 1, decimals = 1, unit, min = -Infinity, max = Infinity, disabled, label }: ScrubProps) {
  const [editing, setEditing] = useState(false)
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  if (editing) {
    return (
      <input
        className="input compact scrub-input mono"
        aria-label={label}
        defaultValue={value.toFixed(decimals)}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onBlur={(event) => {
          const parsed = Number(event.currentTarget.value.replace(',', '.'))
          if (Number.isFinite(parsed) && parsed !== value) onChange(clamp(parsed))
          setEditing(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            event.currentTarget.value = value.toFixed(decimals)
            event.currentTarget.blur()
          }
        }}
      />
    )
  }
  return (
    <span
      className={`scrub mono ${disabled ? 'disabled' : ''}`}
      role="slider"
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      title="Drag to change (Shift: faster, Option: finer), or click to type"
      onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
        if (disabled) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, start: value, moved: false }
      }}
      onPointerMove={(event) => {
        const d = drag.current
        if (!d) return
        const dx = event.clientX - d.x
        if (!d.moved && Math.abs(dx) < 2) return
        d.moved = true
        const factor = event.shiftKey ? 10 : event.altKey ? 0.1 : 1
        const next = clamp(Math.round((d.start + dx * step * factor) * 10 ** decimals) / 10 ** decimals)
        if (next !== value) onChange(next)
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        if (d && !d.moved) setEditing(true)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') setEditing(true)
      }}
    >
      {value.toFixed(decimals)}
      {unit && <span className="scrub-unit">{unit}</span>}
    </span>
  )
}

function Section({ title, onReset, children }: { title: string; onReset?: () => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="fx-section">
      <header className="fx-section-head">
        <button className="twisty" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} fallback={open ? '▾' : '▸'} />
        </button>
        <span className="fx-title">{title}</span>
        <span className="spacer" />
        {onReset && (
          <button className="button compact" title={`Reset ${title}`} onClick={onReset}>
            Reset
          </button>
        )}
      </header>
      {open && <div className="fx-body">{children}</div>}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fx-row">
      <span className="fx-label">{label}</span>
      <span className="fx-values">{children}</span>
    </div>
  )
}

/** How many keyframes a reset would remove: the clip's own, for these properties. */
function keyframeCount(clip: Clip, params: string[]): number {
  return params.reduce((n, p) => n + (clip.keyframes[p]?.length ?? 0), 0)
}

/** Runs a reset, asking first if it would remove keyframes (decision 42). */
async function resetWithWarning(count: number, what: string, run: () => void): Promise<void> {
  if (await confirmKeyframeRemoval(count, what)) run()
}

/** Where the playhead is on a clip: the time values are shown at, and whether a keyframe can go there. */
function clipTime(clip: Clip): { t: number; inside: boolean } {
  const playhead = timelineController.playhead
  return { t: Math.min(Math.max(0, playhead - clip.start), clip.duration - 1), inside: playhead >= clip.start && playhead < clipEnd(clip) }
}

/**
 * One value that can be animated: Premiere's stopwatch (animation on/off), the value at
 * the playhead, and ◀ ◆ ▶ to go to the previous keyframe, add or remove one at the
 * playhead, and go to the next. Right-click for the keyframe menu.
 */
function PropertyRow({
  clip,
  effectId,
  param,
  label,
  locked,
  help,
  unavailable,
  children,
  below
}: {
  clip: Clip
  effectId: string | null
  param: string
  label: string
  locked: boolean
  help?: string
  /** Why this value can't be keyframed right now (e.g. Speed on a reversed clip). */
  unavailable?: string | null
  children(value: ParamValue, onChange: (value: ParamValue) => void, animated: boolean): ReactNode
  /** A full-width control under the row (the curve editor). */
  below?(value: ParamValue, onChange: (value: ParamValue) => void): ReactNode
}) {
  useObservable(keyframeController)
  useObservable(modulationController)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const ref: PropertyRef = { clipId: clip.id, effectId, param }
  const links = linksOf(clip, effectId, param)
  const canModulate = modulatable(clip, effectId, param)
  const track = keyframesOf(clip, effectId, param)
  const animated = track.length > 0
  const { t, inside } = clipTime(clip)
  const playhead = timelineController.playhead
  const here = toFrame(t, timelineController.frame())
  const value = valueAt(clip, effectId, param, t)
  const atKey = inside ? track.find((k) => k.time === here) : undefined
  const prev = [...track].reverse().find((k) => k.time < here)
  const next = track.find((k) => k.time > (inside ? here : t))
  const go = (time: number) => timelineController.movePlayhead(clip.start + time)
  const dispatch = projectController.dispatch.bind(projectController)
  const toggle = async () => {
    if (animated && !(await confirmKeyframeRemoval(track.length, label))) return
    dispatch(setAnimated(ref, !animated, playhead))
  }
  const addOrRemove = () => (atKey ? dispatch(removeKeyframes([{ ...ref, keyframeId: atKey.id }])) : dispatch(addKeyframe(ref, playhead)))
  const cantKey = locked || Boolean(unavailable) || !inside
  const openModulation = () => {
    modulationUi.modulate(ref)
    workspaceController.open('modulation')
    workspaceController.focus('modulation')
  }
  const spec = propertySpec(clip, effectId, param)
  const copyValue = () => spec && modulationUi.copy(spec.kind, value, label)
  const pasteable = Boolean(spec && modulationUi.copied && modulationUi.copied.kind === spec.kind && clampValue(spec, modulationUi.copied.value) !== null)
  const pasteValue = () => modulationUi.copied && dispatch(setValue(ref, modulationUi.copied.value, playhead))
  const resetValue = async () => {
    const project = projectController.project
    const fresh = project ? defaultValueOf(project, clip, effectId, param) : null
    if (fresh === null) return
    if (!(await confirmKeyframeRemoval(track.length, label))) return
    dispatch(resetValues(clip.id, [{ effectId, param, value: fresh }], `Reset ${label}`))
  }
  const live = links.length > 0 ? modulatedValueAt(clip, effectId, param, inside ? playhead : clip.start + t, modulationController.context) : null
  const showInEditor = () => {
    keyframeController.focus(ref)
    workspaceController.open('keyframe-editor')
    workspaceController.focus('keyframe-editor')
  }
  const items: MenuEntry[] = [
    animated ? { label: 'Remove All Keyframes', onSelect: () => void toggle(), disabled: locked, danger: true } : { label: 'Create Keyframes', onSelect: () => void toggle(), disabled: cantKey },
    { label: atKey ? 'Delete Keyframe at Playhead' : 'Add Keyframe at Playhead', onSelect: addOrRemove, disabled: cantKey },
    'separator',
    { label: 'Go to Previous Keyframe', onSelect: () => prev && go(prev.time), disabled: !prev },
    { label: 'Go to Next Keyframe', onSelect: () => next && go(next.time), disabled: !next },
    'separator',
    { label: 'Paste Keyframes Here', onSelect: () => (keyframeController.focus(ref), keyframeController.paste()), disabled: !keyframeController.clipboard || cantKey },
    { label: 'Show in Keyframe Editor', onSelect: showInEditor, shortcut: '⌥0' },
    'separator',
    { label: 'Link to Audio…', onSelect: () => modulationUi.openLinkToAudio(ref), disabled: locked || !canModulate },
    // The Channel Rack's rows (M12): this value fires on that row's steps.
    ...(projectController.project?.sequence.rack.rows ?? [])
      .filter((r) => r.modulatorId)
      .map((r): MenuEntry => ({ label: `Link to Pattern: ${r.name}`, onSelect: () => dispatch(addLink(ref, r.modulatorId!, playhead)), disabled: locked || !canModulate || links.some((l) => l.modulatorId === r.modulatorId) })),
    { label: 'Modulate Parameter…', onSelect: openModulation, disabled: locked || !canModulate, shortcut: '⌥⇧2' },
    { label: links.length > 1 ? `Remove Modulation (${links.length})` : 'Remove Modulation', onSelect: () => dispatch(removeLinks(ref)), disabled: locked || links.length === 0, danger: true },
    'separator',
    { label: 'Copy Value', onSelect: copyValue },
    { label: 'Paste Value', onSelect: pasteValue, disabled: locked || !pasteable },
    { label: 'Reset', onSelect: () => void resetValue(), disabled: locked || (effectId === null && param === 'speed') }
  ]
  const stopwatchTitle = unavailable ?? (animated ? `Turn off animation (removes the ${track.length} keyframe${track.length === 1 ? '' : 's'})` : inside ? 'Animate: set a keyframe at the playhead' : 'Move the playhead over the clip to animate this')
  const change = (v: ParamValue) => dispatch(setValue(ref, v, playhead))
  const row = (
    <div
      className={`fx-row kf-row ${keyframeController.isFocused(ref) ? 'focused' : ''}`}
      title={help}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <span className="fx-label">
        <button
          className={`kf-stopwatch ${animated ? 'on' : ''}`}
          aria-pressed={animated}
          aria-label={`Animate ${label}`}
          title={stopwatchTitle}
          disabled={locked || (!animated && (Boolean(unavailable) || !inside))}
          onClick={() => void toggle()}
        >
          ⏱
        </button>
        <span className="kf-name" onClick={() => keyframeController.focus(ref)}>
          {label}
        </span>
      </span>
      <span className="fx-values">
        {children(value, change, animated)}
        {links.length > 0 && (
          <button className="fx-mod-badge" title={`Modulated by ${links.length === 1 ? 'a modulator' : `${links.length} modulators`}; now ${formatLive(live)}. Click to edit.`} onClick={openModulation}>
            ∿ {formatLive(live)}
          </button>
        )}
      </span>
      {animated && (
        <span className="kf-nav">
          <button className="kf-nav-button" title="Previous keyframe" disabled={!prev} onClick={() => prev && go(prev.time)}>
            ◀
          </button>
          <button className={`kf-nav-button kf-diamond ${atKey ? 'on' : ''}`} title={atKey ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead'} disabled={cantKey} onClick={addOrRemove}>
            ◆
          </button>
          <button className="kf-nav-button" title="Next keyframe" disabled={!next} onClick={() => next && go(next.time)}>
            ▶
          </button>
        </span>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  )
  if (!below) return row
  return (
    <div className="fx-row-block">
      {row}
      <div className="fx-below">{below(value, change)}</div>
    </div>
  )
}

function formatLive(value: ParamValue | null): string {
  if (value === null) return ''
  if (Array.isArray(value)) return `${value[0].toFixed(1)}, ${value[1].toFixed(1)}`
  return typeof value === 'number' ? value.toFixed(1) : String(value)
}

/**
 * The shared mask an effect (or an adjustment layer) uses: None, any of the sequence's
 * masks, or a new one; Invert uses its outside; Edit opens it in the Masks window.
 */
function MaskRow({ clip, effectId, value, locked }: { clip: Clip; effectId: string | null; value: MaskRef | null; locked: boolean }) {
  useObservable(maskController)
  const masks = projectController.project?.sequence.masks ?? []
  const set = (ref: MaskRef | null) => projectController.dispatch(effectId === null ? setClipMask(clip.id, ref) : setEffectMask(clip.id, effectId, ref))
  const create = () => {
    const command = addMaskTo(clip.id, effectId, 'rectangle')
    if (projectController.dispatch(command)) maskController.edit(command.maskId)
  }
  return (
    <div className="fx-row fx-mask-row" title={effectId !== null ? 'Where this effect shows' : clip.adjustment ? 'Where this adjustment layer applies' : 'Where this clip shows: outside the mask it’s transparent'}>
      <span className="fx-label">Mask</span>
      <span className="fx-values">
        <select
          className="input compact"
          aria-label="Mask"
          value={value?.id ?? ''}
          disabled={locked}
          onChange={(event) => {
            const id = event.target.value
            if (id === '__new') create()
            else set(id ? { id, invert: value?.invert ?? false, followClip: value?.followClip } : null)
          }}
        >
          <option value="">None (everywhere)</option>
          {masks.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option disabled>──────────</option>
          <option value="__new">New Mask…</option>
        </select>
        {value && (
          <>
            <label className="mod-check" title="Show outside the mask instead">
              <input type="checkbox" checked={value.invert} disabled={locked} onChange={(event) => set({ ...value, invert: event.target.checked })} /> Invert
            </label>
            {!clip.adjustment && (
              <label className="mod-check" title="Follow clip: the mask moves, scales and turns with this clip's Motion. Off: it stays where it is on the frame.">
                <input type="checkbox" checked={value.followClip === true} disabled={locked} onChange={(event) => set({ ...value, followClip: event.target.checked })} /> Follow clip
              </label>
            )}
            <button
              className={`button compact ${maskController.maskId === value.id ? 'active' : ''}`}
              title="Edit this mask (Masks window and Program monitor)"
              onClick={() => maskController.edit(value.id, value.followClip ? clip.id : null)}
            >
              Edit
            </button>
          </>
        )}
      </span>
    </div>
  )
}

/** Blend modes in Photoshop's menu order, grouped. */
export function BlendSelect({ value, onChange, disabled, label }: { value: BlendMode; onChange(mode: BlendMode): void; disabled?: boolean; label: string }) {
  return (
    <select className="input compact" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as BlendMode)}>
      {BLEND_MENU.map((mode, index) =>
        mode === '-' ? (
          <option key={`sep-${index}`} disabled>
            ──────────
          </option>
        ) : (
          <option key={mode} value={mode}>
            {BLEND_MODES.find((m) => m.id === mode)!.label}
          </option>
        )
      )}
    </select>
  )
}

/** One generated control, from the effect's manifest. */
function ParamControl({ spec, value, onChange, disabled, readout }: { spec: ParamSpec; value: ParamValue | undefined; onChange(value: ParamValue): void; disabled: boolean; readout?: string | null }) {
  switch (spec.type) {
    case 'steps':
      return <StepsKnob label={spec.label} value={Number(value ?? spec.default)} steps={spec.steps} defaultValue={spec.default} onChange={onChange} disabled={disabled} readout={readout} />
    case 'number': {
      const range = spec.max - spec.min
      return (
        <ScrubNumber label={spec.label} value={Number(value ?? spec.default)} min={spec.min} max={spec.max} step={range > 1000 ? 1 : range > 10 ? 0.5 : 0.01} decimals={spec.decimals ?? 1} unit={spec.unit} onChange={onChange} disabled={disabled} />
      )
    }
    case 'angle':
      return <ScrubNumber label={spec.label} value={Number(value ?? spec.default)} step={0.5} unit="°" onChange={onChange} disabled={disabled} />
    case 'choice':
      return (
        <select className="input compact" aria-label={spec.label} value={String(value ?? spec.default)} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {spec.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      )
    case 'toggle':
      return <input type="checkbox" aria-label={spec.label} checked={Boolean(value ?? spec.default)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    case 'point': {
      const point = (Array.isArray(value) ? value : [0, 0]) as [number, number]
      return (
        <>
          <ScrubNumber label={`${spec.label} X`} value={point[0]} onChange={(x) => onChange([x, point[1]])} disabled={disabled} />
          <ScrubNumber label={`${spec.label} Y`} value={point[1]} onChange={(y) => onChange([point[0], y])} disabled={disabled} />
        </>
      )
    }
    case 'gradient':
    case 'lut':
    case 'track':
      return null
    case 'curve': {
      const points = parseCurve(String(value ?? spec.default))
      const straight = String(value ?? spec.default) === IDENTITY_CURVE
      return (
        <span className="muted small">
          {straight ? 'Straight' : `${points?.length ?? 2} points`}
          {!straight && (
            <button className="button compact" style={{ marginLeft: 8 }} disabled={disabled} title={`Make the ${spec.label} curve straight again`} onClick={() => onChange(IDENTITY_CURVE)}>
              Straighten
            </button>
          )}
        </span>
      )
    }
  }
}

/**
 * A gradient parameter (M13): its swatch (click to open the Gradient Editor on it) and ▾ to
 * pick one from the library.
 */
function GradientControl({ clip, effect, spec, value, disabled }: { clip: Clip; effect: EffectInstance; spec: GradientParam; value: ParamValue | undefined; disabled: boolean }) {
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
  const gradient = parseGradient(String(value ?? spec.default)) ?? BLACK_WHITE
  const methodValue = spec.methodParam ? effect.params[spec.methodParam] : 'classic'
  const method = GRADIENT_METHODS.some((m) => m.id === methodValue) ? (methodValue as GradientMethod) : 'classic'
  const ref = { clipId: clip.id, effectId: effect.id, param: spec.id }
  return (
    <span className="gradient-control">
      <button className="gradient-control-swatch" style={{ background: gradientCss(gradient, method) }} title={`${gradient.name}: click to edit in the Gradient Editor`} disabled={disabled} onClick={() => gradientController.edit(ref)} />
      <button className="button compact" disabled={disabled} title="Pick a gradient from the library" aria-label={`Pick ${spec.label} from the library`} onClick={(event) => setPicker({ x: event.clientX - 200, y: event.clientY + 12 })}>
        ▾
      </button>
      {picker && <GradientPopover x={picker.x} y={picker.y} onClose={() => setPicker(null)} onPick={(item) => gradientController.use(item, ref)} />}
    </span>
  )
}

/** One parameter's row: its control, and for a curve the editor under it. */
function ParamRow({ clip, effect, spec, locked }: { clip: Clip; effect: EffectInstance; spec: ParamSpec; locked: boolean }) {
  return (
    <PropertyRow
      clip={clip}
      effectId={effect.id}
      param={spec.id}
      label={spec.label}
      locked={locked}
      help={spec.help}
      below={spec.type === 'curve' ? (value, onChange) => <CurveEditor value={String(value)} onChange={onChange} colour={CHANNEL_COLOURS[spec.id] ?? CHANNEL_COLOURS['master']!} disabled={locked} label={spec.label} /> : undefined}
    >
      {(value, onChange) => {
        const manifest = effectById(effect.effectId)
        const readout = manifest?.readout?.(spec.id, { ...effect.params, [spec.id]: value }, { beatGrid: projectController.project?.sequence.beatGrid ?? null }) ?? null
        if (spec.type === 'gradient') return <GradientControl clip={clip} effect={effect} spec={spec} value={value} disabled={locked} />
        if (spec.type === 'lut') return <LutControl value={String(value ?? '')} onChange={onChange} disabled={locked} label={spec.label} />
        if (spec.type === 'track') return <TrackControl value={String(value ?? '')} onChange={onChange} disabled={locked} label={spec.label} ownTrackId={clip.trackId} />
        return <ParamControl spec={spec} value={value} disabled={locked} onChange={onChange} readout={readout} />
      }}
    </PropertyRow>
  )
}

/** A group made only of curves (Curves' RGB, Red, Green, Blue): tabs, one editor at a time. */
function CurveTabs({ clip, effect, specs, locked }: { clip: Clip; effect: EffectInstance; specs: CurveParam[]; locked: boolean }) {
  const [shown, setShown] = useState(specs[0]!.id)
  const spec = specs.find((s) => s.id === shown) ?? specs[0]!
  return (
    <>
      <div className="curve-tabs" role="tablist" aria-label="Curve">
        {specs.map((s) => {
          const changed = String(effect.params[s.id] ?? s.default) !== IDENTITY_CURVE || (effect.keyframes[s.id]?.length ?? 0) > 0
          return (
            <button key={s.id} role="tab" aria-selected={s.id === spec.id} className={`curve-tab ${s.id === spec.id ? 'active' : ''}`} title={changed ? `${s.label} (changed)` : s.label} onClick={() => setShown(s.id)}>
              <span className="curve-tab-dot" style={{ background: CHANNEL_COLOURS[s.id] ?? CHANNEL_COLOURS['master'] }} />
              {s.label}
              {changed && <span className="fx-group-changed">●</span>}
            </button>
          )
        })}
      </div>
      <ParamRow clip={clip} effect={effect} spec={spec} locked={locked} />
    </>
  )
}

/** Whether a parameter applies right now (`showIf`): always, while its choice is keyframed, since that changes over time. */
function applies(effect: EffectInstance, spec: ParamSpec): boolean {
  const rule = spec.showIf
  if (!rule) return true
  if ((effect.keyframes[rule.param]?.length ?? 0) > 0) return true
  return rule.is.includes(String(effect.params[rule.param]))
}

/** Consecutive parameters with the same group, in manifest order (ungrouped ones alone). */
function paramSections(manifest: EffectManifest): Array<{ group: string | null; specs: ParamSpec[] }> {
  const out: Array<{ group: string | null; specs: ParamSpec[] }> = []
  for (const spec of manifest.params) {
    const group = spec.group ?? null
    const last = out[out.length - 1]
    if (last && group !== null && last.group === group) last.specs.push(spec)
    else out.push({ group, specs: [spec] })
  }
  return out
}

/** A parameter group's heading (fold it away), with a dot when anything in it differs from its default. */
function ParamGroup({ clip, effect, manifest, group, specs, locked }: { clip: Clip; effect: EffectInstance; manifest: EffectManifest; group: string; specs: ParamSpec[]; locked: boolean }) {
  const [open, setOpen] = useState(!manifest.closedGroups?.includes(group))
  const changed = specs.some((s) => JSON.stringify(effect.params[s.id] ?? null) !== JSON.stringify(s.default) || (effect.keyframes[s.id]?.length ?? 0) > 0 || (effect.modulation[s.id]?.length ?? 0) > 0)
  const curves = specs.every((s) => s.type === 'curve') && specs.length > 1
  return (
    <div className="fx-group">
      <div className="fx-group-head" onClick={() => setOpen(!open)}>
        <button className="twisty" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${group}`}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} fallback={open ? '▾' : '▸'} />
        </button>
        <span>{group}</span>
        {changed && (
          <span className="fx-group-changed" title="Something here is changed, animated or modulated">
            ●
          </span>
        )}
      </div>
      {open && (
        <div className="fx-group-body">
          {curves ? <CurveTabs clip={clip} effect={effect} specs={specs as CurveParam[]} locked={locked} /> : specs.filter((spec) => applies(effect, spec)).map((spec) => <ParamRow key={spec.id} clip={clip} effect={effect} spec={spec} locked={locked} />)}
        </div>
      )}
    </div>
  )
}

function dragKind(event: DragEvent): 'stack' | 'effect' | 'preset' | null {
  const types = event.dataTransfer.types
  if (types.includes(STACK_DRAG_TYPE)) return 'stack'
  if (types.includes(EFFECT_DRAG_TYPE)) return 'effect'
  if (types.includes(PRESET_DRAG_TYPE)) return 'preset'
  return null
}

/** One effect in a stack: header (drag to reorder, on/off, reset, remove) and its controls. */
interface EffectBlockProps {
  clip: Clip
  effect: EffectInstance
  index: number
  locked: boolean
  selected: boolean
  /** What of the playhead its rows show: the time, for an effect with keyframes or links; else only whether it's over the clip. */
  when: number | string
  /** The beat grid (readouts in beats), the masks (their names) and the Channel Rack (its rows in menus). */
  grid: unknown
  masks: unknown
  rack: unknown
  onDropAt(event: DragEvent, index: number): void
}

/**
 * One effect's block. Drawn again only when what it shows changed (its effect, where the
 * playhead is if it's animated, …), so with a long stack, changing one value redraws one block.
 */
const EffectBlock = memo(
  EffectBlockView,
  (a, b) =>
    a.effect === b.effect &&
    a.index === b.index &&
    a.locked === b.locked &&
    a.selected === b.selected &&
    a.when === b.when &&
    a.grid === b.grid &&
    a.masks === b.masks &&
    a.rack === b.rack &&
    a.onDropAt === b.onDropAt &&
    a.clip.id === b.clip.id &&
    a.clip.start === b.clip.start &&
    a.clip.duration === b.clip.duration
)

function EffectBlockView({ clip, effect, index, locked, selected, onDropAt }: EffectBlockProps) {
  const [open, setOpen] = useState(true)
  const [dropSide, setDropSide] = useState<'above' | 'below' | null>(null)
  const manifest = effectById(effect.effectId)
  const change = (changes: Parameters<typeof setEffectValues>[2]) => projectController.dispatch(setEffectValues(clip.id, effect.id, changes))
  return (
    <section
      className={`fx-section fx-effect ${selected ? 'selected' : ''} ${effect.enabled ? '' : 'off'} ${dropSide ? `drop-${dropSide}` : ''}`}
      onDragOver={(event) => {
        if (locked || !dragKind(event)) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        setDropSide(event.clientY < rect.top + rect.height / 2 ? 'above' : 'below')
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(event) => {
        const side = dropSide
        setDropSide(null)
        if (!side) return
        event.preventDefault()
        event.stopPropagation()
        onDropAt(event, side === 'above' ? index : index + 1)
      }}
    >
      <header
        className="fx-section-head"
        onClick={(event) => effectsController.select([effect.id], event.shiftKey || event.metaKey ? 'toggle' : 'replace')}
      >
        <span
          className="fx-grip"
          title="Drag to reorder"
          draggable={!locked}
          onDragStart={(event) => {
            event.dataTransfer.setData(STACK_DRAG_TYPE, effect.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
        >
          ⋮⋮
        </span>
        <button
          className={`fx-toggle ${effect.enabled ? 'on' : ''}`}
          title={effect.enabled ? 'Turn this effect off' : 'Turn this effect on'}
          aria-pressed={effect.enabled}
          disabled={locked}
          onClick={(event) => {
            event.stopPropagation()
            projectController.dispatch(setEffectEnabled(clip.id, effect.id, !effect.enabled))
          }}
        >
          fx
        </button>
        <button className="twisty" onClick={(event) => (event.stopPropagation(), setOpen(!open))} aria-expanded={open}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} fallback={open ? '▾' : '▸'} />
        </button>
        <span className="fx-title">{manifest ? manifest.name : `Missing effect: ${effect.effectId}`}</span>
        <span className="spacer" />
        {manifest && (
          <button className="button compact" disabled={locked} title={`Reset ${manifest.name}`} onClick={(event) => {
              event.stopPropagation()
              const count = Object.values(effect.keyframes).reduce((n, t) => n + t.length, 0)
              void resetWithWarning(count, manifest.name, () => projectController.dispatch(resetEffect(clip.id, effect.id)))
            }}>
            Reset
          </button>
        )}
        <button className="button compact" disabled={locked} title="Remove this effect" onClick={(event) => (event.stopPropagation(), projectController.dispatch(removeEffects(clip.id, [effect.id])))}>
          ✕
        </button>
      </header>
      {open && (
        <div className="fx-body">
          {!manifest && <p className="muted small">This effect isn’t in this version of ginosa, so the picture passes through it unchanged. It’s kept in the project.</p>}
          {manifest && (
            <>
              <PropertyRow clip={clip} effectId={effect.id} param="mix" label="Mix" locked={locked}>
                {(value, onChange) => <ScrubNumber label="Mix" value={Number(value)} min={0} max={100} step={0.5} unit="%" onChange={onChange} disabled={locked} />}
              </PropertyRow>
              <Row label="Blend Mode">
                <BlendSelect label="Effect blend mode" value={effect.blendMode} disabled={locked} onChange={(blendMode) => change({ blendMode })} />
              </Row>
              <MaskRow clip={clip} effectId={effect.id} value={effect.mask} locked={locked} />
              {paramSections(manifest).map((section) =>
                section.group === null ? (
                  applies(effect, section.specs[0]!) && <ParamRow key={section.specs[0]!.id} clip={clip} effect={effect} spec={section.specs[0]!} locked={locked} />
                ) : (
                  <ParamGroup key={`group-${section.group}-${section.specs[0]!.id}`} clip={clip} effect={effect} manifest={manifest} group={section.group} specs={section.specs} locked={locked} />
                )
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

/** A clip's (or adjustment layer's) effects, top to bottom, with drop targets for the Effects Library. */
function EffectStack({ clip, locked, selectedClipIds }: { clip: Clip; locked: boolean; selectedClipIds: string[] }) {
  useObservable(effectsController)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  useEffect(() => {
    // Selection belongs to the clip shown; switching clips clears it.
    effectsController.select([], 'replace')
  }, [clip.id])
  // A stable handler (reading the latest stack), so effect blocks needn't be drawn again for it.
  const latestDrop = useRef<(event: DragEvent, index: number) => void>(() => undefined)
  const stableDropAt = useCallback((event: DragEvent, index: number) => latestDrop.current(event, index), [])
  const dropAt = (event: DragEvent, index: number) => {
    const kind = dragKind(event)
    if (kind === 'stack') {
      const id = event.dataTransfer.getData(STACK_DRAG_TYPE)
      const from = clip.effects.findIndex((e) => e.id === id)
      if (from >= 0) projectController.dispatch(moveEffect(clip.id, id, from < index ? index - 1 : index))
    } else if (kind === 'effect') projectController.dispatch(addEffect([clip.id], event.dataTransfer.getData(EFFECT_DRAG_TYPE), index))
    else if (kind === 'preset') effectsController.applyPreset(event.dataTransfer.getData(PRESET_DRAG_TYPE), [clip.id])
  }
  latestDrop.current = dropAt
  const savePreset = () =>
    setPrompt({
      title: 'Save Effect Preset',
      label: effectsController.selected.size > 0 ? `Name for the ${effectsController.selected.size} selected effect${effectsController.selected.size === 1 ? '' : 's'}` : 'Name for the whole stack',
      initial: effectsController.selected.size === 1 ? (effectById(clip.effects.find((e) => effectsController.selected.has(e.id))?.effectId ?? '')?.name ?? 'Preset') : `${clip.name} effects`,
      confirm: 'Save',
      resolve: (name) => {
        setPrompt(null)
        if (name) void effectsController.savePreset(name, clip.id).catch((error: Error) => projectController.showMessage(error.message))
      }
    })
  return (
    <div
      className="fx-stack"
      onDragOver={(event) => {
        if (!locked && dragKind(event)) event.preventDefault()
      }}
      onDrop={(event) => {
        if (locked || !dragKind(event)) return
        event.preventDefault()
        dropAt(event, clip.effects.length)
      }}
    >
      <div className="fx-stack-head">
        <span className="fx-title">Effects</span>
        <span className="spacer" />
        <button className="button compact" disabled={clip.effects.length === 0} title="Copy the selected effects (or all) — ⌘C" onClick={() => effectsController.copy(clip.id)}>
          Copy
        </button>
        <button className="button compact" disabled={!effectsController.clipboard || locked} title="Paste effects onto the selected clips — ⌘V" onClick={() => effectsController.paste(selectedClipIds)}>
          Paste
        </button>
        <button className="button compact" disabled={clip.effects.length === 0} onClick={savePreset}>
          Save Preset…
        </button>
      </div>
      {clip.effects.map((effect, index) => {
        const live = Object.values(effect.keyframes).some((t) => t.length > 0) || Object.values(effect.modulation).some((l) => l.length > 0)
        const when = live ? timelineController.playhead : clipTime(clip).inside ? 'over' : 'off'
        return <EffectBlock key={effect.id} clip={clip} effect={effect} index={index} locked={locked} selected={effectsController.selected.has(effect.id)} when={when} grid={projectController.project?.sequence.beatGrid ?? null} masks={projectController.project?.sequence.masks} rack={projectController.project?.sequence.rack} onDropAt={stableDropAt} />
      })}
      {clip.effects.length === 0 && <p className="muted small fx-drop-hint">Drag an effect here from the Effects Library (⌥9), or onto the clip in the timeline.</p>}
      <PromptDialog request={prompt} />
    </div>
  )
}


/** Opacity (animatable) and blend mode, for clips and adjustment layers. */
function OpacitySection({ clip, locked }: { clip: Clip; locked: boolean }) {
  return (
    <Section
      title="Opacity"
      onReset={locked ? undefined : () => void resetWithWarning(keyframeCount(clip, ['opacity']), 'Opacity', () => projectController.dispatch(resetValues(clip.id, [{ effectId: null, param: 'opacity', value: 100 }], 'Reset Opacity', 'normal')))}
    >
      <PropertyRow clip={clip} effectId={null} param="opacity" label="Opacity" locked={locked}>
        {(value, onChange) => <ScrubNumber label="Opacity" value={Number(value)} min={0} max={100} step={0.5} unit="%" onChange={onChange} disabled={locked} />}
      </PropertyRow>
      <Row label="Blend Mode">
        <BlendSelect label="Blend mode" value={clip.blendMode} disabled={locked} onChange={(blendMode) => projectController.dispatch(setClipProperties([clip.id], { blendMode }))} />
      </Row>
      <MaskRow clip={clip} effectId={null} value={clip.mask} locked={locked} />
    </Section>
  )
}

/** Premiere's Effect Controls for the selected clip: Motion, Opacity and blend mode, Time Remapping, Volume, effects. */
export function EffectControlsWindow() {
  useObservable(projectController)
  // Values at the playhead: during playback, refreshed 10 times a second rather than every frame.
  useObservable(timelineController, STATE_AND_PLAYHEAD, PLAYHEAD_THROTTLE)
  const project = projectController.project
  if (!project) return null
  const selected = project.sequence.clips.filter((c) => timelineController.selection.has(c.id))
  const video = selected.find((c) => c.kind === 'video')
  const adjustment = video?.adjustment ? video : null
  const audio = selected.find((c) => c.kind === 'audio')
  const locked = (clip: Clip) => project.sequence.tracks.find((t) => t.id === clip.trackId)?.locked ?? false

  if (!video && !audio) {
    return (
      <div className="empty-state">
        <p className="muted">Select a clip or adjustment layer in the timeline to adjust its Motion, Opacity, Volume and effects.</p>
      </div>
    )
  }

  const set = (clip: Clip, changes: ClipPropertyChanges) => projectController.dispatch(setClipProperties([clip.id], changes))
  const setMotion = (clip: Clip, changes: Partial<Motion>) => set(clip, { motion: changes })
  const item = video ? project.media.find((m) => m.id === video.mediaId) : undefined
  const fresh = video && !adjustment ? defaultMotion(item, project.sequence.settings) : null
  const selectedVideoIds = selected.filter((c) => c.kind === 'video').map((c) => c.id)

  return (
    <div
      className="effect-controls"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!video || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
        const cmd = event.metaKey || event.ctrlKey
        if (cmd && event.key.toLowerCase() === 'c') effectsController.copy(video.id)
        else if (cmd && event.key.toLowerCase() === 'v') effectsController.paste(selectedVideoIds)
        else if ((event.key === 'Delete' || event.key === 'Backspace') && effectsController.selected.size > 0) {
          projectController.dispatch(removeEffects(video.id, [...effectsController.selected]))
        } else return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div className="fx-clip">
        <span className="fx-clip-name">{video?.name ?? audio?.name}</span>
        {selected.length > 2 && <span className="muted small">and {selected.length - 1} more selected; showing one</span>}
      </div>
      {video && !adjustment && item && item.kind === 'video' && (
        <div className="fx-source-colour muted small">
          Source colour: <strong>{item.colour.lut ? `Input LUT ${item.colour.lut.name}` : COLOUR_LABELS[effectiveColour(item)]}</strong>
          {item.colour.input === 'auto' && !item.colour.lut ? ' (detected)' : ''} · right-click the file in Media to change
        </div>
      )}
      {video && !adjustment && (video.speed !== 1 || video.reverse) && (
        <div className="fx-source-colour muted small">
          Speed: <strong>{video.speed === 0 ? 'Frame Hold' : `${video.reverse ? '-' : ''}${Math.round(video.speed * 1000) / 10}%`}</strong> · ⌘R to change
        </div>
      )}
      {video && fresh && (
        <>
          <Section
            title="Motion"
            onReset={
              locked(video)
                ? undefined
                : () => void resetWithWarning(keyframeCount(video, ['position', 'scale', 'scaleWidth', 'rotation', 'anchor']), 'Motion', () => projectController.dispatch(resetMotion([video.id], 'reset')))
            }
          >
            <PropertyRow clip={video} effectId={null} param="position" label="Position" locked={locked(video)}>
              {(value, onChange) => {
                const [x, y] = value as [number, number]
                return (
                  <>
                    <ScrubNumber label="Position X" value={x} onChange={(v) => onChange([v, y])} disabled={locked(video)} />
                    <ScrubNumber label="Position Y" value={y} onChange={(v) => onChange([x, v])} disabled={locked(video)} />
                  </>
                )
              }}
            </PropertyRow>
            <PropertyRow clip={video} effectId={null} param="scale" label="Scale" locked={locked(video)}>
              {(value, onChange) => (
                <>
                  <ScrubNumber label="Scale" value={Number(value)} min={0} max={10000} step={0.5} onChange={onChange} disabled={locked(video)} />
                  <button className="button compact" title="Fit the whole clip in the frame (removes Scale keyframes)" disabled={locked(video)} onClick={() => void resetWithWarning(keyframeCount(video, ['scale']), 'Scale', () => projectController.dispatch(resetMotion([video.id], 'frame-size')))}>
                    Frame Size
                  </button>
                </>
              )}
            </PropertyRow>
            <PropertyRow clip={video} effectId={null} param="scaleWidth" label="Scale Width" locked={locked(video)}>
              {(value, onChange) => <ScrubNumber label="Scale Width" value={Number(value)} min={0} max={10000} step={0.5} unit="%" onChange={onChange} disabled={locked(video)} />}
            </PropertyRow>
            <PropertyRow clip={video} effectId={null} param="rotation" label="Rotation" locked={locked(video)}>
              {(value, onChange) => <ScrubNumber label="Rotation" value={Number(value)} step={0.5} unit="°" onChange={onChange} disabled={locked(video)} />}
            </PropertyRow>
            <PropertyRow clip={video} effectId={null} param="anchor" label="Anchor Point" locked={locked(video)}>
              {(value, onChange) => {
                const [x, y] = value as [number, number]
                return (
                  <>
                    <ScrubNumber label="Anchor X" value={x} onChange={(v) => onChange([v, y])} disabled={locked(video)} />
                    <ScrubNumber label="Anchor Y" value={y} onChange={(v) => onChange([x, v])} disabled={locked(video)} />
                  </>
                )
              }}
            </PropertyRow>
          </Section>
          <OpacitySection clip={video} locked={locked(video)} />
          <Section
            title="Time Remapping"
            onReset={
              locked(video) || !video.keyframes['speed']?.length
                ? undefined
                : () => void resetWithWarning(keyframeCount(video, ['speed']), 'Speed', () => projectController.dispatch(resetValues(video.id, [{ effectId: null, param: 'speed', value: 100 }], 'Remove Speed Keyframes')))
            }
          >
            <PropertyRow
              clip={video}
              effectId={null}
              param="speed"
              label="Speed"
              locked={locked(video)}
              unavailable={speedKeyframeProblem(video)}
              help="Keyframe the speed to ramp it (the picture only; linked sound keeps its speed). One fixed speed: Speed/Duration (⌘R)."
            >
              {(value, onChange, animated) =>
                animated ? (
                  <ScrubNumber label="Speed" value={Number(value)} min={0} max={MAX_SPEED_PERCENT} step={1} unit="%" onChange={onChange} disabled={locked(video)} />
                ) : (
                  <span className="muted small">
                    {video.speed === 0 ? 'Frame Hold' : `${video.reverse ? '-' : ''}${Math.round(video.speed * 1000) / 10}%`} · ⌘R to change
                  </span>
                )
              }
            </PropertyRow>
          </Section>
        </>
      )}
      {adjustment && <OpacitySection clip={adjustment} locked={locked(adjustment)} />}
      {video && <EffectStack clip={video} locked={locked(video)} selectedClipIds={selectedVideoIds} />}
      {audio && (
        <Section
          title="Volume"
          onReset={locked(audio) ? undefined : () => void resetWithWarning(keyframeCount(audio, ['volume']), 'Volume', () => projectController.dispatch(resetValues(audio.id, [{ effectId: null, param: 'volume', value: 0 }], 'Reset Volume')))}
        >
          <PropertyRow clip={audio} effectId={null} param="volume" label="Level" locked={locked(audio)}>
            {(value, onChange) => <ScrubNumber label="Volume" value={Number(value)} min={MIN_VOLUME_DB} max={MAX_VOLUME_DB} step={0.1} unit="dB" onChange={onChange} disabled={locked(audio)} />}
          </PropertyRow>
        </Section>
      )}
      <LinkToAudioDialog />
      <p className="muted small fx-note">⏱ animates a value from the playhead; ◆ adds or removes a keyframe there. Right-click a value for more, or open the Keyframe Editor (⌥0) to move keyframes and shape their curves.</p>
    </div>
  )
}
