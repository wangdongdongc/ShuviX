/**
 * AgentRuntimeRegistry 的缓存用量累计与上下文占用 —— 事件影子里「读 usage」的那一段。
 *
 * 契约（注册中心 + chat-protocol `AgentMonitorCacheUsage`）：
 *  - **累计与最近一次**：每个登记的运行时（root / spawned 一视同仁）从登记起累计
 *    `calls / input / cacheRead / cacheWrite`，并记住最近一次**计入**调用的三项 `last`；
 *    命中率按 token 加权（cacheRead / 三项之和），由调用方用 `cacheHitRate` 算。
 *  - **不计入的调用**：`stopReason` 为 aborted / error；零内容空回复（判定表在
 *    `harness/__tests__/zeroContent.test.ts`，这里只钉接线）。它们既不进缓存累计，也不改写
 *    上下文占用 —— 两份读数跳过同一批消息。
 *  - **reported**：任一次计入的调用里 cacheRead 或 cacheWrite > 0 即置真，之后不再回落；
 *    被排除的调用里的非 0 缓存不能把它置真。
 *  - **运行时边界**：重新登记（同 id 的运行时重建）从零开始；注销后退订；快照是副本。
 *  - **监控不外溢**：归约里抛出的任何错误都不能从 harness 的订阅回调里冒出去
 *    （pi 会把它 rethrow 成 hook error，打断这一轮）。
 *
 * 不用单例 `agentRuntimeRegistry`：每条用例一个新实例，用例之间不串状态。
 * harness 是最小的假对象 —— 注册中心只用到 subscribe 与快照里的几个 getter。
 *
 *   R-1 ~ R-8    初值与计入（累计、last、加权、缺字段、stopReason 表）
 *   R-9 ~ R-12   reported 的单调性
 *   R-13 ~ R-19  不计入的调用 + 上下文占用跟着跳过
 *   R-20 ~ R-24  运行时边界与隔离（root / spawned、重建、注销、快照副本、list = get）
 *   R-25 ~ R-26  健壮性（usage 访问抛错、content 里混进 null）
 */
import { describe, expect, it } from 'vitest'
import type { AgentHarness, Session } from '@earendil-works/pi-agent-core'
import type { Usage } from '@earendil-works/pi-ai'
import { cacheHitRate } from '@shuvix/chat-protocol/utils/cacheHitRate'
import {
  AgentRuntimeRegistry,
  type AgentRuntimeCacheUsage,
  type AgentRuntimeIdentity
} from '../runtimeRegistry'

// ─────────────────────────────────────────────────────────────────────────
// 夹具

interface FakeHarness {
  subscribe: (fn: (e: unknown) => void) => () => void
  emit: (e: unknown) => void
  listenerCount: () => number
  getModel: () => { provider: string; id: string; contextWindow: number }
  getThinkingLevel: () => string
  getTools: () => unknown[]
  getActiveTools: () => unknown[]
}

function fakeHarness(): FakeHarness {
  const listeners = new Set<(e: unknown) => void>()
  return {
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    emit: (e) => {
      for (const fn of [...listeners]) fn(e)
    },
    listenerCount: () => listeners.size,
    getModel: () => ({ provider: 'p', id: 'm', contextWindow: 200_000 }),
    getThinkingLevel: () => 'off',
    getTools: () => [],
    getActiveTools: () => []
  }
}

const ROOT: AgentRuntimeIdentity = {
  agentId: 'a',
  kind: 'root',
  rootSessionId: 'a',
  depth: 0,
  profileName: 'chat',
  displayName: 'chat'
}

type UsageInput = Partial<Omit<Usage, 'cost'>>

/** 补全成完整的 pi `Usage`（output / cost 置 0；totalTokens 缺省 0 → pi 回落成四项之和） */
const usageOf = (u: UsageInput): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  ...u,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

/** 一条 assistant 消息（pi 把 usage 挂在它上面） */
function assistant({
  content = [{ type: 'text', text: 'ok' }],
  stopReason = 'stop',
  usage = {}
}: {
  content?: unknown
  stopReason?: string
  usage?: UsageInput
} = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    stopReason,
    usage: usageOf(usage),
    timestamp: Date.now()
  }
}

