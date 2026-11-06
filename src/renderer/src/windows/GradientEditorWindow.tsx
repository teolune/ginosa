import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { hexToRgb, hsbToRgb, rgbToHex, rgbToHsb, type Rgb } from '@engine/gradients/colour'
import { solidAt } from '@engine/gradients/evaluate'
import { BLACK_WHITE, GRADIENT_METHODS, gradientNotes, sortStops, type ColourStop, type Gradient, type GradientMethod, type NoiseGradient, type OpacityStop, type SolidGradient } from '@engine/gradients/gradient'
import { PromptDialog, type PromptRequest } from '../app/Dialogs'
import { GradientBar, LibraryBrowser } from '../gradients/GradientViews'
import { gradientController, type StopSelection } from '../gradients/gradient-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { timelineController } from '../timeline/timeline-controller'
import { ScrubNumber } from './EffectControlsWindow'

/**
 * The Gradient Editor (M13), after Photoshop's: the library at the top (folders, import and
 * export .grd), then the gradient: opacity stops above the bar, colour stops below, the
 * midpoints between the selected stop and its neighbours as diamonds. Click under (or over)
 * the bar to add a stop; drag stops and diamonds; drag a stop away from the bar to delete it.
 * Opened from a Gradient row in Effect Controls, it edits that effect (undoable, keyframes
 * as usual); opened on its own, it edits a gradient to save to the library.
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const MIN_STOPS = 2
const AWAY = 36

export function GradientEditorWindow() {
  useObservable(gradientController)
  useObservable(projectController)
  useObservable(timelineController)
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  useEffect(() => void gradientController.load(), [])
  const { gradient, method, label, editingEffect } = gradientController.current()
  const set = (g: Gradient) => gradientController.set(g)
  const ask = (title: string, initial: string, confirm: string, done: (value: string) => void) =>
    setPrompt({
      title,
      label: 'Name',
      initial,
      confirm,
      resolve: (value) => {
        setPrompt(null)
        if (value?.trim()) done(value.trim())
      }
    })
  const folder = gradientController.folder
  const message = gradientController.message
  const notes = gradientNotes(gradient)
  return (
    <div className="gradient-editor">
      <div className="gradient-editor-library">
        <LibraryBrowser manage method={method} onPick={(item) => gradientController.use(item)} />
        <div className="gradient-library-actions">
          <button className="button compact" onClick={() => void gradientController.import()} title="Add Photoshop .grd libraries (each gets a folder; the files aren't changed)">
            Import .grd…
          </button>
          <button className="button compact" onClick={() => void gradientController.export(folder.length ? folder : null)} title="Write this folder (or everything, from All folders) as a .grd for Photoshop">
            Export {folder.length ? 'Folder' : 'All'}…
          </button>
          <button className="button compact" onClick={() => ask('New Folder', 'Folder', 'Create', (n) => void gradientController.newFolder(n))}>
            New Folder…
          </button>
          <button className="button compact primary" onClick={() => ask('Save Gradient', gradient.name, 'Save', (n) => void gradientController.saveCurrent(n))} title={`Save the gradient below into “${folder.join(' › ') || 'Top'}”`}>
            Save to Library…
          </button>
        </div>
      </div>
      {message && (
        <div className="gradient-message">
          <div className="gradient-message-text">{message.text}</div>
          {message.warnings.map((w) => (
            <div key={w} className="muted small">
              ⚠ {w}
            </div>
          ))}
          <button className="button compact" onClick={() => gradientController.dismissMessage()}>
            OK
          </button>
        </div>
      )}
      <div className={`gradient-target small ${editingEffect ? '' : 'muted'}`}>{editingEffect ? `Editing ${label}` : label}</div>
      <div className="gradient-fields">
        <label className="field-inline">
          Name
          <input key={gradient.name} className="input compact" defaultValue={gradient.name} onBlur={(event) => event.target.value.trim() && event.target.value !== gradient.name && set({ ...gradient, name: event.target.value.trim() })} onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()} />
        </label>
        <label className="field-inline">
          Type
          <select
            className="input compact"
            value={gradient.kind}
            onChange={(event) => set(event.target.value === 'noise' ? { ...DEFAULT_NOISE, name: gradient.name } : { ...BLACK_WHITE, name: gradient.name })}
          >
            <option value="solid">Solid</option>
            <option value="noise">Noise</option>
          </select>
        </label>
        <label className="field-inline">
          Method
          <select className="input compact" value={method} onChange={(event) => gradientController.setMethod(event.target.value as GradientMethod)} disabled={gradient.kind === 'noise'}>
            {GRADIENT_METHODS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {gradient.kind === 'solid' ? <SolidEditor gradient={gradient} method={method} onChange={set} /> : <NoiseEditor gradient={gradient} onChange={set} />}
      {notes.length > 0 && (
        <div className="gradient-notes">
          {notes.map((n) => (
            <div key={n} className="small">
              ⚠ {n}
            </div>
          ))}
        </div>
      )}
      {prompt && <PromptDialog request={prompt} />}
    </div>
  )
}

const DEFAULT_NOISE: NoiseGradient = { kind: 'noise', name: 'Noise', seed: 1, roughness: 0.5, model: 'rgb', min: [0, 0, 0, 0], max: [1, 1, 1, 1], transparency: false, restrict: true }

type Kind = 'colour' | 'opacity'
type AnyStop = ColourStop | OpacityStop

function stopsOf(g: SolidGradient, kind: Kind): AnyStop[] {
  return kind === 'colour' ? g.colourStops : g.opacityStops
}

function withStops(g: SolidGradient, kind: Kind, stops: AnyStop[]): SolidGradient {
  return kind === 'colour' ? { ...g, colourStops: sortStops(stops as ColourStop[]) } : { ...g, opacityStops: sortStops(stops as OpacityStop[]) }
}

/** The stops mirrored: locations flipped, and each midpoint moved to the stop now after it. */
function reversed<T extends AnyStop>(stops: T[]): T[] {
  const n = stops.length
  return stops.map((_, j) => {
    const s = stops[n - 1 - j]!
    return { ...s, location: 1 - s.location, midpoint: j === 0 ? 0.5 : 1 - stops[n - j]!.midpoint }
  })
}

