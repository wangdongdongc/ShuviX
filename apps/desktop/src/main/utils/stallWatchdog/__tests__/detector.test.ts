import { describe, expect, it } from 'vitest'
import { StallDetector } from '../detector'

const make = (): StallDetector => new StallDetector({ thresholdMs: 2000, suspendGapMs: 1500 })

/** 依次喂入 (now, beat)，断言每一拍都没有事件 */
function expectQuiet(d: StallDetector, ticks: [number, number][]): void {
  for (const [now, beat] of ticks) {
    expect(d.tick(now, beat), `tick(${now}, ${beat})`).toBeNull()
  }
}

describe('StallDetector', () => {
  it('starts a stall exactly at the threshold (>=), not before', () => {
    const d = make()
    expectQuiet(d, [
      [500, 0],
      [1000, 0],
      [1500, 0],
      [1999, 0]
    ])
    expect(d.tick(2000, 0)).toEqual({ type: 'start', lastBeatAtMs: 0, silentMs: 2000 })
  })

  it('reports a start only once per stall and tracks how long it has lasted', () => {
    expect(make().stalledForMs(1234)).toBeNull()
    const d = make()
    expectQuiet(d, [
      [500, 0],
      [1000, 0],
      [1500, 0],
      [1999, 0]
    ])
    expect(d.tick(2000, 0)?.type).toBe('start')
    expectQuiet(d, [
      [2500, 0],
      [3000, 0]
    ])
    expect(d.stalledForMs(3000)).toBe(3000)
  })

  it('ends the stall on the first newer beat and stops tracking it', () => {
    const d = make()
    expect(d.tick(2000, 0)?.type).toBe('start')
    expect(d.tick(3500, 3400)).toEqual({
      type: 'end',
      lastBeatAtMs: 0,
      resumedAtMs: 3400,
      durationMs: 3400
    })
    expect(d.stalledForMs(3500)).toBeNull()
  })

  it('a beat equal to the stall origin does not end it', () => {
    const d = make()
    expectQuiet(d, [
      [1000, 1000],
      [1500, 1000],
      [2000, 1000],
      [2500, 1000]
    ])
    expect(d.tick(3000, 1000)).toEqual({ type: 'start', lastBeatAtMs: 1000, silentMs: 2000 })
    expectQuiet(d, [
      [3500, 1000],
      [4000, 1000]
    ])
    expect(d.stalledForMs(4000)).toBe(3000)
  })

  it('a new stall needs a full threshold measured from the new beat', () => {
    const d = make()
    expect(d.tick(2000, 0)?.type).toBe('start')
    expect(d.tick(3500, 3400)?.type).toBe('end')
    expectQuiet(d, [
      [4000, 3400],
      [4500, 3400],
      [5000, 3400],
      [5399, 3400]
    ])
    expect(d.tick(5400, 3400)).toEqual({ type: 'start', lastBeatAtMs: 3400, silentMs: 2000 })
  })

  it('a late worker tick (suspension) discards the silence before it', () => {
    const d = make()
    expectQuiet(d, [
      [500, 0],
      // 间隔 1600 > 1500：整个进程停过，2100 ≥ 2000 也不算
      [2100, 0],
      [2600, 0],
      [3100, 0],
      [3600, 0],
      [4099, 0]
    ])
    const start = d.tick(4100, 0)
    // 计入的沉默从停顿结束那一拍算起
    expect(start).toEqual({ type: 'start', lastBeatAtMs: 2100, silentMs: 2000 })
    expect(d.tick(4600, 4500)).toEqual({
      type: 'end',
      lastBeatAtMs: 2100,
      resumedAtMs: 4500,
      durationMs: 4500 - 2100
    })
  })

  it('a gap of exactly suspendGapMs is not a suspension', () => {
    const d = make()
    expectQuiet(d, [[500, 0]])
    expect(d.tick(2000, 0)).toEqual({ type: 'start', lastBeatAtMs: 0, silentMs: 2000 })
  })

  it('a beat newer than the suspension point wins', () => {
    const d = make()
    expectQuiet(d, [
      [500, 0],
      [2100, 0],
      [2600, 2400],
      [3100, 2400],
      [3600, 2400],
      [4100, 2400],
      [4399, 2400]
    ])
    expect(d.tick(4400, 2400)).toEqual({ type: 'start', lastBeatAtMs: 2400, silentMs: 2000 })
  })

  it('a suspension during a stall neither ends nor restarts it', () => {
    const d = make()
    expect(d.tick(2000, 0)?.type).toBe('start')
    expect(d.tick(5000, 0)).toBeNull()
    expect(d.stalledForMs(5000)).toBe(5000)
    expect(d.tick(5500, 5400)).toEqual({
      type: 'end',
      lastBeatAtMs: 0,
      resumedAtMs: 5400,
      durationMs: 5400
    })
  })

  it('the very first tick never counts as a suspension', () => {
    expect(make().tick(5000, 0)).toEqual({ type: 'start', lastBeatAtMs: 0, silentMs: 5000 })
  })
})
