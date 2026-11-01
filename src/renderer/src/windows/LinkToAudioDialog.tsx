import { useEffect, useState } from 'react'
import { BANDS, type BandId } from '@engine/audio/analysis'
import { propertySpec } from '@engine/keyframes/properties'
import type { AudioSignal } from '@engine/modulation/types'
import { linkToAudio } from '@engine/timeline/modulation-edits'
import { modulationUi } from '../audio/modulation-ui'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'

/** What Link to Audio offers: a band's level, or the whole sound's loudness or peak, or a band's transients or hits. */
const CHOICES: Array<{ id: string; label: string; signal: AudioSignal; band: BandId }> = [
  ...BANDS.map((b) => ({ id: `level:${b.id}`, label: `${b.label} level`, signal: 'level' as const, band: b.id })),
  { id: 'loudness', label: 'Loudness', signal: 'loudness', band: 'bass' },
  { id: 'peak', label: 'Peak', signal: 'peak', band: 'bass' },
  ...BANDS.map((b) => ({ id: `transient:${b.id}`, label: `${b.label} transients`, signal: 'transient' as const, band: b.id })),
  ...BANDS.map((b) => ({ id: `hits:${b.id}`, label: `${b.label} hits (flash on each)`, signal: 'hits' as const, band: b.id }))
]

/** Right-click › Link to Audio: pick a source and what to follow in it (e.g. "Song · Bass"). */
export function LinkToAudioDialog() {
  useObservable(modulationUi)
  const ref = modulationUi.linkToAudio
  const project = projectController.project
  const sources = project?.sequence.audioSources ?? []
  const [sourceId, setSourceId] = useState('')
  const [choice, setChoice] = useState('level:bass')
  useEffect(() => {
    if (ref) setSourceId((id) => (sources.some((s) => s.id === id) ? id : (sources[0]?.id ?? '')))
  }, [ref])
  if (!ref || !project) return null
  const clip = project.sequence.clips.find((c) => c.id === ref.clipId)
  const spec = clip ? propertySpec(clip, ref.effectId, ref.param) : null
  const close = () => modulationUi.openLinkToAudio(null)
  const link = () => {
    const picked = CHOICES.find((c) => c.id === choice)
    if (!picked || !sourceId) return
    if (projectController.dispatch(linkToAudio(ref, sourceId, picked.signal, picked.band, timelineController.playhead))) close()
  }
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault()
          link()
        }}
        onKeyDown={(event) => event.key === 'Escape' && close()}
      >
        <h2>Link {spec?.label ?? 'value'} to Audio</h2>
        {sources.length === 0 ? (
          <p className="muted">
            There's no sound to follow yet. Add your song (or a drum stem) as a source in Audio Analysis first.
          </p>
        ) : (
          <>
            <label className="field">
              <span>Source</span>
              <select className="input" value={sourceId} onChange={(event) => setSourceId(event.target.value)} autoFocus>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Follow</span>
              <select className="input" value={choice} onChange={(event) => setChoice(event.target.value)}>
                {CHOICES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small">
              It reacts within 5 ms and falls back over 150 ms, from the value as it is now. Shape it in the Modulation window (⌥⇧2).
            </p>
          </>
        )}
        <div className="modal-actions">
          {sources.length === 0 && (
            <button type="button" className="button" onClick={() => (close(), workspaceController.open('audio-analysis'), workspaceController.focus('audio-analysis'))}>
              Open Audio Analysis
            </button>
          )}
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          {sources.length > 0 && (
            <button type="submit" className="button primary">
              Link
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
