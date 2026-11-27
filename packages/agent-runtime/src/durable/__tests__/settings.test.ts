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
  SHUVIX_STREAM_OPTIONS,
  type LiveModelContextWindow,
  type ShuviXSettingsOverrides
} from '../settings'
import { answer, fauxKit, held, modelError } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { callAgent, hostD } from './support/spawn'
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
    expect(await withTimeout(result, 5000, 'submit')).toEqual({ cutShort: 'aborted' })

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

describe('ShuviX settings · live spawned windows (P2-03, Q-P2-08 / PIN-08)', () => {
  const window = (settings: HarnessSettings): number[] => [
    settings.compaction!.reserveTokens!,
    settings.compaction!.backgroundTokens!,
    settings.compaction!.keepRecentTokens!
  ]

  it('P2-03-71 the min over the lock window and the live windows', () => {
    expect(
      window(createShuviXSettings({ contextWindow: () => 40000, liveContextWindows: () => [8000] }))
    ).toEqual([2000, 2000, 2000])
    expect(
      window(
        createShuviXSettings({ contextWindow: () => undefined, liveContextWindows: () => [8000] })
      )
    ).toEqual([2000, 2000, 2000])
  })

  it('P2-03-71 unknown live windows are ignored; nothing known → the defaults', () => {
    expect(
      window(
        createShuviXSettings({
          contextWindow: () => 40000,
          liveContextWindows: () => [undefined, Number.NaN, 0]
        })
      )
    ).toEqual([10000, 10000, 10000])
    expect(
      window(createShuviXSettings({ contextWindow: () => undefined, liveContextWindows: () => [] }))
    ).toEqual([32768, 32768, 20000])
  })

  it('P2-03-71 a throwing live source counts as unknown; overrides still win', () => {
    expect(
      window(
        createShuviXSettings({
          contextWindow: () => 40000,
          liveContextWindows: () => {
            throw new Error('boom')
          }
        })
      )
    ).toEqual([10000, 10000, 10000])
    const settings = createShuviXSettings({
      contextWindow: () => 40000,
      liveContextWindows: () => [8000],
      overrides: { compaction: { reserveTokens: 123 } }
    })
    expect(window(settings)).toEqual([123, 2000, 2000])
  })
})

