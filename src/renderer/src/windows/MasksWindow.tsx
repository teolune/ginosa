import { useState } from 'react'
import type { ParamValue } from '@engine/effects/types'
import type { InterpolationPreset } from '@engine/keyframes/keyframes'
import { shapeValueAt } from '@engine/masks/masks'
import { MASK_KIND_LABELS, MASK_PARAMS, maskParams, type Mask, type MaskMode, type MaskParam, type MaskShape, type MaskShapeKind } from '@engine/masks/types'
import type { Sequence } from '@engine/project/model'
import {
  addMask,
  addShape,
  addShapeKeyframe,
  duplicateMask,
  maskUsers,
  moveShape,
  removeMask,
  removeMaskLinks,
  removeShape,
  removeShapeKeyframes,
  renameMask,
  setShapeAnimated,
  setShapeInterpolation,
  setShapeInverted,
  setShapeMode,
  setShapeValues,
  type MaskValueRef
} from '@engine/timeline/mask-edits'
import { effectById } from '../../../effects/registry'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { confirmKeyframeRemoval } from '../app/warnings'
import { modulationController } from '../audio/modulation-controller'
import { modulationUi } from '../audio/modulation-ui'
import { maskController } from '../masks/mask-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController as tl } from '../timeline/timeline-controller'
import { LinkToAudioDialog } from './LinkToAudioDialog'
import { ScrubNumber } from './EffectControlsWindow'

/**
 * The Masks window (M9): the sequence's shared masks, the shapes each is made of (combined
 * top to bottom), the selected shape's settings (each keyframeable and modulatable, in
 * sequence time), and what uses the mask. Shapes are drawn and dragged on the Program monitor.
 */

const dispatch = (command: Parameters<typeof projectController.dispatch>[0]) => projectController.dispatch(command)
const KINDS: MaskShapeKind[] = ['rectangle', 'ellipse', 'path', 'edge', 'luminance']
const MODE_LABELS: Record<MaskMode, string> = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' }

const KIND_HELP: Record<MaskShapeKind, string> = {
  rectangle: 'Drag it on the Program monitor; its corners resize it and the knob above turns it.',
  ellipse: 'Drag it on the Program monitor; its handles resize it and the knob above turns it.',
  path: 'Drag its points on the Program monitor. Click an edge to add a point, ⌥-click a point to remove it, double-click a point to make it smooth or a corner; drag a handle to bend (⌥ bends one side only).',
  edge: 'From the frame’s edges inwards: Width is how far it reaches (drag the dashed line on the monitor).',
  luminance: 'Where the image underneath is between Low and High brightness (each effect checks its own input).'
}

