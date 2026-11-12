import type { VideoLayer } from '@engine/timeline/render-plan'
import { isStateful } from '@engine/timeline/temporal'
import { secondsToTicks, type Ticks } from '@engine/time'
import type { EffectState } from './compositor'

/**
 * The state of stateful effects between frames (M9). Each effect instance on each clip has
 * a slot holding its output on recent frames, plus a checkpoint every second (frames since
 * its reset), within a memory budget. A frame needs the exact state of the frame before:
 * stills and export only render with it (catching up from the nearest checkpoint first);
 * playback may carry on from an older state when it drops a frame, and such approximate
 * states are never used as checkpoints or for stills.
 */

/** Video memory for kept states and checkpoints (decision 54: 2 GB; a 1080p state is 16.6 MB, so about 120 checkpoints, two minutes of one effect). */
export const STATE_BUDGET_BYTES = 2 * 1024 * 1024 * 1024

interface Kept {
  texture: GPUTexture
  /** Images the effect's passes keep with the state (M14: e.g. Datamosh's last frame and motion), by slot. */
  extras: Array<GPUTexture | null>
  /** Rendered from the exact state before it (not a playback approximation). */
  exact: boolean
}

const bytesOf = (k: Kept) => [k.texture, ...k.extras].reduce((sum, t) => sum + (t ? t.width * t.height * 8 : 0), 0)

interface Slot {
  key: string
  /** The key as the layers give it (without the playback resolution). */
  raw: string
  width: number
  height: number
  kept: Map<number, Kept>
  usedAt: number
  /** The frame committed last (where the playhead was). */
  lastFrame: number
}

export class TemporalStore {
  private slots = new Map<string, Slot>()
  private free = new Map<string, GPUTexture[]>()
  private clock = 0
  /**
   * Exact (stills, export, catch-up), live (playback: an older state will do when a frame was
   * dropped) or preview (a paused frame while you edit or scrub: the nearest state there is,
   * even from before the edit, so it shows at once; the exact one follows when you pause).
   */
  mode: 'exact' | 'live' | 'preview' = 'exact'
  /**
   * Each slot's last exact states from before its latest edit (only those near where it was
   * used, so it stays small), for previews until the new state has caught up.
   */
  private stale = new Map<string, Slot>()
  /** Playback resolution: part of every key (a state at one size is no use at another). */
  scale = 1
  stats = { approximate: 0, missed: 0, resets: 0, carried: 0 }
  /** Ticks per frame, for placing a change in the modulation curves on a slot's frames. */
  frame: Ticks = 0
  /** Where two modulation contexts' curves first differ, in seconds (Infinity: nowhere; 0: not known). */
  modulationChange: ((before: string, after: string) => number) | null = null
  /** What each key is made of (the layers describe theirs before asking for states). */
  private parts = new Map<string, { base: string; modulation: string; resetAt: Ticks }>()

  constructor(
    private readonly device: GPUDevice,
    /** Frames between checkpoints. */
    public checkpointEvery = 25,
    public budget = STATE_BUDGET_BYTES
  ) {}

  private slotKey(key: string): string {
    return `${key}@${this.scale}`
  }

  /** A layer's key and what it's made of (render-plan's LayerTemporal). */
  describe(t: { key: string; base?: string; modulation?: string; resetAt: Ticks }): void {
    if (t.base === undefined || t.modulation === undefined || this.parts.has(t.key)) return
    this.parts.set(t.key, { base: t.base, modulation: t.modulation, resetAt: t.resetAt })
    if (this.parts.size > 256) this.parts.delete(this.parts.keys().next().value!)
  }

