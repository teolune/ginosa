import { useEffect, useRef, useState } from 'react'
import { projectController } from '../state/project-controller'
import { warnings } from './warnings'
import { useObservable } from '../state/observable'

function formatTime(iso: string | null): string {
  if (!iso) return 'unknown time'
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })
}

/** Offered when a project is opened after ginosa quit unexpectedly. */
export function RecoveryDialog() {
  useObservable(projectController)
  const recovery = projectController.recovery
  if (!recovery) return null
  const changes = recovery.changeCount
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true">
        <h2>Restore unsaved changes?</h2>
        <p>ginosa didn't close properly the last time this project was open.</p>
        <p className="muted">
          {changes > 0
            ? `${changes} change${changes === 1 ? '' : 's'} after the last save, the most recent at ${formatTime(recovery.lastChangeAt)}.`
            : `An autosave from ${formatTime(recovery.baseSavedAt)} is newer than the saved project.`}
        </p>
        <div className="modal-actions">
          <button className="button" onClick={() => void projectController.resolveRecovery(false)}>
            Open last saved version
          </button>
          <button className="button primary" autoFocus onClick={() => void projectController.resolveRecovery(true)}>
            Restore changes
          </button>
        </div>
      </div>
    </div>
  )
}

export interface PromptRequest {
  title: string
  label: string
  initial: string
  confirm: string
  resolve(value: string | null): void
}

/** A small in-app text prompt (e.g. Save Workspace As…). */
export function PromptDialog({ request }: { request: PromptRequest | null }) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (request) {
      setValue(request.initial)
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [request])
  if (!request) return null
  const submit = () => request.resolve(value.trim() ? value.trim() : null)
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
          if (event.key === 'Escape') request.resolve(null)
        }}
      >
        <h2>{request.title}</h2>
        <label className="field">
          <span>{request.label}</span>
          <input ref={inputRef} className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </label>
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => request.resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!value.trim()}>
            {request.confirm}
          </button>
        </div>
      </form>
    </div>
  )
}

/** A warning before something is removed, with "Don't ask me again" (decision 42). */
export function WarningDialog() {
  useObservable(warnings)
  const [dontAsk, setDontAsk] = useState(false)
  const request = warnings.request
  useEffect(() => setDontAsk(false), [request])
  if (!request) return null
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="alertdialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault()
          request.resolve(true, dontAsk)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') request.resolve(false, false)
        }}
      >
        <h2>{request.title}</h2>
        <p>{request.message}</p>
        {request.silenceable && (
          <label className="check-row">
            <input type="checkbox" checked={dontAsk} onChange={(event) => setDontAsk(event.target.checked)} />
            <span>Don’t ask me again</span>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={() => request.resolve(false, false)}>
            Cancel
          </button>
          <button type="submit" className="button primary" autoFocus>
            {request.confirm}
          </button>
        </div>
      </form>
    </div>
  )
}

/** A dismissable message for refused edits (e.g. deleting the last audio track). */
export function ErrorToast() {
  useObservable(projectController)
  const message = projectController.lastError
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => projectController.clearError(), 5000)
    return () => clearTimeout(timer)
  }, [message])
  if (!message) return null
  return (
    <div className="toast" role="status" onClick={() => projectController.clearError()}>
      {message}
    </div>
  )
}
