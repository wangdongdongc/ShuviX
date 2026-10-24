/**
 * 内置 timer 触发源（实验）—— `TimerSource` / `timerPayloadAt` / `isBuiltinTimerEnabled`。
 *
 * 契约（triggerTimer.ts 文件头）：
 *  - 对齐整分钟：排到下一分钟起点再多等 50ms；计时器 `unref`，不把进程留住；
 *  - 按真实分钟（`firedAt`）去重：同一分钟进来两次只发一次；夏令时回拨那一小时里本地时刻重复，
 *    但那是两个不同的真实分钟，各发一次；
 *  - 错过就错过：睡眠唤醒后只发**当下**这一分钟，不补；
 *  - 开关 `triggers.timer.enabled` 每次现读（缺省开，只有 'false' 是关）：关着时计时器照走、不发事件。
 *
 * 手法：除 TT-3（真走一遍 setTimeout 的延迟）外，`now` 由构造参数注入（可变的 `clock`），fake timers 只接管
 * setTimeout / clearTimeout —— `vi.runOnlyPendingTimers()` 就是「计时器此刻醒来」，醒在哪一刻由 `clock` 定，
 * 早醒、迟醒、睡一大觉都能直接摆出来。日期一律用本地构造函数，测试与所在时区无关。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TimerFiredPayload } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  get: vi.fn<(key: string) => string | undefined>(),
  warn: vi.fn(),
  info: vi.fn()
}))

vi.mock('../settingsService', () => ({ settingsService: { get: mocks.get } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() })
}))

import {
  BUILTIN_TIMER_ID,
  TIMER_ENABLED_KEY,
  TimerSource,
  isBuiltinTimerEnabled,
  timerPayloadAt
} from '../triggerTimer'

/** 本地时刻（月份按人读的 1–12） */
function at(y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s, ms)
}

/** 某一本地分钟起点的 firedAt */
function minuteIso(y: number, mo: number, d: number, h: number, mi: number): string {
  return at(y, mo, d, h, mi).toISOString()
}

beforeEach(() => {
  mocks.get.mockReset()
  mocks.warn.mockReset()
  mocks.info.mockReset()
})

describe('timerPayloadAt —— 一刻所在的本地分钟 → 事件 payload', () => {
  it('TT-1 截到分钟起点：firedAt 是那一分钟的 UTC ISO，local 各字段是本机本地时间，sourceId 是内置实例', () => {
    const payload = timerPayloadAt(at(2026, 10, 24, 17, 59, 30, 500))
    expect(payload).toStrictEqual({
      sourceId: 'timer:builtin:minute',
      firedAt: minuteIso(2026, 10, 24, 17, 59),
      local: { date: '2026-10-24', time: '17:59', weekday: 6, hour: 17, minute: 59 }
    })
    expect(BUILTIN_TIMER_ID).toBe('timer:builtin:minute')
    // 指定 sourceId 时照用
    expect(timerPayloadAt(at(2026, 10, 24, 17, 59), 'timer:x').sourceId).toBe('timer:x')
  })

  it('TT-2 补零（01-05 07:03）；星期日 = 0', () => {
    expect(timerPayloadAt(at(2026, 1, 5, 7, 3, 59, 999)).local).toStrictEqual({
      date: '2026-01-05',
      time: '07:03',
      weekday: 1,
      hour: 7,
      minute: 3
    })
    expect(timerPayloadAt(at(2026, 10, 25, 0, 0)).local).toStrictEqual({
      date: '2026-10-25',
      time: '00:00',
      weekday: 0,
      hour: 0,
      minute: 0
    })
  })
})

describe('TimerSource —— 对齐整分钟（真走 setTimeout）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('TT-3 在 hh:mm:20.300 启动：下一次排在 60000 − 20300 + 50 ms 之后；句柄 unref；之后每次都落在整分钟 + 50ms', () => {
    vi.useFakeTimers()
    vi.setSystemTime(at(2026, 10, 24, 12, 0, 20, 300))
    const unref = vi.fn()
    const fakeSetTimeout = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      const handle = fakeSetTimeout(fn, ms)
      return Object.assign(handle, { unref })
    }) as unknown as typeof setTimeout)

    const listener = vi.fn<(p: TimerFiredPayload) => void>()
    const source = new TimerSource(() => true)
    source.start(listener)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toBe(60_000 - 20_300 + 50)
    expect(unref).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000 - 20_300 + 49)
    expect(listener).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].firedAt).toBe(minuteIso(2026, 10, 24, 12, 1))
    // 醒在 12:01:00.050 → 下一次 = 60000 − 50 + 50
    expect(spy.mock.calls[1][1]).toBe(60_000)
    vi.advanceTimersByTime(60_000)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[1][0].local.time).toBe('12:02')
    source.stop()
  })
})

