import { useEffect, useRef } from 'react'
import type { RackRow } from '@engine/project/model'
import { sectionName, type PlacedSection } from '@engine/timeline/rack'

/**
 * The whole song under the Channel Rack (your request, 20 Nov): every section from bar 1 to the
 * end, lettered, with a tick for each cube (a lane per channel), the bars the rack shows framed,
 * and the playhead. Click or drag along it to go to a bar: the playhead moves there and the rack
 * shows it.
 */
export function RackOverview({
  placed,
  rows,
  perBar,
  playBar,
  view,
  shownId,
  onPick
}: {
  placed: readonly PlacedSection[]
  rows: readonly RackRow[]
  perBar: number
  /** The playhead, in bars from bar 1 (fractional). */
  playBar: number
  /** The bars the rack shows, from bar 1. */
  view: { from: number; to: number } | null
  shownId: string | null
  /** A bar from bar 1 (0 = bar 1). */
  onPick(bar: number): void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastBar = useRef(-1)
  const last = placed[placed.length - 1]
  const total = last ? last.startBar + last.section.bars : 0

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || total === 0) return
    const ratio = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
    }
    const g = canvas.getContext('2d')
    if (!g) return
    g.setTransform(ratio, 0, 0, ratio, 0, 0)
    g.clearRect(0, 0, width, height)
    const barW = width / total
    const top = 13
    // Sections, alternating, lettered when there's room.
    placed.forEach((p, i) => {
      const x = p.startBar * barW
      const w = p.section.bars * barW
      g.fillStyle = p.section.id === shownId ? 'rgba(155, 130, 255, 0.16)' : i % 2 ? 'rgba(255, 255, 255, 0.035)' : 'rgba(255, 255, 255, 0.07)'
      g.fillRect(x, 0, w, height)
      g.fillStyle = 'rgba(255, 255, 255, 0.12)'
      g.fillRect(Math.round(x), 0, 1, height)
      if (w >= 12) {
        g.fillStyle = p.section.id === shownId ? '#d9c6ff' : 'rgba(236, 232, 245, 0.55)'
        g.font = '9.5px ui-monospace, SFMono-Regular, Menlo, monospace'
        g.fillText(sectionName(p.index), x + 3, 10)
      }
    })
    // A tick for every cube, a lane per channel.
    const lanes = Math.max(1, rows.length)
    const lane = (height - top - 3) / lanes
    rows.forEach((row, r) => {
      g.fillStyle = row.enabled ? 'rgba(170, 145, 255, 0.85)' : 'rgba(170, 145, 255, 0.3)'
      const y = top + r * lane
      for (const p of placed) {
        for (const cube of p.section.cubes[row.id] ?? []) {
          if (cube.step >= p.section.bars * perBar) continue
          const x = (p.startBar + cube.step / perBar) * barW
          g.fillRect(x, y, Math.max(1, barW / perBar - 0.5), Math.max(1, lane - 1))
        }
      }
    })
    // The bars the rack shows.
    if (view) {
      const x = view.from * barW
      const w = Math.max(2, (view.to - view.from) * barW)
      g.strokeStyle = 'rgba(217, 198, 255, 0.9)'
      g.lineWidth = 1.5
      g.beginPath()
      g.roundRect(x + 0.75, 0.75, Math.min(w, width - x) - 1.5, height - 1.5, 4)
      g.stroke()
    }
    // The playhead.
    if (playBar >= 0 && playBar <= total) {
      g.fillStyle = '#ff7ac8'
      g.fillRect(Math.round(playBar * barW) - 0.5, 0, 1.5, height)
    }
  })

  if (total === 0) return null
  // A drag goes to each bar once, as it reaches it.
  const pick = (event: React.PointerEvent<HTMLCanvasElement>, always: boolean) => {
    const box = event.currentTarget.getBoundingClientRect()
    const bar = Math.max(0, Math.min(total - 1, Math.floor(((event.clientX - box.left) / box.width) * total)))
    if (!always && bar === lastBar.current) return
    lastBar.current = bar
    onPick(bar)
  }
  return (
    <canvas
      ref={canvasRef}
      className="rack-overview"
      role="slider"
      aria-label="The whole song: click or drag to go to a bar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={Math.floor(playBar) + 1}
      title="The whole song: click or drag to go to a bar"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        pick(event, true)
      }}
      onPointerMove={(event) => {
        if (event.buttons & 1 && event.currentTarget.hasPointerCapture(event.pointerId)) pick(event, false)
      }}
    />
  )
}