function distributed<T extends AnyStop>(stops: T[]): T[] {
  return stops.map((s, i) => ({ ...s, location: stops.length === 1 ? 0 : i / (stops.length - 1) }))
}

function SolidEditor({ gradient, method, onChange }: { gradient: SolidGradient; method: GradientMethod; onChange(g: SolidGradient): void }) {
  const selected = gradientController.selected
  const kind: Kind = selected?.kind ?? 'colour'
  const stops = stopsOf(gradient, kind)
  const index = selected && selected.index < stops.length ? selected.index : 0
  const stop = stops[index]
  const select = (s: StopSelection) => gradientController.select(s)
  const change = (kind: Kind, i: number, patch: Partial<ColourStop & OpacityStop>) => {
    const next = stopsOf(gradient, kind).map((s, k) => (k === i ? { ...s, ...patch } : s))
    const moved = next[i]!
    const g = withStops(gradient, kind, next)
    onChange(g)
    select({ kind, index: stopsOf(g, kind).indexOf(moved) })
  }
  const remove = (kind: Kind, i: number) => {
    const list = stopsOf(gradient, kind)
    if (list.length <= MIN_STOPS) return
    onChange(withStops(gradient, kind, list.filter((_, k) => k !== i)))
    select({ kind, index: Math.max(0, i - 1) })
  }
  const duplicate = () => {
    if (!stop) return
    const next = stops[index + 1]
    const location = next ? (stop.location + next.location) / 2 : Math.max(0, stop.location - 0.05)
    const copy = { ...stop, location, midpoint: 0.5 }
    const g = withStops(gradient, kind, [...stops, copy])
    onChange(g)
    select({ kind, index: stopsOf(g, kind).indexOf(copy) })
  }
  return (
    <div className="gradient-solid">
      <div className="gradient-fields">
        <ScrubNumber label="Smoothness" value={gradient.smoothness * 100} min={0} max={100} step={0.5} decimals={0} unit="%" onChange={(v) => onChange({ ...gradient, smoothness: v / 100 })} />
        <span className="muted small">Smoothness</span>
      </div>
      <StopBar gradient={gradient} method={method} onChange={onChange} />
      {stop && (
        <div className="gradient-stop-panel">
          {kind === 'colour' ? (
            <ColourFields stop={stop as ColourStop} onChange={(colour) => change('colour', index, { colour, kind: 'user', source: undefined })} />
          ) : (
            <label className="field-inline">
              Opacity
              <ScrubNumber label="Opacity" value={(stop as OpacityStop).opacity * 100} min={0} max={100} step={0.5} decimals={0} unit="%" onChange={(v) => change('opacity', index, { opacity: v / 100 })} />
            </label>
          )}
          <label className="field-inline">
            Location
            <ScrubNumber label="Location" value={stop.location * 100} min={0} max={100} step={0.1} decimals={1} unit="%" onChange={(v) => change(kind, index, { location: v / 100 })} />
          </label>
          <div className="gradient-stop-actions">
            <button className="button compact" onClick={duplicate}>
              Duplicate
            </button>
            <button className="button compact" disabled={stops.length <= MIN_STOPS} onClick={() => remove(kind, index)} title={stops.length <= MIN_STOPS ? 'A gradient needs at least two of each kind of stop' : `Delete this ${kind} stop`}>
              Delete
            </button>
            <button className="button compact" onClick={() => onChange(withStops(gradient, kind, distributed(stops)))} title={`Space the ${kind} stops evenly`}>
              Distribute
            </button>
            <button className="button compact" onClick={() => onChange({ ...gradient, colourStops: reversed(gradient.colourStops), opacityStops: reversed(gradient.opacityStops) })} title="Flip the gradient end to end">
              Reverse
            </button>
          </div>
        </div>
      )}
      <div className="muted small">Click under the bar for a colour stop, over it for an opacity stop. Drag a stop away to delete it. The diamonds are midpoints.</div>
    </div>
  )
}

