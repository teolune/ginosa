import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { placePoint, resolveShape, shapeValueAt, unplacePoint, type ResolvedShape } from '@engine/masks/masks'
import type { MaskShape, PathPoint } from '@engine/masks/types'
import { hasLinks } from '@engine/modulation/apply'
import { setPathPoints, setShapeValues } from '@engine/timeline/mask-edits'
import { resolveClip } from '@engine/keyframes/properties'
import { applyAffine, defaultMotion, invertAffine, motionMatrix, type Affine } from '@engine/timeline/motion'
import { clipEnd } from '@engine/timeline/timeline'
import type { Project } from '@engine/project/model'
import { modulationController } from '../audio/modulation-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'
import { workspaceController } from '../state/workspace'
import { timelineController as tl } from '../timeline/timeline-controller'
import { maskController } from './mask-controller'

/**
 * The selected mask shape drawn over the Program monitor (while the Masks window is
 * open), in frame pixels: drag it to move it, its handles to resize or turn it, a pen
 * path's points and bezier handles to reshape it, an edge mask's dashed line to set its
 * width. Animated settings get a keyframe at the playhead, as when typed.
 */

type Pt = [number, number]

type Drag =
  | { kind: 'move'; from: Pt; position: Pt }
  | { kind: 'resize'; sx: number; sy: number; size: Pt; keepAspect: boolean }
  | { kind: 'rotate'; from: number; rotation: number }
  | { kind: 'point'; index: number; points: PathPoint[]; from: Pt }
  | { kind: 'tangent'; index: number; side: 'in' | 'out'; points: PathPoint[] }
  | { kind: 'edge' }

const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]]
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]]
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** A rectangle's or ellipse's local axes → frame pixels. */
function local(r: ResolvedShape, x: number, y: number): Pt {
  const a = (r.rotation * Math.PI) / 180
  return [r.position[0] + Math.cos(a) * x - Math.sin(a) * y, r.position[1] + Math.sin(a) * x + Math.cos(a) * y]
}

function toLocal(r: ResolvedShape, p: Pt): Pt {
  const a = (r.rotation * Math.PI) / 180
  const d = sub(p, r.position)
  return [Math.cos(a) * d[0] + Math.sin(a) * d[1], -Math.sin(a) * d[0] + Math.cos(a) * d[1]]
}

/** The cubic from point i to the next, in path coordinates. */
function segment(points: readonly PathPoint[], i: number): [Pt, Pt, Pt, Pt] {
  const a = points[i]!
  const b = points[(i + 1) % points.length]!
  return [[a.x, a.y], [a.x + a.outX, a.y + a.outY], [b.x + b.inX, b.y + b.inY], [b.x, b.y]]
}

function bezierAt(c: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t
  return [0, 1].map((k) => u * u * u * c[0][k]! + 3 * u * u * t * c[1][k]! + 3 * u * t * t * c[2][k]! + t * t * t * c[3][k]!) as Pt
}

/** Adds a point on segment i at t, keeping the outline exactly as it was (de Casteljau). */
function splitAt(points: readonly PathPoint[], i: number, t: number): PathPoint[] {
  const out = points.map((p) => ({ ...p }))
  const a = out[i]!
  const j = (i + 1) % out.length
  const b = out[j]!
  const straight = a.outX === 0 && a.outY === 0 && b.inX === 0 && b.inY === 0
  const [p0, p1, p2, p3] = segment(points, i)
  if (straight) {
    const s = lerp(p0, p3, t)
    out.splice(i + 1, 0, { x: s[0], y: s[1], inX: 0, inY: 0, outX: 0, outY: 0 })
    return out
  }
  const q0 = lerp(p0, p1, t)
  const q1 = lerp(p1, p2, t)
  const q2 = lerp(p2, p3, t)
  const r0 = lerp(q0, q1, t)
  const r1 = lerp(q1, q2, t)
  const s = lerp(r0, r1, t)
  a.outX = q0[0] - a.x
  a.outY = q0[1] - a.y
  b.inX = q2[0] - b.x
  b.inY = q2[1] - b.y
  out.splice(i + 1, 0, { x: s[0], y: s[1], inX: r0[0] - s[0], inY: r0[1] - s[1], outX: r1[0] - s[0], outY: r1[1] - s[1] })
  return out
}

