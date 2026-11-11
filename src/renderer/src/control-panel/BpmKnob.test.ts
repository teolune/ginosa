import { describe, expect, it } from 'vitest'
import { bpmTurn, clampBpm, dragBpm, parseBpm } from './BpmKnob'

describe('the Control Panel tempo knob', () => {
  it('takes typed tempos up to 999.999 with three decimals', () => {
    expect(parseBpm('130')).toBe(130)
    expect(parseBpm(' 128,5 ')).toBe(128.5)
    expect(parseBpm('999.999')).toBe(999.999)
    expect(parseBpm('174.12345')).toBe(174.123)
    expect(parseBpm('1000')).toBeNull()
    expect(parseBpm('19')).toBeNull()
    expect(parseBpm('fast')).toBeNull()
  })

  it('drags in whole BPM keeping the decimals, faster with Shift and finer with Option', () => {
    expect(dragBpm(128.5, 3, false, false)).toBe(128.5)
    expect(dragBpm(128.5, 8, false, false)).toBe(130.5)
    expect(dragBpm(128.5, -8, false, false)).toBe(126.5)
    expect(dragBpm(120, 8, false, true)).toBe(140)
    expect(dragBpm(120, 7, true, false)).toBe(120.07)
    expect(dragBpm(990, 400, false, true)).toBe(999.999)
    expect(dragBpm(25, -400, false, false)).toBe(20)
  })

  it('turns on a log scale with the usual tempos near the middle', () => {
    expect(bpmTurn(20)).toBe(0)
    expect(bpmTurn(999.999)).toBeCloseTo(1, 5)
    expect(bpmTurn(130)).toBeGreaterThan(0.4)
    expect(bpmTurn(130)).toBeLessThan(0.6)
    expect(clampBpm(130.00049)).toBe(130)
  })
})
