/// <reference lib="webworker" />
import { analyseAudio, analyseBand, customBandWindow, packAnalysis, packBand } from '@engine/audio/analysis'

/**
 * Audio analysis off the interface thread (M8). Receives a mono sound at the analysis
 * sample rate, replies with progress and then the packed result.
 */

export type AnalysisWorkerMessage = { kind: 'progress'; done: number } | { kind: 'done'; data: ArrayBuffer | null; bands: ArrayBuffer[] } | { kind: 'failed'; error: string }

export interface AnalysisWorkerRequest {
  pcm: Float32Array
  /** Whether to do the full analysis, or only the custom bands. */
  full: boolean
  bands: Array<{ low: number; high: number }>
}

self.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  try {
    const { pcm, full, bands } = event.data
    const steps = (full ? 1 : 0) + bands.length
    const report = (done: number) => self.postMessage({ kind: 'progress', done } satisfies AnalysisWorkerMessage)
    const data = full ? packAnalysis(analyseAudio(pcm, (d) => report(d / steps))) : null
    const packed = bands.map((b, i) => {
      const out = packBand(analyseBand(pcm, b.low, b.high, customBandWindow(b.low)))
      report(((full ? 1 : 0) + i + 1) / steps)
      return out
    })
    self.postMessage({ kind: 'done', data, bands: packed } satisfies AnalysisWorkerMessage, [...(data ? [data] : []), ...packed])
  } catch (error) {
    self.postMessage({ kind: 'failed', error: (error as Error).message } satisfies AnalysisWorkerMessage)
  }
}
