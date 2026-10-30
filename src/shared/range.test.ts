import { describe, expect, it } from 'vitest'
import { parseRange } from './range'
import { mediaUrlForPath, pathFromMediaUrl } from './ipc'

describe('parseRange', () => {
  it('returns null without a header', () => {
    expect(parseRange(null, 100)).toBeNull()
  })
  it('parses a closed range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
  })
  it('parses an open-ended range', () => {
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
  })
  it('clamps the end to the file size', () => {
    expect(parseRange('bytes=50-1000', 100)).toEqual({ start: 50, end: 99 })
  })
  it('parses a suffix range', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })
  it('rejects ranges past the end of the file', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
  })
  it('rejects malformed headers', () => {
    expect(parseRange('bytes=a-b', 100)).toBe('invalid')
    expect(parseRange('bytes=-', 100)).toBe('invalid')
    expect(parseRange('items=0-1', 100)).toBe('invalid')
  })
})

describe('media URLs', () => {
  it('round-trips paths with spaces and unicode', () => {
    const path = '/Users/teo/Developer/Reference Materials/clip één #1.mp4'
    expect(pathFromMediaUrl(mediaUrlForPath(path))).toBe(path)
  })
  it('ignores non-media URLs', () => {
    expect(pathFromMediaUrl('https://example.com/a.mp4')).toBeNull()
  })
})
