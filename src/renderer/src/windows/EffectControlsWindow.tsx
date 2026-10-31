import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { BLEND_MENU, BLEND_MODES, type BlendMode, type Clip, type Motion } from '@engine/project/model'
import type { EffectInstance, ParamSpec, ParamValue } from '@engine/effects/types'
import { addEffect, moveEffect, removeEffects, resetEffect, setEffectEnabled, setEffectValues } from '@engine/timeline/effect-edits'
import { effectById } from '../../../effects/registry'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { EFFECT_DRAG_TYPE, PRESET_DRAG_TYPE, STACK_DRAG_TYPE, effectsController } from '../effects/effects-controller'
import { MAX_VOLUME_DB, MIN_VOLUME_DB, resetMotion, setClipProperties, type ClipPropertyChanges } from '@engine/timeline/edits'
import { defaultMotion } from '@engine/timeline/motion'
import { COLOUR_LABELS, effectiveColour } from '@engine/project/media'
import { Icon } from '../app/Icon'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'

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
function ScrubNumber({ value, onChange, step = 1, decimals = 1, unit, min = -Infinity, max = Infinity, disabled, label }: ScrubProps) {
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
function ParamControl({ spec, value, onChange, disabled }: { spec: ParamSpec; value: ParamValue | undefined; onChange(value: ParamValue): void; disabled: boolean }) {
  switch (spec.type) {
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
  }
}

function dragKind(event: DragEvent): 'stack' | 'effect' | 'preset' | null {
  const types = event.dataTransfer.types
  if (types.includes(STACK_DRAG_TYPE)) return 'stack'
  if (types.includes(EFFECT_DRAG_TYPE)) return 'effect'
  if (types.includes(PRESET_DRAG_TYPE)) return 'preset'
  return null
}

/** One effect in a stack: header (drag to reorder, on/off, reset, remove) and its controls. */
function EffectBlock({ clip, effect, index, locked, onDropAt }: { clip: Clip; effect: EffectInstance; index: number; locked: boolean; onDropAt(event: DragEvent, index: number): void }) {
  const [open, setOpen] = useState(true)
  const [dropSide, setDropSide] = useState<'above' | 'below' | null>(null)
  const manifest = effectById(effect.effectId)
  const selected = effectsController.selected.has(effect.id)
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
          <button className="button compact" disabled={locked} title={`Reset ${manifest.name}`} onClick={(event) => (event.stopPropagation(), projectController.dispatch(resetEffect(clip.id, effect.id)))}>
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
              <Row label="Mix">
                <ScrubNumber label="Mix" value={effect.mix} min={0} max={100} step={0.5} unit="%" onChange={(mix) => change({ mix })} disabled={locked} />
              </Row>
              <Row label="Blend Mode">
                <BlendSelect label="Effect blend mode" value={effect.blendMode} disabled={locked} onChange={(blendMode) => change({ blendMode })} />
              </Row>
              {manifest.params.map((spec) => (
                <div key={spec.id} title={spec.help}>
                  <Row label={spec.label}>
                    <ParamControl spec={spec} value={effect.params[spec.id]} disabled={locked} onChange={(value) => change({ params: { [spec.id]: value } })} />
                  </Row>
                </div>
              ))}
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
  const dropAt = (event: DragEvent, index: number) => {
    const kind = dragKind(event)
    if (kind === 'stack') {
      const id = event.dataTransfer.getData(STACK_DRAG_TYPE)
      const from = clip.effects.findIndex((e) => e.id === id)
      if (from >= 0) projectController.dispatch(moveEffect(clip.id, id, from < index ? index - 1 : index))
    } else if (kind === 'effect') projectController.dispatch(addEffect([clip.id], event.dataTransfer.getData(EFFECT_DRAG_TYPE), index))
    else if (kind === 'preset') effectsController.applyPreset(event.dataTransfer.getData(PRESET_DRAG_TYPE), [clip.id])
  }
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
      {clip.effects.map((effect, index) => (
        <EffectBlock key={effect.id} clip={clip} effect={effect} index={index} locked={locked} onDropAt={dropAt} />
      ))}
      {clip.effects.length === 0 && <p className="muted small fx-drop-hint">Drag an effect here from the Effects Library (⌥9), or onto the clip in the timeline.</p>}
      <PromptDialog request={prompt} />
    </div>
  )
}

