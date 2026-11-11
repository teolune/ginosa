import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { beatAt, beatTime } from '@engine/audio/beat-grid'
import { DEFAULT_GRID } from '@engine/modulation/curve'
import { MAX_SECTION_BARS, STEPS_PER_BEAT, type RackCube, type RackRow, type Sequence } from '@engine/project/model'
import { channelModulatorIds, maxLoopSteps, placeSections, sectionAtStep, sectionName, stepsPerBar, type PlacedSection } from '@engine/timeline/rack'
import {
  addRackRows,
  addRackSection,
  moveRackRow,
  pasteCubeAmounts,
  pasteRackCubes,
  removeRackCubes,
  removeRackRow,
  removeRackSection,
  renameRackRow,
  setRackCubes,
  setRackRow,
  setRackSectionBars,
  STARTER_ROWS,
  type CubeRef
} from '@engine/timeline/rack-edits'
import { linksTo } from '@engine/timeline/modulation-edits'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { Icon } from '../app/Icon'
import { modulationController } from '../audio/modulation-controller'
import { modulationUi } from '../audio/modulation-ui'
import { CubeWindow } from '../rack/CubeWindow'
import { detector } from '../rack/detect'
import { MiniKnob } from '../rack/MiniKnob'
import { CHANNEL_DRAG_TYPE, rackUi } from '../rack/rack-ui'
import { PLAYHEAD_THROTTLE, STATE_AND_PLAYHEAD, useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController } from '../timeline/timeline-controller'

/**
 * The Channel Rack (M12, redesigned in W3, decisions 105–109). Sections run on from bar 1
 * (A, B, C…, 1–16 bars each); each shows one loop of cubes per channel, two bars of 16ths,
 * which repeats through it. Click an empty cube to make one, a cube to select it; Backspace
 * deletes; double-click opens the cube window (how far it pushes each linked value). A
 * channel's light, nudge and strength sit at its left; click its name, then R, to link values.
 */

const dispatch = (command: Parameters<typeof projectController.dispatch>[0]) => projectController.dispatch(command)

function gridOf(sequence: Sequence) {
  return sequence.beatGrid ?? DEFAULT_GRID
}

function cubesOf(placed: PlacedSection | null, rowId: string): Map<number, RackCube> {
  return new Map((placed?.section.cubes[rowId] ?? []).map((c) => [c.step, c]))
}