  /**
   * A slot whose key changed only in its modulation curves (a Channel Rack edit, say) keeps its
   * exact states from before the first frame the curves change on: they were made from the same
   * inputs. The rest go, as on any other change. True if it was carried over.
   */
  private carryOver(slotId: string, slot: Slot, key: string): boolean {
    if (!this.modulationChange || this.frame <= 0) return false
    const before = this.parts.get(slot.raw)
    const after = this.parts.get(key)
    if (!before || !after || before.base !== after.base || before.resetAt !== after.resetAt) return false
    const seconds = this.modulationChange(before.modulation, after.modulation)
    const limit = Number.isFinite(seconds) ? Math.floor((secondsToTicks(Math.max(0, seconds)) - after.resetAt) / this.frame) : Infinity
    if (!(limit > 0)) return false
    const gone = [...slot.kept].filter(([f, k]) => f >= limit || !k.exact)
    const carried = this.carriedOn(slot)
    // As on any change: the exact states near where it was used stay for previews meanwhile.
    const near = gone.filter(([f, k]) => k.exact && f !== carried?.[0] && Math.abs(f - slot.lastFrame) <= 2 * this.checkpointEvery)
    if (near.length) {
      this.dropStale(slotId)
      this.stale.set(slotId, { ...slot, kept: new Map(near) })
    }
    for (const [f, k] of gone) {
      slot.kept.delete(f)
      if (f === carried?.[0]) slot.kept.set(f, { ...k, exact: false })
      else if (!near.some(([g]) => g === f)) this.giveKept(k)
    }
    slot.raw = key
    slot.key = this.slotKey(key)
    this.stats.carried++
    return true
  }

  /**
   * Live playback through an edit (a cube, an effect's value): the newest state carries on, as
   * an approximation, so the picture doesn't jump back to an older checkpoint or start over
   * while playing. The exact states follow once playback stops.
   */
  private carriedOn(slot: Slot): [number, Kept] | null {
    if (this.mode !== 'live') return null
    let newest: [number, Kept] | null = null
    for (const entry of slot.kept) if (!newest || entry[0] > newest[0]) newest = entry
    return newest
  }

