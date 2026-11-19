import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { EFFECTS, effectById } from '../../../effects/registry'
import type { EffectManifest } from '@engine/effects/types'
import type { Clip } from '@engine/project/model'
import { renameRackRow } from '@engine/timeline/rack-edits'
import { addChannelEffect, channelEffects, linkToChannel, mainParam, unlinkFromChannel } from '@engine/timeline/rack-links'
import { trackName, ValuePicker } from '../app/ValuePicker'
import { channelModulatorIds } from '@engine/timeline/rack'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { rackUi } from './rack-ui'

/**
 * The channel window (decision 129): double-click a channel's name. Its name, and the effects
 * linked to it, value by value, each with × to unlink. "Link a value…" links a value of an
 * effect already on a clip or adjustment layer; "New effect…" puts an effect from the library
 * on the selected clips (or a new adjustment layer over the whole song) with one of its values
 * linked.
 */

/** The values of an effect a channel can move, from its manifest (Mix last). */
function manifestValues(manifest: EffectManifest): Array<{ id: string; label: string }> {
  return [
    ...manifest.params.filter((p) => (p.type === 'number' || p.type === 'angle' || p.type === 'steps' || p.type === 'point') && p.modulatable !== false).map((p) => ({ id: p.id, label: p.label })),
    { id: 'mix', label: 'Mix' }
  ]
}

