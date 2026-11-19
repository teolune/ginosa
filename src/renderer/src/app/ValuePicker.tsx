import { useState } from 'react'
import type { PropertyRef } from '@engine/keyframes/properties'
import type { Clip, Sequence } from '@engine/project/model'
import { effectLabel, linkableValues } from '@engine/timeline/rack-links'
import { timelineController } from '../timeline/timeline-controller'

/**
 * Picks a value on any clip (decisions 127 and 129): the clips' effects, Motion and Opacity (and
 * an audio clip's Volume), the selected clips first, then adjustment layers, then the rest from
 * the top track down; with a search. A channel's window and the automation editor use it.
 */

const MAX_LISTED = 60

function pickableClips(sequence: Sequence): Clip[] {
  const selected = timelineController.selection
  const order = new Map(sequence.tracks.map((t, i) => [t.id, i]))
  const rank = (c: Clip) => (selected.has(c.id) ? 0 : c.adjustment ? 1 : c.kind === 'video' ? 2 : 3)
  return sequence.clips
    .filter((c) => c.kind === 'video' || c.kind === 'audio')
    .sort((a, b) => rank(a) - rank(b) || (order.get(b.trackId) ?? 0) - (order.get(a.trackId) ?? 0) || a.start - b.start)
}

export function trackName(sequence: Sequence, clip: Clip): string {
  return sequence.tracks.find((t) => t.id === clip.trackId)?.name ?? ''
}

export function ValuePicker({
  sequence,
  targetName,
  linked,
  onPick
}: {
  sequence: Sequence
  targetName: string
  linked: (clip: Clip, effectId: string | null, param: string) => boolean
  onPick: (ref: PropertyRef) => void
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const needle = query.trim().toLowerCase()
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle)
  const entries = pickableClips(sequence).flatMap((clip) =>
    [null, ...clip.effects.map((e) => e.id)].map((effectId) => ({ clip, effectId, name: effectLabel(clip, effectId), values: linkableValues(clip, effectId) }))
  )
  const shown = entries.filter((e) => e.values.length > 0 && (matches(`${e.name} ${e.clip.name} ${trackName(sequence, e.clip)}`) || e.values.some((v) => matches(v.label))))
  return (
    <>
      <input className="input compact" placeholder="Search clips, effects and values" aria-label="Search" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
      <div className="channel-picker">
        {shown.length === 0 && <p className="muted small">No clip or effect matches.</p>}
        {shown.slice(0, MAX_LISTED).map((entry) => {
          const key = `${entry.clip.id}:${entry.effectId ?? ''}`
          const open = expanded === key || (needle !== '' && shown.length <= 3)
          return (
            <div key={key} className="channel-pick">
              <button className={`channel-pick-head ${open ? 'open' : ''}`} aria-expanded={open} onClick={() => setExpanded(open ? null : key)}>
                <span className="channel-effect-name-text">{entry.name}</span>
                <span className="muted small">
                  {entry.clip.name} · {trackName(sequence, entry.clip)}
                  {timelineController.selection.has(entry.clip.id) ? ' · selected' : ''}
                </span>
              </button>
              {open && (
                <div className="channel-pick-values">
                  {entry.values.map((value) => {
                    const done = linked(entry.clip, entry.effectId, value.param)
                    return (
                      <button
                        key={value.param}
                        className="button compact"
                        disabled={done}
                        title={done ? `Already linked to ${targetName}` : `Link ${value.label} to ${targetName}`}
                        onClick={() => onPick({ clipId: entry.clip.id, effectId: entry.effectId, param: value.param })}
                      >
                        {value.label}
                        {done ? ' ✓' : ''}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        {shown.length > MAX_LISTED && <p className="muted small">{shown.length - MAX_LISTED} more: type to narrow them down.</p>}
      </div>
    </>
  )
}