  /** The state for one stateful effect on one frame (`frame` = frames since its reset). */
  state(slotId: string, key: string, frame: number): EffectState {
    const fullKey = this.slotKey(key)
    let exactInput = frame === 0
    // The state the frame before left (exact, or in live playback the newest one before it).
    let chosen: Kept | null = null
    let looked = false
    const before = (width: number, height: number): Kept | null => {
      if (looked) return chosen
      looked = true
      const slot = this.slot(slotId, key, width, height)
      if (frame === 0) return null
      const kept = slot.kept.get(frame - 1)
      if (kept?.exact) {
        exactInput = true
        return (chosen = kept)
      }
      if (this.mode === 'exact') this.stats.missed++
      else this.stats.approximate++
      if (this.mode === 'exact' && !kept) return null
      // Live: the newest state before this frame (a dropped frame, or one rendered approximately).
      let best: number | null = null
      for (const f of slot.kept.keys()) if (f < frame && (best === null || f > best)) best = f
      if (best === null && this.mode === 'preview') {
        // Nothing yet since the edit: the newest exact state from before it.
        const old = this.stale.get(slotId)
        if (old && old.width === width && old.height === height) for (const [f, k] of old.kept) if (k.exact && f < frame && (best === null || f > best)) best = f
        return (chosen = best === null ? null : old!.kept.get(best)!)
      }
      return (chosen = best === null ? null : slot.kept.get(best)!)
    }
    return {
      frames: frame,
      kept: (width, height) => {
        const kept = this.slot(slotId, key, width, height).kept.get(frame)
        return kept?.exact ? kept.texture : null
      },
      previous: (width, height) => before(width, height)?.texture ?? null,
      previousKept: (slot) => (frame === 0 ? null : (chosen?.extras[slot] ?? null)),
      commit: (encoder, output, extras = []) => {
        const slot = this.slots.get(slotId)
        if (!slot || slot.key !== fullKey) return
        const copy = (source: GPUTexture) => {
          const texture = this.take(source.width, source.height)
          encoder.copyTextureToTexture({ texture: source }, { texture }, [source.width, source.height])
          return texture
        }
        const old = slot.kept.get(frame)
        if (old) this.giveKept(old)
        // A preview's output is never exact (its state may come from before an edit).
        const exact = exactInput && (this.mode !== 'preview' || frame === 0 || chosen?.exact === true)
        slot.kept.set(frame, { texture: copy(output), extras: extras.map((t) => (t ? copy(t) : null)), exact })
        slot.lastFrame = frame
        // Once the new state has caught up past the old one, the old one has served its purpose.
        const older = this.stale.get(slotId)
        if (exact && older && Math.max(...older.kept.keys()) <= frame) this.dropStale(slotId)
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
    if (!slot) return 0
    if (slot.key !== this.slotKey(key) && !this.carryOver(slotId, slot, key)) return 0
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
      this.describe(t)
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
    for (const slot of [...this.slots.values(), ...this.stale.values()]) for (const k of slot.kept.values()) [k.texture, ...k.extras].forEach((t) => t?.destroy())
    this.slots.clear()
    this.stale.clear()
    for (const list of this.free.values()) list.forEach((t) => t.destroy())
    this.free.clear()
  }

  /** Bytes held in states and checkpoints. */
  bytes(): number {
    let total = 0
    for (const slot of [...this.slots.values(), ...this.stale.values()]) for (const k of slot.kept.values()) total += bytesOf(k)
    return total
  }

  /** States held (each effect's recent frames, checkpoints and stale states), for tests. */
  states(): number {
    let n = 0
    for (const slot of [...this.slots.values(), ...this.stale.values()]) n += slot.kept.size
    return n
  }

  private dropStale(slotId: string): void {
    const old = this.stale.get(slotId)
    if (!old) return
    for (const k of old.kept.values()) this.giveKept(k)
    this.stale.delete(slotId)
  }

  /** How many checkpoints are kept (for tests and the stats overlay). */
  checkpoints(): number {
    let n = 0
    for (const slot of this.slots.values()) for (const [f, k] of slot.kept) if (k.exact && f % this.checkpointEvery === 0 && f > 0) n++
    return n
  }

  private slot(slotId: string, raw: string, width: number, height: number): Slot {
    const key = this.slotKey(raw)
    let slot = this.slots.get(slotId)
    if (slot && slot.key !== key && slot.width === width && slot.height === height) this.carryOver(slotId, slot, raw)
    if (!slot || slot.key !== key || slot.width !== width || slot.height !== height) {
      let carried: [number, Kept] | null = null
      if (slot) {
        if (slot.width === width && slot.height === height) carried = this.carriedOn(slot)
        // The exact states near where it was last used stay, for previews, until the new key catches up.
        const near = [...slot.kept].filter(([f, k]) => k.exact && f !== carried?.[0] && Math.abs(f - slot!.lastFrame) <= 2 * this.checkpointEvery)
        if (near.length) {
          this.dropStale(slotId)
          this.stale.set(slotId, { ...slot, kept: new Map(near) })
        }
        for (const [f, k] of slot.kept) if (f !== carried?.[0] && !near.some(([g]) => g === f)) this.giveKept(k)
        this.stats.resets++
      }
      slot = { key, raw, width, height, kept: new Map(), usedAt: 0, lastFrame: carried?.[0] ?? 0 }
      if (carried) slot.kept.set(carried[0], { ...carried[1], exact: false })
      this.slots.set(slotId, slot)
    }
    slot.usedAt = ++this.clock
    return slot
  }

  /**
   * Keeps the two newest frames, the exact checkpoints and the furthest exact state (where a
   * stopped catch-up got to, so the next carries on from there); then trims to the budget.
   */
  private prune(slot: Slot, frame: number): void {
    let furthest = -1
    for (const [f, k] of slot.kept) if (k.exact && f > furthest) furthest = f
    for (const [f, k] of slot.kept) {
      if (f === frame || f === frame - 1 || f === furthest) continue
      if (k.exact && f > 0 && f % this.checkpointEvery === 0) continue
      slot.kept.delete(f)
      this.giveKept(k)
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
        const k = s.kept.get(f)!
        over -= bytesOf(k)
        this.giveKept(k)
        s.kept.delete(f)
      }
    }
  }

  private take(width: number, height: number): GPUTexture {
    const texture = this.free.get(`${width}x${height}`)?.pop()
    if (texture) return texture
    return this.device.createTexture({ size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC })
  }

  private giveKept(k: Kept): void {
    this.give(k.texture)
    for (const t of k.extras) if (t) this.give(t)
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