/** Smooth (handles along its neighbours' direction) ↔ corner (no handles). */
function toggleSmooth(points: readonly PathPoint[], i: number): PathPoint[] {
  const out = points.map((p) => ({ ...p }))
  const p = out[i]!
  if (p.inX !== 0 || p.inY !== 0 || p.outX !== 0 || p.outY !== 0) {
    Object.assign(p, { inX: 0, inY: 0, outX: 0, outY: 0 })
    return out
  }
  const prev = out[(i - 1 + out.length) % out.length]!
  const next = out[(i + 1) % out.length]!
  const tx = (next.x - prev.x) / 6
  const ty = (next.y - prev.y) / 6
  Object.assign(p, { inX: -tx, inY: -ty, outX: tx, outY: ty })
  return out
}

/** A pen path's outline in frame pixels; `scale` is its Scale at the playhead. */
function pathD(shape: MaskShape, r: ResolvedShape, scale: number): string {
  const pts = shape.points
  if (pts.length < 2) return ''
  const place = (p: Pt) => placePoint(p[0], p[1], r.position, scale, r.rotation)
  let d = ''
  for (let i = 0; i < pts.length; i++) {
    const [p0, c1, c2, p3] = segment(pts, i).map(place) as [Pt, Pt, Pt, Pt]
    if (i === 0) d += `M${p0[0]},${p0[1]}`
    d += `C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p3[0]},${p3[1]}`
  }
  return `${d}Z`
}

function outline(shape: MaskShape, r: ResolvedShape, scale: number, className: string, onPointerDown?: (e: ReactPointerEvent) => void) {
  if (shape.kind === 'rectangle') {
    const [w, h] = r.size
    return <rect className={className} x={-w / 2} y={-h / 2} width={w} height={h} rx={Math.min(r.roundness, w / 2, h / 2)} transform={`translate(${r.position[0]} ${r.position[1]}) rotate(${r.rotation})`} onPointerDown={onPointerDown} />
  }
  if (shape.kind === 'ellipse') return <ellipse className={className} rx={r.size[0] / 2} ry={r.size[1] / 2} transform={`translate(${r.position[0]} ${r.position[1]}) rotate(${r.rotation})`} onPointerDown={onPointerDown} />
  if (shape.kind === 'path') return <path className={className} d={pathD(shape, r, scale)} fillRule="evenodd" onPointerDown={onPointerDown} />
  return null
}

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function compose(m: Affine, n: Affine): Affine {
  // m after n.
  return { a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d, e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f }
}

/**
 * Mask pixels → frame pixels as the mask is seen: on the frame (identity), or, when the
 * clip it's being edited on uses it with Follow clip, through that clip's Motion at the
 * playhead relative to its default Motion (decision 58).
 */
function maskView(project: Project, maskId: string, clipId: string | null, playhead: number): { view: Affine; clipName: string | null } {
  const clip = clipId ? project.sequence.clips.find((c) => c.id === clipId) : undefined
  if (!clip || clip.adjustment || !clip.effects.some((e) => e.mask?.id === maskId && e.mask.followClip)) return { view: IDENTITY, clipName: null }
  const item = project.media.find((m) => m.id === clip.mediaId)
  const at = Math.min(Math.max(playhead, clip.start), clipEnd(clip) - 1)
  const motion = resolveClip(clip, at, modulationController.context).motion
  const home = invertAffine(motionMatrix(defaultMotion(item, project.sequence.settings)))
  return home ? { view: compose(motionMatrix(motion), home), clipName: clip.name } : { view: IDENTITY, clipName: null }
}