const messageEnd = (message: unknown): { type: string; message: unknown } => ({
  type: 'message_end',
  message
})

/** 新注册中心 + 一个登记好的运行时 */
function setup(identity: AgentRuntimeIdentity = ROOT): {
  registry: AgentRuntimeRegistry
  harness: FakeHarness
  /** 发一条 assistant 调用 */
  call: (opts?: Parameters<typeof assistant>[0]) => void
  snap: () => NonNullable<ReturnType<AgentRuntimeRegistry['get']>>
} {
  const registry = new AgentRuntimeRegistry()
  const harness = fakeHarness()
  registry.register(identity, harness as unknown as AgentHarness, {} as Session)
  return {
    registry,
    harness,
    call: (opts) => harness.emit(messageEnd(assistant(opts))),
    snap: () => {
      const s = registry.get(identity.agentId)
      if (!s) throw new Error(`no entry for ${identity.agentId}`)
      return s
    }
  }
}

const EMPTY_CACHE = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, reported: false }

// ─────────────────────────────────────────────────────────────────────────

describe('AgentRuntimeRegistry 缓存累计：初值与计入', () => {
  it('R-1 刚登记：cache 全 0、reported false、没有 last；contextTokens 为 0', () => {
    const { snap } = setup()
    const s = snap()
    expect(s.cache).toEqual(EMPTY_CACHE)
    // 契约是「calls 为 0 时缺席」：值为 undefined（key 在不在是实现细节）
    expect(s.cache.last).toBeUndefined()
    expect(s.contextTokens).toBe(0)
  })

  it('R-2 一次计入：三项累计 = 这一次，last = 这一次，reported 置真', () => {
    const { call, snap } = setup()
    call({ usage: { input: 100, cacheRead: 300, cacheWrite: 0 } })
    expect(snap().cache).toEqual({
      calls: 1,
      input: 100,
      cacheRead: 300,
      cacheWrite: 0,
      reported: true,
      last: { input: 100, cacheRead: 300, cacheWrite: 0 }
    })
  })

  it('R-3 三次计入：各项求和，命中率按 token 加权（不是每次比例取平均）', () => {
    const { call, snap } = setup()
    call({ usage: { input: 100 } })
    call({ usage: { input: 100, cacheRead: 900 } })
    call({ usage: { input: 50, cacheRead: 50, cacheWrite: 10 } })
    const cache = snap().cache
    expect(cache).toMatchObject({ calls: 3, input: 250, cacheRead: 950, cacheWrite: 10 })
    expect(cache.last).toEqual({ input: 50, cacheRead: 50, cacheWrite: 10 })

    const rate = cacheHitRate(cache)
    expect(rate).toBeCloseTo(950 / 1210)
    // 每次比例取平均：(0 + 0.9 + 50/110) / 3 ≈ 0.45 —— 必须与加权值分得开
    const meanOfRatios = (0 + 0.9 + 50 / 110) / 3
    expect(Math.abs((rate ?? 0) - meanOfRatios)).toBeGreaterThan(0.1)
  })

  it('R-4 last 只保留最近一次：不是累计值，也不是第一次', () => {
    const { call, snap } = setup()
    call({ usage: { input: 100 } })
    call({ usage: { input: 100, cacheRead: 900 } })
    call({ usage: { input: 50, cacheRead: 50, cacheWrite: 10 } })
    const last = snap().cache.last
    expect(last).toEqual({ input: 50, cacheRead: 50, cacheWrite: 10 })
    expect(last).not.toEqual({ input: 250, cacheRead: 950, cacheWrite: 10 })
    expect(last).not.toEqual({ input: 100, cacheRead: 0, cacheWrite: 0 })
  })

  it('R-5 只有 input、从不带缓存：计入但 reported 仍为 false', () => {
    const { call, snap } = setup()
    call({ usage: { input: 40 } })
    call({ usage: { input: 60 } })
    const cache = snap().cache
    expect(cache).toMatchObject({ calls: 2, input: 100, cacheRead: 0, cacheWrite: 0 })
    // 算术本身是 0，UI 要靠 reported 把它门成「未上报」
    expect(cache.reported).toBe(false)
  })

  it('R-6 usage 四项全 0（provider 没发 usage 块）：仍计一次，reported false，命中率 null', () => {
    const { call, snap } = setup()
    call({ usage: {} })
    const s = snap()
    expect(s.cache.calls).toBe(1)
    expect(s.cache.last).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0 })
    expect(s.cache.reported).toBe(false)
    expect(cacheHitRate(s.cache)).toBeNull()
  })

  it('R-7 usage 缺缓存字段：按 0 计，累计仍是有限数', () => {
    const { harness, call, snap } = setup()
    call({ usage: { input: 5, cacheRead: 20 } })
    // 缺字段的 usage：绕过 usageOf 的补全，直接挂一个不完整的对象
    harness.emit(
      messageEnd({ ...assistant(), usage: { input: 10, output: 1 } as unknown as Usage })
    )
    const cache = snap().cache
    expect(cache.calls).toBe(2)
    expect(cache.last).toEqual({ input: 10, cacheRead: 0, cacheWrite: 0 })
    expect(cache.input).toBe(15)
    expect(cache.cacheRead).toBe(20)
    expect(cache.cacheWrite).toBe(0)
    for (const n of [cache.input, cache.cacheRead, cache.cacheWrite]) {
      expect(Number.isFinite(n)).toBe(true)
    }
    // reported 由第一次（cacheRead 20）置真；缺字段那次不能把它弄成 NaN / 回落
    expect(cache.reported).toBe(true)
  })

  it('R-7b 只有缺字段的调用：cacheRead / cacheWrite 为 0，reported false', () => {
    const { harness, snap } = setup()
    harness.emit(
      messageEnd({ ...assistant(), usage: { input: 10, output: 1 } as unknown as Usage })
    )
    expect(snap().cache).toEqual({
      calls: 1,
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      reported: false,
      last: { input: 10, cacheRead: 0, cacheWrite: 0 }
    })
  })

  it('R-8 stopReason 表：stop / toolUse / length 都计入（只排除 aborted / error）', () => {
    const { call, snap } = setup()
    for (const stopReason of ['stop', 'toolUse', 'length']) {
      call({ stopReason, usage: { input: 10, cacheRead: 30 } })
    }
    expect(snap().cache).toMatchObject({ calls: 3, input: 30, cacheRead: 90, reported: true })
  })
})

