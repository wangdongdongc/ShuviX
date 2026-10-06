// @vitest-environment jsdom
/**
 * 运行状态行（jsdom，P3-12）—— StreamingFooter 那一格里的重试倒计时与压缩通知：
 *
 *   P3-12-15 倒计时：显示第 attempt+1 次（durable 的 attempt 是失败的那一次）、剩余秒数与原因；1 秒后少 1；
 *            `at` 不晚于此刻 → 「正在重试」，绝不出负数；卸载即停表
 *   P3-12-16 摆放：没有 retry / 不是 busy → 没有倒计时；倒计时在时没有 loading 点点；实时卡出现（retry 没了）
 *            倒计时随之消失
 *   P3-12-17 很长的原因：只显示第一行（截断），全文在 title
 *   P3-12-20 压缩通知：threshold 的文案；blocking:false 是后台变体；retryAt 带倒计时、attempt>1 带次数；
 *            不认识的原因走通用文案；没有 compacting 就没有这一行
 *
 * 状态只经 `applySessionView` 写（PIN-23）；假时钟（PIN-22：`at` 是同一台机器的毫秒时间戳）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { RunView } from '@shuvix/chat-protocol/types/sessionView'
import { applySessionView } from '../../../stores/chatStore'
import { StreamingFooter } from '../StreamingFooter'
import { V, liveCard, resetStore, text, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 's1'
const NOW = 1_800_000_000_000

let container: HTMLDivElement
let root: Root

function apply(run: RunView, live: ReturnType<typeof liveCard> | null = null): void {
  act(() => applySessionView(SID, V(SID, { messages: [user('u1', 'hi')], run, live })))
}

function mount(): void {
  act(() => root.render(createElement(StreamingFooter)))
}

const retryRow = (): HTMLElement | null => container.querySelector('[data-run-retry]')
const compactRow = (): HTMLElement | null => container.querySelector('[data-run-compacting]')
const dots = (): HTMLElement | null => container.querySelector('[data-streaming-dots]')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  resetStore(SID)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('P3-12-15 countdown', () => {
  it('P3-12-15 attempt+1, the seconds left and the reason; one second later it shows 4s', () => {
    apply({
      state: 'busy',
      retry: { attempt: 2, at: NOW + 5000, error: '503 Service Unavailable' }
    })
    mount()
    expect(retryRow()!.textContent).toContain('Retrying (attempt 3) in 5s')
    expect(retryRow()!.textContent).toContain('503 Service Unavailable')
    act(() => vi.advanceTimersByTime(1000))
    expect(retryRow()!.textContent).toContain('Retrying (attempt 3) in 4s')
  })

  it('P3-12-15 when `at` is not later than now: "retrying now", never a negative number', () => {
    apply({ state: 'busy', retry: { attempt: 1, at: NOW + 1500, error: 'boom' } })
    mount()
    expect(retryRow()!.textContent).toContain('in 2s')
    act(() => vi.advanceTimersByTime(3000))
    expect(retryRow()!.textContent).toContain('Retrying now (attempt 2)')
    expect(retryRow()!.textContent).not.toMatch(/-\d/)
    apply({ state: 'busy', retry: { attempt: 1, at: NOW - 10_000, error: 'boom' } })
    expect(retryRow()!.textContent).toContain('Retrying now (attempt 2)')
  })

  it('P3-12-15 unmounting clears the interval', () => {
    apply({ state: 'busy', retry: { attempt: 0, at: NOW + 5000, error: 'x' } })
    mount()
    expect(vi.getTimerCount()).toBe(1)
    act(() => root.render(createElement('div')))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('P3-12-16 placement', () => {
  it('P3-12-16 no countdown without retry, or when the run is not busy', () => {
    apply({ state: 'busy' })
    mount()
    expect(retryRow()).toBeNull()
    apply({ state: 'idle', retry: { attempt: 1, at: NOW + 5000, error: 'x' } })
    expect(retryRow()).toBeNull()
    apply({ state: 'interrupted', retry: { attempt: 1, at: NOW + 5000, error: 'x' } })
    expect(retryRow()).toBeNull()
  })

  it('P3-12-16 the dots do not show while the countdown shows; once a live card appears (retry gone) the countdown is gone', () => {
    apply({ state: 'busy' })
    mount()
    expect(dots()).not.toBeNull()
    apply({ state: 'busy', retry: { attempt: 1, at: NOW + 5000, error: 'x' } })
    expect(retryRow()).not.toBeNull()
    expect(dots()).toBeNull()
    apply({ state: 'busy' }, liveCard(7, [text('after retry')]))
    expect(retryRow()).toBeNull()
  })
})

describe('P3-12-17 long reason', () => {
  it('P3-12-17 a 2 KB multi-line error: the row shows the first line, truncated; the full text is in title', () => {
    const first = 'E'.repeat(400)
    const error = `${first}\n${'second line '.repeat(140)}`
    expect(error.length).toBeGreaterThan(2000)
    apply({ state: 'busy', retry: { attempt: 1, at: NOW + 5000, error } })
    mount()
    const reason = container.querySelector<HTMLElement>('[data-run-retry-reason]')!
    expect(reason.title).toBe(error)
    expect(reason.textContent).not.toContain('second line')
    expect(reason.textContent!.length).toBeLessThan(first.length)
    expect(reason.textContent!.endsWith('...')).toBe(true)
    expect(reason.className).toContain('truncate')
  })
})

describe('P3-12-20 compaction notice', () => {
  it('P3-12-20 threshold, blocking: the threshold text; the dots give way', () => {
    apply({ state: 'busy', compacting: { reason: 'threshold', blocking: true, attempt: 1 } })
    mount()
    expect(compactRow()!.dataset.runCompacting).toBe('blocking')
    expect(compactRow()!.textContent).toBe(
      en.run.compactingBlocking.replace('{{reason}}', en.run.compactingReasonThreshold)
    )
    expect(dots()).toBeNull()
  })

  it('P3-12-20 blocking:false gives the background variant', () => {
    apply({ state: 'busy', compacting: { reason: 'overflow', blocking: false, attempt: 1 } })
    mount()
    expect(compactRow()!.dataset.runCompacting).toBe('background')
    expect(compactRow()!.textContent).toBe(
      en.run.compactingBackground.replace('{{reason}}', en.run.compactingReasonOverflow)
    )
  })

  it('P3-12-20 retryAt gives a countdown; attempt above 1 shows the attempt', () => {
    apply({
      state: 'busy',
      compacting: { reason: 'threshold', blocking: true, attempt: 3, retryAt: NOW + 4000 }
    })
    mount()
    expect(compactRow()!.textContent).toContain('attempt 3')
    expect(compactRow()!.textContent).toContain('retrying in 4s')
    act(() => vi.advanceTimersByTime(1000))
    expect(compactRow()!.textContent).toContain('retrying in 3s')
    apply({ state: 'busy', compacting: { reason: 'threshold', blocking: true, attempt: 1 } })
    expect(compactRow()!.textContent).not.toContain('attempt')
  })

  it('P3-12-20 an unknown reason falls back to the generic text; no row when compacting is undefined', () => {
    apply({ state: 'busy', compacting: { reason: 'mystery', blocking: true, attempt: 1 } })
    mount()
    expect(compactRow()!.textContent).toBe(
      en.run.compactingBlocking.replace('{{reason}}', en.run.compactingReasonUnknown)
    )
    apply({ state: 'busy' })
    expect(compactRow()).toBeNull()
  })
})