/** The bar with its stops and midpoints; all dragging happens here. */
function StopBar({ gradient, method, onChange }: { gradient: SolidGradient; method: GradientMethod; onChange(g: SolidGradient): void }) {
  const bar = useRef<HTMLDivElement>(null)
  const drag = useRef<{ kind: Kind; index: number; base: SolidGradient; mid: boolean; startY: number } | null>(null)
  const selected = gradientController.selected
  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1)
  }
  const begin = (event: ReactPointerEvent, kind: Kind, index: number, mid = false) => {
    event.stopPropagation()
    event.preventDefault()
    ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
    drag.current = { kind, index, base: gradient, mid, startY: event.clientY }
    if (!mid) gradientController.select({ kind, index })
  }
  const move = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const list = stopsOf(d.base, d.kind)
    const x = at(event.clientX)
    if (d.mid) {
      // A midpoint diamond belongs to the stop after its segment.
      const a = list[d.index - 1]!.location
      const b = list[d.index]!.location
      const m = b > a ? clamp((x - a) / (b - a), 0.05, 0.95) : 0.5
      onChange(withStops(d.base, d.kind, list.map((s, k) => (k === d.index ? { ...s, midpoint: m } : s))))
      return
    }
    const away = Math.abs(event.clientY - d.startY) > AWAY && list.length > MIN_STOPS
    if (away) {
      onChange(withStops(d.base, d.kind, list.filter((_, k) => k !== d.index)))
      gradientController.select({ kind: d.kind, index: Math.max(0, d.index - 1) })
      return
    }
    const moved = { ...list[d.index]!, location: x }
    const g = withStops(d.base, d.kind, list.map((s, k) => (k === d.index ? moved : s)))
    onChange(g)
    gradientController.select({ kind: d.kind, index: stopsOf(g, d.kind).indexOf(moved) })
  }
  const end = () => (drag.current = null)
  const add = (event: ReactPointerEvent, kind: Kind) => {
    if (event.button !== 0) return
    const x = at(event.clientX)
    const [r, g, b, a] = solidAt(gradient, method, x)
    const stop: AnyStop = kind === 'colour' ? { location: x, midpoint: 0.5, colour: [r, g, b], kind: 'user' } : { location: x, midpoint: 0.5, opacity: a }
    const next = withStops(gradient, kind, [...stopsOf(gradient, kind), stop])
    onChange(next)
    const index = stopsOf(next, kind).indexOf(stop)
    gradientController.select({ kind, index })
    begin(event, kind, index)
    drag.current = { kind, index, base: next, mid: false, startY: event.clientY }
  }
  const markers = (kind: Kind) => {
    const list = stopsOf(gradient, kind)
    const sel = selected?.kind === kind ? selected.index : -1
    return (
      <>
        {list.map((s, i) => (
          <button
            key={`${kind}-${i}`}
            className={`gradient-stop ${kind} ${i === sel ? 'on' : ''}`}
            style={{ left: `${s.location * 100}%`, ...(kind === 'colour' ? { ['--stop' as string]: rgbToHex((s as ColourStop).colour) } : { ['--stop' as string]: `rgba(255,255,255,${(s as OpacityStop).opacity})` }) }}
            title={kind === 'colour' ? `${rgbToHex((s as ColourStop).colour)} at ${(s.location * 100).toFixed(1)}%` : `${Math.round((s as OpacityStop).opacity * 100)}% at ${(s.location * 100).toFixed(1)}%`}
            onPointerDown={(event) => begin(event, kind, i)}
            onPointerMove={move}
            onPointerUp={end}
          />
        ))}
        {sel >= 0 &&
          [sel, sel + 1]
            .filter((k) => k >= 1 && k < list.length && list[k]!.location > list[k - 1]!.location)
            .map((k) => {
              const a = list[k - 1]!.location
              const b = list[k]!.location
              return (
                <button
                  key={`mid-${kind}-${k}`}
                  className={`gradient-mid ${kind}`}
                  style={{ left: `${(a + (b - a) * list[k]!.midpoint) * 100}%` }}
                  title={`Midpoint ${Math.round(list[k]!.midpoint * 100)}%`}
                  onPointerDown={(event) => begin(event, kind, k, true)}
                  onPointerMove={move}
                  onPointerUp={end}
                />
              )
            })}
      </>
    )
  }
  return (
    <div className="gradient-stopbar">
      <div className="gradient-track opacity" onPointerDown={(event) => add(event, 'opacity')} onPointerMove={move} onPointerUp={end} title="Click to add an opacity stop">
        {markers('opacity')}
      </div>
      <div ref={bar} className="gradient-bar-wrap">
        <GradientBar gradient={gradient} method={method} height={28} showOpacity />
      </div>
      <div className="gradient-track colour" onPointerDown={(event) => add(event, 'colour')} onPointerMove={move} onPointerUp={end} title="Click to add a colour stop">
        {markers('colour')}
      </div>
    </div>
  )
}