describe('AgentRuntimeRegistry 缓存累计：reported 的单调性', () => {
  it('R-9 只有写入没有命中：reported 置真（Anthropic 首次调用的形状）', () => {
    const { call, snap } = setup()
    call({ usage: { input: 100, cacheWrite: 50 } })
    expect(snap().cache.reported).toBe(true)
  })

  it('R-10 置真之后来一次缓存全 0 的调用：reported 不回落，last 是那次全 0', () => {
    const { call, snap } = setup()
    call({ usage: { cacheRead: 10 } })
    call({ usage: { input: 100 } })
    const cache = snap().cache
    expect(cache.reported).toBe(true)
    expect(cache.calls).toBe(2)
    expect(cache.last).toEqual({ input: 100, cacheRead: 0, cacheWrite: 0 })
  })

  it('R-11 置真之后来被排除的调用（中止、零内容）：reported 不变，last 不被改写', () => {
    const { call, snap } = setup()
    call({ usage: { input: 30, cacheRead: 70 } })
    const before = snap().cache
    call({ stopReason: 'aborted', usage: { input: 5 } })
    call({ content: [{ type: 'text', text: '' }], usage: { input: 6 } })
    const after = snap().cache
    expect(after.reported).toBe(true)
    expect(after.last).toEqual({ input: 30, cacheRead: 70, cacheWrite: 0 })
    expect(after).toEqual(before)
  })

  it('R-12 被排除的调用里的非 0 缓存不能把 reported 置真', () => {
    const { call, snap } = setup()
    call({ usage: { input: 100 } })
    call({
      stopReason: 'aborted',
      content: [{ type: 'text', text: 'partial' }],
      usage: { input: 1, cacheRead: 500 }
    })
    call({ stopReason: 'error', usage: { input: 1, cacheWrite: 400 } })
    call({ content: [], usage: { input: 1, cacheRead: 300 } })
    call({ usage: { input: 50 } })
    const cache = snap().cache
    expect(cache.reported).toBe(false)
    expect(cache).toMatchObject({ calls: 2, input: 150, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('AgentRuntimeRegistry 缓存累计：不计入的调用与上下文占用', () => {
  /** 每条用例先铺的正常调用 P（上下文 1210） */
  const P: UsageInput = {
    input: 1000,
    output: 10,
    cacheRead: 200,
    cacheWrite: 0,
    totalTokens: 1210
  }

  /** 铺好 P，返回之后比对用的 before 快照 */
  function withP(): ReturnType<typeof setup> & {
    before: ReturnType<ReturnType<typeof setup>['snap']>
  } {
    const ctx = setup()
    ctx.call({ usage: P })
    const before = ctx.snap()
    expect(before.contextTokens).toBe(1210)
    expect(before.cache.calls).toBe(1)
    return { ...ctx, before }
  }

  it('R-13 中止（content 非空）：不计入，上下文占用不变 —— 靠的是 stopReason 门', () => {
    const { call, snap, before } = withP()
    call({
      stopReason: 'aborted',
      content: [{ type: 'text', text: 'partial' }],
      usage: { input: 20, output: 3, cacheRead: 999, totalTokens: 50 }
    })
    const after = snap()
    expect(after.cache).toEqual(before.cache)
    expect(after.contextTokens).toBe(1210)
  })

  it('R-14 出错（content 非空）：不计入，上下文占用不变', () => {
    const { call, snap, before } = withP()
    call({
      stopReason: 'error',
      content: [{ type: 'text', text: 'partial' }],
      usage: { input: 20, output: 3, cacheRead: 999, totalTokens: 50 }
    })
    const after = snap()
    expect(after.cache).toEqual(before.cache)
    expect(after.contextTokens).toBe(1210)
  })

  it('R-15 零内容空回复（stop）：不计入，上下文占用仍为 1210 而不是缩水到 51', () => {
    const { call, snap, before } = withP()
    call({
      content: [{ type: 'text', text: '' }],
      usage: { input: 50, output: 1, cacheRead: 0, totalTokens: 51 }
    })
    const after = snap()
    expect(after.cache).toEqual(before.cache)
    expect(after.cache.last).toEqual({ input: 1000, cacheRead: 200, cacheWrite: 0 })
    expect(after.contextTokens).toBe(1210)
  })

  it.each<[string, unknown]>([
    ['空字符串', ''],
    ['空白字符串', '  \n'],
    ['空数组（真实空回复的形状）', []],
    ['空白 text', [{ type: 'text', text: '   ' }]],
    ['空 thinking', [{ type: 'thinking', thinking: '' }]],
    ['空白 thinking', [{ type: 'thinking', thinking: ' \n' }]],
    [
      '空 text + 空白 thinking',
      [
        { type: 'text', text: '' },
        { type: 'thinking', thinking: '  ' }
      ]
    ]
  ])('R-16 零内容的形状「%s」：不计入，上下文占用不变', (_label, content) => {
    const { call, snap, before } = withP()
    call({ content, usage: { input: 50, output: 1, cacheRead: 7, totalTokens: 51 } })
    const after = snap()
    expect(after.cache).toEqual(before.cache)
    expect(after.contextTokens).toBe(1210)
  })

  it.each<[string, unknown]>([
    [
      '空 text + toolCall',
      [
        { type: 'text', text: '' },
        { type: 'toolCall', id: 't', name: 'ls', arguments: {} }
      ]
    ],
    ['image', [{ type: 'image', data: 'x', mimeType: 'image/png' }]],
    ['只有非空 thinking', [{ type: 'thinking', thinking: 'plan' }]],
    [
      '空 thinking + 非空 text',
      [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'x' }
      ]
    ],
    ['未知块类型', [{ type: 'mystery' }]]
  ])('R-17 有内容的对照组「%s」：计入，上下文占用更新成这一条', (_label, content) => {
    const { call, snap, before } = withP()
    call({ content, usage: { input: 1400, output: 20, cacheRead: 80, totalTokens: 1500 } })
    const after = snap()
    expect(after.cache.calls).toBe(before.cache.calls + 1)
    expect(after.cache.last).toEqual({ input: 1400, cacheRead: 80, cacheWrite: 0 })
    expect(after.contextTokens).toBe(1500)
  })

  it('R-18 排除之后的恢复：零内容之后的正常调用照常计入，上下文占用跟上', () => {
    const { call, snap } = withP()
    call({
      content: [{ type: 'text', text: '' }],
      usage: { input: 50, output: 1, totalTokens: 51 }
    })
    call({ usage: { input: 800, output: 0, cacheRead: 500, totalTokens: 1300 } })
    const after = snap()
    expect(after.cache.calls).toBe(2)
    expect(after.cache.last).toEqual({ input: 800, cacheRead: 500, cacheWrite: 0 })
    expect(after.cache).toMatchObject({ input: 1800, cacheRead: 700 })
    expect(after.contextTokens).toBe(1300)
  })

  it('R-19 没有 usage 的 message_end（user / toolResult / message 缺失）：不计入、不抛', () => {
    const { harness, snap } = setup()
    expect(() => {
      harness.emit(messageEnd({ role: 'user', content: 'hi', timestamp: Date.now() }))
      harness.emit(
        messageEnd({
          role: 'toolResult',
          toolCallId: 't',
          toolName: 'ls',
          content: [{ type: 'text', text: 'out' }],
          isError: false,
          timestamp: Date.now()
        })
      )
      harness.emit(messageEnd(undefined))
      harness.emit({ type: 'message_end' })
    }).not.toThrow()
    const s = snap()
    expect(s.cache).toEqual(EMPTY_CACHE)
    expect(s.contextTokens).toBe(0)
  })
})

describe('AgentRuntimeRegistry 缓存累计：运行时边界与隔离', () => {
  it('R-20 root 与 spawned 各算各的，spawned 同样累计', () => {
    const registry = new AgentRuntimeRegistry()
    const a = fakeHarness()
    const b = fakeHarness()
    registry.register(ROOT, a as unknown as AgentHarness, {} as Session)
    registry.register(
      { ...ROOT, agentId: 'child', kind: 'spawned', parentAgentId: 'a', depth: 1 },
      b as unknown as AgentHarness,
      {} as Session
    )

    a.emit(messageEnd(assistant({ usage: { input: 200, cacheRead: 150 } })))
    expect(registry.get('child')!.cache).toEqual(EMPTY_CACHE)

    b.emit(messageEnd(assistant({ usage: { input: 100, cacheWrite: 30 } })))
    b.emit(messageEnd(assistant({ usage: { input: 40 } })))

    expect(registry.get('a')!.cache).toEqual({
      calls: 1,
      input: 200,
      cacheRead: 150,
      cacheWrite: 0,
      reported: true,
      last: { input: 200, cacheRead: 150, cacheWrite: 0 }
    })
    expect(registry.get('child')!.cache).toEqual({
      calls: 2,
      input: 140,
      cacheRead: 0,
      cacheWrite: 30,
      reported: true,
      last: { input: 40, cacheRead: 0, cacheWrite: 0 }
    })
  })

  it('R-21 同 id 重新登记（运行时重建）：从初值开始，旧 harness 已退订，新 harness 正常计入', () => {
    const { registry, harness: old, call } = setup()
    call({ usage: { input: 100, cacheRead: 300 } })
    expect(registry.get('a')!.cache.calls).toBe(1)

    const fresh = fakeHarness()
    registry.register(ROOT, fresh as unknown as AgentHarness, {} as Session)
    const s = registry.get('a')!
    expect(s.cache).toEqual(EMPTY_CACHE)
    expect(s.cache.last).toBeUndefined()
    expect(s.contextTokens).toBe(0)
    expect(old.listenerCount()).toBe(0)

    old.emit(messageEnd(assistant({ usage: { input: 999, cacheRead: 999 } })))
    expect(registry.get('a')!.cache).toEqual(EMPTY_CACHE)

    fresh.emit(messageEnd(assistant({ usage: { input: 10, cacheWrite: 5 } })))
    expect(registry.get('a')!.cache).toMatchObject({
      calls: 1,
      input: 10,
      cacheWrite: 5,
      reported: true
    })
  })

  it('R-22 注销之后：get 为 undefined、list 里没有它，harness 已退订', () => {
    const { registry, harness, call } = setup()
    call({ usage: { input: 100 } })
    registry.unregister('a')
    expect(registry.get('a')).toBeUndefined()
    expect(registry.list().some((s) => s.agentId === 'a')).toBe(false)
    expect(harness.listenerCount()).toBe(0)
  })

  it('R-23 快照是副本：改快照不影响注册中心，新事件也不改旧快照（last 是深拷贝）', () => {
    const { call, snap } = setup()
    call({ usage: { input: 100, cacheRead: 300 } })

    const s1 = snap()
    s1.cache.calls = 99
    s1.cache.last!.input = 99
    const s1Frozen = JSON.parse(JSON.stringify(s1)) as typeof s1

    call({ usage: { input: 20, cacheRead: 30, cacheWrite: 1 } })
    const s2 = snap()
    expect(s2.cache).toEqual({
      calls: 2,
      input: 120,
      cacheRead: 330,
      cacheWrite: 1,
      reported: true,
      last: { input: 20, cacheRead: 30, cacheWrite: 1 }
    })
    // 旧快照不是活视图：新事件之后它还是被改过的那份，一个字段都没被刷新
    expect(s1).toEqual(s1Frozen)
    expect(s1.cache.last).toEqual({ input: 99, cacheRead: 300, cacheWrite: 0 })
  })

  it('R-23b 未改动的旧快照同样不随新事件变化', () => {
    const { call, snap } = setup()
    call({ usage: { input: 100, cacheRead: 300 } })
    const s0 = snap()
    const s0Copy = JSON.parse(JSON.stringify(s0)) as typeof s0
    call({ usage: { input: 1, cacheRead: 1 } })
    expect(s0.cache).toEqual(s0Copy.cache)
    expect(s0.contextTokens).toBe(s0Copy.contextTokens)
  })

  it('R-24 list() 与 get() 给出的 cache 一致', () => {
    const { registry, call } = setup()
    call({ usage: { input: 100, cacheRead: 300 } })
    call({ usage: { input: 5, cacheWrite: 7 } })
    const fromList = registry.list().find((s) => s.agentId === 'a')
    expect(fromList).toBeDefined()
    const cache: AgentRuntimeCacheUsage = registry.get('a')!.cache
    expect(fromList!.cache).toEqual(cache)
    expect(fromList!.contextTokens).toBe(registry.get('a')!.contextTokens)
  })
})

describe('AgentRuntimeRegistry 缓存累计：监控绝不外溢', () => {
  it('R-25 访问 usage 就抛错的消息：emit 不抛，之后的正常调用照常计入', () => {
    const { harness, call, snap } = setup()
    const bad = assistant()
    Object.defineProperty(bad, 'usage', {
      get() {
        throw new Error('boom')
      }
    })
    expect(() => harness.emit(messageEnd(bad))).not.toThrow()

    call({ usage: { input: 10, cacheRead: 30, totalTokens: 45 } })
    const s = snap()
    expect(s.cache).toMatchObject({ calls: 1, input: 10, cacheRead: 30, reported: true })
    expect(s.contextTokens).toBe(45)
  })

  it('R-26 content 里混进 null 块：emit 不抛，之后的正常调用照常计入', () => {
    const { harness, call, snap } = setup()
    expect(() =>
      harness.emit(messageEnd(assistant({ content: [null], usage: { input: 10, cacheRead: 5 } })))
    ).not.toThrow()
    const callsAfterBad = snap().cache.calls

    call({ usage: { input: 20, cacheRead: 40, totalTokens: 70 } })
    const s = snap()
    // null 块那次算不算是实现细节，不钉；只钉之后的调用照常 +1、last 是它
    expect(s.cache.calls).toBe(callsAfterBad + 1)
    expect(s.cache.last).toEqual({ input: 20, cacheRead: 40, cacheWrite: 0 })
    expect(s.contextTokens).toBe(70)
  })
})
