import { effectById } from '../../effects/registry'
import { hashText } from '../audio/sources'
import type { ResolvedShape } from '../masks/masks'
import type { MediaItem } from '../project/media'
import type { Sequence } from '../project/model'
import type { ModulationContext } from '../modulation/types'
import { frameTicks, sequenceEnd } from '../timeline/timeline'
import { videoLayersAt, type VideoLayer } from '../timeline/render-plan'

/**
 * Render cache keys (M9): one per frame, from everything that decides what the frame
 * looks like: each layer's values on that frame (after keyframes and modulation), its
 * media and which of its frames is shown, the masks it uses, the effects' code, and for
 * stateful effects every frame since their reset (a chain). Any edit changes exactly the
 * keys of the frames it changes, so cached frames elsewhere stay valid.
 */

const shaderHashes = new Map<string, string>()

function shaderHash(effectId: string): string {
  let h = shaderHashes.get(effectId)
  if (h === undefined) {
    // The main shader and any earlier passes' (M10), so changing either invalidates its frames.
    const manifest = effectById(effectId)
    h = hashText(manifest ? [manifest.shader, ...(manifest.passes ?? []).map((p) => p.shader)].join('\n// pass\n') : 'missing')
    shaderHashes.set(effectId, h)
  }
  return h
}

const round = (v: number) => Math.round(v * 1e4) / 1e4

function shapeContent(s: ResolvedShape): unknown {
  return { ...s, polygon: s.polygon ? Array.from(s.polygon, round) : null }
}

/** One layer on one frame, as text: what it is and every value that changes how it looks. */
/** The clocks the layer's clock-reading effects (grain) see: the held moment's above a Posterize Time, else this frame's. */
function clockKey(layer: VideoLayer): Array<{ frame: number; beat: number }> | null {
  const clocks = layer.clip.effects.flatMap((e, i) => {
    if (!e.enabled || !effectById(e.effectId)?.readsClock) return []
    const c = layer.held && i < layer.held.effects ? layer.held.clock : layer.clock
    return [{ frame: c.frame, beat: Math.round(c.beat * 1e6) / 1e6 }]
  })
  return clocks.length ? clocks : null
}

export function layerContent(layer: VideoLayer): string {
  const clip = layer.clip
  const item = layer.item
  const maskIds = [clip.mask?.id, ...clip.effects.map((e) => (e.enabled ? e.mask?.id : undefined))].filter((id): id is string => Boolean(id))
  return JSON.stringify({
    adjustment: clip.adjustment,
    motion: clip.motion,
    opacity: clip.opacity,
    blend: clip.blendMode,
    mask: clip.mask,
    effects: clip.effects.filter((e) => e.enabled).map((e) => ({ id: e.effectId, v: e.version, code: shaderHash(e.effectId), mix: e.mix, blend: e.blendMode, params: e.params, mask: e.mask })),
    weight: round(layer.weight),
    media: item ? { id: item.id, fingerprint: item.fingerprint, colour: item.colour, kind: item.kind, rotation: item.info.video?.rotation ?? 0 } : null,
    // Images show the same picture throughout.
    at: item?.kind === 'image' ? 0 : layer.sourceTime,
    masks: maskIds.map((id) => (layer.masks.byId.get(id) ?? []).map(shapeContent)),
    // Effects that change with the frame or the beat (grain) differ on every frame, even on a still.
    clock: clockKey(layer)
  })
}

export interface FrameKeys {
  /** One key per frame, from the sequence's start. */
  keys: string[]
  /** 1 where the frame has a switched-on effect (it may not play in real time unless cached). */
  effects: Uint8Array
}

/**
 * Works the keys out a slice at a time (`step`), so a long sequence doesn't hold up the
 * interface. `rendererVersion` stands for the compositor's own shaders.
 */
export class FrameKeyJob {
  readonly frames: number
  readonly keys: string[]
  readonly effects: Uint8Array
  private next = 0
  private readonly base: string
  private readonly frame: number
  /** Stateful clips' chains: the key of every frame since the reset, folded together. */
  private chains = new Map<string, { frame: number; key: string; chain: string }>()

  constructor(
    private readonly sequence: Sequence,
    private readonly media: MediaItem[],
    private readonly modulation: ModulationContext | null,
    rendererVersion: string
  ) {
    this.frame = frameTicks(sequence)
    this.frames = Math.ceil(sequenceEnd(sequence) / this.frame)
    this.keys = new Array<string>(this.frames)
    this.effects = new Uint8Array(this.frames)
    this.base = hashText(JSON.stringify({ size: [sequence.settings.width, sequence.settings.height], renderer: rendererVersion }))
  }

  get done(): boolean {
    return this.next >= this.frames
  }

  /** Works out up to `count` more frames; true once every frame has a key. */
  step(count = Infinity): boolean {
    const end = Math.min(this.frames, this.next + count)
    for (let j = this.next; j < end; j++) this.keyFrame(j)
    this.next = end
    return this.done
  }

  private keyFrame(j: number): void {
    const layers = videoLayersAt(this.sequence, this.media, j * this.frame, this.modulation)
    let prefix = this.base
    let effects = 0
    for (const layer of layers) {
      const part = layerContent(layer)
      prefix = hashText(prefix + part)
      if (layer.clip.effects.some((e) => e.enabled)) effects = 1
      const t = layer.temporal
      if (t) {
        // A clip's stateful effects see only the clip; an adjustment layer's see everything below it.
        const input = layer.clip.adjustment ? prefix : hashText(part)
        const before = this.chains.get(layer.clip.id)
        const continues = before && before.frame === t.frame - 1 && before.key === t.key
        const chain = hashText(`${t.frame === 0 || !continues ? `reset:${t.frame}` : before.chain}|${input}`)
        this.chains.set(layer.clip.id, { frame: t.frame, key: t.key, chain })
        prefix = hashText(prefix + chain)
      }
    }
    this.keys[j] = prefix
    this.effects[j] = effects
  }
}

/** Every frame's key at once (tests, and short sequences). */
export function frameKeys(sequence: Sequence, media: MediaItem[], modulation: ModulationContext | null, rendererVersion = 'test'): FrameKeys {
  const job = new FrameKeyJob(sequence, media, modulation, rendererVersion)
  job.step()
  return { keys: job.keys, effects: job.effects }
}