export function ChannelWindow() {
  useObservable(projectController)
  useObservable(rackUi)
  useObservable(timelineController)
  const [mode, setMode] = useState<'list' | 'link' | 'new'>('list')
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<{ effectId: string; param: string } | null>(null)
  const sequence = projectController.project?.sequence
  const row = sequence?.rack.rows.find((r) => r.id === rackUi.channelWindow)
  if (!sequence || !row) return null
  const groups = channelEffects(sequence, row.id)
  const modulators = new Set(channelModulatorIds(sequence, row.id))
  const at = timelineController.playhead
  const dispatch = projectController.dispatch.bind(projectController)
  const go = (next: 'list' | 'link' | 'new') => {
    setMode(next)
    setQuery('')
    setChosen(null)
  }
  const close = () => rackUi.openChannelWindow(null)
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (mode !== 'list') go('list')
    else close()
  }
  const rename = (name: string) => {
    const next = name.trim()
    if (next && next !== row.name) dispatch(renameRackRow(row.id, next))
  }
  const show = (clip: Clip) => {
    timelineController.select([clip.id], 'replace')
    workspaceController.open('effect-controls')
  }
  const needle = query.trim().toLowerCase()
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle)
  const selectedVideo = [...timelineController.selection].filter((id) => sequence.clips.some((c) => c.id === id && c.kind === 'video'))

  return (
    <div className="cube-window channel-window" role="dialog" aria-label={`${row.name}: name and effects`} onKeyDown={onKeyDown}>
      <header className="cube-window-head">
        <input
          key={`${row.id}:${row.name}`}
          className="input compact channel-window-name"
          aria-label="Channel name"
          defaultValue={row.name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => rename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="spacer" />
        <button className="window-button close" title="Close (Esc)" onClick={close}>
          ×
        </button>
      </header>

      {mode === 'list' && (
        <>
          <div className="channel-window-label muted small">Effects linked to {row.name}</div>
          {groups.length === 0 && <p className="muted small">Nothing yet. Link a value of an effect that’s already on a clip, or add a new effect.</p>}
          {groups.map((group) => {
            const all = group.values.map((v) => ({ ref: v.ref, linkId: v.link.id }))
            return (
              <div key={`${group.clip.id}:${group.effectId ?? ''}`} className="channel-effect">
                <div className="channel-effect-head">
                  <button className="channel-effect-name" title="Show it in Effect Controls" onClick={() => show(group.clip)}>
                    {group.name}
                  </button>
                  <span className="muted small channel-effect-where">
                    {group.clip.name} · {trackName(sequence, group.clip)}
                  </span>
                  <span className="spacer" />
                  <button className="channel-unlink" aria-label={`Unlink ${group.name} from ${row.name}`} title={`Unlink all of ${group.name} from ${row.name}`} onClick={() => dispatch(unlinkFromChannel(all))}>
                    ×
                  </button>
                </div>
                {group.values.map((value) => (
                  <div key={value.link.id} className="channel-value">
                    <span>{value.label}</span>
                    <span className="spacer" />
                    <button className="channel-unlink" aria-label={`Unlink ${value.label}`} title={`Unlink ${value.label} from ${row.name}`} onClick={() => dispatch(unlinkFromChannel([{ ref: value.ref, linkId: value.link.id }]))}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )
          })}
          <div className="channel-window-actions">
            <button className="button compact" onClick={() => go('link')}>
              + Link a value…
            </button>
            <button className="button compact" onClick={() => go('new')}>
              + New effect…
            </button>
          </div>
          <p className="muted small cube-hint">Or click {row.name}, press R and click the link sockets in Effect Controls. How far each cube pushes a value is in the cube window (double-click a cube).</p>
        </>
      )}

      {mode === 'link' && (
        <>
          <div className="channel-window-label muted small">Link a value to {row.name}</div>
          <ValuePicker
            sequence={sequence}
            targetName={row.name}
            linked={(clip, effectId, param) => (effectId === null ? clip.modulation : clip.effects.find((e) => e.id === effectId)?.modulation)?.[param]?.some((l) => modulators.has(l.modulatorId)) ?? false}
            onPick={(ref) => {
              if (dispatch(linkToChannel(row.id, ref, at))) go('list')
            }}
          />
          <div className="channel-window-actions">
            <button className="button compact" onClick={() => go('list')}>
              Back
            </button>
          </div>
        </>
      )}

      {mode === 'new' && !chosen && (
        <>
          <div className="channel-window-label muted small">New effect for {row.name}</div>
          <input className="input compact" placeholder="Search effects" aria-label="Search effects" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
          <div className="channel-picker">
            {[...new Set(EFFECTS.map((e) => e.category))].map((category) => {
              const effects = EFFECTS.filter((e) => e.category === category && mainParam(e) && matches(`${e.name} ${e.category} ${e.description}`))
              if (effects.length === 0) return null
              return (
                <div key={category} className="channel-pick">
                  <div className="muted small channel-category">{category}</div>
                  {effects.map((effect) => (
                    <button key={effect.id} className="channel-pick-head" title={effect.description} onClick={() => setChosen({ effectId: effect.id, param: mainParam(effect)! })}>
                      <span className="channel-effect-name-text">{effect.name}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
          <div className="channel-window-actions">
            <button className="button compact" onClick={() => go('list')}>
              Back
            </button>
          </div>
        </>
      )}

      {mode === 'new' && chosen && (() => {
        const manifest = effectById(chosen.effectId)
        if (!manifest) return null
        const where =
          selectedVideo.length === 0
            ? 'On a new adjustment layer over the whole song, above everything'
            : selectedVideo.length === 1
              ? `On the selected clip: ${sequence.clips.find((c) => c.id === selectedVideo[0])?.name ?? ''}`
              : `On the ${selectedVideo.length} selected clips`
        return (
          <>
            <div className="channel-window-label muted small">
              {manifest.name}: which value follows {row.name}?
            </div>
            <div className="channel-pick-values channel-params" role="radiogroup" aria-label="Value">
              {manifestValues(manifest).map((value) => (
                <label key={value.id} className="channel-param">
                  <input type="radio" name="channel-param" checked={chosen.param === value.id} onChange={() => setChosen({ ...chosen, param: value.id })} />
                  {value.label}
                </label>
              ))}
            </div>
            <p className="muted small">{where}. Select clips in the timeline first to put it on them instead.</p>
            <div className="channel-window-actions">
              <button className="button compact" onClick={() => setChosen(null)}>
                Back
              </button>
              <button
                className="button compact primary"
                onClick={() => {
                  const command = addChannelEffect({ rowId: row.id, effectId: manifest.id, param: chosen.param, clipIds: selectedVideo, at })
                  if (!dispatch(command)) return
                  if (selectedVideo.length === 0) timelineController.select(command.clipIds, 'replace')
                  go('list')
                }}
              >
                Add {manifest.name}
              </button>
            </div>
          </>
        )
      })()}
    </div>
  )
}
