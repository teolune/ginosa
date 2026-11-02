import { useEffect, useState } from 'react'
import { addEffect } from '@engine/timeline/effect-edits'
import { BUILTIN_PRESETS } from '@engine/timeline/builtin-presets'
import { EFFECTS } from '../../../effects/registry'
import { ContextMenu, type MenuEntry } from '../app/ContextMenu'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { Icon } from '../app/Icon'
import { EFFECT_DRAG_TYPE, PRESET_DRAG_TYPE, effectsController } from '../effects/effects-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'

function selectedVideoClips(): string[] {
  const project = projectController.project
  if (!project) return []
  return project.sequence.clips.filter((c) => c.kind === 'video' && timelineController.selection.has(c.id)).map((c) => c.id)
}

/**
 * Premiere's Effects panel: every effect by category, plus your presets. Drag one onto
 * a clip or adjustment layer (or into Effect Controls), or double-click to apply it to
 * the selected clips.
 */
export function EffectsLibraryWindow() {
  useObservable(effectsController)
  useObservable(timelineController)
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  useEffect(() => void effectsController.loadPresets(), [])
  const q = query.trim().toLowerCase()
  const matches = (text: string) => !q || text.toLowerCase().includes(q)
  const effects = EFFECTS.filter((e) => matches(`${e.name} ${e.category} ${e.description}`))
  const categories = [...new Set(effects.map((e) => e.category))]
  const presets = effectsController.presets.filter((p) => matches(p.name))
  const builtins = BUILTIN_PRESETS.filter((p) => matches(`${p.name} ${p.description}`))
  const targets = selectedVideoClips()
  const apply = (effectId: string) => {
    if (targets.length === 0) projectController.showMessage('Select a video clip or adjustment layer first, or drag the effect onto one')
    else projectController.dispatch(addEffect(targets, effectId))
  }
  const toggle = (group: string) => {
    const next = new Set(closed)
    if (next.has(group)) next.delete(group)
    else next.add(group)
    setClosed(next)
  }
  const Group = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
    <div className="library-group">
      <button className="library-group-head" onClick={() => toggle(id)} aria-expanded={!closed.has(id) || Boolean(q)}>
        <Icon name={!closed.has(id) || q ? 'chevronDown' : 'chevronRight'} fallback={!closed.has(id) || q ? '▾' : '▸'} />
        <Icon name="folder" fallback="" />
        {title}
      </button>
      {(!closed.has(id) || Boolean(q)) && <div className="library-items">{children}</div>}
    </div>
  )

  return (
    <div className="effects-library">
      <input className="input" placeholder="Search effects" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search effects" />
      <div className="library-list">
        <Group id="presets" title={`Presets (${effectsController.presets.length})`}>
          {presets.length === 0 && <p className="muted small library-empty">{q ? 'No presets match.' : 'Save one from Effect Controls (Save Preset…).'}</p>}
          {presets.map((preset) => (
            <div
              key={preset.id}
              className="library-item"
              draggable
              title={`${preset.effects.length} effect${preset.effects.length === 1 ? '' : 's'}. Drag onto a clip, or double-click to apply to the selected clips.`}
              onDragStart={(event) => {
                event.dataTransfer.setData(PRESET_DRAG_TYPE, preset.id)
                event.dataTransfer.effectAllowed = 'copy'
              }}
              onDoubleClick={() => (targets.length ? effectsController.applyPreset(preset.id, targets) : projectController.showMessage('Select a video clip or adjustment layer first'))}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  entries: [
                    { label: 'Apply to Selected Clips', disabled: targets.length === 0, onSelect: () => effectsController.applyPreset(preset.id, targets) },
                    {
                      label: 'Rename…',
                      onSelect: () =>
                        setPrompt({
                          title: 'Rename Preset',
                          label: 'Name',
                          initial: preset.name,
                          confirm: 'Rename',
                          resolve: (name) => {
                            setPrompt(null)
                            if (name) void effectsController.renamePreset(preset.id, name)
                          }
                        })
                    },
                    'separator',
                    { label: 'Delete Preset', danger: true, onSelect: () => void effectsController.deletePreset(preset.id) }
                  ]
                })
              }}
            >
              <span className="library-badge preset">P</span>
              {preset.name}
              <span className="muted small">{preset.effects.length > 1 ? `${preset.effects.length} effects` : ''}</span>
            </div>
          ))}
        </Group>
        <Group id="builtin" title="Built-in Presets">
          {builtins.length === 0 && <p className="muted small library-empty">No built-in presets match.</p>}
          {builtins.map((preset) => (
            <div
              key={preset.id}
              className="library-item"
              draggable
              title={`${preset.description} Links to the first source in Audio Analysis. Drag onto a clip, or double-click to apply to the selected clips.`}
              onDragStart={(event) => {
                event.dataTransfer.setData(PRESET_DRAG_TYPE, preset.id)
                event.dataTransfer.effectAllowed = 'copy'
              }}
              onDoubleClick={() => (targets.length ? effectsController.applyPreset(preset.id, targets) : projectController.showMessage('Select a video clip or adjustment layer first'))}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, entries: [{ label: 'Apply to Selected Clips', disabled: targets.length === 0, onSelect: () => effectsController.applyPreset(preset.id, targets) }] })
              }}
            >
              <span className="library-badge preset builtin">∿</span>
              {preset.name}
            </div>
          ))}
        </Group>
        <Group id="video" title="Video Effects">
          {categories.map((category) => (
            <Group key={category} id={`cat-${category}`} title={category}>
              {effects
                .filter((e) => e.category === category)
                .map((effect) => (
                  <div
                    key={effect.id}
                    className="library-item"
                    draggable
                    title={`${effect.description} Drag onto a clip, or double-click to apply to the selected clips.`}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(EFFECT_DRAG_TYPE, effect.id)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                    onDoubleClick={() => apply(effect.id)}
                  >
                    <span className="library-badge">fx</span>
                    {effect.name}
                  </div>
                ))}
            </Group>
          ))}
          {effects.length === 0 && <p className="muted small library-empty">No effects match “{query}”.</p>}
        </Group>
      </div>
      <p className="muted small library-hint">{targets.length > 0 ? `Double-click applies to ${targets.length} selected clip${targets.length === 1 ? '' : 's'}.` : 'Select clips, or drag onto one.'} More effects arrive from M10.</p>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.entries} onClose={() => setMenu(null)} />}
      <PromptDialog request={prompt} />
    </div>
  )
}
