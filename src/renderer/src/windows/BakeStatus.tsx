import { useEffect, useState } from 'react'
import type { EffectInstance } from '@engine/effects/types'
import type { Clip } from '@engine/project/model'
import { bakeController, type BakeState } from '../playback/bake-controller'
import { useObservable } from '../state/observable'
import { projectController } from '../state/project-controller'

const STAGES: Record<Extract<BakeState, { kind: 'baking' }>['stage'], string> = {
  rendering: 'rendering the picture',
  breaking: 'removing keyframes',
  vectors: 'moving the vectors',
  decoding: 'decoding'
}

/**
 * Datamosh Bake's state in Effect Controls (M15): baked, baking (how far), waiting, failed (and
 * why, with Try Again), or waiting for FFglitch (with Set Up FFglitch). Until it's baked the
 * effect shows the live Datamosh look.
 */
export function BakeStatus({ clip, effect }: { clip: Clip; effect: EffectInstance }) {
  useObservable(bakeController)
  useObservable(projectController)
  const [setup, setSetup] = useState<{ running: boolean; line: string } | null>(null)
  useEffect(() => {
    void bakeController.refreshStatus()
  }, [])
  if (!effect.enabled) return null
  const state = bakeController.stateOf(clip, effect.id)
  const live = <span className="muted"> The live Datamosh look shows meanwhile.</span>
  let body: React.ReactNode
  switch (state.kind) {
    case 'ready':
      body = <span>Baked: {state.frames} frames.</span>
      break
    case 'waiting':
      body = <span>Waiting to bake.{live}</span>
      break
    case 'baking':
      body = (
        <>
          <progress max={1} value={state.fraction} />
          <span>
            Baking ({STAGES[state.stage]}), {Math.round(state.fraction * 100)}%.{live}
          </span>
        </>
      )
      break
    case 'failed':
      body = (
        <>
          <span>Didn’t bake: {state.error}</span>
          <button className="button compact" onClick={() => bakeController.retry(clip, effect.id)}>
            Try Again
          </button>
        </>
      )
      break
    case 'unavailable':
      body = (
        <>
          <span>
            Baking needs FFglitch.{live}
          </span>
          <button
            className="button compact"
            disabled={setup?.running}
            title="Downloads FFglitch 0.10.2 (GPL) from ffglitch.org into .ffglitch/ in the ginosa folder, as npm run ffglitch-setup does"
            onClick={() => {
              setSetup({ running: true, line: 'Starting…' })
              void bakeController.setUp((line) => setSetup({ running: true, line })).then((code) => setSetup({ running: false, line: code === 0 ? 'FFglitch is set up.' : 'The setup didn’t work (the last line is above).' }))
            }}
          >
            Set Up FFglitch
          </button>
          {setup && <span className="muted small">{setup.line}</span>}
        </>
      )
      break
  }
  return (
    <div className={`bake-status bake-${state.kind}`} role="status">
      {body}
    </div>
  )
}
