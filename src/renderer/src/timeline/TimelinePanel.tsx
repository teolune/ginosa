import { useEffect, useLayoutEffect, useReducer, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { produce } from 'immer'
import { addTrack, CommandError, removeTrack, renameTrack, setTrackFlag, type Command } from '@engine/project/commands'
import type { MediaItem } from '@engine/project/media'
import { frameRateOf, type Sequence, type Track } from '@engine/project/model'
import { frameRateValue, parseTimecode, ticksToSeconds, type Ticks } from '@engine/time'
import { applyPlace, removeMarkers, renameMarker, rippleDeleteClips, deleteClips, rippleDeleteGap, type EditMode } from '@engine/timeline/edits'
import { snapTargets, snapTime } from '@engine/timeline/snapping'
import { EditContext, clipEnd, sequenceEnd, toFrame, trackIndex, tracksOf } from '@engine/timeline/timeline'
import { CommitInput } from '../app/CommitInput'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { Icon } from '../app/Icon'
import { mediaController } from '../state/media-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { drawTimeline } from './draw'
import { MEDIA_DRAG_TYPE, SOURCE_DRAG_TYPE } from './drag-types'
import { RULER_HEIGHT, SNAP_PIXELS, layoutRows, pixelsToTicks, rowAt, xToTime, type Row } from './geometry'
import { TimelineInteraction, hitTest, type Hit } from './interaction'
import { TOOLS, timelineController as tl, type Tool } from './timeline-controller'
import type { SymbolName } from '@shared/symbols'

const HEADER_WIDTH = 196

const TOOL_ICONS: Record<Tool, SymbolName> = {
  select: 'toolSelect',
  forward: 'toolForward',
  backward: 'toolBackward',
  ripple: 'toolRipple',
  roll: 'toolRoll',
  razor: 'toolRazor'
}

function TrackHeader({ track, row, onMenu }: { track: Track; row: Row; onMenu(event: ReactMouseEvent, track: Track): void }) {
  const [editing, setEditing] = useState(false)
  const isVideo = track.kind === 'video'
  const dispatch = (command: Command) => projectController.dispatch(command)
  return (
    <div
      className={`track-header ${track.kind} ${track.locked ? 'locked' : ''}`}
      style={{ top: RULER_HEIGHT + row.top - tl.scrollY, height: row.height }}
      onContextMenu={(event) => onMenu(event, track)}
    >
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
        <button className={`toggle ${track.visible ? '' : 'off'}`} title={track.visible ? 'Hide track output' : 'Show track output'} onClick={() => dispatch(setTrackFlag(track.id, 'visible', !track.visible))}>
          <Icon name={track.visible ? 'eye' : 'eyeSlash'} fallback={track.visible ? 'Eye' : 'Off'} />
        </button>
      ) : (
        <button className={`toggle ${track.muted ? 'on warn' : ''}`} title={track.muted ? 'Unmute track' : 'Mute track'} onClick={() => dispatch(setTrackFlag(track.id, 'muted', !track.muted))}>
          <Icon name={track.muted ? 'speakerSlash' : 'speaker'} fallback="M" />
        </button>
      )}
      <button
        className={`toggle ${track.solo ? 'on warn' : ''}`}
        title={track.solo ? 'Unsolo' : isVideo ? 'Solo: see only soloed video tracks' : 'Solo: hear only soloed audio tracks (playback arrives in M4)'}
        onClick={() => dispatch(setTrackFlag(track.id, 'solo', !track.solo))}
      >
        <Icon name={track.solo ? 'soloOn' : 'solo'} fallback="S" />
      </button>
      <button
        className={`toggle ${track.syncLock ? 'on' : ''}`}
        title={track.syncLock ? 'Sync Lock on: ripple and insert edits shift this track too. Click to turn off.' : 'Sync Lock off: ripple and insert edits leave this track alone'}
        onClick={() => dispatch(setTrackFlag(track.id, 'syncLock', !track.syncLock))}
      >
        <Icon name={track.syncLock ? 'syncLockOn' : 'syncLock'} fallback="Sync" />
      </button>
      <button className={`toggle ${track.locked ? 'on' : ''}`} title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => dispatch(setTrackFlag(track.id, 'locked', !track.locked))}>
        <Icon name={track.locked ? 'lock' : 'lockOpen'} fallback="L" />
      </button>
    </div>
  )
}

