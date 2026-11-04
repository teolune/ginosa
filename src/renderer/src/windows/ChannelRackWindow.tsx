import { useEffect, useRef, useState } from 'react'
import { BANDS } from '@engine/audio/analysis'
import { beatAt } from '@engine/audio/beat-grid'
import { DEFAULT_GRID } from '@engine/modulation/curve'
import { STEPS_PER_BEAT, type RackRow, type Sequence } from '@engine/project/model'
import { addRackRows, fillRackRow, moveRackRow, removeRackRow, renameRackRow, repeatRackSteps, setRackRow, setRackSteps, STARTER_ROWS } from '@engine/timeline/rack-edits'
import { autofillRow, songSteps } from '../rack/autofill'
import { sequenceEnd } from '@engine/timeline/timeline'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { analysisController } from '../audio/analysis-controller'
import { modulationController } from '../audio/modulation-controller'
import { modulationUi } from '../audio/modulation-ui'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'
import { ScrubNumber } from './EffectControlsWindow'

/**
 * The Channel Rack (M12), after FL Studio's: one row per trigger, each with its light (on or
 * off), Swing and name, then its steps, a bar or more at a time, in groups of four (a beat)
 * shaded alternately. Click a step to turn it on or off; drag across steps to paint. Steps sit
 * on the beat grid through the whole song; the page follows the playhead, or turn the pages.
 * Each row drives a modulator: link values to it (right-click a value › Link to Pattern).
 */

const dispatch = (command: Parameters<typeof projectController.dispatch>[0]) => projectController.dispatch(command)

function gridOf(sequence: Sequence) {
  return sequence.beatGrid ?? DEFAULT_GRID
}