/** Colour as RGB (0–255), HSB and hex, plus the system colour picker. */
function ColourFields({ stop, onChange }: { stop: ColourStop; onChange(colour: Rgb): void }) {
  const [r, g, b] = stop.colour.map((v) => v * 255) as Rgb
  const [h, s, v] = rgbToHsb(stop.colour)
  const setRgb = (k: number, value: number) => onChange(stop.colour.map((c, i) => (i === k ? clamp(value / 255, 0, 1) : c)) as Rgb)
  const setHsb = (k: number, value: number) => {
    const next = [h, s, v]
    next[k] = value
    onChange(hsbToRgb(next[0]!, next[1]!, next[2]!))
  }
  const source = stop.source
  return (
    <div className="gradient-colour">
      <input type="color" aria-label="Stop colour" value={rgbToHex(stop.colour)} onChange={(event) => hexToRgb(event.target.value) && onChange(hexToRgb(event.target.value)!)} />
      <span className="gradient-colour-group">
        {(['R', 'G', 'B'] as const).map((name, k) => (
          <label key={name} className="field-inline">
            {name}
            <ScrubNumber label={name} value={[r, g, b][k]!} min={0} max={255} step={1} decimals={0} onChange={(x) => setRgb(k, x)} />
          </label>
        ))}
      </span>
      <span className="gradient-colour-group">
        <label className="field-inline">
          H
          <ScrubNumber label="Hue" value={h} min={0} max={360} step={1} decimals={0} unit="°" onChange={(x) => setHsb(0, x)} />
        </label>
        <label className="field-inline">
          S
          <ScrubNumber label="Saturation" value={s} min={0} max={100} step={0.5} decimals={0} unit="%" onChange={(x) => setHsb(1, x)} />
        </label>
        <label className="field-inline">
          B
          <ScrubNumber label="Brightness" value={v} min={0} max={100} step={0.5} decimals={0} unit="%" onChange={(x) => setHsb(2, x)} />
        </label>
      </span>
      <label className="field-inline">
        Hex
        <input
          key={rgbToHex(stop.colour)}
          className="input compact mono gradient-hex"
          defaultValue={rgbToHex(stop.colour)}
          onBlur={(event) => {
            const c = hexToRgb(event.target.value)
            if (c) onChange(c)
          }}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
      </label>
      {stop.kind !== 'user' && <span className="muted small">{stop.kind === 'foreground' ? 'Foreground stop (black)' : 'Background stop (white)'}</span>}
      {source && <span className="muted small">From the file as {describeSource(source)}; changing the colour replaces it</span>}
    </div>
  )
}

