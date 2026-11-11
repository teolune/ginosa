import { MAX_DIMENSION, MIN_DIMENSION } from './model'

/**
 * The title screen's New Project choices (decision 96): a resolution (1080p, 4K or custom)
 * and a shape (16:9 or 9:16, or a custom ratio). 1080p and 4K set the short side (1080 or
 * 2160); the ratio sets the long side, rounded to an even number for the encoders.
 */
export type ResolutionChoice = '1080p' | '4k' | 'custom'

export interface NewProjectChoice {
  resolution: ResolutionChoice
  /** 16:9 (landscape) or 9:16 (portrait), when no custom ratio is set. */
  portrait: boolean
  /** Custom Ratio, width : height (e.g. 4 : 5), or null for 16:9 / 9:16. */
  ratio: { w: number; h: number } | null
  /** Custom Resolution. */
  size: { width: number; height: number }
}

export const SHORT_SIDE: Record<Exclude<ResolutionChoice, 'custom'>, number> = { '1080p': 1080, '4k': 2160 }

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/** The frame size for the choices, or what is wrong with them. */
export function newProjectSize(choice: NewProjectChoice): { width: number; height: number } | { error: string } {
  if (choice.resolution === 'custom') {
    const { width, height } = choice.size
    if (!Number.isInteger(width) || !Number.isInteger(height)) return { error: 'Width and height must be whole numbers' }
    if (width < MIN_DIMENSION || height < MIN_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return { error: `Width and height must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}` }
    }
    if (width % 2 !== 0 || height % 2 !== 0) return { error: 'Width and height must be even (video encoders need it)' }
    return { width, height }
  }
  const short = SHORT_SIDE[choice.resolution]
  const ratio = choice.ratio ?? (choice.portrait ? { w: 9, h: 16 } : { w: 16, h: 9 })
  if (!(ratio.w > 0 && ratio.h > 0) || !Number.isFinite(ratio.w) || !Number.isFinite(ratio.h)) return { error: 'The ratio needs two numbers above 0, like 4 : 5' }
  const width = ratio.w >= ratio.h ? even((short * ratio.w) / ratio.h) : short
  const height = ratio.w >= ratio.h ? short : even((short * ratio.h) / ratio.w)
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return { error: `That ratio is too wide for ${choice.resolution === '4k' ? '4K' : '1080p'} (the longest side is ${MAX_DIMENSION})` }
  return { width, height }
}

/** "4:5", "4 : 5", "2.39:1" or "4x5" → { w, h }; null if it isn't a ratio. */
export function parseRatio(text: string): { w: number; h: number } | null {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*[:x×/]\s*(\d+(?:[.,]\d+)?)\s*$/i.exec(text)
  if (!match) return null
  const w = Number(match[1]!.replace(',', '.'))
  const h = Number(match[2]!.replace(',', '.'))
  return w > 0 && h > 0 ? { w, h } : null
}
