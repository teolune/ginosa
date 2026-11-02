/** The CPU version of shader.wgsl, for tests: display R'G'B' (0–1) in, display out. */

export interface Level {
  inBlack: number
  inWhite: number
  gamma: number
  outBlack: number
  outWhite: number
}

export const IDENTITY_LEVEL: Level = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }

/**
 * Photoshop's Levels on one value (0–1): the input range stretched to 0–1 and clipped, raised
 * to 1/gamma, then mapped onto the output range. Input white at or below input black gives a
 * hard threshold at input black.
 */
export function level(x: number, l: Level): number {
  const v = Math.min(1, Math.max(0, (Math.min(1, Math.max(0, x)) * 255 - l.inBlack) / Math.max(l.inWhite - l.inBlack, 0.001)))
  const g = v <= 0 ? 0 : Math.pow(v, 1 / Math.max(l.gamma, 0.01))
  return (l.outBlack + g * (l.outWhite - l.outBlack)) / 255
}

/** Reads the four levels out of the effect's parameters (RGB unprefixed, channels prefixed). */
export function levelsFrom(params: Record<string, number>): { master: Level; red: Level; green: Level; blue: Level } {
  const one = (prefix: string): Level => {
    const id = (name: string) => (prefix ? prefix + name : name[0]!.toLowerCase() + name.slice(1))
    return { inBlack: params[id('InBlack')] ?? 0, inWhite: params[id('InWhite')] ?? 255, gamma: params[id('Gamma')] ?? 1, outBlack: params[id('OutBlack')] ?? 0, outWhite: params[id('OutWhite')] ?? 255 }
  }
  return { master: one(''), red: one('red'), green: one('green'), blue: one('blue') }
}

export function levelsReference(rgb: readonly [number, number, number], params: Record<string, number>): [number, number, number] {
  const l = levelsFrom(params)
  const channels = [l.red, l.green, l.blue]
  return rgb.map((v, i) => level(level(v, channels[i]!), l.master)) as [number, number, number]
}
