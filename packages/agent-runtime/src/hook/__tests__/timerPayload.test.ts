/**
 * `timerPayloadAt`（hook/timerPayload）—— 某一刻所在的本地分钟 → `timer.fired` 的 payload。内置 timer（桌面
 * services/triggerTimer 的同名包装，缺省 sourceId 是内置实例）与 bot 文件的排期预演用的是同一个函数：预演说
 * 「20:00 触发」时真的 timer 才会这么判。
 *
 *   TP-1 桌面包装与这里逐字相同（同一 sourceId）；包装不给 sourceId 时是 timer:builtin:minute
 *   TP-2 Asia/Shanghai：本地字段按本机时区，UTC 还在前一天时本地已是次日（周日 = 0）
 *   TP-3 America/New_York 回拨那一小时：两个本地 01:30 各自的 firedAt
 *   TP-4 补零；:59.999 截到那一分钟的起点
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timerPayloadAt } from '../timerPayload'

// 桌面包装（TP-1）引着设置与日志：桩掉，免得拉起数据库
vi.mock('../../../../../apps/desktop/src/main/services/settingsService', () => ({
  settingsService: { get: () => undefined }
}))
vi.mock('../../../../../apps/desktop/src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { timerPayloadAt as desktopTimerPayloadAt } from '../../../../../apps/desktop/src/main/services/triggerTimer'

const savedTz = process.env.TZ
beforeEach(() => {
  process.env.TZ = 'Asia/Shanghai'
})
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

/** 本地时刻（月份按人读的 1–12） */
function at(y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s, ms)
}

describe('timerPayloadAt', () => {
  it('TP-1 桌面的包装与这里逐字相同；包装不给 sourceId 时是内置实例 timer:builtin:minute', () => {
    for (const moment of [
      at(2026, 10, 31, 12, 0, 30),
      at(2026, 11, 1, 0, 0),
      at(2026, 1, 5, 7, 3, 59, 999),
      new Date('2026-10-31T16:30:00.000Z')
    ]) {
      expect(desktopTimerPayloadAt(moment, 'timer:x')).toStrictEqual(
        timerPayloadAt(moment, 'timer:x')
      )
      expect(desktopTimerPayloadAt(moment)).toStrictEqual(
        timerPayloadAt(moment, 'timer:builtin:minute')
      )
    }
    expect(desktopTimerPayloadAt(at(2026, 10, 31, 12, 0)).sourceId).toBe('timer:builtin:minute')
  })

  it('TP-2 Asia/Shanghai：UTC 10-31 16:30 = 本地 11-01（周日 = 0）00:30；firedAt 仍是那一刻的 UTC', () => {
    expect(timerPayloadAt(new Date('2026-10-31T16:30:20.000Z'), 'timer:x')).toStrictEqual({
      sourceId: 'timer:x',
      firedAt: '2026-10-31T16:30:00.000Z',
      local: { date: '2026-11-01', time: '00:30', weekday: 0, hour: 0, minute: 30 }
    })
    // 本地周六 23:59 → weekday 6
    expect(timerPayloadAt(at(2026, 10, 31, 23, 59), 'timer:x').local).toStrictEqual({
      date: '2026-10-31',
      time: '23:59',
      weekday: 6,
      hour: 23,
      minute: 59
    })
  })

  it('TP-3 America/New_York 回拨（11-01 02:00 EDT → 01:00 EST）：两个本地 01:30 是两个真实分钟，firedAt 各是自己的', () => {
    process.env.TZ = 'America/New_York'
    const edt = timerPayloadAt(new Date('2026-11-01T05:30:45.000Z'), 'timer:x')
    const est = timerPayloadAt(new Date('2026-11-01T06:30:45.000Z'), 'timer:x')
    expect(edt.local).toStrictEqual(est.local)
    expect(edt.local).toStrictEqual({
      date: '2026-11-01',
      time: '01:30',
      weekday: 0,
      hour: 1,
      minute: 30
    })
    expect([edt.firedAt, est.firedAt]).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:30:00.000Z'
    ])
  })

  it('TP-4 补零（01-05 07:03）；:59.999 截到那一分钟的起点，不进到下一分钟', () => {
    const payload = timerPayloadAt(at(2026, 1, 5, 7, 3, 59, 999), 'timer:x')
    expect(payload).toStrictEqual({
      sourceId: 'timer:x',
      firedAt: at(2026, 1, 5, 7, 3).toISOString(),
      local: { date: '2026-01-05', time: '07:03', weekday: 1, hour: 7, minute: 3 }
    })
    expect(timerPayloadAt(at(2026, 9, 9, 0, 0), 'timer:x').local).toMatchObject({
      date: '2026-09-09',
      time: '00:00'
    })
  })
})