describe('ShuviX settings · per-model compaction overrides (modelOverrides)', () => {
  it('C-01 root 200k + single sub-agent 32k → root stays 32768/32768/20000, sub gets 8000/8000/8000', () => {
    const compaction = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => [{ key: 'p/sub-32k', contextWindow: 32_000 }]
    }).compaction
    expect(compaction).toEqual({
      reserveTokens: 32_768,
      backgroundTokens: 32_768,
      keepRecentTokens: 20_000,
      modelOverrides: {
        'p/sub-32k': {
          reserveTokens: 8000,
          backgroundTokens: 8000,
          keepRecentTokens: 8000
        }
      }
    })
  })

  it('C-02 multiple parallel sub-agents with different windows → each computed independently', () => {
    const compaction = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => [
        { key: 'p/sub-16k', contextWindow: 16_000 },
        { key: 'p/sub-128k', contextWindow: 128_000 },
        { key: 'p/sub-200k', contextWindow: 200_000 }
      ]
    }).compaction
    expect(compaction?.modelOverrides).toEqual({
      'p/sub-16k': { reserveTokens: 4000, backgroundTokens: 4000, keepRecentTokens: 4000 },
      'p/sub-128k': { reserveTokens: 32_000, backgroundTokens: 32_000, keepRecentTokens: 20_000 },
      'p/sub-200k': { reserveTokens: 32_768, backgroundTokens: 32_768, keepRecentTokens: 20_000 }
    })
  })

  it('C-03 unknown root window + 8k sub-agent → root keeps defaults, sub-agent gets 2000/2000/2000', () => {
    const compaction = createShuviXSettings({
      contextWindow: () => undefined,
      liveModelContextWindows: () => [{ key: 'p/sub-8k', contextWindow: 8000 }]
    }).compaction
    expect(compaction).toEqual({
      reserveTokens: 32_768,
      backgroundTokens: 32_768,
      keepRecentTokens: 20_000,
      modelOverrides: {
        'p/sub-8k': { reserveTokens: 2000, backgroundTokens: 2000, keepRecentTokens: 2000 }
      }
    })
  })

  it('C-04 live sub-agent models change dynamically (start → switch → clear)', () => {
    let live: LiveModelContextWindow[] = []
    const settings = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => live
    })
    expect(settings.compaction?.modelOverrides).toBeUndefined()

    live = [{ key: 'p/a', contextWindow: 32_000 }]
    expect(settings.compaction?.modelOverrides).toEqual({
      'p/a': { reserveTokens: 8000, backgroundTokens: 8000, keepRecentTokens: 8000 }
    })

    live = [{ key: 'p/b', contextWindow: 16_000 }]
    expect(settings.compaction?.modelOverrides).toEqual({
      'p/b': { reserveTokens: 4000, backgroundTokens: 4000, keepRecentTokens: 4000 }
    })

    live = []
    expect(settings.compaction?.modelOverrides).toBeUndefined()
  })

  it('C-05 invalid windows and empty key are ignored; all invalid → modelOverrides undefined', () => {
    const invalid: LiveModelContextWindow[] = [
      { key: '', contextWindow: 32_000 },
      { key: 'p/undef', contextWindow: undefined },
      { key: 'p/zero', contextWindow: 0 },
      { key: 'p/neg', contextWindow: -1 },
      { key: 'p/nan', contextWindow: Number.NaN },
      { key: 'p/inf', contextWindow: Number.POSITIVE_INFINITY },
      { key: 'p/ninf', contextWindow: Number.NEGATIVE_INFINITY }
    ]

    const allInvalid = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => invalid
    }).compaction
    expect(allInvalid?.modelOverrides).toBeUndefined()

    const mixed = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => [...invalid, { key: 'p/valid', contextWindow: 32_000 }]
    }).compaction
    expect(mixed?.modelOverrides).toEqual({
      'p/valid': { reserveTokens: 8000, backgroundTokens: 8000, keepRecentTokens: 8000 }
    })
  })

  it('C-06 throwing liveModelContextWindows degrades safely; root and explicit modelOverrides preserved', () => {
    const compaction = createShuviXSettings({
      contextWindow: () => 100_000,
      liveModelContextWindows: () => {
        throw new Error('registry unavailable')
      },
      overrides: {
        compaction: {
          modelOverrides: { 'p/explicit': { reserveTokens: 5000 } }
        }
      }
    }).compaction
    expect(compaction).toEqual({
      reserveTokens: 25_000,
      backgroundTokens: 25_000,
      keepRecentTokens: 20_000,
      modelOverrides: {
        'p/explicit': { reserveTokens: 5000 }
      }
    })
  })

  it('C-07 duplicate model keys produce a single entry without throwing', () => {
    const compaction = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => [
        { key: 'p/dup', contextWindow: 16_000 },
        { key: 'p/dup', contextWindow: 32_000 }
      ]
    }).compaction
    expect(Object.keys(compaction?.modelOverrides ?? {})).toEqual(['p/dup'])
    expect(compaction?.modelOverrides?.['p/dup']).toEqual({
      reserveTokens: 8000,
      backgroundTokens: 8000,
      keepRecentTokens: 8000
    })
  })

  it('C-08 explicit overrides.compaction base fields apply to both root and dynamic modelOverrides', () => {
    const compaction = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => [{ key: 'p/sub-32k', contextWindow: 32_000 }],
      overrides: {
        compaction: { enabled: false, reserveTokens: 1234 }
      }
    }).compaction
    expect(compaction).toEqual({
      enabled: false,
      reserveTokens: 1234,
      backgroundTokens: 32_768,
      keepRecentTokens: 20_000,
      modelOverrides: {
        'p/sub-32k': {
          enabled: false,
          reserveTokens: 1234,
          backgroundTokens: 8000,
          keepRecentTokens: 8000
        }
      }
    })
  })

  it('C-09 explicit overrides.compaction.modelOverrides merge per-key, read live via function, and return isolated copies', () => {
    // 无动态项时保留显式 modelOverrides
    const staticOnly = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => [],
      overrides: {
        compaction: {
          modelOverrides: { 'p/manual': { reserveTokens: 4321 } }
        }
      }
    }).compaction
    expect(staticOnly?.modelOverrides).toEqual({ 'p/manual': { reserveTokens: 4321 } })

    // 有动态项时按 key 字段级合并，显式字段优先，动态字段不丢失；支持函数形式现读
    const manualPolicy = { keepRecentTokens: 1111 }
    let currentOverrides: ShuviXSettingsOverrides | undefined = {
      compaction: {
        modelOverrides: {
          'p/sub-32k': manualPolicy,
          'p/other': { reserveTokens: 9999 }
        }
      }
    }
    const settings = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => [{ key: 'p/sub-32k', contextWindow: 32_000 }],
      overrides: () => currentOverrides
    })
    const first = settings.compaction!
    expect(first.modelOverrides).toEqual({
      'p/sub-32k': {
        reserveTokens: 8000,
        backgroundTokens: 8000,
        keepRecentTokens: 1111
      },
      'p/other': { reserveTokens: 9999 }
    })

    // 返回值为浅拷贝：修改返回值不污染入参也不影响后续读取
    ;(first.modelOverrides!['p/sub-32k'] as { keepRecentTokens?: number }).keepRecentTokens = 7777
    ;(first.modelOverrides!['p/other'] as { reserveTokens?: number }).reserveTokens = 5555
    expect(manualPolicy.keepRecentTokens).toBe(1111)
    expect(settings.compaction?.modelOverrides?.['p/sub-32k']?.keepRecentTokens).toBe(1111)
    expect(settings.compaction?.modelOverrides?.['p/other']?.reserveTokens).toBe(9999)

    // 函数形式现读
    currentOverrides = {
      compaction: {
        modelOverrides: { 'p/sub-32k': { reserveTokens: 2222 } }
      }
    }
    expect(settings.compaction?.modelOverrides).toEqual({
      'p/sub-32k': {
        reserveTokens: 2222,
        backgroundTokens: 8000,
        keepRecentTokens: 8000
      }
    })
  })

  it('C-10 liveModelContextWindows takes precedence over legacy liveContextWindows; legacy still works alone', () => {
    const both = createShuviXSettings({
      contextWindow: () => 200_000,
      liveModelContextWindows: () => [{ key: 'p/sub-32k', contextWindow: 32_000 }],
      liveContextWindows: () => [8000]
    }).compaction
    expect(both).toEqual({
      reserveTokens: 32_768,
      backgroundTokens: 32_768,
      keepRecentTokens: 20_000,
      modelOverrides: {
        'p/sub-32k': { reserveTokens: 8000, backgroundTokens: 8000, keepRecentTokens: 8000 }
      }
    })

    const legacyOnly = createShuviXSettings({
      contextWindow: () => 200_000,
      liveContextWindows: () => [8000]
    }).compaction
    expect(legacyOnly).toEqual({
      reserveTokens: 2000,
      backgroundTokens: 2000,
      keepRecentTokens: 2000
    })
    expect(legacyOnly?.modelOverrides).toBeUndefined()
  })

  it('C-11 makeHost multi-model integration: live sub-agent populates modelOverrides and clears after completion', async () => {
    const d = await hostD({
      host: {
        makeKit: () =>
          fauxKit({
            models: [
              { id: 'faux-1', contextWindow: 200_000 },
              { id: 'sub-32k', contextWindow: 32_000 }
            ]
          }),
        resolveProfileModel: (spec) =>
          spec === 'spec:faux-2' ? { provider: 'faux', modelId: 'sub-32k' } : null,
        settingsOverrides: { retry: { enabled: false } }
      }
    })

    expect(d.session.effectiveSettings.compaction).toEqual({
      reserveTokens: 32_768,
      backgroundTokens: 32_768,
      keepRecentTokens: 20_000
    })

    const step = held(answer('found'))
    d.t.kit.queue(callAgent('modeled', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached

    expect(d.session.effectiveSettings.compaction).toEqual({
      reserveTokens: 32_768,
      backgroundTokens: 32_768,
      keepRecentTokens: 20_000,
      modelOverrides: {
        'faux/sub-32k': {
          reserveTokens: 8000,
          backgroundTokens: 8000,
          keepRecentTokens: 8000
        }
      }
    })

    step.release()
    expect(await withTimeout(sent, 5000, 'root')).toEqual({})
    expect(d.session.effectiveSettings.compaction).toEqual({
      reserveTokens: 32_768,
      backgroundTokens: 32_768,
      keepRecentTokens: 20_000
    })
  })
})
