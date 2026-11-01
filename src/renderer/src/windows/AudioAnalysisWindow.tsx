import { useEffect, useRef, useState } from 'react'
import { BANDS, type AudioAnalysis } from '@engine/audio/analysis'
import { MAX_BPM, MIN_BPM, beatLength, beatsBetween, normaliseDownbeat, tapTempo } from '@engine/audio/beat-grid'
import type { AudioSource, Sequence } from '@engine/project/model'
import { secondsToTicks, ticksToSeconds, type Ticks } from '@engine/time'
import { addAudioSource, removeAudioSource, renameAudioSource, setBeatGrid } from '@engine/timeline/audio-edits'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { analysisController, type SourceState } from '../audio/analysis-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController as tl } from '../timeline/timeline-controller'
import { ScrubNumber } from './EffectControlsWindow'

/**
 * Audio Analysis (M8): the sounds ginosa listens to, what it hears in them, and the
 * tempo. Sources are a clip, a track (muted ones too: a sidechain) or the mix; the view
 * shows each band's level, transients and hits scrolling past the playhead, with the beat
 * grid; the tempo panel sets the grid from detection, typing, tapping or nudging.
 */

const LANES: Array<{ id: string; label: string; colour: string }> = [
  ...BANDS.map((b, i) => ({ id: b.id, label: b.label, colour: ['#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1', '#48dbfb', '#a29bfe'][i]! })),
  { id: 'loudness', label: 'Loudness', colour: '#dfe6e9' },
  { id: 'peak', label: 'Peak', colour: '#b2bec3' }
]
const LABEL_W = 74

function describe(source: AudioSource, sequence: Sequence): string {
  if (source.kind === 'mix') return 'Mix as heard'
  if (source.kind === 'track') {
    const track = sequence.tracks.find((t) => t.id === source.target)
    return track ? `Track ${track.name}${track.muted ? ' (muted: sidechain)' : ''}` : 'Track (missing)'
  }
  const clip = sequence.clips.find((c) => c.id === source.target)
  return clip ? `Clip ${clip.name}` : 'Clip (missing)'
}

function statusText(state: SourceState): string {
  const s = state.status
  switch (s.kind) {
    case 'empty':
      return s.reason
    case 'queued':
      return 'Waiting…'
    case 'mixing':
      return 'Mixing…'
    case 'analysing':
      return `Analysing… ${Math.round(s.done * 100)}%`
    case 'ready':
      return state.result?.tempo ? `${state.result.tempo.bpm.toFixed(2)} BPM` : 'Analysed'
    case 'failed':
      return `Failed: ${s.error}`
  }
}

function lane(a: AudioAnalysis, id: string): { level: Float32Array; max: number; transient: Float32Array | null; transientMax: number; hits: number[] } {
  if (id === 'loudness') return { level: a.loudness, max: a.loudnessMax, transient: null, transientMax: 1, hits: [] }
  if (id === 'peak') return { level: a.peak, max: a.peakMax, transient: null, transientMax: 1, hits: [] }
  const b = a.bands[id as keyof AudioAnalysis['bands']]
  return { level: b.level, max: b.max, transient: b.transient, transientMax: b.transientMax, hits: b.hits }
}

