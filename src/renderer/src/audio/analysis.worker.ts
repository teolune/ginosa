/// <reference lib="webworker" />
import { analyseAudio, packAnalysis } from '@engine/audio/analysis'

/**
 * Audio analysis off the interface thread (M8). Receives a mono sound at the analysis
 * sample rate, replies with progress and then the packed result.
 */

export type AnalysisWorkerMessage = { kind: 'progress'; done: number } | { kind: 'done'; data: ArrayBuffer } | { kind: 'failed'; error: string }

self.onmessage = (event: MessageEvent<{ pcm: Float32Array }>) => {
  try {
    const result = analyseAudio(event.data.pcm, (done) => self.postMessage({ kind: 'progress', done } satisfies AnalysisWorkerMessage))
    const data = packAnalysis(result)
    self.postMessage({ kind: 'done', data } satisfies AnalysisWorkerMessage, [data])
  } catch (error) {
    self.postMessage({ kind: 'failed', error: (error as Error).message } satisfies AnalysisWorkerMessage)
  }
}
