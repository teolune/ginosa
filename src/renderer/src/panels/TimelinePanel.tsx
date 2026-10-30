import { useState } from 'react'
import { addTrack, removeTrack, renameTrack, setTrackFlag } from '@engine/project/commands'
import { frameRateOf, tracksOfKind, type Track } from '@engine/project/model'
import { formatTimecode, secondsToTicks } from '@engine/time'
import { CommitInput } from '../app/CommitInput'
import { projectController } from '../state/project-controller'
import { useObservable } from '../state/observable'

const PIXELS_PER_SECOND = 80
const RULER_SECONDS = 60

function TrackHeader({ track }: { track: Track }) {
  const [editing, setEditing] = useState(false)
  const isVideo = track.kind === 'video'
  const dispatch = projectController.dispatch.bind(projectController)
  return (
    <div className={`track-header ${track.kind} ${track.locked ? 'locked' : ''}`}>
      {editing ? (
        <CommitInput
          className="input track-name-input"
          value={track.name}
          autoFocus
          autoSelect
          onCommit={(name) => dispatch(renameTrack(track.id, name))}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <span className="track-name" title="Double-click to rename" onDoubleClick={() => setEditing(true)}>
          {track.name}
        </span>
      )}
      <span className="spacer" />
      {isVideo ? (
        <button
          className={`toggle ${track.visible ? '' : 'off'}`}
          title={track.visible ? 'Hide track output' : 'Show track output'}
          onClick={() => dispatch(setTrackFlag(track.id, 'visible', !track.visible))}
        >
          {track.visible ? 'Eye' : 'Off'}
        </button>
      ) : (
        <button
          className={`toggle ${track.muted ? 'on warn' : ''}`}
          title={track.muted ? 'Unmute track' : 'Mute track'}
          onClick={() => dispatch(setTrackFlag(track.id, 'muted', !track.muted))}
        >
          M
        </button>
      )}
      <button
        className={`toggle ${track.locked ? 'on' : ''}`}
        title={track.locked ? 'Unlock track' : 'Lock track'}
        onClick={() => dispatch(setTrackFlag(track.id, 'locked', !track.locked))}
      >
        L
      </button>
      <button className="toggle subtle" title={`Delete ${track.name}`} onClick={() => dispatch(removeTrack(track.id))}>
        ×
      </button>
    </div>
  )
}

/** Tracks and ruler. Clips, trimming and editing tools arrive in M3. */
export function TimelinePanel() {
  useObservable(projectController)
  const project = projectController.project
  if (!project) return null
  const sequence = project.sequence
  const rate = frameRateOf(sequence.settings)
  const video = tracksOfKind(sequence, 'video').slice().reverse() // V1 sits nearest the middle, as in Premiere
  const audio = tracksOfKind(sequence, 'audio')
  const width = RULER_SECONDS * PIXELS_PER_SECOND

  return (
    <section className="panel timeline-panel">
      <header className="panel-header">
        <span>Timeline: {sequence.name}</span>
        <span className="muted small timeline-note">Clips, trimming and editing tools arrive in M3</span>
        <span className="spacer" />
        <button className="button compact" onClick={() => projectController.dispatch(addTrack('video'))}>
          + Video track
        </button>
        <button className="button compact" onClick={() => projectController.dispatch(addTrack('audio'))}>
          + Audio track
        </button>
      </header>
      <div className="timeline-body">
        <div className="timeline-grid">
          <div className="ruler-corner mono">{formatTimecode(0, rate)}</div>
          <div className="ruler" style={{ width }}>
            {Array.from({ length: RULER_SECONDS + 1 }, (_, second) => (
              <div key={second} className={`tick ${second % 5 === 0 ? 'major' : ''}`} style={{ left: second * PIXELS_PER_SECOND }}>
                {second % 5 === 0 && <span className="mono">{formatTimecode(secondsToTicks(second), rate).slice(3, 8)}</span>}
              </div>
            ))}
          </div>
          {video.map((track) => (
            <div className="track-row" key={track.id}>
              <TrackHeader track={track} />
              <div className={`track-lane video ${track.visible ? '' : 'dimmed'}`} style={{ width }} />
            </div>
          ))}
          <div className="track-divider" />
          {audio.map((track) => (
            <div className="track-row" key={track.id}>
              <TrackHeader track={track} />
              <div className={`track-lane audio ${track.muted ? 'dimmed' : ''}`} style={{ width }} />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