/** The bands, transients, hits and beats around the playhead. */
function SignalView({ sourceId, sequence }: { sourceId: string | null; sequence: Sequence }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [span, setSpan] = useState(6)
  useEffect(() => {
    if (!area.current) return
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(area.current)
    return () => observer.disconnect()
  }, [])
  const state = sourceId ? analysisController.state(sourceId) : null
  const ready = sourceId ? analysisController.ready(sourceId) : null
  useEffect(() => {
    const c = canvas.current
    if (!c || size.width === 0) return
    const ratio = window.devicePixelRatio || 1
    c.width = Math.round(size.width * ratio)
    c.height = Math.round(size.height * ratio)
    const ctx = c.getContext('2d')!
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const { width, height } = size
    ctx.fillStyle = '#16171a'
    ctx.fillRect(0, 0, width, height)
    const plotW = width - LABEL_W
    const centre = tl.playhead
    const from = centre - secondsToTicks(span / 2)
    const to = centre + secondsToTicks(span / 2)
    const xOf = (t: Ticks) => LABEL_W + ((t - from) / (to - from)) * plotW
    const laneH = height / LANES.length
    // Beat grid.
    const grid = sequence.beatGrid
    if (grid) {
      for (const b of beatsBetween(grid, from, to)) {
        ctx.fillStyle = b.bar ? 'rgba(232,176,74,0.45)' : 'rgba(232,176,74,0.16)'
        ctx.fillRect(Math.round(xOf(b.time)), 0, 1, height)
      }
    }
    LANES.forEach((l, i) => {
      const top = i * laneH
      ctx.fillStyle = i % 2 ? '#1a1b1f' : '#1c1e22'
      ctx.fillRect(0, top, LABEL_W, laneH)
      ctx.fillStyle = l.colour
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText(l.label, 8, top + laneH / 2)
      ctx.fillStyle = '#24262b'
      ctx.fillRect(LABEL_W, top + laneH - 1, plotW, 1)
      if (!ready) return
      const data = lane(ready.result, l.id)
      const rate = ready.result.rate
      const frameOf = (x: number) => ((ticksToSeconds(from + ((x - LABEL_W) / plotW) * (to - from) - ready.start)) * rate)
      // Level: filled, scaled to the band's loudest moment.
      ctx.fillStyle = `${l.colour}55`
      ctx.strokeStyle = l.colour
      ctx.beginPath()
      ctx.moveTo(LABEL_W, top + laneH - 1)
      for (let x = LABEL_W; x <= width; x++) {
        const f = Math.round(frameOf(x))
        const v = f >= 0 && f < data.level.length && data.max > 0 ? data.level[f]! / data.max : 0
        ctx.lineTo(x, top + laneH - 1 - v * (laneH - 4))
      }
      ctx.lineTo(width, top + laneH - 1)
      ctx.closePath()
      ctx.fill()
      // Transients: a thin white line.
      if (data.transient && data.transientMax > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.beginPath()
        for (let x = LABEL_W; x <= width; x++) {
          const f = Math.round(frameOf(x))
          const v = f >= 0 && f < data.transient.length ? data.transient[f]! / data.transientMax : 0
          const y = top + laneH - 1 - v * (laneH - 4)
          if (x === LABEL_W) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      // Hits: white marks at the top of the lane.
      ctx.fillStyle = '#ffffff'
      for (const h of data.hits) {
        const t = ready.start + secondsToTicks(h / rate)
        if (t < from || t > to) continue
        const x = xOf(t)
        ctx.beginPath()
        ctx.moveTo(x - 3, top + 2)
        ctx.lineTo(x + 3, top + 2)
        ctx.lineTo(x, top + 7)
        ctx.closePath()
        ctx.fill()
      }
    })
    ctx.fillStyle = '#ff5d5d'
    ctx.fillRect(Math.round(xOf(centre)), 0, 1, height)
    if (!ready && state) {
      ctx.fillStyle = 'rgba(22,23,26,0.75)'
      ctx.fillRect(LABEL_W, height / 2 - 14, plotW, 28)
      ctx.fillStyle = '#c8cad0'
      ctx.textAlign = 'center'
      ctx.fillText(statusText(state), LABEL_W + plotW / 2, height / 2)
      ctx.textAlign = 'left'
    }
  })
  const scrub = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    if (x < LABEL_W) return
    const from = tl.playhead - secondsToTicks(span / 2)
    tl.movePlayhead(from + ((x - LABEL_W) / (rect.width - LABEL_W)) * secondsToTicks(span))
  }
  return (
    <div className="aa-view" ref={area}>
      <canvas
        ref={canvas}
        style={{ width: size.width, height: size.height }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          scrub(event)
        }}
        onWheel={(event) => setSpan((s) => Math.min(60, Math.max(1, s * Math.exp(event.deltaY * 0.002))))}
        title="Click to move the playhead; scroll to zoom"
      />
    </div>
  )
}

