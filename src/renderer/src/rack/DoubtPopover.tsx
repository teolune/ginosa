import { useEffect, useRef, useState } from 'react'
import type { RackRow } from '@engine/project/model'
import type { PlacedSection } from '@engine/timeline/rack'
import { keepRackCubes, removeRackCubes } from '@engine/timeline/rack-edits'
import { projectController } from '../state/project-controller'
import { listenBack } from './listen-back'
import { rackUi } from './rack-ui'

const WHAT: Record<string, string> = { kick: 'kick', clap: 'clap', hihat: 'hi-hat', bass: 'bass note' }

/**
 * A doubtful cube's pop-up (W4.6): above the cube, no window; clicking anywhere else or Esc
 * closes it. Listen plays that moment of the channel's stem on its own; Keep takes the mark
 * away; Delete removes the cube. Keep and Delete are saved as answers for the detection bench.
 */
export function DoubtPopover(props: { placed: PlacedSection; row: RackRow; step: number; x: number; y: number; onClose: () => void }) {
  const { placed, row, step, x, y, onClose } = props
  const box = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  const ref = { sectionId: placed.section.id, rowId: row.id, step }
  const listen = () => {
    setNote('Listening…')
    listenBack.play(placed, row, step).then(
      () => setNote(null),
      (error: Error) => setNote(`Couldn’t play it: ${error.message}`)
    )
  }
  const decide = (kept: boolean) => {
    if (!projectController.dispatch(kept ? keepRackCubes([ref]) : removeRackCubes([ref]))) return
    if (!kept) rackUi.select([])
    void listenBack.answer(placed, row, step, kept).catch(() => undefined)
    onClose()
  }
  return (
    <div ref={box} className="rack-doubt-popover" style={{ left: x, top: y }} role="dialog" aria-label={`Doubtful ${WHAT[row.detect ?? ''] ?? 'cube'}`}>
      <span className="rack-doubt-text">{note ?? `Only one of Detect’s two checks heard this ${WHAT[row.detect ?? ''] ?? 'hit'}.`}</span>
      <div className="rack-doubt-actions">
        <button className="button compact" onClick={listen} title="Hear this moment of the channel’s stem on its own">
          ▶ Listen
        </button>
        <button className="button compact" onClick={() => decide(true)} title="It’s right: take the mark away">
          Keep
        </button>
        <button className="button compact danger" onClick={() => decide(false)} title="It isn’t there: delete the cube">
          Delete
        </button>
      </div>
    </div>
  )
}
