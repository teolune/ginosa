import { MULTICAM_KEYS, frameRateOf, type MulticamAngle, type MulticamGroup, type Sequence } from '@engine/project/model'
import { formatTimecode } from '@engine/time'
import { angleName, removeMulticamGroup, setAngleKey, setBRoll } from '@engine/timeline/multicam-edits'
import { trackIndex } from '@engine/timeline/timeline'
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { Icon } from '../app/Icon'
import { mediaSelection } from '../media-panel/selection'
import { player } from '../playback/player'
import { STATE_AND_PLAYHEAD, PLAYHEAD_THROTTLE, useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { FavouriteStrip } from './FavouriteStrip'
import { MulticamOverlay } from './MulticamOverlay'
import { CUT_LABELS, multicamUi } from './multicam-ui'
import { syncController } from './sync-controller'

type Menu = { x: number; y: number; items: MenuEntry[] }

/** A clip's label: its take's name and its track, "take_a (V2)". */
function clipLabel(sequence: Sequence, angle: MulticamAngle): string {
  const track = sequence.tracks.find((t) => t.id === angle.trackId)
  const takes = sequence.clips.filter((c) => c.trackId === angle.trackId && c.kind === 'video' && !c.adjustment && !c.multicam)
  const name = takes.length === 1 ? takes[0]!.name : takes.length > 1 ? `${angleName(sequence, angle)} · ${takes.length} takes` : angleName(sequence, angle)
  return track ? `${name} (V${trackIndex(sequence, track) + 1})` : name
}

/** The window's preview: the Program monitor's picture (each frame drawn once, shown on both), with the clips' labels over the grid. */
function MulticamPreview() {
  useObservable(player)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sequence = projectController.project?.sequence
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    void player.attachMirror(canvas)
    return () => player.detachMirror(canvas)
  }, [])
  if (!sequence) return null
  const { width, height } = sequence.settings
  const group = multicamUi.group(sequence)
  const solo = group?.angles.find((a) => a.id === multicamUi.solo)
  const pending = multicamUi.pendingIn
  return (
    <div className="monitor-area mc-preview">
      <div className="monitor-frame" style={{ aspectRatio: `${width} / ${height}`, ['--ar' as string]: width / height }}>
        <canvas ref={canvasRef} className="monitor-canvas" width={width} height={height} />
        <MulticamOverlay />
        {solo && (
          <span className="mc-preview-label mono">
            {solo.key} · {clipLabel(sequence, solo)}
            {multicamUi.marking && (pending ? ` · in at ${timelineController.timecode(pending.at)}: M for the out` : ' · M marks the in')}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The Multi-Camera window (W5, decision 134), as your design of 20 Nov: a preview with its
 * controls (Record, Play/Pause, full screen on the right), Add Clip + and Mark Clip, then each
 * clip with its key, its solo and its strip of favourite parts. Automatic and the gaps it leaves
 * are under the clips.
 */
export function MulticamWindow() {
  useObservable(projectController)
  useObservable(multicamUi)
  useObservable(syncController)
  useObservable(player, ['state'])
  useObservable(timelineController, STATE_AND_PLAYHEAD, PLAYHEAD_THROTTLE)
  const [menu, setMenu] = useState<Menu | null>(null)
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => {
    multicamUi.windowShown(true)
    return () => multicamUi.windowShown(false)
  }, [])
  const sequence = projectController.project?.sequence
  if (!sequence) return null
  const group = multicamUi.group()
  const recording = multicamUi.recording !== null
  const at = (event: ReactMouseEvent) => {
    const r = event.currentTarget.getBoundingClientRect()
    return { x: r.left, y: r.bottom + 4 }
  }

  const fullScreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void top.current?.requestFullscreen().catch((error: Error) => projectController.showMessage(`Full screen didn't start: ${error.message}`))
  }

  // Add Clip +: the selected timeline clips, the Media panel's selected files, or a whole video track.
  const addMenu = (event: ReactMouseEvent) => {
    const timeline = sequence.clips.filter((c) => timelineController.selection.has(c.id) && c.kind === 'video' && !c.adjustment && !c.multicam)
    const files = projectController.project!.media.filter((m) => mediaSelection.ids.includes(m.id) && m.kind === 'video')
    const used = new Set([...sequence.multicam.map((g) => g.programTrackId), ...(group?.angles.map((a) => a.trackId) ?? [])])
    const tracks = sequence.tracks.filter((t) => t.kind === 'video' && !used.has(t.id))
    const items: MenuEntry[] = [
      { label: timeline.length ? `Selected on the Timeline (${timeline.length})` : 'Selected on the Timeline', disabled: timeline.length === 0, onSelect: () => void multicamUi.addClips(timeline.map((c) => c.id)) },
      { label: files.length ? `Selected in the Media Panel (${files.length})` : 'Selected in the Media Panel', disabled: files.length === 0 || multicamUi.busy, onSelect: () => void multicamUi.addMedia(files.map((m) => m.id)) },
      ...(tracks.length ? (['separator'] as MenuEntry[]) : []),
      ...tracks.map((t): MenuEntry => {
        const takes = sequence.clips.filter((c) => c.trackId === t.id && c.kind === 'video' && !c.adjustment)
        const name = `V${trackIndex(sequence, t) + 1}`
        return { label: `${name}${t.name !== name ? ` · ${t.name}` : ''}${takes.length ? '' : ' (empty)'}`, disabled: takes.length === 0, onSelect: () => void multicamUi.addTrack(t.id) }
      })
    ]
    setMenu({ ...at(event), items })
  }

  const groupMenu = (event: ReactMouseEvent) => {
    if (!group) return
    const items: MenuEntry[] = [
      ...sequence.multicam.map((g): MenuEntry => ({ label: `${g.id === group.id ? '✓ ' : '   '}${g.name}`, onSelect: () => multicamUi.choose(g.id) })),
      'separator',
      {
        label: syncController.busy ? 'Listening…' : 'Sync All Clips to the Song',
        disabled: syncController.busy || !syncController.song(),
        onSelect: () => {
          const ids = sequence.clips.filter((c) => group.angles.some((a) => a.trackId === c.trackId && !a.bRoll) && c.kind === 'video').map((c) => c.id)
          void syncController.syncToSong(ids).then((r) => projectController.showMessage(syncController.summary(r)), (e: Error) => projectController.showMessage(e.message))
        }
      },
      { label: 'Clear Gap Flags', disabled: multicamUi.gaps.length === 0, onSelect: () => multicamUi.clearGaps() },
      'separator',
      { label: `Remove ${group.name}`, danger: true, onSelect: () => projectController.dispatch(removeMulticamGroup(group.id)) }
    ]
    setMenu({ ...at(event), items })
  }

  const controls = (
    <div className="mc-controls">
      <button className={`mc-square mc-record ${recording ? 'on' : ''}`} disabled={!group} title={recording ? 'Stop recording (Space): writes the cuts onto the timeline' : 'Record: the song plays from the playhead; press a clip’s key (1–9, 0) to cut to it. The cuts go onto the timeline, to fix later'} aria-label={recording ? 'Stop recording' : 'Record'} onClick={() => multicamUi.record()}>
        <span className="mc-record-dot" />
      </button>
      <button className={`mc-square mc-play ${player.playing ? 'on' : ''}`} title={player.playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={player.playing ? 'Pause' : 'Play'} onClick={() => player.toggle()}>
        <Icon name={player.playing ? 'pause' : 'play'} fallback={player.playing ? '❚❚' : '▶'} />
      </button>
      <span className="mc-transport">
        <button className="tool-button" title="Go to the start (Home)" aria-label="Go to the start" onClick={() => timelineController.gotoEnd(false)}>
          <Icon name="goToStart" fallback="⏮︎" />
        </button>
        <button className="tool-button" title="Back one frame (←)" aria-label="Back one frame" onClick={() => timelineController.stepFrames(-1)}>
          <Icon name="stepBack" fallback="◀︎" />
        </button>
        <button className="tool-button" title="Forward one frame (→)" aria-label="Forward one frame" onClick={() => timelineController.stepFrames(1)}>
          <Icon name="stepForward" fallback="▶︎" />
        </button>
        <button className="tool-button" title="Go to the end (End)" aria-label="Go to the end" onClick={() => timelineController.gotoEnd(true)}>
          <Icon name="goToEnd" fallback="⏭︎" />
        </button>
      </span>
      <span className="mono timecode">{timelineController.timecode(timelineController.playhead)}</span>
      <span className="spacer" />
      {group && (
        <button className={`tool-button ${multicamUi.view && !multicamUi.solo ? 'active' : ''}`} disabled={Boolean(multicamUi.solo)} title={multicamUi.solo ? 'A clip is soloed: un-solo it to see them all' : multicamUi.view ? 'Showing every clip: click to see the edit' : 'Showing the edit: click to see every clip in a grid'} aria-label="Grid" onClick={() => multicamUi.setView(!multicamUi.view)}>
          <Icon name="channelRack" fallback="▦" />
        </button>
      )}
      <button className="tool-button" title="Full screen (Esc to leave)" aria-label="Full screen" onClick={fullScreen}>
        <Icon name="fullscreen" fallback="⤢" />
      </button>
    </div>
  )

  const actions = (
    <div className="mc-actions">
      <button className="button mc-wide" disabled={multicamUi.busy || syncController.busy} title="Add clips: the ones selected on the timeline or in the Media panel, or a whole video track. Each is lined up with the song on A1 by its sound" onClick={addMenu}>
        {multicamUi.busy || syncController.busy ? 'Listening…' : 'Add Clip +'}
      </button>
      <button className={`button mc-wide ${multicamUi.marking ? 'on' : ''}`} disabled={!group || recording} aria-pressed={multicamUi.marking} title={multicamUi.marking ? 'Marking: M marks the soloed clip’s in, then its out. Click to stop' : 'Mark Clip: the soloed clip plays in the preview, and M marks its favourite parts (in, then out). With none soloed, the next clip with nothing marked is'} onClick={() => multicamUi.toggleMarking()}>
        Mark Clip
      </button>
      <span className="spacer" />
      {group && (
        <button className="tool-button" title={`${group.name}: sync, remove${sequence.multicam.length > 1 ? ', other groups' : ''}`} aria-label="Group" onClick={groupMenu}>
          ⋯
        </button>
      )}
    </div>
  )

  return (
    <div className="multicam-window">
      <div className="mc-top" ref={top}>
        <MulticamPreview />
        {controls}
      </div>
      {actions}
      {!group ? (
        <p className="muted small mc-empty">
          Put the song on A1, then add your takes: <b>Add Clip +</b> here, or right-click a clip on the timeline (or a file in the Media panel) › <b>Add to Multi-Camera</b>. Each goes on a key, 1–9 and 0, lined up with the song by its sound.
        </p>
      ) : (
        <>
          <div className="mc-clips" role="list" aria-label="Clips">
            {group.angles.map((angle) => (
              <ClipRow key={angle.id} sequence={sequence} group={group} angle={angle} onMenu={setMenu} />
            ))}
          </div>
          <AutomaticRow group={group} />
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** A clip: its label, then its key, its solo and its strip. Right-click for B-roll, a sync point, removing it. */
function ClipRow({ sequence, group, angle, onMenu }: { sequence: Sequence; group: MulticamGroup; angle: MulticamAngle; onMenu(menu: Menu): void }) {
  const takes = sequence.clips.filter((c) => c.trackId === angle.trackId && c.kind === 'video' && !c.adjustment)
  const sync = takes.map((c) => syncController.results.find((r) => r.clipId === c.id)).find(Boolean)
  const marked = multicamUi.syncMark && takes.some((c) => c.id === multicamUi.syncMark!.clipId)
  const soloed = multicamUi.solo === angle.id
  const label = clipLabel(sequence, angle)
  const rowMenu = (event: ReactMouseEvent) => {
    event.preventDefault()
    onMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: soloed ? 'Un-solo' : 'Solo', onSelect: () => multicamUi.setSolo(angle.id) },
        { label: angle.bRoll ? '✓ B-Roll' : 'B-Roll', onSelect: () => projectController.dispatch(setBRoll(group.id, angle.id, !angle.bRoll)) },
        'separator',
        marked ? { label: 'Line Up Here', onSelect: () => multicamUi.lineUpHere() } : { label: 'Sync Point', disabled: angle.bRoll, onSelect: () => multicamUi.markSyncPoint(angle.trackId) },
        'separator',
        { label: 'Remove from Multi-Camera', danger: true, onSelect: () => multicamUi.removeAngle(angle.id) }
      ]
    })
  }
  const keyMenu = (event: ReactMouseEvent) => {
    const r = event.currentTarget.getBoundingClientRect()
    onMenu({
      x: r.left,
      y: r.bottom + 4,
      items: MULTICAM_KEYS.map((k): MenuEntry => {
        const other = group.angles.find((a) => a.key === k && a.id !== angle.id)
        return { label: `${k === angle.key ? '✓ ' : ''}${k}${other ? ` (swap with ${clipLabel(sequence, other)})` : ''}`, onSelect: () => projectController.dispatch(setAngleKey(group.id, angle.id, k)) }
      })
    })
  }
  return (
    <div className={`mc-clip ${multicamUi.live === angle.id ? 'live' : ''} ${soloed ? 'soloed' : ''}`} role="listitem" onContextMenu={rowMenu}>
      <div className="mc-clip-label">
        <span className="mc-clip-name" title={takes.map((c) => c.name).join(', ')}>
          {label}
        </span>
        {angle.bRoll && <span className="status-pill">B-roll</span>}
        {sync && !angle.bRoll && <span className={`status-pill ${sync.outcome === 'sure' ? 'ok' : sync.outcome === 'unsure' ? 'warn' : 'bad'}`} title={sync.detail}>{sync.outcome === 'sure' ? 'In sync' : sync.outcome === 'unsure' ? 'Check' : 'Not heard'}</span>}
        {marked && (
          <button className="button compact" title="Moves the take so the moment you marked is at the playhead (put the playhead where the song has it)" onClick={() => multicamUi.lineUpHere()}>
            Line Up Here
          </button>
        )}
      </div>
      <div className="mc-clip-row">
        <button className="mc-square mc-key mono" title={`Its key: press ${angle.key} to cut to it (while recording) or to switch pieces to it. Click to change`} aria-label={`${label} key ${angle.key}`} onClick={keyMenu}>
          {angle.key}
        </button>
        <button className={`mc-square mc-solo ${soloed ? 'on' : ''}`} aria-pressed={soloed} title={soloed ? 'Soloed: only this clip plays in the preview, and Mark Clip marks it. Click to un-solo' : 'Solo: only this clip in the preview, to mark its favourite parts'} aria-label={`Solo ${label}`} onClick={() => multicamUi.setSolo(angle.id)}>
          <span className="mc-solo-dot" />
        </button>
        <FavouriteStrip group={group} angle={angle} />
      </div>
    </div>
  )
}

/** Automatic (W5.5): cut between the favourite parts on the beat; the stretches nothing covers listed. */
function AutomaticRow({ group }: { group: MulticamGroup }) {
  const sequence = projectController.project!.sequence
  const range = multicamUi.automaticRange()
  const gaps = multicamUi.gaps.filter((g) => g.groupId === group.id)
  const rate = frameRateOf(sequence.settings)
  const name = (id: string | null) => {
    const angle = group.angles.find((a) => a.id === id)
    return angle ? clipLabel(sequence, angle) : null
  }
  return (
    <>
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
        <label className="small" title="Fill what no synced favourite part covers with B-roll clips' favourite parts, each in turn">
          <input type="checkbox" checked={multicamUi.useBRoll} onChange={(e) => multicamUi.setUseBRoll(e.target.checked)} /> Use B-roll
        </label>
        <span className="spacer" />
        <button className="button compact primary" disabled={!range || multicamUi.recording !== null} title={range ? `Cuts ${range.label} between the favourite parts you marked, on the beat (one undo step); what was on ${group.name} there goes` : 'Put the song on A1, or set In and Out'} onClick={() => multicamUi.automatic()}>
          Make the Edit {range ? <span className="muted">{range.label}</span> : null}
        </button>
      </div>
      {gaps.length > 0 && (
        <div className="multicam-gaps" role="list" aria-label="Gaps">
          <span className="small">Nothing marked covers:</span>
          {gaps.map((g) => (
            <button key={g.from} role="listitem" className="button compact gap" title={`${name(g.hold) ? `${name(g.hold)} holds here. ` : ''}Mark a favourite part that covers it, or use B-roll, and Make the Edit again`} onClick={() => timelineController.setPlayhead(g.from)}>
              {formatTimecode(g.from, rate)}–{formatTimecode(g.to, rate)}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
