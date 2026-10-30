import { useEffect, useReducer, useRef, useState } from 'react'
import type { TestEffect } from '@shared/ipc'
import { getGpu } from '../gpu/shared'
import { TestPlayer } from '../media/test-player'

/** The M0 playback test as a tool window: open a clip, scrub, play (no audio), test shader. */
export function PlaybackTestWindow() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<TestPlayer | null>(null)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [gpuError, setGpuError] = useState<string | null>(null)

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
      .catch((error: Error) => setGpuError(error.message))
    return () => {
      disposed = true
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  const player = playerRef.current
  const state = player?.state
  const clip = state?.clip ?? null
  const info = clip?.info
  const canPlay = Boolean(info?.canDecode)

  const open = async () => {
    const path = await window.ginosa.openMediaDialog()
    if (path && player && canvasRef.current) await player.open(path, canvasRef.current)
  }

  return (
    <div
      className="test-player"
      tabIndex={0}
      onKeyDown={(event) => {
        if (!player) return
        if (event.key === 'ArrowRight') player.step(1)
        else if (event.key === 'ArrowLeft') player.step(-1)
        else if (event.key === ' ') {
          event.preventDefault()
          if (state?.playing) player.stop()
          else void player.play()
        } else return
        event.preventDefault()
      }}
    >
      <div className="test-player-screen">
        <canvas ref={canvasRef} width={1920} height={1080} style={{ aspectRatio: info ? `${info.width} / ${info.height}` : '16 / 9' }} />
      </div>
      <div className="test-player-bar">
        <button className="button primary" onClick={() => void open()} disabled={!player}>
          Open video…
        </button>
        <button className="button" disabled={!canPlay} onClick={() => (state?.playing ? player?.stop() : void player?.play())}>
          {state?.playing ? 'Stop' : 'Play'}
        </button>
        <input
          className="scrubber"
          type="range"
          min={0}
          max={Math.max(0, (info?.frameCount ?? 1) - 1)}
          value={state?.index ?? 0}
          disabled={!canPlay}
          onChange={(event) => {
            player?.stop()
            void player?.showFrame(Number(event.target.value))
          }}
        />
        <span className="mono muted">{info ? `${state?.index ?? 0} / ${info.frameCount}` : ''}</span>
        <select
          className="input compact"
          value={state?.effect ?? 'none'}
          onChange={(event) => player?.setEffect(event.target.value as TestEffect, state?.amount ?? 1)}
        >
          <option value="none">No effect</option>
          <option value="invert">Invert (test shader)</option>
        </select>
        <input
          className="slider"
          type="range"
          min={0}
          max={100}
          value={Math.round((state?.amount ?? 1) * 100)}
          disabled={state?.effect === 'none'}
          onChange={(event) => player?.setEffect(state?.effect ?? 'none', Number(event.target.value) / 100)}
        />
      </div>
      <div className="test-player-status">
        <span className="mono muted">
          {info ? `${info.codec} · ${info.width}×${info.height} · ${info.fps.toFixed(2)} fps` : 'M0 test tool. Real monitors arrive in M2–M4. No audio.'}
        </span>
        <span className="mono muted">{state?.stats}</span>
        {(state?.error || gpuError) && <span className="error-text">{state?.error ?? gpuError}</span>}
      </div>
    </div>
  )
}
