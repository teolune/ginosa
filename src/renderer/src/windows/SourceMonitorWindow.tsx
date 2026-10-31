import { useEffect, useLayoutEffect, useRef } from 'react'
import { setMarks } from '@engine/project/media-commands'
import type { MediaItem } from '@engine/project/media'
import { secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import { Icon } from '../app/Icon'
import { SOURCE_DRAG_TYPE } from '../timeline/drag-types'
import { timelineController } from '../timeline/timeline-controller'
import { formatMediaTime } from '../media-panel/format'
import { sourceHost, sourcePlayer } from '../playback/source-player'
import { mediaController, type Waveform } from '../state/media-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'

function timeLabel(item: MediaItem, seconds: number): string {
  return formatMediaTime(item, seconds)
}

/** In/out range drawn over the scrubber. */
function MarkRange({ item, duration }: { item: MediaItem; duration: number }) {
  const { in: markIn, out: markOut } = item.marks
  if (!duration || (markIn === null && markOut === null)) return null
  const start = markIn !== null ? ticksToSeconds(markIn) / duration : 0
  const end = markOut !== null ? ticksToSeconds(markOut) / duration : 1
  return <div className="mark-range" style={{ left: `${start * 100}%`, width: `${Math.max(0, end - start) * 100}%` }} />
}

function WaveformView({ waveform, duration, position, onSeek }: { waveform: Waveform | null; duration: number; position: number; onSeek(seconds: number): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = (canvas.width = canvas.clientWidth * devicePixelRatio)
    const height = (canvas.height = canvas.clientHeight * devicePixelRatio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, height)
    if (waveform) {
      const buckets = waveform.peaks.length / 2
      ctx.fillStyle = '#3fb27f'
      for (let x = 0; x < width; x++) {
        const from = Math.floor((x / width) * buckets)
        const to = Math.max(from + 1, Math.floor(((x + 1) / width) * buckets))
        let min = 0
        let max = 0
        for (let b = from; b < to && b < buckets; b++) {
          min = Math.min(min, waveform.peaks[b * 2]!)
          max = Math.max(max, waveform.peaks[b * 2 + 1]!)
        }
        const top = ((1 - max) / 2) * height
        const bottom = ((1 - min) / 2) * height
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
      }
    }
    if (duration > 0) {
      ctx.fillStyle = '#5b8cff'
      ctx.fillRect(Math.round((position / duration) * width), 0, 2 * devicePixelRatio, height)
    }
  }, [waveform, duration, position])
  return (
    <canvas
      ref={canvasRef}
      className="waveform-canvas"
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        onSeek(((event.clientX - rect.left) / rect.width) * duration)
      }}
    />
  )
}

/**
 * Shows the media item chosen in the Media panel and plays it with sound, through the
 * same player and colour conversion as the Program monitor. Mark In and Out like
 * Premiere's Source Monitor.
 */