/** One mask setting: stopwatch, value at the playhead, ◀ ◆ ▶, right-click for keyframes and modulation. */
function MaskParamRow({ mask, shape, param }: { mask: Mask; shape: MaskShape; param: MaskParam }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const spec = MASK_PARAMS[param]
  const ref: MaskValueRef = { maskId: mask.id, shapeId: shape.id, param }
  const playhead = tl.playhead
  const frame = tl.frame()
  const here = Math.max(0, Math.round(playhead / frame) * frame)
  const track = shape.keyframes[param] ?? []
  const animated = track.length > 0
  const value = shapeValueAt(shape, param, playhead)
  const links = shape.modulation[param] ?? []
  const live = links.length > 0 ? shapeValueAt(shape, param, playhead, modulationController.context) : null
  const atKey = track.find((k) => k.time === here)
  const prev = [...track].reverse().find((k) => k.time < here)
  const next = track.find((k) => k.time > here)
  const set = (v: ParamValue) => dispatch(setShapeValues(mask.id, shape.id, { [param]: v }, playhead))
  const toggle = async () => {
    if (animated && !(await confirmKeyframeRemoval(track.length, spec.label))) return
    dispatch(setShapeAnimated(ref, !animated, playhead))
  }
  const addOrRemove = () => (atKey ? dispatch(removeShapeKeyframes(ref, [atKey.id])) : dispatch(addShapeKeyframe(ref, playhead)))
  const interpolation = (preset: InterpolationPreset) => atKey && dispatch(setShapeInterpolation(ref, atKey.id, preset))
  const items: MenuEntry[] = [
    animated ? { label: 'Remove All Keyframes', onSelect: () => void toggle(), danger: true } : { label: 'Create Keyframes', onSelect: () => void toggle() },
    { label: atKey ? 'Delete Keyframe at Playhead' : 'Add Keyframe at Playhead', onSelect: addOrRemove },
    'separator',
    { label: 'Linear', onSelect: () => interpolation('linear'), disabled: !atKey },
    { label: 'Hold', onSelect: () => interpolation('hold'), disabled: !atKey },
    { label: 'Ease In', onSelect: () => interpolation('ease-in'), disabled: !atKey },
    { label: 'Ease Out', onSelect: () => interpolation('ease-out'), disabled: !atKey },
    { label: 'Ease In and Out', onSelect: () => interpolation('ease-in-out'), disabled: !atKey },
    'separator',
    { label: 'Link to Audio…', onSelect: () => modulationUi.openLinkToAudio(ref) },
    {
      label: 'Modulate Parameter…',
      onSelect: () => (modulationUi.modulate(ref), workspaceController.open('modulation'), workspaceController.focus('modulation')),
      shortcut: '⌥⇧2'
    },
    { label: links.length > 1 ? `Remove Modulation (${links.length})` : 'Remove Modulation', onSelect: () => dispatch(removeMaskLinks(ref)), disabled: links.length === 0, danger: true }
  ]
  const number = (v: number, label: string, onChange: (n: number) => void) => (
    <ScrubNumber label={label} value={v} min={spec.min} max={spec.max} step={spec.unit === '%' ? 0.5 : 1} decimals={spec.decimals} unit={spec.unit} onChange={onChange} />
  )
  return (
    <div
      className="fx-row kf-row"
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <span className="fx-label">
        <button className={`kf-stopwatch ${animated ? 'on' : ''}`} aria-pressed={animated} aria-label={`Animate ${spec.label}`} title={animated ? `Turn off animation (removes the ${track.length} keyframe${track.length === 1 ? '' : 's'})` : 'Animate: set a keyframe at the playhead'} onClick={() => void toggle()}>
          ⏱
        </button>
        <span className="kf-name">{spec.label}</span>
      </span>
      <span className="fx-values">
        {Array.isArray(value) ? (
          <>
            {number(value[0], `${spec.label} X`, (x) => set([x, value[1]]))}
            {number(value[1], `${spec.label} Y`, (y) => set([value[0], y]))}
          </>
        ) : (
          number(Number(value), spec.label, set)
        )}
        {links.length > 0 && live !== null && (
          <button className="fx-mod-badge" title="Modulated: the value now. Click to edit." onClick={() => (modulationUi.select(links[0]!.modulatorId), workspaceController.open('modulation'), workspaceController.focus('modulation'))}>
            ∿ {Array.isArray(live) ? `${live[0].toFixed(0)}, ${live[1].toFixed(0)}` : Number(live).toFixed(1)}
          </button>
        )}
      </span>
      {animated && (
        <span className="kf-nav">
          <button className="kf-nav-button" title="Previous keyframe" disabled={!prev} onClick={() => prev && tl.movePlayhead(prev.time)}>
            ◀
          </button>
          <button className={`kf-nav-button kf-diamond ${atKey ? 'on' : ''}`} title={atKey ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead'} onClick={addOrRemove}>
            ◆
          </button>
          <button className="kf-nav-button" title="Next keyframe" disabled={!next} onClick={() => next && tl.movePlayhead(next.time)}>
            ▶
          </button>
        </span>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Where a mask is used: "Clip › Effect" or "Adjustment Layer (whole layer)". */
function UsedBy({ sequence, mask }: { sequence: Sequence; mask: Mask }) {
  const users = maskUsers(sequence, mask.id)
  if (users.length === 0) return <p className="muted small mask-hint">Not used yet. Pick it in an effect’s Mask menu in Effect Controls (or an adjustment layer’s).</p>
  return (
    <div className="mask-users">
      {users.map(({ clipId, effectId }) => {
        const clip = sequence.clips.find((c) => c.id === clipId)!
        const effect = effectId ? clip.effects.find((e) => e.id === effectId) : null
        const ref = effect ? effect.mask : clip.mask
        return (
          <button
            key={`${clipId}:${effectId}`}
            className="link-button"
            title={ref?.followClip ? 'Select it in the timeline, and show the mask where it lands on this clip' : 'Select it in the timeline'}
            onClick={() => (tl.select([clipId], 'replace'), maskController.setClip(ref?.followClip ? clipId : null), workspaceController.focus('effect-controls'))}
          >
            {clip.name} › {effect ? (effectById(effect.effectId)?.name ?? 'Effect') : clip.adjustment ? 'whole layer' : 'Opacity (where the clip shows)'}
            {ref?.invert ? ' (outside)' : ''}
            {ref?.followClip ? ' (follows the clip)' : ''}
          </button>
        )
      })}
    </div>
  )
}

/** The clip the mask is shown on, when it's being edited on a clip that uses it with Follow clip. */
function followName(sequence: Sequence, maskId: string): string | null {
  const clip = maskController.clipId ? sequence.clips.find((c) => c.id === maskController.clipId) : undefined
  return clip && (clip.mask?.id === maskId ? clip.mask.followClip : clip.effects.some((e) => e.mask?.id === maskId && e.mask.followClip)) ? clip.name : null
}

export function MasksWindow() {
  useObservable(projectController)
  useObservable(maskController)
  useObservable(tl)
  useObservable(modulationController)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const project = projectController.project
  if (!project) return null
  const sequence = project.sequence
  const masks = sequence.masks
  const mask = maskController.mask ?? null
  const shape = maskController.shape ?? null
  const create = (kind: MaskShapeKind) => {
    const command = addMask(kind)
    if (dispatch(command)) maskController.select(command.maskId, command.shapeId)
  }
  const kindMenu = (pick: (kind: MaskShapeKind) => void): MenuEntry[] => KINDS.map((kind) => ({ label: MASK_KIND_LABELS[kind], onSelect: () => pick(kind) }))
  const open = (event: React.MouseEvent, items: MenuEntry[]) => setMenu({ x: event.clientX, y: event.clientY, items })
  return (
    <div className="masks-window">
      <div className="mod-list">
        <div className="aa-sources-head">
          <span className="fx-title">Masks</span>
          <span className="spacer" />
          <button className="button compact" onClick={(event) => open(event, kindMenu(create))}>
            + New
          </button>
        </div>
        {masks.length === 0 && <p className="muted small aa-hint">A mask limits where an effect or adjustment layer shows. One mask can drive several effects, and every setting can be keyframed or follow the music.</p>}
        {masks.map((m) => {
          const users = maskUsers(sequence, m.id).length
          return (
            <div
              key={m.id}
              className={`aa-source ${mask?.id === m.id ? 'selected' : ''}`}
              onClick={() => maskController.select(m.id)}
              onDoubleClick={() => setRenaming(m.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                open(event, [
                  { label: 'Rename', onSelect: () => setRenaming(m.id) },
                  { label: 'Duplicate', onSelect: () => dispatch(duplicateMask(m.id)) },
                  'separator',
                  { label: 'Delete', onSelect: () => dispatch(removeMask(m.id)), danger: true }
                ])
              }}
            >
              {renaming === m.id ? (
                <input
                  className="input compact"
                  defaultValue={m.name}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== m.name) dispatch(renameMask(m.id, e.target.value))
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <div className="aa-source-name">{m.name}</div>
              )}
              <div className="muted small">
                {m.shapes.length === 1 ? MASK_KIND_LABELS[m.shapes[0]!.kind] : `${m.shapes.length} shapes`} · {users === 0 ? 'unused' : `used ${users === 1 ? 'once' : `${users}×`}`}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mod-editor">
        {!mask ? (
          <div className="empty-state">
            <p className="muted">{masks.length === 0 ? 'No masks yet: + New makes one.' : 'Select a mask.'}</p>
          </div>
        ) : (
          <div className="mod-editor-body">
            <div className="fx-stack-head">
              <span className="fx-title">Shapes</span>
              <span className="muted small">combined top to bottom</span>
              <span className="spacer" />
              <label className="mod-check" title="Draw the selected shape on the Program monitor to drag it">
                <input type="checkbox" checked={maskController.overlay} onChange={(e) => maskController.setOverlay(e.target.checked)} /> Show on monitor
              </label>
              <button className="button compact" onClick={(event) => open(event, kindMenu((kind) => {
                const command = addShape(mask.id, kind)
                if (dispatch(command)) maskController.selectShape(command.shapeId)
              }))}>
                + Shape
              </button>
            </div>
            {followName(sequence, mask.id) && <p className="small mask-follow mask-hint">Shown where it lands on {followName(sequence, mask.id)}, whose Motion it follows (Follow clip).</p>}
            <div className="mask-shapes">
              {mask.shapes.length === 0 && <p className="muted small mask-hint">No shapes: whatever uses this mask shows everywhere.</p>}
              {mask.shapes.map((s, index) => (
                <div key={s.id} className={`mask-shape ${shape?.id === s.id ? 'selected' : ''}`} onClick={() => maskController.selectShape(s.id)}>
                  <span className="mask-shape-name">{MASK_KIND_LABELS[s.kind]}</span>
                  <select className="input compact" aria-label="How it combines" title="How this shape combines with the ones above it" value={s.mode} onClick={(e) => e.stopPropagation()} onChange={(e) => dispatch(setShapeMode(mask.id, s.id, e.target.value as MaskMode))}>
                    {(['add', 'subtract', 'intersect'] as MaskMode[]).map((mode) => (
                      <option key={mode} value={mode}>
                        {MODE_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                  <label className="mod-check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={s.invert} onChange={(e) => dispatch(setShapeInverted(mask.id, s.id, e.target.checked))} /> Invert
                  </label>
                  <span className="spacer" />
                  <button className="icon-button" title="Move up" disabled={index === 0} onClick={(e) => (e.stopPropagation(), dispatch(moveShape(mask.id, s.id, index - 1)))}>
                    ↑
                  </button>
                  <button className="icon-button" title="Move down" disabled={index === mask.shapes.length - 1} onClick={(e) => (e.stopPropagation(), dispatch(moveShape(mask.id, s.id, index + 1)))}>
                    ↓
                  </button>
                  <button className="icon-button" title="Remove this shape" onClick={(e) => (e.stopPropagation(), dispatch(removeShape(mask.id, s.id)))}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
            {shape && (
              <>
                <div className="fx-stack-head">
                  <span className="fx-title">{MASK_KIND_LABELS[shape.kind]}</span>
                </div>
                <p className="muted small mask-hint">{KIND_HELP[shape.kind]}</p>
                {maskParams(shape.kind).map((param) => (
                  <MaskParamRow key={`${shape.id}:${param}`} mask={mask} shape={shape} param={param} />
                ))}
              </>
            )}
            <div className="fx-stack-head">
              <span className="fx-title">Used by</span>
            </div>
            <UsedBy sequence={sequence} mask={mask} />
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      <LinkToAudioDialog />
    </div>
  )
}
