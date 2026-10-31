import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { setMarks } from '@engine/project/media-commands'
import { frameRateValue, type MediaItem } from '@engine/project/media'
import { frameToTicks, nearestStandardRate, secondsToTicks, ticksToSeconds } from '@engine/time'
import { Icon } from '../app/Icon'
import { SOURCE_DRAG_TYPE } from '../timeline/drag-types'
import { timelineController } from '../timeline/timeline-controller'
import { getGpu } from '../gpu/shared'
import { formatMediaTime } from '../media-panel/format'
import { TestPlayer } from '../media/test-player'
import { mediaController, type Waveform } from '../state/media-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'

function itemRate(item: MediaItem) {
  return nearestStandardRate(frameRateValue(item.info.video?.frameRate ?? null))
}

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

/** Shows the media item chosen in the Media panel; mark In and Out like Premiere's Source Monitor. */
export function SourceMonitorWindow() {
  useObservable(mediaController)
  useObservable(projectController)
  const item = projectController.project?.media.find((m) => m.id === mediaController.sourceId) ?? null
  const runtime = item ? mediaController.get(item.id) : null
  const playable = item ? mediaController.playablePath(item) : null
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<TestPlayer | null>(null)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [audioPosition, setAudioPosition] = useState(0)

  // One GPU player for the window's lifetime.
  useEffect(() => {
    let disposed = false
    getGpu()
      .then((gpu) => {
        if (disposed || !canvasRef.current) return
        const player = new TestPlayer(gpu, rerender)
        player.attach(canvasRef.current)
        playerRef.current = player
        rerender()
      })
      .catch(() => rerender())
    return () => {
      disposed = true
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  // Open the clip (or its optimised copy once ready).
  const player = playerRef.current
  useEffect(() => {
    if (!player || !canvasRef.current || !item || item.kind !== 'video' || !playable) return
    if (player.state.path === playable) return
    void player.open(playable, canvasRef.current).then(() => {
      const start = mediaController.sourceSeek?.at ?? item.marks.in
      if (start !== null) void player.showFrame(Math.round(ticksToSeconds(start) * frameRateValue(item.info.video?.frameRate ?? null)))
    })
  }, [player, item, playable])

  // Match Frame / double-click in the timeline: jump to that frame.
  const seek = mediaController.sourceSeek
  useEffect(() => {
    if (!seek || !player || !item || item.kind !== 'video' || player.state.path !== playable) return
    void player.showFrame(Math.round(ticksToSeconds(seek.at) * frameRateValue(item.info.video?.frameRate ?? null)))
  }, [seek?.version, player, item, playable])

  useEffect(() => {
    if (item?.kind === 'audio' || item?.kind === 'video') mediaController.requestWaveform(item)
    setAudioPosition(0)
  }, [item])

  if (!item || !runtime) {
    return (
      <div className="source-empty">
        <p className="muted">Double-click a clip in the Media panel to view it here.</p>
      </div>
    )
  }

  const isVideo = item.kind === 'video'
  const fps = frameRateValue(item.info.video?.frameRate ?? null) || 25
  const index = player?.state.index ?? 0
  const position = isVideo ? index / fps : audioPosition
  const duration = item.info.durationSeconds
  const frameCount = Math.max(1, player?.state.clip?.info.frameCount ?? Math.round(duration * fps))

  const positionTicks = () => {
    const rate = itemRate(item)
    return isVideo && rate ? frameToTicks(index, rate) : secondsToTicks(position)
  }
  const markIn = () => projectController.dispatch(setMarks(item.id, { in: positionTicks() }))
  const markOut = () => projectController.dispatch(setMarks(item.id, { out: positionTicks() }))
  const clearMarks = () => projectController.dispatch(setMarks(item.id, { in: null, out: null }))

  let notice: string | null = null
  if (runtime.status === 'offline') notice = 'This file is offline. Right-click it in Media → Locate File…'
  else if (isVideo && !playable) {
    const job = runtime.job
    notice = job?.status === 'running' ? `Making an optimised copy… ${Math.round(job.progress * 100)}%` : job?.status === 'failed' ? `The optimised copy failed: ${job.error ?? ''}` : 'Preparing an optimised copy…'
  }

  return (
    <div
      className="source-monitor"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return
        const key = event.key.toLowerCase()
        if (key === 'i') markIn()
        else if (key === 'o') markOut()
        else if (isVideo && player && event.key === 'ArrowRight') player.step(1)
        else if (isVideo && player && event.key === 'ArrowLeft') player.step(-1)
        else if (!isVideo && event.key === 'ArrowRight') setAudioPosition((p) => Math.min(duration, p + 0.1))
        else if (!isVideo && event.key === 'ArrowLeft') setAudioPosition((p) => Math.max(0, p - 0.1))
        else if (isVideo && player && event.key === ' ') {
          if (player.state.playing) player.stop()
          else void player.play()
        } else return
        event.preventDefault()
      }}
    >
      <div
        className="source-screen"
        draggable={item.kind !== 'image' || runtime.status !== 'offline'}
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
        <canvas ref={canvasRef} width={1920} height={1080} style={{ display: isVideo && playable ? 'block' : 'none', aspectRatio: `${item.info.video?.width ?? 16} / ${item.info.video?.height ?? 9}` }} />
        {item.kind === 'image' && runtime.status !== 'offline' && <img className="source-image" src={window.ginosa.mediaUrl(item.path)} alt={item.name} />}
        {item.kind === 'audio' && <WaveformView waveform={runtime.waveform} duration={duration} position={audioPosition} onSeek={setAudioPosition} />}
        {notice && <p className="source-notice">{notice}</p>}
      </div>
      {item.kind !== 'image' && (
        <div className="source-scrub">
          <MarkRange item={item} duration={duration} />
          <input
            className="scrubber"
            type="range"
            min={0}
            max={isVideo ? frameCount - 1 : Math.max(0.01, duration)}
            step={isVideo ? 1 : 0.01}
            value={isVideo ? index : audioPosition}
            disabled={isVideo && !playable}
            onChange={(event) => {
              if (isVideo) {
                player?.stop()
                void player?.showFrame(Number(event.target.value))
              } else setAudioPosition(Number(event.target.value))
            }}
          />
        </div>
      )}
      <div className="source-bar">
        <span className="mono timecode">{item.kind === 'image' ? 'Still' : timeLabel(item, position)}</span>
        {isVideo && (
          <button
            className="button compact icon-only"
            title={player?.state.playing ? 'Stop (Space)' : 'Play (Space)'}
            disabled={!playable}
            onClick={() => (player?.state.playing ? player.stop() : void player?.play())}
          >
            <Icon name={player?.state.playing ? 'stop' : 'play'} fallback={player?.state.playing ? 'Stop' : 'Play'} />
          </button>
        )}
        {item.kind !== 'image' && (
          <>
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
          {item.marks.out !== null ? `  Out ${timeLabel(item, ticksToSeconds(item.marks.out))}` : ''}
        </span>
      </div>
      <div className="source-footer muted small">
        <span className="item-name">{item.name}</span>
        <span>{runtime.optimisedPath ? 'Playing the optimised copy' : ''}</span>
        <span>{item.kind === 'image' ? '' : 'Sound in the Source Monitor arrives in M4 part 2'}</span>
      </div>
    </div>
  )
}
