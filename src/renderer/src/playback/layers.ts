import { APPLE_WIDE_GAMUT_TO_REC709, BT2020_TO_REC709 } from '@engine/colour/colour'
import { parseCube, sampleCube, type CubeLut } from '@engine/colour/cube'
import { unitCube } from '@engine/colour/look-lut'
import { effectiveColour, type MediaItem } from '@engine/project/media'
import type { Sequence } from '@engine/project/model'
import { defaultMotion, inverseMotion, motionMatrix, sourceSize, type Affine } from '@engine/timeline/motion'
import type { FrameMasks, VideoLayer } from '@engine/timeline/render-plan'
import { packMask, type ResolvedShape } from '@engine/masks/masks'
import type { MaskRef } from '@engine/masks/types'
import { projectController } from '../state/project-controller'
import { effectById } from '../../../effects/registry'
import type { EffectInstance } from '@engine/effects/types'
import type { AdjustmentStep, Compositor, CompositeLayer, CompositeStep, GpuEffect, GpuLut, GpuMask, LayerColour } from './compositor'
import type { TemporalStore } from './temporal'

/**
 * Turns the render plan's layers into compositor layers: Motion, opacity × transition
 * weight, blend mode, and how the file's pixels become working values (colour
 * interpretation, input LUTs). Playback and export both use this, so they look the same.
 */
export class LayerBuilder {
  private luts = new Map<string, GpuLut | 'loading' | 'failed'>()
  /** Stills on the GPU, least recently used first, within STILL_TEXTURE_BYTES. */
  private stills = new Map<string, { texture: GPUTexture; usedAt: number }>()
  static readonly STILL_TEXTURE_BYTES = 1024 * 1024 * 1024
  /** Masks packed this frame (a mask several effects share is packed once). */
  private packed = new WeakMap<ResolvedShape[], { data: Float32Array; parts: number }>()

  constructor(
    private readonly compositor: Compositor,
    /** A LUT finished loading (redraw). */
    private readonly onLoaded: () => void = () => undefined,
    private readonly onError: (message: string) => void = () => undefined,
    /** Where stateful effects keep their state between frames (none: they run as if every frame were their first). */
    readonly temporal: TemporalStore | null = null
  ) {}

  /** A layer's switched-on effects, ready for the GPU (effects missing from this version are skipped). */
  effects(layer: VideoLayer): GpuEffect[] {
    return layer.clip.effects.flatMap((effect, index) => {
      const manifest = effect.enabled ? effectById(effect.effectId) : undefined
      // Posterize Time is worked out by the render plan: it has no GPU pass.
      if (!manifest || manifest.holdsTime) return []
      const t = layer.temporal
      if (t) this.temporal?.describe(t)
      const state = manifest.time === 'stateful' && t && this.temporal ? this.temporal.state(`${layer.clip.id}:${effect.id}`, t.key, t.frame) : null
      // A LUT parameter (decision 77): its cube, once loaded (until then the effect passes the picture through).
      const lutSpec = manifest.params.find((p) => p.type === 'lut')
      const lutFile = lutSpec ? String(effect.params[lutSpec.id] ?? '') : ''
      const lut = lutFile ? this.lookLut(lutFile) : null
      return [{ manifest, params: effect.params, mix: effect.mix / 100, blend: effect.blendMode, mask: this.mask(effect.mask, layer.masks, layer), state, clock: layer.held && index < layer.held.effects ? layer.held.clock : layer.clock, lut, sinceCut: t?.sinceCut ?? 0, motionKey: layer.motion?.[effect.id] }]
    })
  }

  /** A mask reference ready for the GPU (null when there's none, or the mask is gone). */
  mask(ref: MaskRef | null, masks: FrameMasks, layer: VideoLayer | null = null): GpuMask | null {
    const shapes = ref ? masks.byId.get(ref.id) : undefined
    if (!ref || !shapes) return null
    let packed = this.packed.get(shapes)
    if (!packed) {
      packed = packMask(shapes)
      this.packed.set(shapes, packed)
    }
    return { ...packed, invert: ref.invert, frame: masks.frame, onClip: ref.followClip && layer?.item ? clipMaskSpace(layer, masks.frame) : null }
  }

