/**
 * 日期通知的纯文本口径（裁决 Q14）：
 * `<date-change>Today is YYYY-MM-DD (Weekday). The previous message in this conversation was about N hours ago.</date-change>`
 * —— 间隔 ≥ 48 小时按天说，没有上一条消息的时间就省掉第二句；星期按日历算、与时区无关。
 */
import { describe, expect, it } from 'vitest'
import {
  DATE_NOTICE_KIND,
  dateNoticeRequestId,
  localDate,
  renderDateNotice,
  weekdayOf
} from '../prompt/dateNotice'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 5, 9, 0, 0)

const notice = (body: string): string => `<date-change>${body}</date-change>`

describe('renderDateNotice', () => {
  it('DN-01 hours: the exact Q14 sentence pair', () => {
    expect(renderDateNotice('2026-10-05', NOW - 30 * HOUR, NOW)).toBe(
      notice(
        'Today is 2026-10-05 (Monday). The previous message in this conversation was about 30 hours ago.'
      )
    )
  })

  it('DN-02 no previous message time → only the first sentence', () => {
    expect(renderDateNotice('2026-10-04', undefined, NOW)).toBe(
      notice('Today is 2026-10-04 (Sunday).')
    )
  })

  it('DN-03 ≥ 48 hours switches to days (rounded)', () => {
    expect(renderDateNotice('2026-10-05', NOW - 48 * HOUR, NOW)).toContain('about 2 days ago.')
    expect(renderDateNotice('2026-10-05', NOW - 72 * HOUR, NOW)).toContain('about 3 days ago.')
    expect(renderDateNotice('2026-10-05', NOW - 10 * 24 * HOUR, NOW)).toContain(
      'about 10 days ago.'
    )
  })

  it('DN-04 just under 48 hours still says hours', () => {
    expect(renderDateNotice('2026-10-05', NOW - 47.4 * HOUR, NOW)).toContain('about 47 hours ago.')
    expect(renderDateNotice('2026-10-05', NOW - 47.9 * HOUR, NOW)).toContain('about 48 hours ago.')
  })

  it('DN-05 hours are rounded; under an hour reads as one hour (singular)', () => {
    expect(renderDateNotice('2026-10-05', NOW - 5.4 * HOUR, NOW)).toContain('about 5 hours ago.')
    expect(renderDateNotice('2026-10-05', NOW - 5.6 * HOUR, NOW)).toContain('about 6 hours ago.')
    expect(renderDateNotice('2026-10-05', NOW - 1 * HOUR, NOW)).toContain('about 1 hour ago.')
    expect(renderDateNotice('2026-10-05', NOW - 10 * 60_000, NOW)).toContain('about 1 hour ago.')
    expect(renderDateNotice('2026-10-05', NOW, NOW)).toContain('about 1 hour ago.')
  })

  it('DN-06 a previous time in the future or not finite → the second sentence is omitted', () => {
    const only = notice('Today is 2026-10-05 (Monday).')
    expect(renderDateNotice('2026-10-05', NOW + HOUR, NOW)).toBe(only)
    expect(renderDateNotice('2026-10-05', Number.NaN, NOW)).toBe(only)
    expect(renderDateNotice('2026-10-05', Number.POSITIVE_INFINITY, NOW)).toBe(only)
  })

  it('DN-07 invalid dates throw instead of announcing nonsense', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '2026-1-5', 'today', '', '2026/10/05']) {
      expect(() => renderDateNotice(bad, undefined, NOW), bad).toThrow(/calendar date/)
    }
  })
})

describe('weekdayOf / localDate / requestId', () => {
  it('DN-08 weekday is calendar-based (independent of the time zone)', () => {
    expect(weekdayOf('2026-10-04')).toBe('Sunday')
    expect(weekdayOf('2026-10-05')).toBe('Monday')
    expect(weekdayOf('2024-02-29')).toBe('Thursday')
    expect(weekdayOf('2000-01-01')).toBe('Saturday')
  })

  it('DN-08b the weekday does not move with the process time zone', () => {
    const saved = process.env.TZ
    try {
      for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
        process.env.TZ = zone
        expect(weekdayOf('2026-10-04'), zone).toBe('Sunday')
        expect(renderDateNotice('2026-10-04', undefined, NOW), zone).toContain('(Sunday)')
      }
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })

  it('DN-09 localDate formats the local calendar day, zero-padded', () => {
    const at = new Date(2026, 0, 7, 23, 59, 0).getTime()
    expect(localDate(at)).toBe('2026-01-07')
    expect(localDate(new Date(2026, 11, 31, 0, 0, 1).getTime())).toBe('2026-12-31')
    expect(localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('DN-10 requestId is per conversation and date; the notice kind is "date"', () => {
    expect(dateNoticeRequestId(0, '2026-10-05')).toBe('shuvix:date:0:2026-10-05')
    expect(dateNoticeRequestId(7, '2026-10-05')).not.toBe(dateNoticeRequestId(8, '2026-10-05'))
    expect(DATE_NOTICE_KIND).toBe('date')
  })
})
