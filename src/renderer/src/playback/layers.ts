import { APPLE_WIDE_GAMUT_TO_REC709, BT2020_TO_REC709 } from '@engine/colour/colour'
import { parseCube, sampleCube, type CubeLut } from '@engine/colour/cube'
import { effectiveColour, type MediaItem } from '@engine/project/media'
import type { Sequence } from '@engine/project/model'
import { inverseMotion, sourceSize } from '@engine/timeline/motion'
import type { FrameMasks, VideoLayer } from '@engine/timeline/render-plan'
import { packMask, type ResolvedShape } from '@engine/masks/masks'
import type { MaskRef } from '@engine/masks/types'
import { projectController } from '../state/project-controller'
import { effectById } from '../../../effects/registry'
import type { EffectInstance } from '@engine/effects/types'
import type { AdjustmentStep, Compositor, CompositeLayer, GpuEffect, GpuLut, GpuMask, LayerColour } from './compositor'

/**
 * Turns the render plan's layers into compositor layers: Motion, opacity × transition
 * weight, blend mode, and how the file's pixels become working values (colour
 * interpretation, input LUTs). Playback and export both use this, so they look the same.
 */
export class LayerBuilder {
  private luts = new Map<string, GpuLut | 'loading' | 'failed'>()
  private stills = new Map<string, GPUTexture>()
  /** Masks packed this frame (a mask several effects share is packed once). */
  private packed = new WeakMap<ResolvedShape[], { data: Float32Array; parts: number }>()

  constructor(
    private readonly compositor: Compositor,
    /** A LUT finished loading (redraw). */
    private readonly onLoaded: () => void = () => undefined,
    private readonly onError: (message: string) => void = () => undefined
  ) {}

  /** The switched-on effects of a stack, ready for the GPU (effects missing from this version are skipped). */
  effects(stack: EffectInstance[], masks: FrameMasks): GpuEffect[] {
    return stack.flatMap((effect) => {
      const manifest = effect.enabled ? effectById(effect.effectId) : undefined
      return manifest ? [{ manifest, params: effect.params, mix: effect.mix / 100, blend: effect.blendMode, mask: this.mask(effect.mask, masks) }] : []
    })
  }

  /** A mask reference ready for the GPU (null when there's none, or the mask is gone). */
  mask(ref: MaskRef | null, masks: FrameMasks): GpuMask | null {
    const shapes = ref ? masks.byId.get(ref.id) : undefined
    if (!ref || !shapes) return null
    let packed = this.packed.get(shapes)
    if (!packed) {
      packed = packMask(shapes)
      this.packed.set(shapes, packed)
    }
    return { ...packed, invert: ref.invert, frame: masks.frame }
  }

  /** An adjustment layer: its effects on everything beneath, with its opacity × transition weight, within its mask. */
  adjustment(layer: VideoLayer): AdjustmentStep {
    return {
      kind: 'adjustment',
      effects: this.effects(layer.clip.effects, layer.masks),
      opacity: (layer.clip.opacity / 100) * layer.weight,
      blend: layer.clip.blendMode,
      mask: this.mask(layer.clip.mask, layer.masks)
    }
  }

  build(layer: VideoLayer, source: CompositeLayer['source'], sequence: Sequence): CompositeLayer | null {
    const inverse = inverseMotion(layer.clip.motion)
    if (!inverse || !layer.item) return null
    const size = sourceSize(layer.item, sequence.settings)
    const rotation = Math.round(((layer.item.info.video?.rotation ?? 0) % 360) / 90)
    return {
      source,
      inverse,
      width: size.width,
      height: size.height,
      rotation: (rotation + 4) % 4,
      opacity: (layer.clip.opacity / 100) * layer.weight,
      blend: layer.clip.blendMode,
      colour: this.colour(layer.item, source),
      effects: this.effects(layer.clip.effects, layer.masks)
    }
  }

  /** A still already on the GPU, or null. */
  loadedStill(path: string): GPUTexture | null {
    return this.stills.get(path) ?? null
  }

  stillTexture(path: string, bitmap: ImageBitmap): GPUTexture {
    let texture = this.stills.get(path)
    if (!texture) {
      texture = this.compositor.imageTexture(bitmap)
      this.stills.set(path, texture)
    }
    return texture
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

  private key(file: string): string {
    return `${projectController.path ?? ''}::${file}`
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