export function ChannelRackWindow() {
  useObservable(projectController)
  useObservable(timelineController)
  useObservable(modulationController)
  useObservable(analysisController)
  const [barsShown, setBarsShown] = useState(2)
  const [follow, setFollow] = useState(true)
  const [page, setPage] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const stroke = useRef<{ id: string; on: boolean; rowId: string } | null>(null)
  useEffect(() => {
    const end = () => (stroke.current = null)
    window.addEventListener('pointerup', end)
    return () => window.removeEventListener('pointerup', end)
  }, [])
  const project = projectController.project
  if (!project) return null
  const sequence = project.sequence
  const rows = sequence.rack.rows
  const grid = gridOf(sequence)
  const stepsPerBar = grid.beatsPerBar * STEPS_PER_BEAT
  const playhead = timelineController.playhead
  const playStep = Math.floor(beatAt(grid, playhead) * STEPS_PER_BEAT + 1e-9)
  const playBar = Math.floor(playStep / stepsPerBar)
  const firstBar = Math.floor(beatAt(grid, 0) / grid.beatsPerBar)
  const lastBar = Math.max(firstBar, Math.floor(beatAt(grid, sequenceEnd(sequence)) / grid.beatsPerBar))
  // Pages line up with the downbeat (bar 1); bars before it (a pickup) count back from 0.
  const startBar = follow ? Math.floor(playBar / barsShown) * barsShown : page
  const from = startBar * stepsPerBar
  const count = barsShown * stepsPerBar
  const columns = Array.from({ length: count }, (_, i) => from + i)
  const endStep = Math.ceil(beatAt(grid, sequenceEnd(sequence)) * STEPS_PER_BEAT)
  const turn = (bars: number) => {
    setFollow(false)
    setPage(Math.min(lastBar, Math.max(Math.floor(firstBar / barsShown) * barsShown, startBar + bars)))
  }

  const paint = (row: RackRow, step: number, start: boolean) => {
    if (start) stroke.current = { id: `${row.id}:${Date.now()}`, on: !row.steps.includes(step), rowId: row.id }
    const s = stroke.current
    if (!s || s.rowId !== row.id) return
    if (row.steps.includes(step) === s.on) return
    dispatch(setRackSteps(row.id, [step], s.on, s.id))
  }

  const autofill = (row: RackRow, sourceId: string, whole: boolean) => {
    if (!analysisController.ready(sourceId)) return projectController.showMessage('That source is still being analysed: try again in a moment (Audio Analysis shows its progress)')
    const [a, b] = whole ? songSteps(sequence) : [from, from + count]
    const steps = autofillRow(row, sourceId, a, b)
    const source = sequence.audioSources.find((s) => s.id === sourceId)
    if (steps) projectController.showMessage(`${row.name}: ${steps.length} step${steps.length === 1 ? '' : 's'} from ${source?.name ?? 'the source'}’s ${BANDS.find((x) => x.id === row.band)?.label ?? row.band} hits${whole ? '' : ' in these bars'}. Fix any it got wrong by clicking steps.`)
  }

  const rowMenu = (row: RackRow, x: number, y: number) => {
    const index = rows.indexOf(row)
    const band = BANDS.find((b) => b.id === row.band)?.label ?? row.band
    const items: MenuEntry[] = [
      {
        label: 'Rename…',
        onSelect: () =>
          setPrompt({
            title: 'Rename Row',
            label: 'Name',
            initial: row.name,
            confirm: 'Rename',
            resolve: (name) => {
              setPrompt(null)
              if (name) dispatch(renameRackRow(row.id, name))
            }
          })
      },
      'separator',
      ...(sequence.audioSources.length === 0
        ? [{ label: 'Auto-fill: add a source in Audio Analysis first', disabled: true, onSelect: () => undefined } as MenuEntry]
        : sequence.audioSources.flatMap((s): MenuEntry[] => [
            { label: `Auto-fill whole song from ${s.name} (${band} hits)`, onSelect: () => autofill(row, s.id, true) },
            { label: `Auto-fill these bars from ${s.name} (${band} hits)`, onSelect: () => autofill(row, s.id, false) }
          ])),
      ...BANDS.map((b): MenuEntry => ({ label: `${b.id === row.band ? '✓ ' : '   '}Auto-fill listens to ${b.label}`, onSelect: () => dispatch(setRackRow(row.id, { band: b.id })) })),
      'separator',
      { label: 'Clear These Bars', onSelect: () => dispatch(fillRackRow(row.id, from, from + count, [], `Clear ${row.name}`)), disabled: !row.steps.some((s) => s >= from && s < from + count) },
      { label: 'Repeat These Bars to the End', onSelect: () => dispatch(repeatRackSteps([row.id], from, count, endStep)), disabled: from + count >= endStep },
      { label: 'Show Its Modulator', onSelect: () => openModulator(row), disabled: !row.modulatorId },
      'separator',
      { label: 'Move Up', onSelect: () => dispatch(moveRackRow(row.id, index - 1)), disabled: index === 0 },
      { label: 'Move Down', onSelect: () => dispatch(moveRackRow(row.id, index + 1)), disabled: index === rows.length - 1 },
      'separator',
      { label: 'Delete Row', danger: true, onSelect: () => dispatch(removeRackRow(row.id)) }
    ]
    setMenu({ x, y, items })
  }

  const addMenu = (x: number, y: number) => {
    const has = new Set(rows.map((r) => r.name.toLowerCase()))
    const items: MenuEntry[] = [
      ...STARTER_ROWS.map((r): MenuEntry => ({ label: `${r.name} (Auto-fill from ${BANDS.find((b) => b.id === r.band)!.label})`, onSelect: () => dispatch(addRackRows([r])), disabled: has.has(r.name.toLowerCase()) })),
      'separator',
      {
        label: 'Other…',
        onSelect: () =>
          setPrompt({
            title: 'New Row',
            label: 'Name',
            initial: `Row ${rows.length + 1}`,
            confirm: 'Add',
            resolve: (name) => {
              setPrompt(null)
              if (name) dispatch(addRackRows([{ name, band: 'mid' }]))
            }
          })
      }
    ]
    setMenu({ x, y, items })
  }

  return (
    <div className="channel-rack">
      <div className="rack-head">
        <button className="button compact" title="Earlier bars" onClick={() => turn(-barsShown)} disabled={startBar <= firstBar}>
          ◀
        </button>
        <span className="rack-bars">{barsShown === 1 ? `Bar ${startBar + 1}` : `Bars ${startBar + 1}–${startBar + barsShown}`}</span>
        <button className="button compact" title="Later bars" onClick={() => turn(barsShown)} disabled={startBar + barsShown > lastBar}>
          ▶
        </button>
        <label className="mod-check" title="Turn the pages with the playhead">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => {
              setFollow(e.target.checked)
              if (!e.target.checked) setPage(startBar)
            }}
          />{' '}
          Follow playhead
        </label>
        <select className="input compact" aria-label="Bars shown" value={barsShown} onChange={(e) => setBarsShown(Number(e.target.value))}>
          {[1, 2, 4].map((n) => (
            <option key={n} value={n}>
              {n} bar{n === 1 ? '' : 's'}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="button compact" title="Loop these bars of every row through to the end of the sequence" disabled={rows.length === 0 || from + count >= endStep} onClick={() => dispatch(repeatRackSteps(rows.map((r) => r.id), from, count, endStep))}>
          Repeat to End
        </button>
        <button className="button compact" onClick={(e) => addMenu(e.clientX, e.clientY)}>
          + Row
        </button>
      </div>
      {!sequence.beatGrid && <p className="muted small rack-note">No beat grid yet, so steps follow 120 BPM from the start. Set the tempo in Audio Analysis (⌥⇧1) and they move with it.</p>}
      {rows.length === 0 ? (
        <div className="rack-empty">
          <p className="muted small">Each row fires on its steps, in time with the beat grid. Link any value to a row (right-click the value › Link to Pattern), and Auto-fill a row from your song’s hits, then fix it by hand.</p>
          <button className="button" onClick={() => dispatch(addRackRows(STARTER_ROWS))}>
            Add Kick, Clap and Hat
          </button>
        </div>
      ) : (
        <div className="rack-rows" style={{ ['--steps' as string]: count }}>
          {rows.map((row) => {
            const level = row.modulatorId ? (modulationController.valueAt(row.modulatorId, playhead) ?? 0) : 0
            return (
              <div key={row.id} className={`rack-row ${row.enabled ? '' : 'off'}`}>
                <button className={`rack-light ${row.enabled ? 'on' : ''}`} title={row.enabled ? 'Turn this row off (its steps are kept)' : 'Turn this row on'} aria-pressed={row.enabled} onClick={() => dispatch(setRackRow(row.id, { enabled: !row.enabled }))} />
                <span className="rack-swing" title="Swing: every second 16th later by this share of a 16th (33% is a triplet shuffle)">
                  <ScrubNumber label={`${row.name} swing`} value={row.swing} min={0} max={75} step={0.5} decimals={0} unit="%" onChange={(v) => dispatch(setRackRow(row.id, { swing: v }))} disabled={false} />
                </span>
                <button className="rack-name" title={`${row.name}: click for its menu (Auto-fill, Clear, Repeat, Rename…)`} onClick={(e) => rowMenu(row, e.clientX, e.clientY)} onContextMenu={(e) => (e.preventDefault(), rowMenu(row, e.clientX, e.clientY))}>
                  <span className="rack-activity" style={{ opacity: 0.2 + 0.8 * level }} />
                  {row.name}
                </button>
                <div className="rack-steps">
                  {columns.map((step, i) => {
                    const on = row.steps.includes(step)
                    const beat = Math.floor(i / STEPS_PER_BEAT)
                    return (
                      <button
                        key={step}
                        className={`rack-step ${beat % 2 ? 'odd' : ''} ${on ? 'on' : ''} ${step === playStep ? 'playing' : ''} ${i % stepsPerBar === 0 ? 'bar' : ''}`}
                        aria-pressed={on}
                        aria-label={`${row.name} bar ${Math.floor(step / stepsPerBar) + 1} step ${(((step % stepsPerBar) + stepsPerBar) % stepsPerBar) + 1}`}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          e.currentTarget.releasePointerCapture(e.pointerId)
                          paint(row, step, true)
                        }}
                        onPointerEnter={() => stroke.current && paint(row, step, false)}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog request={prompt} />}
    </div>
  )
}

function openModulator(row: RackRow) {
  if (!row.modulatorId) return
  modulationUi.select(row.modulatorId)
  workspaceController.open('modulation')
  workspaceController.focus('modulation')
}
