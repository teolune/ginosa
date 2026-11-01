import type { VideoLayer } from '@engine/timeline/render-plan'
import { isStateful } from '@engine/timeline/temporal'
import type { Ticks } from '@engine/time'
import type { EffectState } from './compositor'

/**
 * The state of stateful effects between frames (M9). Each effect instance on each clip has
 * a slot holding its output on recent frames, plus a checkpoint every second (frames since
 * its reset), within a memory budget. A frame needs the exact state of the frame before:
 * stills and export only render with it (catching up from the nearest checkpoint first);
 * playback may carry on from an older state when it drops a frame, and such approximate
 * states are never used as checkpoints or for stills.
 */

/** Video memory for kept states and checkpoints (a 1080p state is 16.6 MB, so about 60 checkpoints). */
export const STATE_BUDGET_BYTES = 1024 * 1024 * 1024

interface Kept {
  texture: GPUTexture
  /** Rendered from the exact state before it (not a playback approximation). */
  exact: boolean
}

interface Slot {
  key: string
  width: number
  height: number
  kept: Map<number, Kept>
  usedAt: number
}

export class TemporalStore {
  private slots = new Map<string, Slot>()
  private free = new Map<string, GPUTexture[]>()
  private clock = 0
  /** Exact (stills, export, catch-up) or live (playback: an older state will do when a frame was dropped). */
  mode: 'exact' | 'live' = 'exact'
  /** Playback resolution: part of every key (a state at one size is no use at another). */
  scale = 1
  stats = { approximate: 0, missed: 0, resets: 0 }

  constructor(
    private readonly device: GPUDevice,
    /** Frames between checkpoints. */
    public checkpointEvery = 25,
    public budget = STATE_BUDGET_BYTES
  ) {}

  private slotKey(key: string): string {
    return `${key}@${this.scale}`
  }

  /** The state for one stateful effect on one frame (`frame` = frames since its reset). */
  state(slotId: string, key: string, frame: number): EffectState {
    const fullKey = this.slotKey(key)
    let exactInput = frame === 0
    return {
      frames: frame,
      kept: (width, height) => {
        const kept = this.slot(slotId, fullKey, width, height).kept.get(frame)
        return kept?.exact ? kept.texture : null
      },
      previous: (width, height) => {
        const slot = this.slot(slotId, fullKey, width, height)
        if (frame === 0) return null
        const before = slot.kept.get(frame - 1)
        if (before?.exact) {
          exactInput = true
          return before.texture
        }
        if (this.mode === 'exact') this.stats.missed++
        else this.stats.approximate++
        if (this.mode === 'exact' && !before) return null
        // Live: the newest state before this frame (a dropped frame, or one rendered approximately).
        let best: number | null = null
        for (const f of slot.kept.keys()) if (f < frame && (best === null || f > best)) best = f
        return best === null ? null : slot.kept.get(best)!.texture
      },
      commit: (encoder, output) => {
        const slot = this.slots.get(slotId)
        if (!slot || slot.key !== fullKey) return
        const texture = this.take(output.width, output.height)
        encoder.copyTextureToTexture({ texture: output }, { texture }, [output.width, output.height])
        const old = slot.kept.get(frame)
        if (old) this.give(old.texture)
        slot.kept.set(frame, { texture, exact: exactInput })
        this.prune(slot, frame)
      }
    }
  }

  /**
   * Where rendering has to start again so that `frame` can be rendered exactly: the frame
   * after the newest exact state before it (a checkpoint, or a recent frame), or 0 (the
   * reset). Null when this frame or the one before is already there, or this is the first frame.
   */
  needs(slotId: string, key: string, frame: number): number | null {
    if (frame === 0) return null
    const slot = this.slots.get(slotId)
    if (!slot || slot.key !== this.slotKey(key)) return 0
    if (slot.kept.get(frame)?.exact || slot.kept.get(frame - 1)?.exact) return null
    let best = -1
    for (const [f, k] of slot.kept) if (k.exact && f < frame - 1 && f > best) best = f
    return best + 1
  }

  /** The earliest sequence time to render from before rendering these layers exactly, or null if nothing needs catching up. */
  catchUpFrom(layers: readonly VideoLayer[], frame: Ticks): Ticks | null {
    let from: Ticks | null = null
    for (const layer of layers) {
      const t = layer.temporal
      if (!t) continue
      for (const effect of layer.clip.effects) {
        if (!effect.enabled || !isStateful(effect.effectId)) continue
        const n = this.needs(`${layer.clip.id}:${effect.id}`, t.key, t.frame)
        if (n === null) continue
        const time = t.resetAt + n * frame
        if (from === null || time < from) from = time
      }
    }
    return from
  }

  /** Every state and checkpoint, freed. */
  clear(): void {
    for (const slot of this.slots.values()) for (const k of slot.kept.values()) k.texture.destroy()
    this.slots.clear()
    for (const list of this.free.values()) list.forEach((t) => t.destroy())
    this.free.clear()
  }

  /** Bytes held in states and checkpoints. */
  bytes(): number {
    let total = 0
    for (const slot of this.slots.values()) total += slot.kept.size * slot.width * slot.height * 8
    return total
  }

  /** How many checkpoints are kept (for tests and the stats overlay). */
  checkpoints(): number {
    let n = 0
    for (const slot of this.slots.values()) for (const [f, k] of slot.kept) if (k.exact && f % this.checkpointEvery === 0 && f > 0) n++
    return n
  }

  private slot(slotId: string, key: string, width: number, height: number): Slot {
    let slot = this.slots.get(slotId)
    if (!slot || slot.key !== key || slot.width !== width || slot.height !== height) {
      if (slot) {
        for (const k of slot.kept.values()) this.give(k.texture)
        this.stats.resets++
      }
      slot = { key, width, height, kept: new Map(), usedAt: 0 }
      this.slots.set(slotId, slot)
    }
    slot.usedAt = ++this.clock
    return slot
  }

  /** Keeps the two newest frames and the exact checkpoints; then trims to the budget. */
  private prune(slot: Slot, frame: number): void {
    for (const [f, k] of slot.kept) {
      if (f === frame || f === frame - 1) continue
      if (k.exact && f > 0 && f % this.checkpointEvery === 0) continue
      slot.kept.delete(f)
      this.give(k.texture)
    }
    let over = this.bytes() - this.budget
    if (over <= 0) return
    // Least recently used slots' checkpoints first; within a slot, the furthest from where it is now.
    const order = [...this.slots.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [, s] of order) {
      const latest = Math.max(...s.kept.keys())
      const candidates = [...s.kept.keys()].filter((f) => f !== latest && f !== latest - 1).sort((a, b) => Math.abs(b - latest) - Math.abs(a - latest))
      for (const f of candidates) {
        if (over <= 0) return
        this.give(s.kept.get(f)!.texture)
        s.kept.delete(f)
        over -= s.width * s.height * 8
      }
    }
  }

  private take(width: number, height: number): GPUTexture {
    const texture = this.free.get(`${width}x${height}`)?.pop()
    if (texture) return texture
    return this.device.createTexture({ size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC })
  }

  private give(texture: GPUTexture): void {
    const key = `${texture.width}x${texture.height}`
    const list = this.free.get(key) ?? []
    // A couple spare per size; the rest go back to the GPU, once the frame being recorded
    // (which may still read them) has been submitted.
    if (list.length >= 2) setTimeout(() => texture.destroy(), 0)
    else {
      list.push(texture)
      this.free.set(key, list)
    }
  }
}