export function MaskOverlay({ width, height }: { width: number; height: number }) {
  useObservable(maskController)
  useObservable(projectController)
  useObservable(tl)
  useObservable(modulationController)
  useObservable(workspaceController)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const mask = maskController.mask
  const shape = maskController.shape
  if (!maskController.overlay || !mask || !shape || !workspaceController.isOpen('masks')) return null
  const playhead = tl.playhead
  const r = resolveShape(shape, playhead)
  const scaleNow = Number(shapeValueAt(shape, 'scale', playhead))
  const live = hasLinks(shape.modulation) ? resolveShape(shape, playhead, modulationController.context) : null
  const svg = svgRef.current
  const { view } = maskView(projectController.project!, mask.id, maskController.clipId, playhead)
  const unview = invertAffine(view) ?? IDENTITY
  // Mask pixels per screen pixel, so handles stay the same size on screen.
  const k = (svg ? width / Math.max(1, svg.getBoundingClientRect().width) : 2) / Math.sqrt(Math.max(1e-6, Math.abs(view.a * view.d - view.b * view.c)))
  const handle = 5 * k
  const dispatch = projectController.dispatch.bind(projectController)
  const setValues = (values: Parameters<typeof setShapeValues>[2]) => dispatch(setShapeValues(mask.id, shape.id, values, playhead))
  const framePoint = (event: { clientX: number; clientY: number }): Pt => {
    const el = svgRef.current!
    const point = el.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const p = point.matrixTransform(el.getScreenCTM()!.inverse())
    // Into mask pixels (the same as frame pixels unless the mask follows a clip).
    const m = applyAffine(unview, p.x, p.y)
    return [m.x, m.y]
  }
  const pathPoint = (p: Pt): Pt => unplacePoint(p[0], p[1], r.position, scaleNow, r.rotation)
  const begin = (event: ReactPointerEvent, d: Drag) => {
    event.stopPropagation()
    event.preventDefault()
    svgRef.current?.setPointerCapture(event.pointerId)
    svgRef.current?.focus()
    drag.current = d
  }
  const onMove = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = framePoint(event)
    switch (d.kind) {
      case 'move':
        setValues({ position: add(d.position, sub(p, d.from)) })
        return
      case 'resize': {
        const l = toLocal(r, p)
        let w = d.sx !== 0 ? Math.abs(l[0]) * 2 : d.size[0]
        let h = d.sy !== 0 ? Math.abs(l[1]) * 2 : d.size[1]
        if (d.keepAspect || event.shiftKey) {
          const f = Math.max(d.sx !== 0 ? w / Math.max(1e-6, d.size[0]) : 0, d.sy !== 0 ? h / Math.max(1e-6, d.size[1]) : 0)
          w = d.size[0] * f
          h = d.size[1] * f
        }
        setValues({ size: [Math.round(w * 10) / 10, Math.round(h * 10) / 10] })
        return
      }
      case 'rotate': {
        const angle = (Math.atan2(p[1] - r.position[1], p[0] - r.position[0]) * 180) / Math.PI
        let rotation = d.rotation + angle - d.from
        if (event.shiftKey) rotation = Math.round(rotation / 15) * 15
        setValues({ rotation: Math.round(rotation * 10) / 10 })
        return
      }
      case 'point': {
        const delta = sub(pathPoint(p), pathPoint(d.from))
        const points = d.points.map((q, i) => (i === d.index ? { ...q, x: q.x + delta[0], y: q.y + delta[1] } : q))
        dispatch(setPathPoints(mask.id, shape.id, points, 'Move Point'))
        return
      }
      case 'tangent': {
        const base = d.points[d.index]!
        const v = sub(pathPoint(p), [base.x, base.y])
        const points = d.points.map((q) => ({ ...q }))
        const q = points[d.index]!
        const other = d.side === 'in' ? 'out' : 'in'
        q[`${d.side}X`] = v[0]
        q[`${d.side}Y`] = v[1]
        // Smooth unless ⌥: the other handle mirrors this one.
        if (!event.altKey) {
          q[`${other}X`] = -v[0]
          q[`${other}Y`] = -v[1]
        }
        dispatch(setPathPoints(mask.id, shape.id, points, 'Bend Path'))
        return
      }
      case 'edge': {
        const distance = Math.min(p[0], p[1], width - p[0], height - p[1])
        setValues({ width: Math.max(0, Math.round(distance - r.expansion)) })
      }
    }
  }
  const end = () => {
    drag.current = null
  }

  const removePoint = (index: number) => {
    if (shape.points.length <= 3) return projectController.showMessage('A path needs at least three points')
    dispatch(setPathPoints(mask.id, shape.id, shape.points.filter((_, i) => i !== index), 'Delete Point'))
    maskController.selectPoint(null)
  }
  const others = mask.shapes.filter((s) => s.id !== shape.id)
  const body = (event: ReactPointerEvent) => begin(event, { kind: 'move', from: framePoint(event), position: r.position })
  const selected = maskController.point
  return (
    <svg
      ref={svgRef}
      className="mask-overlay"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      tabIndex={-1}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if ((event.key === 'Delete' || event.key === 'Backspace') && shape.kind === 'path' && selected !== null) {
          event.preventDefault()
          event.stopPropagation()
          removePoint(selected)
        }
      }}
    >
      <g transform={`matrix(${view.a} ${view.b} ${view.c} ${view.d} ${view.e} ${view.f})`}>
      {others.map((s) => (
        <g key={s.id} opacity={0.45}>
          {outline(s, resolveShape(s, playhead), Number(shapeValueAt(s, 'scale', playhead)), 'mask-outline live')}
        </g>
      ))}
      {live && outline(shape, live, Number(shapeValueAt(shape, 'scale', playhead, modulationController.context)), 'mask-outline live')}
      {(shape.kind === 'rectangle' || shape.kind === 'ellipse') && (
        <>
          {outline(shape, r, scaleNow, 'mask-outline', body)}
          {[
            [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]
          ].map(([sx, sy]) => {
            const at = local(r, (sx! * r.size[0]) / 2, (sy! * r.size[1]) / 2)
            return (
              <rect
                key={`${sx}${sy}`}
                className="mask-handle"
                x={at[0] - handle}
                y={at[1] - handle}
                width={handle * 2}
                height={handle * 2}
                onPointerDown={(event) => begin(event, { kind: 'resize', sx: sx!, sy: sy!, size: r.size, keepAspect: false })}
              />
            )
          })}
          {(() => {
            const top = local(r, 0, -r.size[1] / 2)
            const knob = local(r, 0, -r.size[1] / 2 - 28 * k)
            return (
              <>
                <line className="mask-tangent" x1={top[0]} y1={top[1]} x2={knob[0]} y2={knob[1]} />
                <circle
                  className="mask-rotate"
                  cx={knob[0]}
                  cy={knob[1]}
                  r={handle * 1.1}
                  onPointerDown={(event) => {
                    const p = framePoint(event)
                    begin(event, { kind: 'rotate', from: (Math.atan2(p[1] - r.position[1], p[0] - r.position[0]) * 180) / Math.PI, rotation: r.rotation })
                  }}
                />
              </>
            )
          })()}
        </>
      )}
      {shape.kind === 'path' && (
        <>
          {outline(shape, r, scaleNow, 'mask-outline', body)}
          <path
            className="mask-hit"
            d={pathD(shape, r, scaleNow)}
            onPointerDown={(event) => {
              // Click on the outline: a new point there.
              const p = pathPoint(framePoint(event))
              let best = { i: 0, t: 0, d: Infinity }
              for (let i = 0; i < shape.points.length; i++) {
                const c = segment(shape.points, i)
                for (let s = 1; s < 64; s++) {
                  const q = bezierAt(c, s / 64)
                  const d = Math.hypot(q[0] - p[0], q[1] - p[1])
                  if (d < best.d) best = { i, t: s / 64, d }
                }
              }
              event.stopPropagation()
              dispatch(setPathPoints(mask.id, shape.id, splitAt(shape.points, best.i, best.t), 'Add Point'))
              maskController.selectPoint(best.i + 1)
            }}
          />
          {selected !== null &&
            shape.points[selected] &&
            (['in', 'out'] as const).map((side) => {
              const q = shape.points[selected]!
              const hx = q[`${side}X`]
              const hy = q[`${side}Y`]
              if (hx === 0 && hy === 0) return null
              const from = placePoint(q.x, q.y, r.position, scaleNow, r.rotation)
              const to = placePoint(q.x + hx, q.y + hy, r.position, scaleNow, r.rotation)
              return (
                <g key={side}>
                  <line className="mask-tangent" x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} />
                  <circle className="mask-tangent-end" cx={to[0]} cy={to[1]} r={handle * 0.8} onPointerDown={(event) => begin(event, { kind: 'tangent', index: selected, side, points: shape.points })} />
                </g>
              )
            })}
          {shape.points.map((q, index) => {
            const at = placePoint(q.x, q.y, r.position, scaleNow, r.rotation)
            return (
              <circle
                key={index}
                className={`mask-handle ${selected === index ? 'selected' : ''}`}
                cx={at[0]}
                cy={at[1]}
                r={handle}
                onPointerDown={(event) => {
                  if (event.altKey) {
                    event.stopPropagation()
                    removePoint(index)
                    return
                  }
                  maskController.selectPoint(index)
                  begin(event, { kind: 'point', index, points: shape.points, from: framePoint(event) })
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  dispatch(setPathPoints(mask.id, shape.id, toggleSmooth(shape.points, index), 'Smooth Point'))
                }}
              />
            )
          })}
        </>
      )}
      {shape.kind === 'edge' && (
        <rect
          className="mask-edge-line"
          x={r.width + r.expansion}
          y={r.width + r.expansion}
          width={Math.max(0, width - 2 * (r.width + r.expansion))}
          height={Math.max(0, height - 2 * (r.width + r.expansion))}
          onPointerDown={(event) => begin(event, { kind: 'edge' })}
        />
      )}
      </g>
    </svg>
  )
}
