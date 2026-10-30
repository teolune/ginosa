import { initGpu, type GpuContext } from './gpu'

/** One GPU device for the whole interface; every window that draws shares it. */
let pending: Promise<GpuContext> | null = null
let lostReason: string | null = null

export function getGpu(): Promise<GpuContext> {
  if (!pending) {
    pending = initGpu((reason) => {
      lostReason = reason
      pending = null // the next caller creates a fresh device
    })
    pending.catch(() => {
      pending = null
    })
  }
  return pending
}

export function gpuLostReason(): string | null {
  return lostReason
}
