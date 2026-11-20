import { MULTICAM_KEYS, frameRateOf } from '@engine/project/model'
import { formatTimecode } from '@engine/time'
import { removeMulticamGroup, setAngleKey, setBRoll } from '@engine/timeline/multicam-edits'
import { STATE_AND_PLAYHEAD, PLAYHEAD_THROTTLE, useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { FavouriteStrip } from './FavouriteStrip'
import { CUT_LABELS, multicamUi } from './multicam-ui'
import { syncController } from './sync-controller'

const KEY_LABEL = (key: string) => (key === ',' ? ', (comma)' : key)

/**
 * The Multi-Camera window (W5, decision 134): the group's angles, each on a key, how each take
 * is synced to the song, sync points for takes the song can't be heard in, the multi-camera view
 * and Record; each angle's favourites strip and B-roll (W5.4), and Automatic (W5.5).
 */
export function MulticamWindow() {
  useObservable(projectController)
  useObservable(multicamUi)
  useObservable(syncController)
  useObservable(timelineController, STATE_AND_PLAYHEAD, PLAYHEAD_THROTTLE)
  const sequence = projectController.project?.sequence
  if (!sequence) return null
  const group = multicamUi.group()
  const selectedTakes = sequence.clips.filter((c) => timelineController.selection.has(c.id) && c.kind === 'video' && !c.adjustment && !c.multicam)
  const newGroup = (
    <button className="button" disabled={selectedTakes.length === 0 || multicamUi.busy || syncController.busy} title="Each track holding a selected take becomes an angle; they're synced to the song on A1 by their sound first" onClick={() => void multicamUi.newGroupFromClips(selectedTakes.map((c) => c.id))}>
      New Group from Selected Takes
    </button>
  )
  if (!group) {
    return (
      <div className="multicam-window">
        <p className="muted small">
          Put the song on A1. Then select your takes in the Media panel and right-click › <b>New Multi-Camera Group</b>: each goes on a track of its own, lined up with the song by its sound. Or put the takes on tracks of their own on the timeline, select them, and:
        </p>
        {newGroup}
      </div>
    )
  }
  const results = new Map(syncController.results.map((r) => [r.clipId, r]))
  const recording = multicamUi.recording !== null
  const automaticRange = multicamUi.automaticRange()
  const gaps = multicamUi.gaps.filter((g) => g.groupId === group.id)
  const rate = frameRateOf(sequence.settings)
  const angleLabel = (id: string) => {
    const angle = group.angles.find((a) => a.id === id)
    return sequence.tracks.find((t) => t.id === angle?.trackId)?.name ?? 'The angle before'
  }
  return (
    <div className="multicam-window">
      <div className="multicam-head">
        {sequence.multicam.length > 1 ? (
          <select className="input compact" value={group.id} aria-label="Group" onChange={(e) => multicamUi.choose(e.target.value)}>
            {sequence.multicam.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="multicam-name">{group.name}</span>
        )}
        <span className="spacer" />
        <button className={`button compact ${multicamUi.view ? 'active' : ''}`} aria-pressed={multicamUi.view} title="Every angle in a grid in the Program monitor" onClick={() => multicamUi.setView(!multicamUi.view)}>
          Multi-Camera View
        </button>
        <button className={`button compact multicam-record ${recording ? 'on' : ''}`} title={recording ? 'Stop recording (Space)' : 'Record: the song plays from the playhead; press an angle’s key to cut to it'} onClick={() => multicamUi.record()}>
          {recording ? '■ Stop' : '● Record'}
        </button>
      </div>
      <p className="muted small multicam-hint">
        {recording
          ? 'Recording: press an angle’s key to cut to it. Space or Stop writes the cuts.'
          : 'Press an angle’s key (1–9, 0, comma) to switch the selected pieces, or the piece under the playhead. Record to cut live while the song plays.'}
      </p>
      <div className="multicam-angles" role="table" aria-label="Angles">
        {group.angles.map((angle) => {
          const track = sequence.tracks.find((t) => t.id === angle.trackId)
          const takes = sequence.clips.filter((c) => c.trackId === angle.trackId && c.kind === 'video' && !c.adjustment)
          const sync = takes.map((c) => results.get(c.id)).find(Boolean)
          const marked = multicamUi.syncMark && takes.some((c) => c.id === multicamUi.syncMark!.clipId)
          return (
            <div key={angle.id} className={`multicam-angle ${multicamUi.live === angle.id ? 'live' : ''}`} role="row">
              <select className="input compact multicam-key mono" value={angle.key} aria-label={`${track?.name ?? 'Angle'} key`} onChange={(e) => projectController.dispatch(setAngleKey(group.id, angle.id, e.target.value))}>
                {MULTICAM_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {KEY_LABEL(k)}
                  </option>
                ))}
              </select>
              <span className="multicam-track" title={takes.map((c) => c.name).join(', ')}>
                {track?.name ?? 'Angle'}
                {/* The take's name when the track's is another. */}
                {(takes.length !== 1 || takes[0]!.name !== track?.name) && <span className="muted small"> · {takes.length === 1 ? takes[0]!.name : `${takes.length} takes`}</span>}
              </span>
              {sync && !angle.bRoll && <span className={`status-pill ${sync.outcome === 'sure' ? 'ok' : sync.outcome === 'unsure' ? 'warn' : 'bad'}`} title={sync.detail}>{sync.outcome === 'sure' ? 'In sync' : sync.outcome === 'unsure' ? 'Check' : 'Not heard'}</span>}
              <span className="spacer" />
              <button className={`button compact ${angle.bRoll ? 'active' : ''}`} aria-pressed={angle.bRoll} title={angle.bRoll ? 'B-roll: Automatic puts its favourites wherever nothing synced covers. Click to make it synced again' : 'Make this angle B-roll: not tied to the song, its favourites go wherever nothing synced covers'} onClick={() => projectController.dispatch(setBRoll(group.id, angle.id, !angle.bRoll))}>
                B-Roll
              </button>
              {angle.bRoll ? null : marked ? (
                <button className="button compact" title="Moves the take so the moment you marked is at the playhead (put the playhead where the song has it)" onClick={() => multicamUi.lineUpHere()}>
                  Line Up Here
                </button>
              ) : (
                <button className="button compact" title="Sync by hand: put the playhead on a moment in this take (a clap, a beat) and mark it; then put the playhead where the song has that moment and Line Up Here" onClick={() => multicamUi.markSyncPoint(angle.trackId)}>
                  Sync Point
                </button>
              )}
              <FavouriteStrip group={group} angle={angle} />
            </div>
          )
        })}
      </div>
      <div className="multicam-auto">
        <b>Automatic</b>
        <label className="small">
          Cut every{' '}
          <select className="input compact" value={multicamUi.cutEvery} aria-label="Cut every" onChange={(e) => multicamUi.setCutEvery(e.target.value)}>
            {Object.entries(CUT_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="small" title="Fill what no synced favourite covers with your B-roll favourites, each in turn">
          <input type="checkbox" checked={multicamUi.useBRoll} onChange={(e) => multicamUi.setUseBRoll(e.target.checked)} /> Use B-roll
        </label>
        <span className="spacer" />
        <button className="button compact primary" disabled={!automaticRange || recording} title={automaticRange ? `Cuts ${automaticRange.label} between the favourite parts you marked, on the beat (one undo step); what was on ${group.name} there goes` : 'Put the song on A1, or set In and Out'} onClick={() => multicamUi.automatic()}>
          Make the Edit {automaticRange ? <span className="muted">{automaticRange.label}</span> : null}
        </button>
      </div>
      {gaps.length > 0 && (
        <div className="multicam-gaps" role="list" aria-label="Gaps">
          <span className="small">Nothing you marked covers:</span>
          {gaps.map((g) => (
            <button key={g.from} role="listitem" className="button compact gap" title={g.hold ? `${angleLabel(g.hold)} holds here. Mark a favourite that covers it, or use B-roll, and Make the Edit again` : 'Nothing holds here. Mark a favourite that covers it, or use B-roll, and Make the Edit again'} onClick={() => timelineController.setPlayhead(g.from)}>
              {formatTimecode(g.from, rate)}–{formatTimecode(g.to, rate)}
            </button>
          ))}
          <button className="button compact" title="Stop flagging these" onClick={() => multicamUi.clearGaps()}>
            Clear
          </button>
        </div>
      )}
      <div className="multicam-foot">
        <button className="button compact" disabled={syncController.busy || !syncController.song()} title="Line every take up with the song on A1 by its sound" onClick={() => {
          const ids = sequence.clips.filter((c) => group.angles.some((a) => a.trackId === c.trackId) && c.kind === 'video').map((c) => c.id)
          void syncController.syncToSong(ids).then((r) => projectController.showMessage(syncController.summary(r)), (e: Error) => projectController.showMessage(e.message))
        }}>
          {syncController.busy ? 'Listening…' : 'Sync Takes to Song'}
        </button>
        {newGroup}
        <span className="spacer" />
        <button className="button compact" title="The pieces stay as ordinary clips; the angles' tracks stay as they are" onClick={() => projectController.dispatch(removeMulticamGroup(group.id))}>
          Remove Group
        </button>
      </div>
    </div>
  )
}
