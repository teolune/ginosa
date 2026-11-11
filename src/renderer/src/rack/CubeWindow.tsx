import { useRef } from 'react'
import { effectById } from '../../../effects/registry'
import { propertySpec } from '@engine/keyframes/properties'
import type { RackCube } from '@engine/project/model'
import { linksTo } from '@engine/timeline/modulation-edits'
import { channelModulatorIds, cubeAmount, placeSections, sectionName, stepsPerBar } from '@engine/timeline/rack'
import { setCubeAmount, type CubeRef } from '@engine/timeline/rack-edits'
import { DEFAULT_GRID } from '@engine/modulation/curve'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { rackUi } from './rack-ui'

/**
 * The cube window (decision 109): for the selected cubes, one slider per value linked to
 * their channel: how far each cube pushes it, −100% (down) to +100% (up). The link's own
 * range (how far 100% is) is set in Effect Controls.
 */
export function CubeWindow() {
  useObservable(projectController)
  useObservable(rackUi)
  const stroke = useRef<string>('')
  const sequence = projectController.project?.sequence
  if (!sequence) return null
  const grid = sequence.beatGrid ?? DEFAULT_GRID
  const placed = placeSections(sequence.rack, grid)
  const groups = new Map<string, Array<{ ref: CubeRef; cube: RackCube }>>()
  for (const ref of rackUi.selection) {
    const cube = sequence.rack.sections.find((s) => s.id === ref.sectionId)?.cubes[ref.rowId]?.find((c) => c.step === ref.step)
    if (!cube) continue
    const list = groups.get(ref.rowId) ?? []
    list.push({ ref, cube })
    groups.set(ref.rowId, list)
  }
  const first = rackUi.selection[0]
  const firstRow = first && sequence.rack.rows.find((r) => r.id === first.rowId)
  const firstSection = first && placed.find((p) => p.section.id === first.sectionId)
  const perBar = stepsPerBar(grid)
  const title =
    rackUi.selection.length === 1 && firstRow && firstSection
      ? `${firstRow.name} · section ${sectionName(firstSection.index)} · bar ${Math.floor(first!.step / perBar) + 1}, 16th ${(first!.step % perBar) + 1}`
      : `${rackUi.selection.length} cubes`
  return (
    <div className="cube-window" role="dialog" aria-label="Cube window">
      <header className="cube-window-head">
        <span className="cube-window-title">{title}</span>
        <span className="spacer" />
        <button className="window-button close" title="Close (Esc)" onClick={() => rackUi.openCubeWindow(false)}>
          ×
        </button>
      </header>
      {[...groups].map(([rowId, items]) => {
        const row = sequence.rack.rows.find((r) => r.id === rowId)
        if (!row) return null
        const links = channelModulatorIds(sequence, row.id).flatMap((id) => linksTo(sequence, id))
        return (
          <div key={rowId} className="cube-group">
            {groups.size > 1 && <div className="cube-group-name">{row.name}</div>}
            {links.length === 0 && (
              <p className="muted small">
                Nothing is linked to {row.name} yet. Click its name, press R, then click the link sockets beside values in Effect Controls (or drag {row.name} onto a value).
              </p>
            )}
            {links.map(({ link, clip, ref }) => {
              const effect = ref.effectId ? clip.effects.find((e) => e.id === ref.effectId) : null
              const effectName = effect ? (effectById(effect.effectId)?.name ?? 'Effect') : 'Motion'
              const param = propertySpec(clip, ref.effectId, ref.param)?.label ?? ref.param
              const values = items.map((i) => Math.round(cubeAmount(i.cube, link.id) * 100))
              const value = values[0] ?? 100
              const mixed = values.some((v) => v !== value)
              const refs = items.map((i) => i.ref)
              return (
                <label key={link.id} className="cube-link" title={`${clip.name} › ${effectName} › ${param}`}>
                  <span className="cube-link-name">
                    <span className="cube-link-param">{param}</span>
                    <span className="muted small cube-link-where">
                      {effectName} · {clip.name}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={1}
                    value={value}
                    className="slider cube-slider"
                    onPointerDown={() => (stroke.current = `${link.id}:${Date.now()}`)}
                    onChange={(e) => projectController.dispatch(setCubeAmount(refs, link.id, Number(e.target.value), stroke.current || null))}
                    onDoubleClick={() => projectController.dispatch(setCubeAmount(refs, link.id, 100))}
                  />
                  <span className={`mono cube-amount ${value < 0 ? 'down' : ''}`}>{mixed ? 'mixed' : `${value > 0 ? '+' : ''}${value}%`}</span>
                </label>
              )
            })}
          </div>
        )
      })}
      <p className="muted small cube-hint">How far 100% moves each value is set under it in Effect Controls. Double-click a slider for 100%. ⌥⌘C / ⌥⌘V copy these amounts to other cubes.</p>
    </div>
  )
}
