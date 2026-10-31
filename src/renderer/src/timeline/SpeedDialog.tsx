import { useEffect, useRef, useState } from 'react'
import { frameRateOf } from '@engine/project/model'
import { formatTimecode, parseTimecode } from '@engine/time'
import { MAX_SPEED, MIN_SPEED, setClipSpeed } from '@engine/timeline/edits'
import { frameTicks, sourceSpan, toFrame } from '@engine/timeline/timeline'
import { projectController } from '../state/project-controller'
import { timelineController as tl } from './timeline-controller'

/**
 * Premiere's Clip Speed/Duration (Cmd+R). Speed and duration are linked: changing one
 * changes the other, and the clip always covers the same stretch of its media.
 */
export function SpeedDialog({ clipIds }: { clipIds: string[] }) {
  const project = projectController.project!
  const sequence = project.sequence
  const rate = frameRateOf(sequence.settings)
  const clips = sequence.clips.filter((c) => clipIds.includes(c.id))
  const first = clips[0]
  const [speedText, setSpeedText] = useState(() => String(first && first.speed > 0 ? Math.round(first.speed * 10000) / 100 : 100))
  const [durationText, setDurationText] = useState(() => (first ? formatTimecode(first.duration, rate) : ''))
  const [reverse, setReverse] = useState(() => clips.length > 0 && clips.every((c) => c.reverse))
  const [ripple, setRipple] = useState(false)
  const speedRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setTimeout(() => speedRef.current?.select(), 0)
  }, [])
  if (!first) return null

  // A hold has no span in its media yet; it gets one at its current length.
  const span = first.speed === 0 ? first.duration : sourceSpan(first)
  const sameLength = clips.every((c) => c.duration === first.duration)
  const frame = frameTicks(sequence)
  const parsedSpeed = Number(speedText) / 100
  const speedValid = Number.isFinite(parsedSpeed) && parsedSpeed >= MIN_SPEED && parsedSpeed <= MAX_SPEED
  const hasSound = clips.some((c) => c.kind === 'audio')

  const onSpeed = (text: string) => {
    setSpeedText(text)
    const speed = Number(text) / 100
    if (Number.isFinite(speed) && speed >= MIN_SPEED && speed <= MAX_SPEED) setDurationText(formatTimecode(Math.max(frame, toFrame(span / speed, frame, 'floor')), rate))
  }
  const onDuration = (text: string) => {
    setDurationText(text)
    const duration = parseTimecode(text, rate)
    if (duration && duration > 0) setSpeedText(String(Math.round((span / duration) * 10000) / 100))
  }
  const close = () => tl.closeSpeedDialog()
  const submit = () => {
    if (!speedValid) return
    close()
    tl.run(setClipSpeed({ clipIds, speed: parsedSpeed, reverse, ripple }, project.media))
  }

  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
      >
        <h2>Clip Speed / Duration</h2>
        <div className="modal-body">
          <label className="field">
            <span>Speed</span>
            <span className="field-unit">
              <input ref={speedRef} className="input" value={speedText} onChange={(e) => onSpeed(e.target.value)} inputMode="decimal" autoFocus />%
            </span>
          </label>
          <label className="field">
            <span>Duration</span>
            <input className="input mono" value={sameLength ? durationText : 'Mixed'} disabled={!sameLength} onChange={(e) => onDuration(e.target.value)} />
          </label>
          <label className="field-row">
            <input type="checkbox" checked={reverse} onChange={(e) => setReverse(e.target.checked)} /> Reverse Speed
          </label>
          <label className="field-row">
            <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} /> Ripple Edit, Shifting Trailing Clips
          </label>
          {!speedValid && <p className="modal-note error">Speed must be between {MIN_SPEED * 100}% and {MAX_SPEED * 100}%.</p>}
          {hasSound && (
            <p className="modal-note">
              Sound changes pitch at other speeds, like tape (Maintain Audio Pitch is planned). Reversed sound is silent for now.
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!speedValid}>
            OK
          </button>
        </div>
      </form>
    </div>
  )
}
