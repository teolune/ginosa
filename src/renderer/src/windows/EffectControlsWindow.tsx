import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { BLEND_MODES, type BlendMode, type Clip, type Motion } from '@engine/project/model'
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

/** Premiere's Effect Controls for the selected clip: Motion, Opacity and blend mode, Volume. */
export function EffectControlsWindow() {
  useObservable(projectController)
  useObservable(timelineController)
  const project = projectController.project
  if (!project) return null
  const selected = project.sequence.clips.filter((c) => timelineController.selection.has(c.id))
  const video = selected.find((c) => c.kind === 'video')
  const audio = selected.find((c) => c.kind === 'audio')
  const locked = (clip: Clip) => project.sequence.tracks.find((t) => t.id === clip.trackId)?.locked ?? false

  if (!video && !audio) {
    return (
      <div className="empty-state">
        <p className="muted">Select a clip in the timeline to adjust its Motion, Opacity and Volume.</p>
      </div>
    )
  }

  const set = (clip: Clip, changes: ClipPropertyChanges) => projectController.dispatch(setClipProperties([clip.id], changes))
  const setMotion = (clip: Clip, changes: Partial<Motion>) => set(clip, { motion: changes })
  const item = video ? project.media.find((m) => m.id === video.mediaId) : undefined
  const fresh = video ? defaultMotion(item, project.sequence.settings) : null

  return (
    <div className="effect-controls">
      <div className="fx-clip">
        <span className="fx-clip-name">{video?.name ?? audio?.name}</span>
        {selected.length > 2 && <span className="muted small">and {selected.length - 1} more selected; showing one</span>}
      </div>
      {video && item && item.kind === 'video' && (
        <div className="fx-source-colour muted small">
          Source colour: <strong>{item.colour.lut ? `Input LUT ${item.colour.lut.name}` : COLOUR_LABELS[effectiveColour(item)]}</strong>
          {item.colour.input === 'auto' && !item.colour.lut ? ' (detected)' : ''} · right-click the file in Media to change
        </div>
      )}
      {video && (video.speed !== 1 || video.reverse) && (
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
              <select className="input compact" value={video.blendMode} disabled={locked(video)} onChange={(event) => set(video, { blendMode: event.target.value as BlendMode })}>
                {BLEND_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </Row>
          </Section>
        </>
      )}
      {audio && (
        <Section title="Volume" onReset={locked(audio) ? undefined : () => set(audio, { volume: 0 })}>
          <Row label="Level">
            <ScrubNumber label="Volume" value={audio.volume} min={MIN_VOLUME_DB} max={MAX_VOLUME_DB} step={0.1} unit="dB" onChange={(v) => set(audio, { volume: v })} disabled={locked(audio)} />
          </Row>
        </Section>
      )}
      <p className="muted small fx-note">Keyframes for these arrive in M7; more effects in M6.</p>
    </div>
  )
}