function describeSource(source: NonNullable<ColourStop['source']>): string {
  const n = (v: number) => Math.round(v)
  switch (source.model) {
    case 'hsb':
      return `HSB ${n(source.h)}°, ${n(source.s)}%, ${n(source.b)}%`
    case 'lab':
      return `Lab ${n(source.l)}, ${n(source.a)}, ${n(source.b)}`
    case 'cmyk':
      return `CMYK ${n(source.c)}/${n(source.m)}/${n(source.y)}/${n(source.k)} (approximate)`
    case 'gray':
      return `Grayscale ${n(source.gray)}%`
    case 'book':
      return `${source.name} from ${source.book} (no colour values in the file)`
  }
}

const CHANNELS: Record<NoiseGradient['model'], [string, string, string]> = { rgb: ['R', 'G', 'B'], hsb: ['H', 'S', 'B'], lab: ['L', 'a', 'b'] }

function NoiseEditor({ gradient, onChange }: { gradient: NoiseGradient; onChange(g: NoiseGradient): void }) {
  const range = (which: 'min' | 'max', k: number, value: number) => {
    const next = [...gradient[which]] as NoiseGradient['min']
    next[k] = clamp(value / 100, 0, 1)
    onChange({ ...gradient, [which]: next })
  }
  return (
    <div className="gradient-noise">
      <GradientBar gradient={gradient} method="classic" height={28} showOpacity />
      <div className="gradient-fields">
        <label className="field-inline">
          Roughness
          <ScrubNumber label="Roughness" value={gradient.roughness * 100} min={0} max={100} step={0.5} decimals={0} unit="%" onChange={(v) => onChange({ ...gradient, roughness: v / 100 })} />
        </label>
        <label className="field-inline">
          Colour Model
          <select className="input compact" value={gradient.model} onChange={(event) => onChange({ ...gradient, model: event.target.value as NoiseGradient['model'] })}>
            <option value="rgb">RGB</option>
            <option value="hsb">HSB</option>
            <option value="lab">Lab</option>
          </select>
        </label>
      </div>
      {CHANNELS[gradient.model].map((name, k) => (
        <div key={name} className="gradient-fields">
          <span className="gradient-channel">{name}</span>
          <ScrubNumber label={`${name} from`} value={gradient.min[k]! * 100} min={0} max={100} step={0.5} decimals={0} unit="%" onChange={(v) => range('min', k, v)} />
          <span className="muted small">to</span>
          <ScrubNumber label={`${name} to`} value={gradient.max[k]! * 100} min={0} max={100} step={0.5} decimals={0} unit="%" onChange={(v) => range('max', k, v)} />
        </div>
      ))}
      <div className="gradient-fields">
        <label className="field-inline">
          <input type="checkbox" checked={gradient.restrict} onChange={(event) => onChange({ ...gradient, restrict: event.target.checked })} /> Restrict Colours
        </label>
        <label className="field-inline">
          <input type="checkbox" checked={gradient.transparency} onChange={(event) => onChange({ ...gradient, transparency: event.target.checked })} /> Add Transparency
        </label>
        <button className="button compact" onClick={() => onChange({ ...gradient, seed: Math.floor(Math.random() * 2 ** 31) })}>
          Randomize
        </button>
      </div>
      <div className="muted small">Noise gradients use the same settings as Photoshop's, but ginosa's own generator, so the colours differ from Photoshop's.</div>
    </div>
  )
}
