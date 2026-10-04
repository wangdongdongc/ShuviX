/**
 * ShuviX 的 HarnessSettings（裁决 Q2 / R6 / PIN-1）：显式的重试 / 请求 / 压缩策略，压缩余量与保留的
 * 近期上下文随根对话的窗口现算（reserve = min(32768, ⌊窗口/4⌋)，keepRecent = min(20000, ⌊窗口/4⌋)），
 * 未知窗口一律 32768 / 20000；同步 getter；覆盖逐段合并。后两组用例把它接到真 Harness 上，
 * 证明请求选项与持久化重试确实生效。
 */
import {
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_RETRY_POLICY,
  LiveDoc,
  type HarnessSettings
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import {
  compactionKeepRecentTokens,
  compactionReserveTokens,
  createShuviXSettings,
  SHUVIX_RETRY_POLICY,
  SHUVIX_STREAM_OPTIONS
} from '../settings'
import { answer, modelError } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { waitFor, withTimeout } from './support/wait'

registerHostCleanup()

describe('ShuviX settings', () => {
  it('S-01 defaults are explicit and differ from durable defaults where intended', () => {
    const settings = createShuviXSettings()
    expect(settings.retry).toEqual({ enabled: true, maxRetries: 10 })
    expect(settings.retry?.baseDelayMs).toBeUndefined()
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(2000)
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3)
    expect(settings.retry?.maxRetries).not.toBe(DEFAULT_RETRY_POLICY.maxRetries)
    expect(settings.stream).toEqual({ timeoutMs: 600000, maxRetries: 0 })
    expect(settings.compaction?.keepRecentTokens).toBe(20000)
    expect(DEFAULT_COMPACTION_POLICY.reserveTokens).toBe(16384)
    expect(settings.compaction?.reserveTokens).not.toBe(DEFAULT_COMPACTION_POLICY.reserveTokens)
    expect(settings.steeringMode).toBe('all')
    expect(settings.followUpMode).toBe('all')
  })

  it.each([
    [200000, 32768, 20000],
    [131072, 32768, 20000],
    [131071, 32767, 20000],
    [128000, 32000, 20000],
    [100000, 25000, 20000],
    [8192, 2048, 2048],
    [3000, 750, 750],
    [1001, 250, 250],
    [1, 0, 0]
  ])('S-02 window %i → reserve = background = %i, keepRecent %i', (window, expected, keep) => {
    expect(compactionReserveTokens(window)).toBe(expected)
    const compaction = createShuviXSettings({ contextWindow: () => window }).compaction
    expect(compaction?.reserveTokens).toBe(expected)
    expect(compaction?.backgroundTokens).toBe(expected)
    expect(compaction?.keepRecentTokens).toBe(keep)
  })

  it.each([
    [16000, 4000],
    [32000, 8000],
    [80000, 20000],
    [200000, 20000]
  ])('S-02b keepRecent scales with the window (PIN-1): %i → %i', (window, expected) => {
    expect(compactionKeepRecentTokens(window)).toBe(expected)
    expect(createShuviXSettings({ contextWindow: () => window }).compaction?.keepRecentTokens).toBe(
      expected
    )
  })

  it.each([undefined, 0, -1, -100000, Number.NaN, Number.POSITIVE_INFINITY])(
    'S-03 unknown window %s → reserve 32768, keepRecent 20000',
    (window) => {
      expect(compactionKeepRecentTokens(window)).toBe(20000)
      const compaction = createShuviXSettings({ contextWindow: () => window }).compaction
      expect(compaction?.reserveTokens).toBe(32768)
      expect(compaction?.backgroundTokens).toBe(32768)
      expect(compaction?.keepRecentTokens).toBe(20000)
    }
  )

  it('S-03b an override still wins over the scaled keepRecent', () => {
    const compaction = createShuviXSettings({
      contextWindow: () => 16000,
      overrides: { compaction: { keepRecentTokens: 100 } }
    }).compaction
    expect(compaction?.keepRecentTokens).toBe(100)
    expect(compaction?.reserveTokens).toBe(4000)
  })

  it('S-03 no window source at all → 32768', () => {
    expect(createShuviXSettings().compaction?.reserveTokens).toBe(32768)
  })

  it('S-04 the window is read live, and two settings over different sources are independent', () => {
    let window = 100000
    const settings = createShuviXSettings({ contextWindow: () => window })
    const other = createShuviXSettings({ contextWindow: () => 3000 })
    expect(settings.compaction?.reserveTokens).toBe(25000)
    window = 8192
    expect(settings.compaction?.reserveTokens).toBe(2048)
    expect(other.compaction?.reserveTokens).toBe(750)
  })

  it('S-05 getters are synchronous and a throwing source counts as unknown', () => {
    const settings = createShuviXSettings({
      contextWindow: () => {
        throw new Error('lock unreadable')
      }
    })
    const compaction = settings.compaction
    expect(compaction).not.toBeInstanceOf(Promise)
    expect(compaction?.reserveTokens).toBe(32768)
    const descriptor = Object.getOwnPropertyDescriptor(settings, 'compaction')
    expect(typeof descriptor?.get).toBe('function')
  })

  it('S-06 overrides merge per section without leaking into fresh defaults', () => {
    const settings = createShuviXSettings({
      overrides: { retry: { enabled: false }, compaction: { enabled: false } }
    })
    expect(settings.retry).toEqual({ enabled: false, maxRetries: 10 })
    expect(settings.compaction).toMatchObject({
      enabled: false,
      keepRecentTokens: 20000,
      reserveTokens: 32768
    })
    expect(settings.stream).toEqual({ timeoutMs: 600000, maxRetries: 0 })
    expect(settings.followUpMode).toBe('all')
    // 没有泄漏回默认值
    const fresh = createShuviXSettings()
    expect(fresh.retry).toEqual({ enabled: true, maxRetries: 10 })
    expect(fresh.compaction?.enabled).toBeUndefined()
    expect(SHUVIX_RETRY_POLICY).toEqual({ enabled: true, maxRetries: 10 })
    expect(SHUVIX_STREAM_OPTIONS).toEqual({ timeoutMs: 600000, maxRetries: 0 })
  })

  it('S-06 a returned section is a copy: mutating it changes nothing', () => {
    const settings: HarnessSettings = createShuviXSettings()
    const retry = settings.retry as { maxRetries: number }
    retry.maxRetries = 99
    expect(settings.retry?.maxRetries).toBe(10)
    expect(createShuviXSettings().retry?.maxRetries).toBe(10)
  })
})