/** The playhead timecode; click to type a new time (Premiere style, "+10" moves 10 frames). */
function TimecodeField({ sequence }: { sequence: Sequence }) {
  const [editing, setEditing] = useState(false)
  const rate = frameRateOf(sequence.settings)
  if (editing) {
    return (
      <CommitInput
        className="input timecode-input mono"
        value={tl.timecode(tl.playhead)}
        autoFocus
        autoSelect
        onCommit={(text) => {
          const time = parseTimecode(text, rate, tl.playhead)
          if (time === null) projectController.showMessage(`Couldn't read "${text}" as timecode`)
          else tl.setPlayhead(time)
        }}
        onBlur={() => setEditing(false)}
      />
    )
  }
  return (
    <button className="timecode-button mono" title="Playhead. Click to type a time." onClick={() => setEditing(true)}>
      {tl.timecode(tl.playhead)}
    </button>
  )
}

function hasVideo(item: MediaItem): boolean {
  return item.kind === 'image' || item.info.video !== null
}

function hasAudio(item: MediaItem): boolean {
  return item.kind !== 'image' && item.info.audio !== null
}

/** Picture and sound tracks for a drop on `row`: the same distance from the middle on each side. */
function dropTracks(sequence: Sequence, row: Row, item: MediaItem): { video: string | null; audio: string | null } {
  const index = trackIndex(sequence, row.track)
  const videos = tracksOf(sequence, 'video')
  const audios = tracksOf(sequence, 'audio')
  const video = row.track.kind === 'video' ? row.track : videos[Math.min(index, videos.length - 1)]
  const audio = row.track.kind === 'audio' ? row.track : audios[Math.min(index, audios.length - 1)]
  return { video: hasVideo(item) ? (video?.id ?? null) : null, audio: hasAudio(item) ? (audio?.id ?? null) : null }
}

/** Places dropped media one after another; one undo step. */
function placeAll(sequence: Sequence, media: MediaItem[], row: Row, at: Ticks, mode: EditMode, ctx: EditContext): string[] {
  const created: string[] = []
  let time = at
  for (const entry of tl.mediaDrag?.items ?? []) {
    const item = media.find((m) => m.id === entry.mediaId)
    if (!item) continue
    const tracks = dropTracks(sequence, row, item)
    if (!tracks.video && !tracks.audio) continue
    const clips = applyPlace(sequence, media, { ...entry, at: time, videoTrackId: tracks.video, audioTrackId: tracks.audio, mode }, ctx)
    created.push(...clips.map((c) => c.id))
    time = Math.max(...clips.map(clipEnd))
  }
  return created
}

