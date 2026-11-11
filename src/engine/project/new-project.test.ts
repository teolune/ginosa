import { describe, expect, it } from 'vitest'
import { newProjectSize, parseRatio, type NewProjectChoice } from './new-project'

const base: NewProjectChoice = { resolution: '1080p', portrait: false, ratio: null, size: { width: 1280, height: 720 } }

describe('new project sizes', () => {
  it('makes 1080p and 4K in 16:9 or 9:16', () => {
    expect(newProjectSize(base)).toEqual({ width: 1920, height: 1080 })
    expect(newProjectSize({ ...base, portrait: true })).toEqual({ width: 1080, height: 1920 })
    expect(newProjectSize({ ...base, resolution: '4k' })).toEqual({ width: 3840, height: 2160 })
    expect(newProjectSize({ ...base, resolution: '4k', portrait: true })).toEqual({ width: 2160, height: 3840 })
  })

  it('keeps the short side for a custom ratio and rounds the long side to an even number', () => {
    expect(newProjectSize({ ...base, ratio: { w: 4, h: 5 } })).toEqual({ width: 1080, height: 1350 })
    expect(newProjectSize({ ...base, ratio: { w: 1, h: 1 } })).toEqual({ width: 1080, height: 1080 })
    expect(newProjectSize({ ...base, ratio: { w: 2.39, h: 1 } })).toEqual({ width: 2582, height: 1080 })
    expect(newProjectSize({ ...base, resolution: '4k', ratio: { w: 4, h: 5 } })).toEqual({ width: 2160, height: 2700 })
    expect(newProjectSize({ ...base, resolution: '4k', ratio: { w: 4, h: 1 } })).toEqual({ error: expect.stringMatching(/too wide/) })
  })

  it('checks a custom resolution', () => {
    expect(newProjectSize({ ...base, resolution: 'custom' })).toEqual({ width: 1280, height: 720 })
    expect(newProjectSize({ ...base, resolution: 'custom', size: { width: 1281, height: 720 } })).toEqual({ error: expect.stringMatching(/even/) })
    expect(newProjectSize({ ...base, resolution: 'custom', size: { width: 9000, height: 720 } })).toEqual({ error: expect.stringMatching(/between/) })
  })

  it('reads ratios', () => {
    expect(parseRatio('4:5')).toEqual({ w: 4, h: 5 })
    expect(parseRatio(' 2,39 : 1 ')).toEqual({ w: 2.39, h: 1 })
    expect(parseRatio('4x5')).toEqual({ w: 4, h: 5 })
    expect(parseRatio('wide')).toBeNull()
    expect(parseRatio('0:5')).toBeNull()
  })
})