/** Tempo: the beat grid from detection, typing, tapping, ×2/÷2 and nudging. */
function TempoPanel({ sequence, selected }: { sequence: Sequence; selected: string | null }) {
  const grid = sequence.beatGrid
  const taps = useRef<number[]>([])
  const [tapped, setTapped] = useState<number | null>(null)
  const frame = tl.frame()
  const dispatch = (changes: Parameters<typeof setBeatGrid>[0], label?: string) => projectController.dispatch(setBeatGrid(changes, label))
  const tempoSource = grid?.sourceId ?? selected
  const detected = tempoSource ? analysisController.ready(tempoSource)?.result.tempo ?? null : null
  const sourceName = (id: string | null) => sequence.audioSources.find((s) => s.id === id)?.name ?? null
  const tap = () => {
    const now = performance.now()
    taps.current = [...taps.current.filter((t) => now - t < 8000), now]
    const bpm = tapTempo(taps.current)
    setTapped(bpm)
    if (bpm && bpm >= MIN_BPM && bpm <= MAX_BPM) dispatch(grid ? { bpm } : { bpm, downbeat: tl.playhead }, 'Tap Tempo')
  }
  const nudge = (event: React.MouseEvent, direction: 1 | -1) => {
    if (!grid) return
    const step = event.shiftKey ? beatLength(grid) : event.altKey ? secondsToTicks(0.001) : frame
    dispatch({ downbeat: grid.downbeat + direction * step }, 'Nudge Downbeat')
  }
  return (
    <div className="aa-tempo">
      <div className="aa-tempo-row">
        <span className="aa-tempo-label">Tempo</span>
        {grid ? (
          <ScrubNumber label="BPM" value={grid.bpm} min={MIN_BPM} max={MAX_BPM} step={0.05} decimals={2} unit=" BPM" onChange={(bpm) => dispatch({ bpm })} />
        ) : (
          <span className="muted small">No beat grid yet</span>
        )}
        <button className="button compact" disabled={!grid || grid.bpm * 2 > MAX_BPM} title="Double the tempo (the detector heard half-time)" onClick={() => grid && dispatch({ bpm: grid.bpm * 2 }, 'Double Tempo')}>
          ×2
        </button>
        <button className="button compact" disabled={!grid || grid.bpm / 2 < MIN_BPM} title="Halve the tempo (the detector heard double-time)" onClick={() => grid && dispatch({ bpm: grid.bpm / 2 }, 'Halve Tempo')}>
          ÷2
        </button>
        <button className="button compact" title="Tap along with the beat (four taps or more); a 2 s pause starts over" onClick={tap}>
          Tap{tapped ? ` · ${tapped.toFixed(1)}` : ''}
        </button>
        {!grid && (
          <button className="button compact" onClick={() => dispatch({ bpm: 120, downbeat: tl.playhead, beatsPerBar: 4, sourceId: null }, 'New Beat Grid')}>
            Enter by Hand
          </button>
        )}
      </div>
      {grid && (
        <div className="aa-tempo-row">
          <span className="aa-tempo-label">Bar</span>
          <select className="input compact" aria-label="Beats per bar" value={grid.beatsPerBar} onChange={(event) => dispatch({ beatsPerBar: Number(event.target.value) }, 'Beats per Bar')}>
            {[2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n} beats
              </option>
            ))}
          </select>
          <span className="aa-tempo-label">Downbeat</span>
          <span className="mono small" title="The first bar at or after the sequence start">
            {tl.timecode(normaliseDownbeat(grid))} · {ticksToSeconds(normaliseDownbeat(grid)).toFixed(3)} s
          </span>
          <button className="button compact" title="Earlier by a frame (Option: 1 ms, Shift: a beat)" onClick={(e) => nudge(e, -1)}>
            ◀
          </button>
          <button className="button compact" title="Later by a frame (Option: 1 ms, Shift: a beat)" onClick={(e) => nudge(e, 1)}>
            ▶
          </button>
          <button className="button compact" title="A bar starts at the playhead" onClick={() => dispatch({ downbeat: tl.playhead }, 'Set Downbeat')}>
            Set to Playhead
          </button>
          <span className="spacer" />
          <button className="button compact" onClick={() => dispatch(null)}>
            Remove Grid
          </button>
        </div>
      )}
      <div className="aa-tempo-row">
        <span className="aa-tempo-label">Detected</span>
        {detected ? (
          <>
            <span className="small">
              <strong>{detected.bpm.toFixed(2)} BPM</strong> in {sourceName(tempoSource)} · {Math.round(detected.confidence * 100)}% clear
            </span>
            <button className="button compact primary" disabled={!tempoSource} onClick={() => tempoSource && analysisController.useDetectedTempo(tempoSource)}>
              Use
            </button>
            {detected.candidates.slice(1, 4).map((c) => (
              <button key={c.bpm} className="button compact" title="Another likely tempo: use it, keeping the downbeat" onClick={() => dispatch(grid ? { bpm: c.bpm } : { bpm: c.bpm, downbeat: 0 }, 'Change Tempo')}>
                {c.bpm}
              </button>
            ))}
          </>
        ) : (
          <span className="muted small">{tempoSource ? statusText(analysisController.state(tempoSource)) : 'Add a source (your song) to detect its tempo'}</span>
        )}
      </div>
    </div>
  )
}