  /** An adjustment layer: its effects on everything beneath, with its opacity × transition weight, within its mask. */
  adjustment(layer: VideoLayer): AdjustmentStep {
    return {
      kind: 'adjustment',
      effects: this.effects(layer),
      opacity: (layer.clip.opacity / 100) * layer.weight,
      blend: layer.clip.blendMode,
      mask: this.mask(layer.clip.mask, layer.masks)
    }
  }

  /** A clip's layer; or, for a motion source (M14), the picture another layer's effect reads. */
  build(layer: VideoLayer, source: CompositeLayer['source'], sequence: Sequence): CompositeStep | null {
    const inverse = inverseMotion(layer.clip.motion)
    if (!inverse || !layer.item) return null
    const size = sourceSize(layer.item, sequence.settings)
    const rotation = Math.round(((layer.item.info.video?.rotation ?? 0) % 360) / 90)
    if (layer.motionFor) {
      const picture: CompositeLayer = { source, inverse, width: size.width, height: size.height, rotation: (rotation + 4) % 4, opacity: layer.weight, blend: 'normal', colour: this.colour(layer.item, source) }
      return { kind: 'motion', key: layer.motionFor, layer: picture }
    }
    return {
      source,
      inverse,
      width: size.width,
      height: size.height,
      rotation: (rotation + 4) % 4,
      opacity: (layer.clip.opacity / 100) * layer.weight,
      blend: layer.clip.blendMode,
      colour: this.colour(layer.item, source),
      effects: this.effects(layer),
      mask: this.mask(layer.clip.mask, layer.masks, layer)
    }
  }

  /** A still already on the GPU, or null. */
  loadedStill(path: string): GPUTexture | null {
    const entry = this.stills.get(path)
    if (!entry) return null
    entry.usedAt = performance.now()
    this.stills.delete(path)
    this.stills.set(path, entry)
    return entry.texture
  }

  stillTexture(path: string, bitmap: ImageBitmap): GPUTexture {
    const loaded = this.loadedStill(path)
    if (loaded) return loaded
    const texture = this.compositor.imageTexture(bitmap)
    this.stills.set(path, { texture, usedAt: performance.now() })
    this.trimStills()
    return texture
  }

  /**
   * Over budget, the least recently used stills go, but never one used in the last couple of
   * seconds (a frame being put together may still draw it); the budget gives way instead.
   */
  private trimStills(): void {
    let total = this.stillBytes()
    const now = performance.now()
    for (const [path, entry] of this.stills) {
      if (total <= LayerBuilder.STILL_TEXTURE_BYTES) break
      if (now - entry.usedAt < 2000) continue
      this.stills.delete(path)
      total -= entry.texture.width * entry.texture.height * 4
      entry.texture.destroy()
    }
  }

  /** Bytes of stills on the GPU. */
  stillBytes(): number {
    let total = 0
    for (const { texture } of this.stills.values()) total += texture.width * texture.height * 4
    return total
  }

  /** Frees its stills and LUTs (an export or a cache render that's finished). */
  destroy(): void {
    for (const { texture } of this.stills.values()) texture.destroy()
    this.stills.clear()
    for (const lut of this.luts.values()) if (typeof lut === 'object') lut.texture.destroy()
    this.luts.clear()
  }

  /** How this layer's pixels become working values: undo Chromium's display step, then the file's conversion. */
  colour(item: MediaItem, source: CompositeLayer['source']): LayerColour {
    // Our decoder request (sRGB transfer) arrives untouched; anything else got the Mac video display transform.
    const undoMacDisplay = source.kind === 'image' || source.frame.colorSpace.transfer !== 'iec61966-2-1'
    if (item.colour.lut) {
      const lut = this.lut(item.colour.lut.file)
      return { undoMacDisplay, conversion: lut ? { kind: 'lut', lut } : { kind: 'none' } }
    }
    const colour = effectiveColour(item)
    if ((colour === 'hlg' || colour === 'pq') && !undoMacDisplay) {
      // Raw HLG/PQ values (the stream's tag was rewritten): ginosa's own HDR → Rec.709, computed exactly.
      return { undoMacDisplay, conversion: { kind: 'hdr', transfer: colour } }
    }
    if (colour === 'apple-log') return { undoMacDisplay, conversion: { kind: 'apple-log', gamut: BT2020_TO_REC709 } }
    if (colour === 'apple-log-2') return { undoMacDisplay, conversion: { kind: 'apple-log', gamut: APPLE_WIDE_GAMUT_TO_REC709 } }
    // Rec.709 as is. HDR that couldn't be rewritten (not HEVC) has been tone-mapped by Chromium.
    return { undoMacDisplay, conversion: { kind: 'none' } }
  }