export function TimelinePanel() {
  useObservable(projectController)
  useObservable(tl)
  useObservable(mediaController)
  const project = projectController.project
  const areaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const interaction = useRef(new TimelineInteraction()).current
  const images = useRef(new Map<string, HTMLImageElement>())
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const [cursor, setCursor] = useState('default')

  useLayoutEffect(() => {
    const area = areaRef.current
    if (!area) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [project !== null])
  tl.viewportWidth = size.width || tl.viewportWidth

  const sequence = tl.sequence
  const rows = sequence ? layoutRows(sequence) : null
  const maxScrollY = rows ? Math.max(0, rows.height - (size.height - RULER_HEIGHT)) : 0

  // Thumbnails and waveforms for everything on the timeline.
  useEffect(() => {
    if (!project) return
    const used = new Set(project.sequence.clips.map((c) => c.mediaId))
    for (const item of project.media) {
      if (!used.has(item.id)) continue
      if (item.kind !== 'audio') mediaController.requestThumbnail(item)
      if (item.info.audio && project.sequence.clips.some((c) => c.mediaId === item.id && c.kind === 'audio')) mediaController.requestWaveform(item)
    }
  }, [project?.sequence.clips, project?.media])

  // Draw after every render (any change to the project, timeline or media state re-renders).
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !sequence || !rows || !project || size.width === 0) return
    const ratio = window.devicePixelRatio || 1
    const w = Math.round(size.width * ratio)
    const h = Math.round(size.height * ratio)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const media = new Map(project.media.map((m) => [m.id, m]))
    drawTimeline(ctx, {
      width: size.width,
      height: size.height,
      sequence,
      rows,
      view: tl.view,
      scrollY: Math.min(tl.scrollY, maxScrollY),
      fps: frameRateValue(frameRateOf(sequence.settings)),
      playhead: tl.playhead,
      selection: tl.selection,
      gap: tl.gap,
      snapLine: tl.snapLine,
      razorLine: tl.razorLine,
      marquee: tl.marquee,
      media,
      runtime: (id) => mediaController.get(id),
      image: (url) => {
        let img = images.current.get(url)
        if (!img) {
          img = new Image()
          img.onload = () => bump()
          img.src = url
          images.current.set(url, img)
        }
        return img.complete && img.naturalWidth > 0 ? img : null
      },
      timecode: (time) => tl.timecode(time),
      focused: true
    })
  })

  // Trackpad: two-finger scroll moves through time (and tracks); pinch or Option+scroll zooms.
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = area.getBoundingClientRect()
      if (event.ctrlKey || event.altKey) {
        tl.zoom(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX - rect.left)
        return
      }
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey
      if (horizontal) tl.scrollBy(event.shiftKey ? event.deltaY : event.deltaX, 0, maxScrollY)
      else if (maxScrollY > 0) tl.scrollBy(0, event.deltaY, maxScrollY)
      else tl.scrollBy(event.deltaY, 0, maxScrollY)
    }
    area.addEventListener('wheel', onWheel, { passive: false })
    return () => area.removeEventListener('wheel', onWheel)
  }, [maxScrollY, project !== null])

  if (!project || !sequence || !rows) return null

  const point = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  // ---- Media drops ----------------------------------------------------------------
  const dropInfo = (event: DragEvent) => {
    const { x, y } = point(event)
    const row = rowAt(rows, y - RULER_HEIGHT + tl.scrollY)
    if (!row || row.track.locked || !tl.mediaDrag) return null
    let at = toFrame(xToTime(x, tl.view), tl.frame())
    tl.snapLine = null
    if (tl.snapping) {
      const snapped = snapTime(at, snapTargets(project.sequence, { playhead: tl.playhead, exclude: new Set() }), pixelsToTicks(SNAP_PIXELS, tl.view))
      at = snapped.time
      tl.snapLine = snapped.target
    }
    return { row, at: Math.max(0, at), mode: (event.metaKey ? 'insert' : 'overwrite') as EditMode }
  }
  const acceptsDrop = (event: DragEvent) =>
    tl.mediaDrag !== null && (event.dataTransfer.types.includes(MEDIA_DRAG_TYPE) || event.dataTransfer.types.includes(SOURCE_DRAG_TYPE))
  const onDragOver = (event: DragEvent) => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const info = dropInfo(event)
    if (!info) {
      tl.preview = null
      tl.changed()
      return
    }
    try {
      tl.preview = produce(project.sequence, (draft) => {
        placeAll(draft, project.media, info.row, info.at, info.mode, new EditContext(() => globalThis.crypto.randomUUID()))
      })
    } catch (error) {
      if (!(error instanceof CommandError)) throw error
      tl.preview = null
    }
    tl.changed()
  }
  const onDrop = (event: DragEvent) => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    const info = dropInfo(event)
    tl.preview = null
    tl.snapLine = null
    if (info) {
      const created: string[] = []
      const label = info.mode === 'insert' ? 'Insert' : 'Overwrite'
      const command: Command = {
        label,
        apply: (draft) => {
          const ctx = new EditContext(() => {
            const id = globalThis.crypto.randomUUID()
            created.push(id)
            return id
          })
          placeAll(draft.sequence, draft.media, info.row, info.at, info.mode, ctx)
        }
      }
      if (tl.run(command)) {
        const clips = projectController.project!.sequence.clips.filter((c) => created.includes(c.id))
        tl.select(clips.map((c) => c.id), 'replace')
      }
    }
    tl.mediaDrag = null
    areaRef.current?.closest<HTMLElement>('.timeline-panel')?.focus()
    tl.changed()
  }

  // ---- Context menus -------------------------------------------------------------
  const clipMenu = (x: number, y: number, hit: Hit) => {
    let entries: MenuEntry[] = []
    if (hit.kind === 'clip') {
      if (!tl.selection.has(hit.clip.id)) tl.select(tl.expand([hit.clip.id], true), 'replace')
      const ids = [...tl.selection]
      const linked = project.sequence.clips.some((c) => ids.includes(c.id) && c.linkId)
      entries = [
        { label: 'Cut', onSelect: () => tl.cut() },
        { label: 'Copy', onSelect: () => tl.copy() },
        'separator',
        { label: 'Add Edit at Playhead', onSelect: () => tl.splitAtPlayhead(false) },
        { label: linked ? 'Unlink' : 'Link', disabled: !linked && ids.length < 2, onSelect: () => tl.toggleLink() },
        { label: 'Match Frame', onSelect: () => tl.matchFrame() },
        'separator',
        { label: 'Delete', danger: true, onSelect: () => tl.run(deleteClips(ids)) },
        { label: 'Ripple Delete', danger: true, onSelect: () => tl.run(rippleDeleteClips(ids)) }
      ]
    } else if (hit.kind === 'lane') {
      const gap = tl.gap
      entries = [
        { label: 'Paste', disabled: tl.clipboard.length === 0, onSelect: () => tl.paste('overwrite') },
        { label: 'Paste Insert', disabled: tl.clipboard.length === 0, onSelect: () => tl.paste('insert') },
        ...(gap ? (['separator', { label: 'Ripple Delete Gap', onSelect: () => tl.run(rippleDeleteGap(gap.trackId, gap.start, gap.end)) }] as MenuEntry[]) : [])
      ]
    } else if (hit.kind === 'ruler') {
      const marker = hit.marker
      entries = marker
        ? [
            { label: 'Rename Marker…', onSelect: () => renameMarkerPrompt(marker.id, marker.name) },
            { label: 'Delete Marker', danger: true, onSelect: () => tl.run(removeMarkers([marker.id])) },
            { label: 'Delete All Markers', danger: true, onSelect: () => tl.run(removeMarkers(project.sequence.markers.map((m) => m.id))) }
          ]
        : [
            { label: 'Add Marker Here', onSelect: () => (tl.setPlayhead(hit.time, false), tl.addMarkerAtPlayhead()) },
            { label: 'Delete All Markers', danger: true, disabled: project.sequence.markers.length === 0, onSelect: () => tl.run(removeMarkers(project.sequence.markers.map((m) => m.id))) }
          ]
    }
    if (entries.length) setMenu({ x, y, entries })
  }
  const renameMarkerPrompt = (id: string, name: string) =>
    setPrompt({
      title: 'Rename Marker',
      label: 'Name',
      initial: name,
      confirm: 'Rename',
      resolve: (value) => {
        setPrompt(null)
        if (value !== null) tl.run(renameMarker(id, value))
      }
    })
  const trackMenu = (event: ReactMouseEvent, track: Track) => {
    event.preventDefault()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { label: 'Add Video Track', onSelect: () => projectController.dispatch(addTrack('video')) },
        { label: 'Add Audio Track', onSelect: () => projectController.dispatch(addTrack('audio')) },
        'separator',
        { label: `Delete ${track.name}`, danger: true, onSelect: () => projectController.dispatch(removeTrack(track.id)) }
      ]
    })
  }

  // ---- Horizontal scrollbar ------------------------------------------------------
  const viewSeconds = size.width / tl.view.pps
  const contentSeconds = Math.max(ticksToSeconds(sequenceEnd(project.sequence)) * 1.1 + 5, tl.view.scroll + viewSeconds, viewSeconds)
  const thumbWidth = Math.max(24, (viewSeconds / contentSeconds) * size.width)
  const thumbLeft = (tl.view.scroll / contentSeconds) * size.width
  const onThumbDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startScroll = tl.view.scroll
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => {
      tl.view = { ...tl.view, scroll: Math.max(0, startScroll + ((e.clientX - startX) / size.width) * contentSeconds) }
      tl.changed()
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
  }

  const soloNote = project.sequence.tracks.some((t) => t.solo)

  return (
    <section className="panel timeline-panel" tabIndex={-1}>
      <header className="panel-header timeline-toolbar">
        <span>Timeline: {project.sequence.name}</span>
        <div className="tool-group" role="toolbar" aria-label="Tools">
          {[...TOOLS, { id: 'backward' as Tool, label: 'Track Select Backward', key: 'Shift+A' }].map((tool) => (
            <button
              key={tool.id}
              className={`tool-button ${tl.tool === tool.id ? 'active' : ''}`}
              title={`${tool.label} (${tool.key})`}
              onClick={() => tl.setTool(tool.id)}
            >
              <Icon name={TOOL_ICONS[tool.id]} fallback={tool.key} />
            </button>
          ))}
          <span className="tool-divider" />
          <button className={`tool-button ${tl.snapping ? 'active' : ''}`} title={`Snap in Timeline (S): ${tl.snapping ? 'on' : 'off'}`} onClick={() => tl.toggleSnapping()}>
            <Icon name="magnet" fallback="Snap" />
          </button>
        </div>
        {soloNote && <span className="small warn-text">Solo on</span>}
        <span className="spacer" />
        <button className="tool-button" title="Zoom out (−)" onClick={() => tl.zoom(1 / 1.5)}>
          <Icon name="zoomOut" fallback="−" />
        </button>
        <button className="tool-button" title="Zoom in (=)" onClick={() => tl.zoom(1.5)}>
          <Icon name="zoomIn" fallback="+" />
        </button>
        <button className="tool-button" title="Zoom to sequence (\)" onClick={() => tl.zoomToFit()}>
          <Icon name="zoomFit" fallback="Fit" />
        </button>
        <span className="tool-divider" />
        <button className="button compact" onClick={() => projectController.dispatch(addTrack('video'))}>
          + Video
        </button>
        <button className="button compact" onClick={() => projectController.dispatch(addTrack('audio'))}>
          + Audio
        </button>
      </header>
      <div className="timeline-main">
        <div className="timeline-headers" style={{ width: HEADER_WIDTH }}>
          <div className="ruler-corner">
            <TimecodeField sequence={project.sequence} />
          </div>
          <div className="timeline-headers-body">
            {rows.rows.map((row) => (
              <TrackHeader key={row.track.id} track={project.sequence.tracks.find((t) => t.id === row.track.id) ?? row.track} row={row} onMenu={trackMenu} />
            ))}
            <div className="track-header-divider" style={{ top: RULER_HEIGHT + rows.dividerTop - tl.scrollY }} />
          </div>
        </div>
        <div className="timeline-area" ref={areaRef} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => ((tl.preview = null), (tl.snapLine = null), tl.changed())}>
          <canvas
            ref={canvasRef}
            className="timeline-canvas"
            style={{ cursor }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              ;(event.currentTarget.closest('.timeline-panel') as HTMLElement | null)?.focus()
              const { x, y } = point(event)
              interaction.down(event.nativeEvent, x, y)
            }}
            onPointerMove={(event) => {
              const { x, y } = point(event)
              if (event.buttons) interaction.move(event.nativeEvent, x, y)
              else interaction.hover(x, y, event.shiftKey)
              setCursor(interaction.cursor(x, y, event))
            }}
            onPointerUp={(event) => {
              const { x, y } = point(event)
              interaction.up(event.nativeEvent, x, y)
            }}
            onPointerCancel={() => interaction.cancel()}
            onPointerLeave={() => interaction.leave()}
            onDoubleClick={(event) => {
              const { x, y } = point(event)
              const hit = hitTest(x, y)
              if (hit.kind === 'ruler' && hit.marker) renameMarkerPrompt(hit.marker.id, hit.marker.name)
              else interaction.doubleClick(x, y)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              const { x, y } = point(event)
              clipMenu(event.clientX, event.clientY, hitTest(x, y))
            }}
          />
          {project.sequence.clips.length === 0 && (
            <p className="timeline-empty muted small">Drag clips here from Media or the Source Monitor, or press , (Insert) / . (Overwrite) with a clip open in the Source Monitor.</p>
          )}
        </div>
      </div>
      <div className="timeline-scrollbar" style={{ marginLeft: HEADER_WIDTH }}>
        <div className="timeline-scroll-thumb" style={{ left: thumbLeft, width: thumbWidth }} onPointerDown={onThumbDown} />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.entries} onClose={() => setMenu(null)} />}
      <PromptDialog request={prompt} />
    </section>
  )
}