export function ChannelRackWindow() {
  useObservable(projectController)
  useObservable(timelineController, STATE_AND_PLAYHEAD, PLAYHEAD_THROTTLE)
  useObservable(modulationController)
  useObservable(rackUi)
  useObservable(detector)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const [editingBars, setEditingBars] = useState<string | null>(null)
  const stroke = useRef<{ id: string; mode: 'paint' | 'select'; rowId: string; sectionId: string; anchor: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const end = () => (stroke.current = null)
    window.addEventListener('pointerup', end)
    return () => window.removeEventListener('pointerup', end)
  }, [])
  const project = projectController.project
  const rack = project?.sequence.rack
  useEffect(() => {
    if (!rack) return
    rackUi.prune(
      (ref) => rack.sections.some((s) => s.id === ref.sectionId && (s.cubes[ref.rowId] ?? []).some((c) => c.step === ref.step)),
      (id) => rack.sections.some((s) => s.id === id),
      (id) => rack.rows.some((r) => r.id === id)
    )
  }, [rack])
  if (!project || !rack) return null
  const sequence = project.sequence
  const rows = rack.rows
  const grid = gridOf(sequence)
  const perBar = stepsPerBar(grid)
  const columns = maxLoopSteps(grid)
  const placed = placeSections(rack, grid)
  const playhead = timelineController.playhead
  const playStep = beatAt(grid, playhead) * 4
  const playing = sectionAtStep(rack, grid, playStep)
  const chosen = placed.find((p) => p.section.id === rackUi.sectionId) ?? null
  const shown = rackUi.follow ? (playing ?? chosen ?? placed[0] ?? null) : (chosen ?? placed[0] ?? null)
  const playColumn = shown && playing && playing.section.id === shown.section.id ? Math.floor(playStep - shown.firstStep) % shown.loop : -1
  const loop = shown?.loop ?? columns

  const ref = (rowId: string, step: number): CubeRef | null => (shown ? { sectionId: shown.section.id, rowId, step } : null)

  // ---- cubes: click to make or select, drag to paint or select more ----
  const onCubeDown = (event: ReactPointerEvent, row: RackRow, step: number) => {
    if (event.button !== 0 || !shown || step >= loop) return
    // Let the drag reach the next cubes (buttons keep the pointer otherwise).
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // No capture to release.
    }
    rootRef.current?.focus()
    rackUi.pickChannel(row.id)
    const cube = cubesOf(shown, row.id).get(step)
    const here = ref(row.id, step)!
    const id = `${row.id}:${Date.now()}`
    if (!cube) {
      dispatch(setRackCubes(shown.section.id, row.id, [step], true, id))
      rackUi.select([here], event.shiftKey || event.metaKey ? 'add' : 'replace')
      stroke.current = { id, mode: 'paint', rowId: row.id, sectionId: shown.section.id, anchor: step }
      return
    }
    if (event.shiftKey && rackUi.selection.length > 0) {
      const last = rackUi.selection[rackUi.selection.length - 1]!
      if (last.rowId === row.id && last.sectionId === shown.section.id) {
        const [a, b] = last.step < step ? [last.step, step] : [step, last.step]
        const cubes = [...cubesOf(shown, row.id).keys()].filter((s) => s >= a && s <= b)
        rackUi.select(cubes.map((s) => ref(row.id, s)!), 'add')
        return
      }
    }
    if (event.metaKey) rackUi.select([here], 'toggle')
    else if (!rackUi.isSelected(here)) rackUi.select([here])
    stroke.current = { id, mode: 'select', rowId: row.id, sectionId: shown.section.id, anchor: step }
  }
  const onCubeEnter = (row: RackRow, step: number) => {
    const s = stroke.current
    if (!s || !shown || s.sectionId !== shown.section.id || step >= loop) return
    const has = cubesOf(shown, row.id).has(step)
    if (s.mode === 'paint' && row.id === s.rowId && !has) {
      dispatch(setRackCubes(shown.section.id, row.id, [step], true, s.id))
      rackUi.select([ref(row.id, step)!], 'add')
    } else if (s.mode === 'select' && has && !rackUi.isSelected(ref(row.id, step)!)) rackUi.select([ref(row.id, step)!], 'add')
  }

  const selectedIn = () => rackUi.selection.filter((s) => shown && s.sectionId === shown.section.id)
  const copyCubes = () => {
    const sel = selectedIn()
    if (!shown || sel.length === 0) return
    rackUi.copiedCubes = sel.map((s) => ({ rowId: s.rowId, step: s.step, amounts: { ...(cubesOf(shown, s.rowId).get(s.step)?.amounts ?? {}) } }))
    projectController.showMessage(`Copied ${sel.length} cube${sel.length === 1 ? '' : 's'}`)
  }
  const pasteCubes = () => {
    if (!shown || !rackUi.copiedCubes) return
    if (dispatch(pasteRackCubes(shown.section.id, rackUi.copiedCubes))) rackUi.select(rackUi.copiedCubes.map((c) => ref(c.rowId, c.step)!))
  }
  const copyAmounts = () => {
    const first = rackUi.selection[0]
    const section = first && rack.sections.find((s) => s.id === first.sectionId)
    const cube = section?.cubes[first!.rowId]?.find((c) => c.step === first!.step)
    if (!cube) return
    rackUi.copiedAmounts = { ...cube.amounts }
    projectController.showMessage('Copied the cube’s amounts: select cubes and press ⌥⌘V to give them the same')
  }
  const pasteAmounts = () => {
    if (rackUi.copiedAmounts && rackUi.selection.length) dispatch(pasteCubeAmounts(rackUi.selection, rackUi.copiedAmounts))
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT') return
    const cmd = event.metaKey || event.ctrlKey
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && rackUi.selection.length) {
      handled()
      dispatch(removeRackCubes(rackUi.selection))
      rackUi.select([])
    } else if (cmd && event.code === 'KeyA' && shown) {
      handled()
      rackUi.select(rows.flatMap((r) => [...cubesOf(shown, r.id).keys()].filter((s) => s < loop).map((s) => ref(r.id, s)!)))
    } else if (cmd && event.altKey && event.code === 'KeyC') {
      handled()
      copyAmounts()
    } else if (cmd && event.altKey && event.code === 'KeyV') {
      handled()
      pasteAmounts()
    } else if (cmd && event.code === 'KeyC') {
      handled()
      copyCubes()
    } else if (cmd && event.code === 'KeyV') {
      handled()
      pasteCubes()
    } else if (!cmd && !event.altKey && (event.key === 'r' || event.key === 'R')) {
      handled()
      const channel = rackUi.channelId ?? rackUi.selection[0]?.rowId ?? null
      if (!channel) projectController.showMessage('Click a channel’s name first, then press R to link values to it')
      else rackUi.toggleLinking(channel)
    } else if (event.key === 'Escape') {
      handled()
      if (rackUi.cubeWindow) rackUi.openCubeWindow(false)
      else rackUi.select([])
    } else if (event.key === 'Enter' && rackUi.selection.length) {
      handled()
      rackUi.openCubeWindow(true)
    }
  }

  // ---- menus ----
  const channelMenu = (row: RackRow, x: number, y: number) => {
    const index = rows.indexOf(row)
    const items: MenuEntry[] = [
      { label: rackUi.linking === row.id ? 'Stop Linking' : 'Link Values to It', shortcut: 'R', onSelect: () => rackUi.toggleLinking(row.id) },
      'separator',
      { label: 'Rename…', onSelect: () => rename(row) },
      {
        label: `Swing… (${row.swing}%)`,
        onSelect: () =>
          setPrompt({
            title: `${row.name}: Swing`,
            label: 'Every second 16th later by (0–75% of a 16th; 33 is a shuffle)',
            initial: String(row.swing),
            confirm: 'Set',
            resolve: (value) => {
              setPrompt(null)
              if (value !== null && value.trim() !== '') dispatch(setRackRow(row.id, { swing: Number(value) }))
            }
          })
      },
      { label: 'Show Its Modulator (rise and fall)', onSelect: () => openModulator(row), disabled: !row.modulatorId },
      'separator',
      { label: 'Move Up', onSelect: () => dispatch(moveRackRow(row.id, index - 1)), disabled: index === 0 },
      { label: 'Move Down', onSelect: () => dispatch(moveRackRow(row.id, index + 1)), disabled: index === rows.length - 1 },
      'separator',
      { label: 'Delete Channel', danger: true, onSelect: () => dispatch(removeRackRow(row.id)) }
    ]
    setMenu({ x, y, items })
  }
  const rename = (row: RackRow) =>
    setPrompt({
      title: 'Rename Channel',
      label: 'Name',
      initial: row.name,
      confirm: 'Rename',
      resolve: (name) => {
        setPrompt(null)
        if (name) dispatch(renameRackRow(row.id, name))
      }
    })
  const addMenu = (x: number, y: number) => {
    const has = new Set(rows.map((r) => r.name.toLowerCase()))
    setMenu({
      x,
      y,
      items: [
        ...STARTER_ROWS.map((r): MenuEntry => ({ label: r.name, onSelect: () => dispatch(addRackRows([r])), disabled: has.has(r.name.toLowerCase()) })),
        'separator',
        {
          label: 'Other…',
          onSelect: () =>
            setPrompt({
              title: 'New Channel',
              label: 'Name',
              initial: `Channel ${rows.length + 1}`,
              confirm: 'Add',
              resolve: (name) => {
                setPrompt(null)
                if (name) dispatch(addRackRows([{ name }]))
              }
            })
        }
      ]
    })
  }
  const sectionMenu = (p: PlacedSection, x: number, y: number) =>
    setMenu({
      x,
      y,
      items: [
        { label: 'Change Length…', onSelect: () => setEditingBars(p.section.id) },
        { label: 'Add Empty Section After', onSelect: () => addSection(p.section.id) },
        { label: 'Go to Its Start', onSelect: () => timelineController.movePlayhead(Math.max(0, beatTime(grid, p.firstStep / 4))) },
        'separator',
        { label: 'Delete Section', danger: true, onSelect: () => dispatch(removeRackSection(p.section.id)) }
      ]
    })
  const addSection = (after: string | null) => {
    const command = addRackSection(after)
    if (dispatch(command)) rackUi.showSection(command.sectionId)
  }
  const commitBars = (id: string, text: string) => {
    setEditingBars(null)
    const bars = Number(text)
    if (!Number.isInteger(bars) || bars < 1 || bars > MAX_SECTION_BARS) return projectController.showMessage(`A section is 1 to ${MAX_SECTION_BARS} bars`)
    dispatch(setRackSectionBars(id, bars))
  }
  const linkCount = (row: RackRow) => channelModulatorIds(sequence, row.id).reduce((n, id) => n + linksTo(sequence, id).length, 0)
  const linkingRow = rows.find((r) => r.id === rackUi.linking)

  return (
    <div className="channel-rack" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="rack-top">
        <button
          className={`cp-button ${detector.busy ? 'busy' : ''}`}
          title={detector.busy ? detector.status : 'Automatic Detection: kicks, claps, hi-hats and bass from the song on A1, in sections where the pattern changes'}
          aria-label="Detect the pattern from the song"
          disabled={detector.busy}
          onClick={() => void detector.run()}
        >
          <Icon name="sparkles" fallback="✦" />
        </button>
        <button className={`cp-button ${rackUi.follow ? 'on' : ''}`} title={rackUi.follow ? 'Following the playhead: shows the section under it. Click to stop.' : 'Follow the playhead'} aria-pressed={rackUi.follow} onClick={() => rackUi.setFollow(!rackUi.follow)}>
          <Icon name="toolForward" fallback="⇥" />
        </button>
        <div className="rack-sections" role="tablist" aria-label="Sections">
          {placed.map((p) => (
            <div
              key={p.section.id}
              role="tab"
              aria-selected={shown?.section.id === p.section.id}
              className={`rack-section ${shown?.section.id === p.section.id ? 'sel' : ''} ${playing?.section.id === p.section.id ? 'playing' : ''}`}
              title={`Section ${sectionName(p.index)}: bars ${p.startBar + 1}–${p.startBar + p.section.bars}. Double-click to change its length.`}
              onClick={() => rackUi.showSection(p.section.id)}
              onDoubleClick={() => setEditingBars(p.section.id)}
              onContextMenu={(e) => (e.preventDefault(), sectionMenu(p, e.clientX, e.clientY))}
            >
              <span className="rack-section-name">{sectionName(p.index)}</span>
              {editingBars === p.section.id ? (
                <input
                  className="input compact rack-bars-input mono"
                  type="number"
                  min={1}
                  max={MAX_SECTION_BARS}
                  defaultValue={p.section.bars}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => commitBars(p.section.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setEditingBars(null)
                  }}
                />
              ) : (
                <span className="rack-section-bars">
                  {p.section.bars} bar{p.section.bars === 1 ? '' : 's'}
                </span>
              )}
            </div>
          ))}
          <button className="cp-button" title="Add an empty section (8 bars) after the one shown" aria-label="Add a section" onClick={() => addSection(shown?.section.id ?? null)}>
            +
          </button>
        </div>
        <span className="spacer" />
        {detector.busy && (
          <span className="rack-status" role="status">
            {detector.status}
          </span>
        )}
        {linkingRow && (
          <button className="rack-linking" onClick={() => rackUi.toggleLinking()} title="Click link sockets in Effect Controls to link or unlink values. R or Esc to stop.">
            Linking to {linkingRow.name} · R or Esc to stop
          </button>
        )}
      </div>
      {!sequence.beatGrid && <p className="muted small rack-note">No tempo yet, so cubes follow 120 BPM from the start. Set it with the Control Panel’s tempo knob or its sparkles.</p>}
      {rows.length === 0 ? (
        <div className="rack-empty">
          <p className="muted small">Each channel fires on its cubes, in time with the tempo. Link values to a channel (click its name, press R, click values in Effect Controls), or let the sparkles fill it from the song on A1.</p>
          <button className="button" onClick={() => dispatch(addRackRows(STARTER_ROWS))}>
            Add Kick, Clap, Hi-hat and Bass
          </button>
        </div>
      ) : (
        <div className="rack-rows">
          {rows.map((row) => {
            const level = row.modulatorId ? Math.min(1, Math.abs(modulationController.valueAt(row.modulatorId, playhead) ?? 0)) : 0
            const cubes = cubesOf(shown, row.id)
            const links = linkCount(row)
            return (
              <div key={row.id} className={`rack-row ${row.enabled ? '' : 'off'}`}>
                <button className={`rack-light ${row.enabled ? 'on' : ''}`} title={row.enabled ? 'Turn this channel off (its cubes are kept)' : 'Turn this channel on'} aria-pressed={row.enabled} onClick={() => dispatch(setRackRow(row.id, { enabled: !row.enabled }))} />
                <MiniKnob
                  value={row.nudge}
                  min={-50}
                  max={50}
                  reset={0}
                  origin={0}
                  label={`${row.name} nudge`}
                  format={(v) => (v === 0 ? 'on the grid' : `${Math.abs(v)}% of a 16th ${v < 0 ? 'earlier' : 'later'}`)}
                  onChange={(v) => dispatch(setRackRow(row.id, { nudge: v }))}
                />
                <MiniKnob
                  value={row.strength}
                  min={0}
                  max={150}
                  reset={100}
                  origin={0}
                  label={`${row.name} strength`}
                  format={(v) => `${v}% of everything it moves`}
                  onChange={(v) => dispatch(setRackRow(row.id, { strength: v }))}
                />
                <button
                  className={`rack-name ${rackUi.channelId === row.id ? 'picked' : ''} ${rackUi.linking === row.id ? 'linking' : ''}`}
                  title={`${row.name}: click to pick it, then R to link values (or drag it onto a value in Effect Controls). Right-click for more.`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(CHANNEL_DRAG_TYPE, row.id)
                    e.dataTransfer.effectAllowed = 'link'
                  }}
                  onClick={() => rackUi.pickChannel(row.id)}
                  onDoubleClick={() => rename(row)}
                  onContextMenu={(e) => (e.preventDefault(), channelMenu(row, e.clientX, e.clientY))}
                >
                  <span className="rack-activity" style={{ opacity: 0.15 + 0.85 * level }} />
                  <span className="rack-name-text">{row.name}</span>
                  {links > 0 && <span className="rack-link-count" title={`${links} value${links === 1 ? '' : 's'} linked`}>{links}</span>}
                </button>
                <div className="rack-cubes" role="grid" aria-label={`${row.name} cubes`} style={{ '--columns': columns } as CSSProperties}>
                  {Array.from({ length: columns }, (_, step) => {
                    const cube = cubes.get(step)
                    const here = ref(row.id, step)
                    const selected = Boolean(here && cube && rackUi.isSelected(here))
                    const outside = step >= loop
                    const pushes = cube ? Object.values(cube.amounts).some((a) => a < 0) : false
                    return (
                      <button
                        key={step}
                        className={`rack-cube ${Math.floor(step / STEPS_PER_BEAT) % 2 ? 'odd' : ''} ${cube ? 'on' : ''} ${pushes ? 'down' : ''} ${selected ? 'sel' : ''} ${step === playColumn ? 'playing' : ''} ${outside ? 'outside' : ''}`}
                        aria-pressed={Boolean(cube)}
                        aria-label={`${row.name}, bar ${Math.floor(step / perBar) + 1}, 16th ${(step % perBar) + 1}${cube ? '' : ', empty'}`}
                        disabled={outside}
                        onPointerDown={(e) => onCubeDown(e, row, step)}
                        onPointerEnter={() => onCubeEnter(row, step)}
                        onDoubleClick={() => {
                          if (!cube || !here) return
                          if (!rackUi.isSelected(here)) rackUi.select([here])
                          rackUi.openCubeWindow(true)
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          if (cube && here && !rackUi.isSelected(here)) rackUi.select([here])
                          setMenu({
                            x: e.clientX,
                            y: e.clientY,
                            items: [
                              { label: 'Open Cube Window', shortcut: '↩', onSelect: () => rackUi.openCubeWindow(true), disabled: !cube },
                              'separator',
                              { label: 'Copy', shortcut: '⌘C', onSelect: copyCubes, disabled: !cube },
                              { label: 'Paste', shortcut: '⌘V', onSelect: pasteCubes, disabled: !rackUi.copiedCubes },
                              { label: 'Copy Amounts', shortcut: '⌥⌘C', onSelect: copyAmounts, disabled: !cube },
                              { label: 'Paste Amounts', shortcut: '⌥⌘V', onSelect: pasteAmounts, disabled: !rackUi.copiedAmounts || rackUi.selection.length === 0 },
                              'separator',
                              { label: 'Delete', shortcut: '⌫', danger: true, onSelect: () => (dispatch(removeRackCubes(rackUi.selection)), rackUi.select([])), disabled: rackUi.selection.length === 0 }
                            ]
                          })
                        }}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
          <div className="rack-row rack-add-row">
            <button className="button compact" onClick={(e) => addMenu(e.clientX, e.clientY)}>
              + Channel
            </button>
            {shown && (
              <span className="muted small rack-where">
                Section {sectionName(shown.index)}: bars {shown.startBar + 1}–{shown.startBar + shown.section.bars}
                {shown.section.bars > 2 ? `, this loop ×${(shown.section.bars / Math.min(2, shown.section.bars)).toFixed(shown.section.bars % 2 ? 1 : 0)}` : ''}
              </span>
            )}
          </div>
        </div>
      )}
      {rackUi.cubeWindow && <CubeWindow />}
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