describe('ShuviX settings wired into a Harness', () => {
  it('S-07 every request carries timeoutMs 600000 and maxRetries 0', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(answer('hi'))
    expect(await session.submitUser('hello')).toEqual({})
    expect(t.kit.requests).toHaveLength(1)
    expect(t.kit.requests[0]!.options).toMatchObject({ timeoutMs: 600000, maxRetries: 0 })
  })

  it('S-08 a retryable error schedules a durable retry ~2s out; retry disabled → model_error', async () => {
    const t = await makeHost({ settingsOverrides: { compaction: { enabled: false } } })
    const session = await t.open()
    await primeRoot(session, t.kit)
    t.kit.queue(modelError('overloaded'))
    const result = session.submitUser('hello')
    const conversation = await session.currentConversation()
    let at: number | undefined
    await waitFor(async () => {
      const live = await session.harness.snapshot(LiveDoc, conversation.id, BG)
      at = live?.generation?.retry?.at
      return at !== undefined
    })
    const delay = at! - Date.now()
    expect(delay).toBeGreaterThanOrEqual(1500)
    expect(delay).toBeLessThanOrEqual(2100)
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await withTimeout(result, 5000, 'submit')).toEqual({})

    const off = await makeHost()
    const other = await off.open()
    await primeRoot(other, off.kit)
    off.kit.queue(modelError('overloaded'))
    expect(await other.submitUser('hello')).toEqual({ error: 'overloaded', code: 'model_error' })
    const live = await other.harness.snapshot(LiveDoc, conversation.id, BG)
    expect(live?.generation).toBeUndefined()
    expect(off.kit.callCount).toBe(1)
  })

  it('S-09 maxRetries 10 → exactly 11 requests, then model_error', async () => {
    const t = await makeHost({
      settingsOverrides: { compaction: { enabled: false }, retry: { baseDelayMs: 1 } }
    })
    const session = await t.open()
    await primeRoot(session, t.kit)
    for (let i = 0; i < 12; i++) t.kit.queue(modelError('overloaded'))
    const result = await withTimeout(session.submitUser('hello'), 10000, 'retries')
    expect(result).toEqual({ error: 'overloaded', code: 'model_error' })
    expect(t.kit.callCount).toBe(11)
  })
})