describe('TimerSource —— 去重、错过、开关、异常、启停（注入 now）', () => {
  let clock: Date
  let enabled: boolean
  let source: TimerSource
  let listener: ReturnType<typeof vi.fn<(p: TimerFiredPayload) => void>>

  /** 计时器此刻（clock）醒来 */
  function wakeAt(when: Date): void {
    clock = when
    vi.runOnlyPendingTimers()
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    clock = at(2026, 10, 24, 11, 59, 30)
    enabled = true
    listener = vi.fn<(p: TimerFiredPayload) => void>()
    source = new TimerSource(
      () => enabled,
      () => clock
    )
    source.start(listener)
  })

  afterEach(() => {
    source.stop()
    vi.useRealTimers()
  })

  it('TT-4 同一分钟里醒两次 → 只发一次', () => {
    wakeAt(at(2026, 10, 24, 12, 0, 0, 50))
    wakeAt(at(2026, 10, 24, 12, 0, 45))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toStrictEqual(timerPayloadAt(at(2026, 10, 24, 12, 0)))
  })

  it('TT-5 早醒（12:00 发过之后醒在 12:00:59.990）→ 不发；再醒落进 12:01 → 发一次', () => {
    wakeAt(at(2026, 10, 24, 12, 0, 0, 50))
    wakeAt(at(2026, 10, 24, 12, 0, 59, 990))
    expect(listener).toHaveBeenCalledTimes(1)
    wakeAt(at(2026, 10, 24, 12, 1, 0, 40))
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[1][0].local.time).toBe('12:01')
  })

  it('TT-6 错过的分钟不补：时钟从 12:01 跳到 12:37 → 只发一次 12:37，不追发中间的', () => {
    wakeAt(at(2026, 10, 24, 12, 1, 0, 50))
    wakeAt(at(2026, 10, 24, 12, 37, 12, 345))
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls.map((c) => c[0].local.time)).toEqual(['12:01', '12:37'])
    expect(listener.mock.calls[1][0].firedAt).toBe(minuteIso(2026, 10, 24, 12, 37))
  })

  it('TT-7 关着：不发、lastFiredPayload 不动、计时器照排；下一分钟打开 → 发。（pin）同一分钟里重新打开不补发这一分钟', () => {
    enabled = false
    wakeAt(at(2026, 10, 24, 12, 0, 0, 50))
    expect(listener).not.toHaveBeenCalled()
    expect(source.lastFiredPayload).toBeNull()
    expect(vi.getTimerCount()).toBe(1)

    // 同一分钟里打开：这一分钟已经「用掉」了
    enabled = true
    wakeAt(at(2026, 10, 24, 12, 0, 30))
    expect(listener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    wakeAt(at(2026, 10, 24, 12, 1, 0, 50))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].local.time).toBe('12:01')
  })

  it('TT-8 监听者抛错 → 记 warn，下一次照排；这一分钟不重试，下一分钟照发', () => {
    listener.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    wakeAt(at(2026, 10, 24, 12, 0, 0, 50))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    expect(mocks.warn.mock.calls[0][0]).toContain('boom')
    expect(vi.getTimerCount()).toBe(1)

    wakeAt(at(2026, 10, 24, 12, 0, 20))
    expect(listener).toHaveBeenCalledTimes(1)
    wakeAt(at(2026, 10, 24, 12, 1, 0, 50))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('TT-9 stop 清掉计时器；stop 之后的一次散落 tick 不发也不再排；start 两次只留一个计时器', () => {
    expect(vi.getTimerCount()).toBe(1)
    source.stop()
    expect(vi.getTimerCount()).toBe(0)

    clock = at(2026, 10, 24, 12, 0, 0, 50)
    source.tick()
    expect(listener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    const second = vi.fn<(p: TimerFiredPayload) => void>()
    source.start(listener)
    source.start(second)
    expect(vi.getTimerCount()).toBe(1)
    wakeAt(at(2026, 10, 24, 12, 1, 0, 50))
    expect(listener).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('TT-11 lastFiredPayload：发事件之前是 null，之后是最后一次发出的 payload；只在进程内（新实例是 null）', () => {
    expect(source.lastFiredPayload).toBeNull()
    wakeAt(at(2026, 10, 24, 12, 0, 0, 50))
    expect(source.lastFiredPayload).toStrictEqual(timerPayloadAt(at(2026, 10, 24, 12, 0)))
    wakeAt(at(2026, 10, 24, 12, 1, 0, 50))
    expect(source.lastFiredPayload).toBe(listener.mock.calls[1][0])
    expect(source.lastFiredPayload?.local.time).toBe('12:01')
    expect(new TimerSource(() => true).lastFiredPayload).toBeNull()
  })
})

describe('TimerSource —— 夏令时回拨（TZ=America/New_York）', () => {
  const savedTz = process.env.TZ
  beforeEach(() => {
    process.env.TZ = 'America/New_York'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    if (savedTz === undefined) delete process.env.TZ
    else process.env.TZ = savedTz
  })

  it('TT-12 回拨后重复的那一小时：两个本地 01:30 是两个真实分钟，各触发一次，firedAt 各是自己的 UTC 时刻', () => {
    // 2026-11-01 02:00 EDT 回拨到 01:00 EST：01:30 EDT = 05:30Z，01:30 EST = 06:30Z
    let clock = new Date('2026-11-01T05:29:30.000Z')
    const listener = vi.fn<(p: TimerFiredPayload) => void>()
    const source = new TimerSource(
      () => true,
      () => clock
    )
    source.start(listener)
    clock = new Date('2026-11-01T05:30:00.050Z')
    vi.runOnlyPendingTimers()
    clock = new Date('2026-11-01T06:30:00.050Z')
    vi.runOnlyPendingTimers()
    source.stop()
    expect(listener.mock.calls.map(([p]) => [p.firedAt, p.local.time])).toEqual([
      ['2026-11-01T05:30:00.000Z', '01:30'],
      ['2026-11-01T06:30:00.000Z', '01:30']
    ])
  })
})

describe('isBuiltinTimerEnabled —— 设置项现读，缺省开', () => {
  it("TT-10 没设 / 'true' / 乱写 / 'FALSE' → 开；只有 'false' 是关", () => {
    for (const value of [undefined, 'true', 'garbage', 'FALSE', '', '0']) {
      mocks.get.mockReturnValue(value)
      expect(isBuiltinTimerEnabled(), String(value)).toBe(true)
    }
    mocks.get.mockReturnValue('false')
    expect(isBuiltinTimerEnabled()).toBe(false)
    expect(mocks.get).toHaveBeenLastCalledWith(TIMER_ENABLED_KEY)
    expect(TIMER_ENABLED_KEY).toBe('triggers.timer.enabled')
  })
})