/** Premiere's Effect Controls for the selected clip: Motion, Opacity and blend mode, Volume. */
export function EffectControlsWindow() {
  useObservable(projectController)
  useObservable(timelineController)
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
          <Section title="Motion" onReset={locked(video) ? undefined : () => projectController.dispatch(resetMotion([video.id], 'reset'))}>
            <Row label="Position">
              <ScrubNumber label="Position X" value={video.motion.positionX} onChange={(v) => setMotion(video, { positionX: v })} disabled={locked(video)} />
              <ScrubNumber label="Position Y" value={video.motion.positionY} onChange={(v) => setMotion(video, { positionY: v })} disabled={locked(video)} />
            </Row>
            <Row label="Scale">
              <ScrubNumber label="Scale" value={video.motion.scale} min={0} max={10000} step={0.5} onChange={(v) => setMotion(video, { scale: v })} disabled={locked(video)} />
              <button className="button compact" title="Fit the whole clip in the frame" disabled={locked(video)} onClick={() => projectController.dispatch(resetMotion([video.id], 'frame-size'))}>
                Frame Size
              </button>
            </Row>
            <Row label="Scale Width">
              <ScrubNumber label="Scale Width" value={video.motion.scaleWidth} min={0} max={10000} step={0.5} unit="%" onChange={(v) => setMotion(video, { scaleWidth: v })} disabled={locked(video)} />
            </Row>
            <Row label="Rotation">
              <ScrubNumber label="Rotation" value={video.motion.rotation} step={0.5} unit="°" onChange={(v) => setMotion(video, { rotation: v })} disabled={locked(video)} />
            </Row>
            <Row label="Anchor Point">
              <ScrubNumber label="Anchor X" value={video.motion.anchorX} onChange={(v) => setMotion(video, { anchorX: v })} disabled={locked(video)} />
              <ScrubNumber label="Anchor Y" value={video.motion.anchorY} onChange={(v) => setMotion(video, { anchorY: v })} disabled={locked(video)} />
            </Row>
          </Section>
          <Section title="Opacity" onReset={locked(video) ? undefined : () => set(video, { opacity: 100, blendMode: 'normal' })}>
            <Row label="Opacity">
              <ScrubNumber label="Opacity" value={video.opacity} min={0} max={100} step={0.5} unit="%" onChange={(v) => set(video, { opacity: v })} disabled={locked(video)} />
            </Row>
            <Row label="Blend Mode">
<BlendSelect label="Blend mode" value={video.blendMode} disabled={locked(video)} onChange={(blendMode) => set(video, { blendMode })} />
            </Row>
          </Section>
        </>
      )}
      {adjustment && (
        <Section title="Opacity" onReset={locked(adjustment) ? undefined : () => set(adjustment, { opacity: 100, blendMode: 'normal' })}>
          <Row label="Opacity">
            <ScrubNumber label="Opacity" value={adjustment.opacity} min={0} max={100} step={0.5} unit="%" onChange={(v) => set(adjustment, { opacity: v })} disabled={locked(adjustment)} />
          </Row>
          <Row label="Blend Mode">
            <BlendSelect label="Blend mode" value={adjustment.blendMode} disabled={locked(adjustment)} onChange={(blendMode) => set(adjustment, { blendMode })} />
          </Row>
        </Section>
      )}
      {video && <EffectStack clip={video} locked={locked(video)} selectedClipIds={selectedVideoIds} />}
      {audio && (
        <Section title="Volume" onReset={locked(audio) ? undefined : () => set(audio, { volume: 0 })}>
          <Row label="Level">
            <ScrubNumber label="Volume" value={audio.volume} min={MIN_VOLUME_DB} max={MAX_VOLUME_DB} step={0.1} unit="dB" onChange={(v) => set(audio, { volume: v })} disabled={locked(audio)} />
          </Row>
        </Section>
      )}
      <p className="muted small fx-note">Keyframes arrive in M7.</p>
    </div>
  )
}
