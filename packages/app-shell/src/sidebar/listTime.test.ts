/**
 * 会话列表行尾的时间（listTime.ts 的 `listTimeLabel`，node 环境）。
 *
 * 契约：同一个日历日 → 时分；前一天 → 调用方给的「昨天」；2–6 天前 → 那种语言里星期几的短写；更早、同一年 →
 * 月-日；不是同一年 → 年-月-日。按日历日算，不按 24 小时算。
 *
 *   LT-1 今天：HH:MM，补零
 *   LT-2 将来的时间也写时分
 *   LT-3 昨天：23:59 对 00:01 也是昨天；不到 24 小时、超过 24 小时都按日历日
 *   LT-4 2–6 天前：星期几（按 locale）
 *   LT-5 边界：6 天前还是星期几，7 天前是月-日
 *   LT-6 更早、同一年：MM-DD
 *   LT-7 另一年：YYYY-MM-DD；跨年但在一周之内仍是昨天 / 星期几
 *   LT-8 [WB] 认不得的 locale：一周之内落到月-日，不抛
 *
 * 时间戳一律用 `new Date(y, m, d, h, min).getTime()` 造（本地时间），与跑测试的时区无关。
 */
import { describe, expect, it } from 'vitest'
import { listTimeLabel } from './listTime'

const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime()
/** 2026-11-14 是星期六 */
const NOW = at(2026, 11, 14, 15, 30)
const OPTS = { yesterday: 'Yesterday', locale: 'en' }
const label = (time: number, now = NOW, opts = OPTS): string => listTimeLabel(time, now, opts)

describe('listTimeLabel', () => {
  it.each<[string, number, string]>([
    ['the morning', at(2026, 11, 14, 9, 5), '09:05'],
    ['midnight', at(2026, 11, 14, 0, 0), '00:00'],
    ['the same minute', NOW, '15:30'],
    ['later today', at(2026, 11, 14, 23, 59), '23:59']
  ])('LT-1 today, %s: hours and minutes, zero-padded', (_label, time, expected) => {
    expect(label(time)).toBe(expected)
  })

  it('LT-2 a future timestamp reads as hours and minutes', () => {
    expect(label(at(2026, 11, 15, 8, 0))).toBe('08:00')
    expect(label(at(2027, 1, 3, 7, 45))).toBe('07:45')
  })

  it('LT-3 one calendar day earlier is the given "yesterday" string', () => {
    expect(label(at(2026, 11, 13, 10, 0))).toBe('Yesterday')
    expect(label(at(2026, 11, 13, 10, 0), NOW, { yesterday: '昨天', locale: 'zh' })).toBe('昨天')
  })

  it('LT-3 days are calendar days, not 24-hour spans', () => {
    // 两分钟之前，但已经是前一天
    expect(label(at(2026, 11, 13, 23, 59), at(2026, 11, 14, 0, 1))).toBe('Yesterday')
    // 将近 48 小时之前，仍是前一天
    expect(label(at(2026, 11, 13, 0, 0), at(2026, 11, 14, 23, 59))).toBe('Yesterday')
    // 不到 24 小时之前、同一天
    expect(label(at(2026, 11, 14, 0, 1), at(2026, 11, 14, 23, 59))).toBe('00:01')
  })

  it.each<[number, string]>([
    [12, 'Thu'],
    [11, 'Wed'],
    [10, 'Tue'],
    [9, 'Mon'],
    [8, 'Sun']
  ])('LT-4 November %i (2–6 days earlier) is the short weekday', (day, expected) => {
    expect(label(at(2026, 11, day, 23, 0))).toBe(expected)
  })

  it('LT-4 the weekday is written in the given locale', () => {
    const time = at(2026, 11, 12, 9, 0)
    for (const locale of ['zh', 'ja', 'de']) {
      const expected = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(time))
      expect(label(time, NOW, { yesterday: 'Yesterday', locale })).toBe(expected)
    }
    expect(label(time, NOW, { yesterday: 'Yesterday', locale: 'zh' })).not.toBe('Thu')
  })

  it('LT-5 six days earlier is still a weekday; seven days earlier is month and day', () => {
    expect(label(at(2026, 11, 8, 0, 0))).toBe('Sun')
    expect(label(at(2026, 11, 7, 23, 59))).toBe('11-07')
  })

  it.each<[string, number, string]>([
    ['last month', at(2026, 10, 31), '10-31'],
    ['a single-digit month and day', at(2026, 3, 5), '03-05'],
    ['the first day of the year', at(2026, 1, 1, 0, 0), '01-01']
  ])('LT-6 older in the same year, %s: MM-DD', (_label, time, expected) => {
    expect(label(time)).toBe(expected)
  })

  it('LT-7 another year carries the year', () => {
    expect(label(at(2025, 12, 31))).toBe('2025-12-31')
    expect(label(at(2020, 3, 5))).toBe('2020-03-05')
    expect(label(at(2025, 12, 20), at(2026, 1, 2))).toBe('2025-12-20')
  })

  it('LT-7 across a new year but within the week it is still yesterday or a weekday', () => {
    const now = at(2026, 1, 2, 9, 0)
    expect(label(at(2025, 12, 31, 20, 0), now)).toBe('Wed')
    expect(label(at(2025, 12, 31, 23, 59), at(2026, 1, 1, 0, 1))).toBe('Yesterday')
  })

  it('LT-8 [WB] a locale tag Intl rejects falls back to month and day without throwing', () => {
    const opts = { yesterday: 'Yesterday', locale: 'not a locale' }
    expect(label(at(2026, 11, 12), NOW, opts)).toBe('11-12')
    expect(label(at(2026, 11, 13), NOW, opts)).toBe('Yesterday')
    expect(label(at(2026, 11, 14, 9, 5), NOW, opts)).toBe('09:05')
  })

  it('LT-8 [WB] without a locale the weekday uses the default one', () => {
    const time = at(2026, 11, 12)
    const expected = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(time))
    expect(listTimeLabel(time, NOW, { yesterday: 'Yesterday' })).toBe(expected)
  })
})