export function SourceMonitorWindow() {
  useObservable(mediaController)
  useObservable(projectController)
  useObservable(sourceHost)
  useObservable(sourcePlayer)
  const item = sourceHost.item()
  const runtime = item ? mediaController.get(item.id) : null
  const playable = item ? mediaController.playablePath(item) : null
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    void sourcePlayer.attach(canvas)
    return () => sourcePlayer.detach(canvas)
    // The canvas exists only while a file is open.
  }, [item !== null])

  useEffect(() => {
    if (item?.kind === 'audio' || item?.kind === 'video') mediaController.requestWaveform(item)
  }, [item?.id])

  if (!item || !runtime) {
    return (
      <div className="source-empty">
        <p className="muted">Double-click a clip in the Media panel to view it here.</p>
      </div>
    )
  }

  const isVideo = item.kind === 'video'
  const isImage = item.kind === 'image'
  const frame = sourceHost.frame()
  const end = sourceHost.end()
  const position = ticksToSeconds(sourceHost.playhead)
  const duration = item.info.durationSeconds
  const lastFrame = Math.max(0, Math.round(end / frame) - 1)

  const markIn = () => projectController.dispatch(setMarks(item.id, { in: sourceHost.playhead }))
  // Like Premiere, the Out point includes the frame on screen (stored as the end of that frame).
  const markOut = () => projectController.dispatch(setMarks(item.id, { out: sourceHost.playhead + frame }))
  const clearMarks = () => projectController.dispatch(setMarks(item.id, { in: null, out: null }))
  const seekTo = (time: Ticks) => {
    sourcePlayer.stop()
    sourceHost.setPlayhead(time)
  }

  let notice: string | null = null
  if (runtime.status === 'offline') notice = 'This file is offline. Right-click it in Media → Locate File…'
  else if (isVideo && !playable) {
    const job = runtime.job
    notice = job?.status === 'running' ? `Making an optimised copy… ${Math.round(job.progress * 100)}%` : job?.status === 'failed' ? `The optimised copy failed: ${job.error ?? ''}` : 'Preparing an optimised copy…'
  } else if (sourcePlayer.message) notice = sourcePlayer.message

  return (
    <div
      className="source-monitor"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement || isImage) return
        const key = event.key.toLowerCase()
        if (event.metaKey || event.ctrlKey || event.altKey) return
        if (key === 'i') markIn()
        else if (key === 'o') markOut()
        else if (event.key === 'ArrowRight') seekTo(sourceHost.playhead + frame * (event.shiftKey ? 5 : 1))
        else if (event.key === 'ArrowLeft') seekTo(sourceHost.playhead - frame * (event.shiftKey ? 5 : 1))
        else if (event.key === 'Home') seekTo(0)
        else if (event.key === 'End') seekTo(end)
        else if (event.key === ' ') sourcePlayer.toggle()
        else if (key === 'j' || key === 'k' || key === 'l') sourcePlayer.shuttle(key === 'l' ? 1 : key === 'j' ? -1 : 0)
        else return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div
        className="source-screen"
        draggable={!isImage || runtime.status !== 'offline'}
        title="Drag into the timeline (Cmd while dropping inserts)"
        onDragStart={(event) => {
          event.dataTransfer.setData(SOURCE_DRAG_TYPE, item.id)
          event.dataTransfer.effectAllowed = 'copy'
          timelineController.mediaDrag = { items: [{ mediaId: item.id, sourceIn: item.marks.in ?? 0, sourceOut: item.marks.out }] }
        }}
        onDragEnd={() => {
          timelineController.mediaDrag = null
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: isVideo && playable ? 'block' : 'none', aspectRatio: `${sourceHost.scene()?.sequence.settings.width ?? 16} / ${sourceHost.scene()?.sequence.settings.height ?? 9}` }}
        />
        {isImage && runtime.status !== 'offline' && <img className="source-image" src={window.ginosa.mediaUrl(item.path)} alt={item.name} />}
        {item.kind === 'audio' && <WaveformView waveform={runtime.waveform} duration={duration} position={position} onSeek={(seconds) => seekTo(secondsToTicks(seconds))} />}
        {notice && <p className="source-notice">{notice}</p>}
      </div>
      {!isImage && (
        <div className="source-scrub">
          <MarkRange item={item} duration={duration} />
          <input
            className="scrubber"
            type="range"
            min={0}
            max={lastFrame}
            step={1}
            value={Math.round(sourceHost.playhead / frame)}
            disabled={!playable}
            onChange={(event) => seekTo(Number(event.target.value) * frame)}
          />
        </div>
      )}
      <div className="source-bar">
        <span className="mono timecode">{isImage ? 'Still' : timeLabel(item, position)}</span>
        {!isImage && (
          <>
            <button className="button compact icon-only" title="Back one frame (←)" disabled={!playable} onClick={() => seekTo(sourceHost.playhead - frame)}>
              <Icon name="stepBack" fallback="◀︎" />
            </button>
            <button className="button compact icon-only" title={sourcePlayer.playing ? 'Stop (Space)' : 'Play (Space)'} disabled={!playable} onClick={() => sourcePlayer.toggle()}>
              <Icon name={sourcePlayer.playing ? 'stop' : 'play'} fallback={sourcePlayer.playing ? 'Stop' : 'Play'} />
            </button>
            <button className="button compact icon-only" title="Forward one frame (→)" disabled={!playable} onClick={() => seekTo(sourceHost.playhead + frame)}>
              <Icon name="stepForward" fallback="▶︎" />
            </button>
            <button className="button compact" title="Mark In (I)" onClick={markIn}>
              Mark In
            </button>
            <button className="button compact" title="Mark Out (O)" onClick={markOut}>
              Mark Out
            </button>
            <button className="button compact" onClick={clearMarks} disabled={item.marks.in === null && item.marks.out === null}>
              Clear
            </button>
          </>
        )}
        <span className="spacer" />
        <span className="mono muted small">
          {item.marks.in !== null ? `In ${timeLabel(item, ticksToSeconds(item.marks.in))}` : ''}
          {item.marks.out !== null ? `  Out ${timeLabel(item, ticksToSeconds(Math.max(0, item.marks.out - frame)))}` : ''}
        </span>
      </div>
      <div className="source-footer muted small">
        <span className="item-name">{item.name}</span>
        <span>{runtime.optimisedPath ? 'Playing the optimised copy' : ''}</span>
        <span>{isImage ? '' : 'Space plays · J K L shuttle · I / O mark'}</span>
      </div>
    </div>
  )
}