  /** An input LUT if it's loaded; starts loading it otherwise (playback draws it once ready). */
  lut(file: string): GpuLut | null {
    const entry = this.luts.get(this.key(file))
    if (entry && entry !== 'loading' && entry !== 'failed') return entry
    if (!entry) void this.loadLut(file).then(this.onLoaded, () => undefined)
    return null
  }

  /** Loads an input LUT (export waits for every LUT it needs before the first frame). */
  async loadLut(file: string): Promise<GpuLut> {
    const projectPath = projectController.path
    if (!projectPath) throw new Error('Save the project first: input LUTs live in its folder')
    const key = this.key(file)
    const entry = this.luts.get(key)
    if (entry && entry !== 'loading' && entry !== 'failed') return entry
    this.luts.set(key, 'loading')
    try {
      const cube = parseCube(await window.ginosa.media.readLut(projectPath, file))
      const rgb = cube.kind === '3d' ? cube.data : expand1d(cube)
      const size = cube.kind === '3d' ? cube.size : 33
      const lut = this.compositor.lutTexture(size, rgb, cube.domainMin, cube.domainMax)
      this.luts.set(key, lut)
      return lut
    } catch (error) {
      this.luts.set(key, 'failed')
      this.onError(`Input LUT ${file}: ${(error as Error).message}`)
      throw error
    }
  }

  /** A look LUT (an effect's LUT) if it's loaded; starts loading it otherwise. */
  lookLut(file: string): GpuLut | null {
    const entry = this.luts.get(this.key(file, 'look'))
    if (entry && entry !== 'loading' && entry !== 'failed') return entry
    if (!entry) void this.loadLookLut(file).then(this.onLoaded, () => undefined)
    return null
  }

  /** Loads a look LUT as a cube over 0–1 (1D LUTs and other domains resampled), for export and rendering to wait on. */
  async loadLookLut(file: string): Promise<GpuLut> {
    const projectPath = projectController.path
    if (!projectPath) throw new Error('Save the project first: LUTs live in its folder')
    const key = this.key(file, 'look')
    const entry = this.luts.get(key)
    if (entry && entry !== 'loading' && entry !== 'failed') return entry
    this.luts.set(key, 'loading')
    try {
      const cube = unitCube(parseCube(await window.ginosa.media.readLut(projectPath, file)))
      const lut = this.compositor.lutTexture(cube.size, cube.data, [0, 0, 0], [1, 1, 1])
      this.luts.set(key, lut)
      return lut
    } catch (error) {
      this.luts.set(key, 'failed')
      this.onError(`Look LUT ${file}: ${(error as Error).message}`)
      throw error
    }
  }

  private key(file: string, kind: 'input' | 'look' = 'input'): string {
    return `${kind}:${projectController.path ?? ''}::${file}`
  }
}

/** A 1D LUT as a 33³ cube, so the shader only needs one kind. */
function expand1d(lut: CubeLut): Float32Array {
  const n = 33
  const out = new Float32Array(n * n * n * 3)
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const at = (b * n * n + g * n + r) * 3
        const span = (i: number) => lut.domainMin[i]! + ((lut.domainMax[i]! - lut.domainMin[i]!) * [r, g, b][i]!) / (n - 1)
        const value = sampleCube(lut, [span(0), span(1), span(2)])
        out[at] = value[0]
        out[at + 1] = value[1]
        out[at + 2] = value[2]
      }
  return out
}

/**
 * Follow clip (decision 58): the clip's source pixels → mask pixels, through the Motion the
 * clip gets by default (centred, fitted to the frame). With Motion untouched, the mask is
 * exactly where it is in frame terms; as the clip moves, scales or turns, the mask goes too.
 */
export function clipMaskSpace(layer: VideoLayer, frame: { width: number; height: number }): Affine {
  return motionMatrix(defaultMotion(layer.item ?? undefined, { width: frame.width, height: frame.height, frameRate: '25', sampleRate: 48_000 }))
}