export function AudioAnalysisWindow() {
  useObservable(projectController)
  useObservable(tl)
  useObservable(analysisController)
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const project = projectController.project
  if (!project) return null
  const sequence = project.sequence
  const sources = sequence.audioSources
  const current = sources.find((s) => s.id === selected) ?? sources[0] ?? null
  const add = (kind: AudioSource['kind'], target: string | null, name: string) => {
    const command = addAudioSource(kind, target, name)
    if (projectController.dispatch(command)) setSelected(command.sourceId)
  }
  const selectedAudio = sequence.clips.find((c) => tl.selection.has(c.id) && c.kind === 'audio')
  const addItems: MenuEntry[] = [
    { label: selectedAudio ? `Selected Clip (${selectedAudio.name})` : 'Selected Clip', disabled: !selectedAudio, onSelect: () => selectedAudio && add('clip', selectedAudio.id, selectedAudio.name) },
    'separator',
    ...sequence.tracks
      .filter((t) => t.kind === 'audio')
      .map((t): MenuEntry => ({ label: `Track ${t.name}${t.muted ? ' (muted: sidechain)' : ''}`, onSelect: () => add('track', t.id, t.name) })),
    'separator',
    { label: 'Full Mix', onSelect: () => add('mix', null, 'Mix') }
  ]
  return (
    <div className="audio-analysis">
      <div className="aa-sources">
        <div className="aa-sources-head">
          <span className="fx-title">Sources</span>
          <span className="spacer" />
          <button className="button compact" onClick={(event) => setMenu({ x: event.clientX, y: event.clientY })}>
            + Source
          </button>
        </div>
        {sources.length === 0 && <p className="muted small aa-hint">Add the sound to listen to: your song's track, a drum stem (mute its track to use it only as a sidechain), one clip, or the full mix.</p>}
        {sources.map((source) => {
          const state = analysisController.state(source.id)
          return (
            <div
              key={source.id}
              className={`aa-source ${current?.id === source.id ? 'selected' : ''}`}
              onClick={() => setSelected(source.id)}
              onDoubleClick={() =>
                setPrompt({
                  title: 'Rename Source',
                  label: 'Name (e.g. Song, Drums)',
                  initial: source.name,
                  confirm: 'Rename',
                  resolve: (name) => {
                    setPrompt(null)
                    if (name) projectController.dispatch(renameAudioSource(source.id, name))
                  }
                })
              }
            >
              <div className="aa-source-name">
                {source.name}
                {sequence.beatGrid?.sourceId === source.id && <span className="aa-badge">tempo</span>}
              </div>
              <div className="muted small">{describe(source, sequence)}</div>
              <div className={`small ${state.status.kind === 'failed' ? 'danger-text' : 'muted'}`}>{statusText(state)}</div>
              <button className="icon-button aa-remove" title="Remove this source (its analysis stays in the cache)" onClick={(event) => (event.stopPropagation(), projectController.dispatch(removeAudioSource(source.id)))}>
                ✕
              </button>
            </div>
          )
        })}
      </div>
      <div className="aa-main">
        <TempoPanel sequence={sequence} selected={current?.id ?? null} />
        <SignalView sourceId={current?.id ?? null} sequence={sequence} />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={addItems} onClose={() => setMenu(null)} />}
      <PromptDialog request={prompt} />
    </div>
  )
}
