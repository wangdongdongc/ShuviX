/**
 * Prompt Cache 后台保活 + 自定义模型借用 + SessionHost 生命周期清理测试：
 *
 *   - CW-M01..04：`resolveCacheWarmingModel` 原样返回、全 0 借用且不修改原对象、部分补齐、前缀短名/大小写/空格/同 api 优先/未命中
 *   - CW-W01..07：`withCacheWarming` 开关关闭、streaming/idle 触发与选项、不调度条件、新请求取消与多对话隔离、
 *                 续期与年龄上限/运行中关闭、失败降级（reject/同步抛错/error/aborted）、dispose 幂等与取消
 *   - CW-H01：`SessionHost` 在 `close` / `delete` / LRU 驱逐时自动 `dispose()` 保活定时器
 */
import {
  CACHE_WARMING_MAX_AGE_MS,
  CACHE_WARMING_MAX_IDLE_AGE_MS,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  getCacheWarmingDelayMs,
  getPromptCacheTtlMs,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions
} from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeLogger } from '../../types'
import { resolveCacheWarmingModel, withCacheWarming } from '../cacheWarmingModels'
import { defaultAgentConfig } from './support/agentConfig'
import { fauxKit } from './support/faux'
import { makeHost, registerHostCleanup } from './support/host'
import { withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000

const EMPTY_CONTEXT: Context = { messages: [] }

function makeModel<TApi extends Api = 'anthropic-messages'>(
  overrides: Partial<Model<TApi>> = {}
): Model<TApi> {
  return {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    api: 'anthropic-messages' as TApi,
    provider: 'custom',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides
  } as Model<TApi>
}

function makeReply(
  stopReason: AssistantMessage['stopReason'] = 'stop',
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'anthropic-messages',
    provider: 'custom',
    model: 'claude-sonnet-4-6',
    usage: {
      input: 500_000,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 500_010,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: Date.now(),
    ...overrides
  }
}

interface FakeTimer {
  id: number
  delayMs: number
  callback: () => void
  cleared: boolean
}

function createFakeTimers(): {
  timers: FakeTimer[]
  activeTimers: () => FakeTimer[]
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
  fire: (timer: FakeTimer) => void
} {
  let seq = 0
  const timers: FakeTimer[] = []
  const setTimer = ((callback: () => void, delayMs = 0) => {
    const entry: FakeTimer = { id: ++seq, delayMs, callback, cleared: false }
    timers.push(entry)
    return entry.id as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  const clearTimer = ((handle: ReturnType<typeof setTimeout>) => {
    const entry = timers.find((t) => t.id === (handle as unknown as number))
    if (entry) entry.cleared = true
  }) as unknown as typeof clearTimeout
  return {
    timers,
    activeTimers: () => timers.filter((t) => !t.cleared),
    setTimer,
    clearTimer,
    fire: (timer: FakeTimer) => {
      if (timer.cleared) throw new Error(`timer ${timer.id} was already cleared`)
      timer.cleared = true
      timer.callback()
    }
  }
}

interface DeferredStream {
  stream: AssistantMessageEventStream
  resolve: (reply: AssistantMessage) => void
  reject: (err: unknown) => void
}

function createDeferredStream(): DeferredStream {
  let resolveFn!: (reply: AssistantMessage) => void
  let rejectFn!: (err: unknown) => void
  const promise = new Promise<AssistantMessage>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  // 挂一个空 catch 防止测试里刻意不 await 时触发 unhandledRejection
  promise.catch(() => undefined)
  const stream = createAssistantMessageEventStream()
  stream.result = () => promise
  return { stream, resolve: resolveFn, reject: rejectFn }
}

function resolvedStream(reply: AssistantMessage): AssistantMessageEventStream {
  const ds = createDeferredStream()
  ds.resolve(reply)
  return ds.stream
}

function rejectedStream(err: unknown): AssistantMessageEventStream {
  const ds = createDeferredStream()
  ds.reject(err)
  return ds.stream
}

async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

interface RecordedCall {
  method: 'stream' | 'streamSimple'
  model: Model<Api>
  context: Context
  options: ModelsSimpleStreamOptions | ModelsApiStreamOptions<Api> | undefined
}

function makeFakeModels(handlers: {
  stream?: (
    model: Model<Api>,
    context: Context,
    options?: ModelsApiStreamOptions<Api>
  ) => AssistantMessageEventStream
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions
  ) => AssistantMessageEventStream
}): { models: Models; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const models = {
    stream: (model: Model<Api>, context: Context, options?: ModelsApiStreamOptions<Api>) => {
      calls.push({ method: 'stream', model, context, options })
      return handlers.stream
        ? handlers.stream(model, context, options)
        : resolvedStream(makeReply())
    },
    streamSimple: (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => {
      calls.push({ method: 'streamSimple', model, context, options })
      return handlers.streamSimple
        ? handlers.streamSimple(model, context, options)
        : resolvedStream(makeReply())
    },
    complete: () => {
      throw new Error('unexpected inner.complete')
    },
    completeSimple: () => {
      throw new Error('unexpected inner.completeSimple')
    }
  } as unknown as Models
  return { models, calls }
}

function makeLogger(): { logger: RuntimeLogger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (msg) => warnings.push(msg),
      error: (msg) => warnings.push(msg)
    }
  }
}

// ─── CW-M01..04：resolveCacheWarmingModel ─────────────────────────────────

describe('CW-M resolveCacheWarmingModel 自定义模型元数据借用', () => {
  it('CW-M01 已有 promptCache 且非零 cost 时原样返回原引用', () => {
    const model = makeModel({
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      promptCache: { short: 600 }
    })
    const resolved = resolveCacheWarmingModel(model)
    expect(resolved).toBe(model)
  })

  it('CW-M02 缺少 promptCache 且 cost 全 0（含 output > 0 但 input/cacheRead/cacheWrite === 0）时借用内置元数据且不修改 Object.freeze 原对象', () => {
    const frozenAllZero = Object.freeze(
      makeModel({
        id: 'claude-sonnet-4-6',
        cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
        promptCache: undefined
      })
    )
    const r1 = resolveCacheWarmingModel(frozenAllZero)
    expect(r1).not.toBe(frozenAllZero)
    expect(r1.promptCache).toBeDefined()
    expect(r1.cost.input).toBeGreaterThan(0)
    expect(frozenAllZero.promptCache).toBeUndefined()
    expect(frozenAllZero.cost.input).toBe(0)

    // output > 0 但 input / cacheRead / cacheWrite 全 0 也视为无缓存成本 → 借用
    const frozenOutputOnly = Object.freeze(
      makeModel({
        id: 'claude-sonnet-4-6',
        cost: Object.freeze({ input: 0, output: 15, cacheRead: 0, cacheWrite: 0 }),
        promptCache: undefined
      })
    )
    const r2 = resolveCacheWarmingModel(frozenOutputOnly)
    expect(r2).not.toBe(frozenOutputOnly)
    expect(r2.promptCache).toBeDefined()
    expect(r2.cost.input).toBeGreaterThan(0)
    expect(frozenOutputOnly.cost.input).toBe(0)
  })

  it('CW-M03 部分缺失时仅补缺失字段（保留已有非零 cost 或已有 promptCache）', () => {
    // 已有非零 cost、缺 promptCache → 只补 promptCache，保留原 cost
    const customCost = { input: 9.9, output: 20, cacheRead: 1.1, cacheWrite: 11 }
    const mNoCache = makeModel({
      id: 'claude-sonnet-4-6',
      cost: customCost,
      promptCache: undefined
    })
    const rNoCache = resolveCacheWarmingModel(mNoCache)
    expect(rNoCache.cost).toBe(customCost)
    expect(rNoCache.promptCache).toBeDefined()

    // 已有 promptCache、cost 全 0 → 只补 cost，保留原 promptCache
    const customCache = { short: 999 }
    const mNoCost = makeModel({
      id: 'claude-sonnet-4-6',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      promptCache: customCache
    })
    const rNoCost = resolveCacheWarmingModel(mNoCost)
    expect(rNoCost.promptCache).toBe(customCache)
    expect(rNoCost.cost.input).toBeGreaterThan(0)
  })

  it('CW-M04 前缀短名、大小写与空格均能命中；同 id 不同 api 优先借用同 api；匹配不到原样返回', async () => {
    // 1) 前缀短名 + 大小写 + 空格
    for (const id of [
      'anthropic/claude-sonnet-4-6',
      'openrouter/anthropic/claude-sonnet-4-6',
      '  CLAUDE-SONNET-4-6  ',
      '  OpenRouter/Anthropic/Claude-Sonnet-4-6 '
    ]) {
      const m = makeModel({ id, promptCache: undefined })
      const resolved = resolveCacheWarmingModel(m)
      expect(resolved, id).not.toBe(m)
      expect(resolved.promptCache, id).toBeDefined()
      expect(resolved.cost.input, id).toBeGreaterThan(0)
    }

    // 2) 匹配不到原样返回
    const unknown = makeModel({ id: 'totally-unknown-custom-model-xyz', promptCache: undefined })
    expect(resolveCacheWarmingModel(unknown)).toBe(unknown)

    // 3) 同 id 不同 api 优先借用同 api（独立模块实例注入两份同 id 不同 api 的内置元数据验证）
    vi.resetModules()
    vi.doMock('@earendil-works/pi-ai/providers/all', () => ({
      builtinProviders: () => [
        {
          id: 'prov-a',
          getModels: () => [
            makeModel({
              id: 'shared-model',
              api: 'anthropic-messages',
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
              promptCache: { short: 300 }
            })
          ]
        },
        {
          id: 'prov-b',
          getModels: () => [
            makeModel<'openai-responses'>({
              id: 'shared-model',
              api: 'openai-responses',
              cost: { input: 7, output: 28, cacheRead: 0.7, cacheWrite: 7 },
              promptCache: { short: 600 }
            })
          ]
        }
      ]
    }))
    try {
      const fresh = await import('../cacheWarmingModels')
      const target = makeModel<'openai-responses'>({
        id: 'vendor/shared-model',
        api: 'openai-responses',
        promptCache: undefined
      })
      const resolved = fresh.resolveCacheWarmingModel(target)
      expect(resolved.cost.input).toBe(7)
      expect(resolved.promptCache).toEqual({ short: 600 })

      // 若请求了目录里不存在的 api，则回落到 byId
      const fallback = makeModel<'openai-completions'>({
        id: 'shared-model',
        api: 'openai-completions',
        promptCache: undefined
      })
      const resolvedFallback = fresh.resolveCacheWarmingModel(fallback)
      expect(resolvedFallback.cost.input).toBe(3)
      expect(resolvedFallback.promptCache).toEqual({ short: 300 })
    } finally {
      vi.doUnmock('@earendil-works/pi-ai/providers/all')
      vi.resetModules()
    }
  })
})

// ─── CW-W01..07：withCacheWarming 装饰器行为 ──────────────────────────────

describe('CW-W withCacheWarming 后台保活装饰器', () => {
  it('CW-W01 isEnabled() 返回 false 时不调度定时器、不发保活请求', async () => {
    const fakeTimers = createFakeTimers()
    const { logger } = makeLogger()
    const { models: inner, calls } = makeFakeModels({
      streamSimple: () => resolvedStream(makeReply('stop'))
    })
    const { models, dispose } = withCacheWarming(inner, {
      sessionId: 's-w01',
      isEnabled: () => false,
      logger,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer
    })

    await models.streamSimple(makeModel(), EMPTY_CONTEXT).result()
    await flushMicrotasks()

    expect(fakeTimers.timers).toHaveLength(0)
    expect(calls).toHaveLength(1)
    dispose()
  })

  it('CW-W02 toolUse（streaming）与 stop（idle）按 getCacheWarmingDelayMs(ttlMs) 触发保活，参数完整且传给 inner 的 model 仍是原始对象', async () => {
    for (const stopReason of ['toolUse', 'stop'] as const) {
      const fakeTimers = createFakeTimers()
      const { logger } = makeLogger()
      // 用自定义零成本缺 promptCache 模型，验证 resolveCacheWarmingModel 只用于核算，传给 inner 的仍是原引用
      const rawModel = Object.freeze(
        makeModel({
          id: 'claude-sonnet-4-6',
          cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
          promptCache: undefined
        })
      )
      const evalModel = resolveCacheWarmingModel(rawModel)
      const ttlMs = getPromptCacheTtlMs(evalModel, undefined)!
      const expectedDelay = getCacheWarmingDelayMs(ttlMs)!
      expect(expectedDelay).toBeGreaterThan(0)

      const { models: inner, calls } = makeFakeModels({
        streamSimple: () => resolvedStream(makeReply(stopReason))
      })
      const { models, dispose } = withCacheWarming(inner, {
        sessionId: `s-w02-${stopReason}`,
        isEnabled: () => true,
        logger,
        now: () => 1_000_000,
        setTimer: fakeTimers.setTimer,
        clearTimer: fakeTimers.clearTimer
      })

      await models.streamSimple(rawModel, EMPTY_CONTEXT, { sessionId: 'conv-1' }).result()
      await flushMicrotasks()

      expect(fakeTimers.activeTimers(), stopReason).toHaveLength(1)
      expect(fakeTimers.activeTimers()[0]!.delayMs, stopReason).toBe(expectedDelay)

      // 触发保活
      fakeTimers.fire(fakeTimers.activeTimers()[0]!)
      await flushMicrotasks()

      expect(calls, stopReason).toHaveLength(2)
      const warmCall = calls[1]!
      expect(warmCall.model, stopReason).toBe(rawModel)
      expect(warmCall.options, stopReason).toMatchObject({
        maxTokens: 1,
        disableContinuation: true,
        maxRetries: 0
      })
      expect((warmCall.options as ModelsSimpleStreamOptions).signal).toBeInstanceOf(AbortSignal)

      dispose()
    }
  })

  it('CW-W03 length/error/aborted、无 TTL 未知模型、不可重放模型、净省 < $0.05、主请求 reject 均不调度且无未捕获异常', async () => {
    const runCase = async (
      label: string,
      setup: {
        model?: Model<Api>
        options?: ModelsSimpleStreamOptions
        streamFactory: () => AssistantMessageEventStream
      }
    ): Promise<void> => {
      const fakeTimers = createFakeTimers()
      const { logger } = makeLogger()
      const { models: inner } = makeFakeModels({ streamSimple: setup.streamFactory })
      const { models, dispose } = withCacheWarming(inner, {
        sessionId: `s-w03-${label}`,
        isEnabled: () => true,
        logger,
        now: () => 1_000_000,
        setTimer: fakeTimers.setTimer,
        clearTimer: fakeTimers.clearTimer
      })
      await models
        .streamSimple(setup.model ?? makeModel(), EMPTY_CONTEXT, setup.options)
        .result()
        .catch(() => undefined)
      await flushMicrotasks()
      expect(fakeTimers.timers, label).toHaveLength(0)
      dispose()
    }

    // 1) stopReason = length / error / aborted
    for (const stopReason of ['length', 'error', 'aborted'] as const) {
      await runCase(`stopReason-${stopReason}`, {
        streamFactory: () => resolvedStream(makeReply(stopReason))
      })
    }

    // 2) 无 TTL 未知模型
    await runCase('unknown-no-ttl', {
      model: makeModel({ id: 'unknown-no-ttl-model', promptCache: undefined }),
      streamFactory: () => resolvedStream(makeReply('stop'))
    })

    // 3) 不可重放模型（anthropic-messages + reasoning 但未开启 forceAdaptiveThinking）
    await runCase('non-replayable', {
      model: makeModel({
        id: 'claude-sonnet-4-6',
        api: 'anthropic-messages',
        compat: { forceAdaptiveThinking: false } as Model<'anthropic-messages'>['compat']
      }),
      options: { reasoning: 'medium' },
      streamFactory: () => resolvedStream(makeReply('stop'))
    })

    // 4) 净省 < $0.05（极小 prompt token 数）
    await runCase('low-savings', {
      streamFactory: () =>
        resolvedStream(
          makeReply('stop', {
            usage: {
              input: 100,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 110,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          })
        )
    })

    // 5) 主请求 result() reject
    await runCase('main-reject', {
      streamFactory: () => rejectedStream(new Error('network reset'))
    })
  })

  it('CW-W04 同对话新到达真实请求（stream/streamSimple/complete/completeSimple）立即清除待触发定时器并 abort 在途保活；不同 sessionId 互不取消', async () => {
    const model = makeModel()

    // (1) 验证四种入口都能取消同对话的待触发定时器与在途保活请求
    for (const method of ['stream', 'streamSimple', 'complete', 'completeSimple'] as const) {
      const fakeTimers = createFakeTimers()
      const { logger } = makeLogger()
      let warmSignal: AbortSignal | undefined

      const { models: inner } = makeFakeModels({
        stream: () => resolvedStream(makeReply('stop')),
        streamSimple: (_m, _c, opts) => {
          // 保活请求携带 disableContinuation: true → 挂起，等待新真实请求 abort
          if (opts?.disableContinuation === true) {
            warmSignal = opts.signal
            return createDeferredStream().stream
          }
          return resolvedStream(makeReply('stop'))
        }
      })

      const { models, dispose } = withCacheWarming(inner, {
        sessionId: `s-w04-${method}`,
        isEnabled: () => true,
        logger,
        now: () => 1_000_000,
        setTimer: fakeTimers.setTimer,
        clearTimer: fakeTimers.clearTimer
      })

      // 场景 A：取消在途保活请求
      await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-A' }).result()
      await flushMicrotasks()
      expect(fakeTimers.activeTimers(), `${method}-pending`).toHaveLength(1)
      const firstTimer = fakeTimers.activeTimers()[0]!

      // 触发定时进入在途保活
      fakeTimers.fire(firstTimer)
      await flushMicrotasks()
      expect(warmSignal?.aborted, `${method}-before`).toBe(false)

      // 发起同对话新真实请求 → 立即 abort 在途保活
      if (method === 'stream') {
        await models.stream(model, EMPTY_CONTEXT, { sessionId: 'conv-A' }).result()
      } else if (method === 'streamSimple') {
        await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-A' }).result()
      } else if (method === 'complete') {
        await models.complete(model, EMPTY_CONTEXT, { sessionId: 'conv-A' })
      } else {
        await models.completeSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-A' })
      }
      expect(warmSignal?.aborted, `${method}-aborted`).toBe(true)

      // 场景 B：取消仅处于等待中的定时器
      await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-B' }).result()
      await flushMicrotasks()
      const pendingTimer = fakeTimers.activeTimers().at(-1)!
      expect(pendingTimer.cleared).toBe(false)
      if (method === 'stream') {
        await models.stream(model, EMPTY_CONTEXT, { sessionId: 'conv-B' }).result()
      } else if (method === 'streamSimple') {
        await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-B' }).result()
      } else if (method === 'complete') {
        await models.complete(model, EMPTY_CONTEXT, { sessionId: 'conv-B' })
      } else {
        await models.completeSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-B' })
      }
      expect(pendingTimer.cleared, `${method}-cleared`).toBe(true)

      dispose()
    }

    // (2) 不同 sessionId 对话互不取消
    {
      const fakeTimers = createFakeTimers()
      const { logger } = makeLogger()
      const { models: inner } = makeFakeModels({
        streamSimple: () => resolvedStream(makeReply('stop'))
      })
      const { models, dispose } = withCacheWarming(inner, {
        sessionId: 's-w04-iso',
        isEnabled: () => true,
        logger,
        now: () => 1_000_000,
        setTimer: fakeTimers.setTimer,
        clearTimer: fakeTimers.clearTimer
      })

      await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-1' }).result()
      await flushMicrotasks()
      const timer1 = fakeTimers.activeTimers()[0]!

      // conv-2 发真实请求不应取消 conv-1 的定时器
      await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-2' }).result()
      await flushMicrotasks()
      expect(timer1.cleared).toBe(false)
      expect(fakeTimers.activeTimers()).toHaveLength(2)

      dispose()
    }
  })

  it('CW-W05 保活成功后继续续期，到达 CACHE_WARMING_MAX_AGE_MS（streaming）和 CACHE_WARMING_MAX_IDLE_AGE_MS（idle）停止；等待期间 isEnabled 翻 false 则取消不发请求', async () => {
    const model = makeModel()
    const delayMs = getCacheWarmingDelayMs(
      getPromptCacheTtlMs(resolveCacheWarmingModel(model), undefined)!
    )!

    // (1) streaming 与 idle 各自推进 now 到达上限后停止
    for (const [stopReason, maxAgeMs] of [
      ['toolUse', CACHE_WARMING_MAX_AGE_MS],
      ['stop', CACHE_WARMING_MAX_IDLE_AGE_MS]
    ] as const) {
      let currentTime = 1_000_000
      const fakeTimers = createFakeTimers()
      const { logger } = makeLogger()
      const { models: inner, calls } = makeFakeModels({
        streamSimple: () => resolvedStream(makeReply(stopReason))
      })
      const { models, dispose } = withCacheWarming(inner, {
        sessionId: `s-w05-${stopReason}`,
        isEnabled: () => true,
        logger,
        now: () => currentTime,
        setTimer: fakeTimers.setTimer,
        clearTimer: fakeTimers.clearTimer
      })

      await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'c1' }).result()
      await flushMicrotasks()

      let rounds = 0
      while (fakeTimers.activeTimers().length > 0 && rounds < 200) {
        const next = fakeTimers.activeTimers()[0]!
        currentTime += next.delayMs
        fakeTimers.fire(next)
        await flushMicrotasks()
        rounds++
      }

      // 至少续期过一次，且在 elapsed + delayMs >= maxAgeMs 时停止
      expect(rounds, stopReason).toBeGreaterThan(0)
      expect(rounds, stopReason).toBeLessThan(200)
      expect(fakeTimers.activeTimers(), stopReason).toHaveLength(0)
      expect(currentTime - 1_000_000 + delayMs, stopReason).toBeGreaterThanOrEqual(maxAgeMs)
      expect(calls.length, stopReason).toBe(1 + rounds)

      dispose()
    }

    // (2) 等待期间 isEnabled() 翻为 false → 定时器触发后取消不发请求
    {
      let enabled = true
      const fakeTimers = createFakeTimers()
      const { logger } = makeLogger()
      const { models: inner, calls } = makeFakeModels({
        streamSimple: () => resolvedStream(makeReply('stop'))
      })
      const { models, dispose } = withCacheWarming(inner, {
        sessionId: 's-w05-flip',
        isEnabled: () => enabled,
        logger,
        now: () => 1_000_000,
        setTimer: fakeTimers.setTimer,
        clearTimer: fakeTimers.clearTimer
      })

      await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'c1' }).result()
      await flushMicrotasks()
      expect(fakeTimers.activeTimers()).toHaveLength(1)

      enabled = false
      fakeTimers.fire(fakeTimers.activeTimers()[0]!)
      await flushMicrotasks()

      expect(calls).toHaveLength(1)
      expect(fakeTimers.activeTimers()).toHaveLength(0)
      dispose()
    }
  })

  it('CW-W06 保活失败降级：stream.result() reject、streamSimple 同步抛错、resolve 为 error/aborted 均记 logger.warn、停止续期、不抛未捕获异常', async () => {
    const model = makeModel()

    const cases: Array<{
      label: string
      warmHandler: () => AssistantMessageEventStream
      expectWarnMatch: RegExp
    }> = [
      {
        label: 'result-reject',
        warmHandler: () => rejectedStream(new Error('upstream 502')),
        expectWarnMatch: /upstream 502/
      },
      {
        label: 'sync-throw',
        warmHandler: () => {
          throw new Error('sync provider error')
        },
        expectWarnMatch: /sync provider error/
      },
      {
        label: 'resolve-error',
        warmHandler: () =>
          resolvedStream(makeReply('error', { errorMessage: 'rate limit exceeded' })),
        expectWarnMatch: /ended with error.*rate limit exceeded/
      },
      {
        label: 'resolve-aborted',
        warmHandler: () => resolvedStream(makeReply('aborted')),
        expectWarnMatch: /ended with aborted/
      }
    ]

    for (const { label, warmHandler, expectWarnMatch } of cases) {
      const fakeTimers = createFakeTimers()
      const { logger, warnings } = makeLogger()
      let count = 0
      const { models: inner } = makeFakeModels({
        streamSimple: () => {
          count++
          if (count === 1) return resolvedStream(makeReply('stop'))
          return warmHandler()
        }
      })

      const { models, dispose } = withCacheWarming(inner, {
        sessionId: `s-w06-${label}`,
        isEnabled: () => true,
        logger,
        now: () => 1_000_000,
        setTimer: fakeTimers.setTimer,
        clearTimer: fakeTimers.clearTimer
      })

      await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'c1' }).result()
      await flushMicrotasks()
      expect(fakeTimers.activeTimers(), label).toHaveLength(1)

      fakeTimers.fire(fakeTimers.activeTimers()[0]!)
      await flushMicrotasks()

      expect(warnings, label).toHaveLength(1)
      expect(warnings[0], label).toMatch(expectWarnMatch)
      // 停止后续续期
      expect(fakeTimers.activeTimers(), label).toHaveLength(0)

      dispose()
    }
  })

  it('CW-W07 dispose() 取消所有定时器并 abort 所有在途保活；之后已有主请求 resolve 也不再调度；重复 dispose 幂等不抛错', async () => {
    const model = makeModel()
    const fakeTimers = createFakeTimers()
    const { logger } = makeLogger()
    const signals: AbortSignal[] = []
    const mainPending = createDeferredStream()
    let callSeq = 0

    const { models: inner } = makeFakeModels({
      streamSimple: (_m, _c, opts) => {
        callSeq++
        // 1: conv-1 主请求（立即完成 → 调度定时器）
        if (callSeq === 1) return resolvedStream(makeReply('stop'))
        // 2: conv-2 主请求（立即完成 → 调度定时器并进入在途保活）
        if (callSeq === 2) return resolvedStream(makeReply('stop'))
        // 3: conv-2 保活请求（挂起，观察 signal）
        if (callSeq === 3) {
          signals.push(opts!.signal!)
          return createDeferredStream().stream
        }
        // 4: conv-3 主请求（在 dispose() 之后才 resolve）
        return mainPending.stream
      }
    })

    const { models, dispose } = withCacheWarming(inner, {
      sessionId: 's-w07',
      isEnabled: () => true,
      logger,
      now: () => 1_000_000,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer
    })

    await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-1' }).result()
    await models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-2' }).result()
    await flushMicrotasks()
    expect(fakeTimers.activeTimers()).toHaveLength(2)

    const [timer1, timer2] = fakeTimers.activeTimers()
    // 触发 conv-2 进入在途保活
    fakeTimers.fire(timer2!)
    await flushMicrotasks()
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)

    // 发起 conv-3 主请求（未 resolve）
    const conv3Stream = models.streamSimple(model, EMPTY_CONTEXT, { sessionId: 'conv-3' })

    // dispose：取消 timer1 并 abort conv-2 的在途保活
    dispose()
    expect(timer1!.cleared).toBe(true)
    expect(signals[0]!.aborted).toBe(true)

    // 随后 conv-3 主请求 resolve：不再调度新定时器
    mainPending.resolve(makeReply('stop'))
    await conv3Stream.result()
    await flushMicrotasks()
    expect(fakeTimers.activeTimers()).toHaveLength(0)

    // 重复 dispose 幂等不抛错
    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
  })
})

// ─── CW-H01：SessionHost 生命周期自动清理保活定时器 ────────────────────────

describe('CW-H01 SessionHost 生命周期自动 dispose 保活定时器', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it(
    'CW-H01 host.close(sid)、host.delete(sid) 与 LRU 驱逐时自动 dispose 保活定时器',
    async () => {
      const sonnetId = 'claude-sonnet-4-6'
      const expectedDelay = getCacheWarmingDelayMs(
        getPromptCacheTtlMs(resolveCacheWarmingModel(makeModel({ id: sonnetId })), undefined)!
      )!

      const scheduledHandles: ReturnType<typeof setTimeout>[] = []
      const clearedHandles = new Set<ReturnType<typeof setTimeout>>()

      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        const handle = realSetTimeout(fn, delay, ...args)
        if (delay === expectedDelay) scheduledHandles.push(handle)
        return handle
      }) as typeof setTimeout)
      vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
        handle: ReturnType<typeof setTimeout>
      ) => {
        if (handle !== undefined) clearedHandles.add(handle)
        return realClearTimeout(handle)
      }) as typeof clearTimeout)

      const highUsageReply = (): AssistantMessage => fauxAssistantMessage([fauxText('done')])

      const config = defaultAgentConfig()
      config.model = { provider: 'faux', modelId: sonnetId }

      const kit = fauxKit({ models: [{ id: sonnetId }] })
      // fauxProvider 会按真实 prompt 长度重算 usage.input；这里只在 stream.result() 上补足高 token 数以过保活净省门槛
      const boostedModels = new Proxy(kit.models, {
        get(target, prop, receiver) {
          if (prop === 'streamSimple') {
            return (
              model: Model<Api>,
              context: Context,
              options?: ModelsSimpleStreamOptions
            ): AssistantMessageEventStream => {
              const stream = target.streamSimple(model, context, options)
              const origResult = stream.result.bind(stream)
              stream.result = async () => {
                const reply = await origResult()
                return {
                  ...reply,
                  usage: { ...reply.usage, input: 500_000, totalTokens: 500_010 }
                }
              }
              return stream
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })

      let resolveLruClosed!: () => void
      const lruClosed = new Promise<void>((resolve) => {
        resolveLruClosed = resolve
      })

      const t = await makeHost({
        kit,
        models: boostedModels,
        agentConfig: config,
        maxIdleOpen: 1,
        cacheWarming: { isEnabled: () => true },
        onSessionClosed: (sessionId) => {
          if (sessionId === 'cw-lru-1') resolveLruClosed()
        }
      })

      // 1) host.close(sid) 清理保活定时器
      const sClose = await t.open('cw-close')
      t.kit.queue(highUsageReply())
      expect(await withTimeout(sClose.submitUser('hi close'), TIMEOUT, 'submit close')).toEqual({})
      expect(scheduledHandles).toHaveLength(1)
      const hClose = scheduledHandles[0]!
      expect(clearedHandles.has(hClose)).toBe(false)

      await withTimeout(t.host.close('cw-close'), TIMEOUT, 'close')
      expect(clearedHandles.has(hClose)).toBe(true)

      // 2) host.delete(sid) 清理保活定时器
      const sDelete = await t.open('cw-delete')
      t.kit.queue(highUsageReply())
      expect(await withTimeout(sDelete.submitUser('hi delete'), TIMEOUT, 'submit delete')).toEqual(
        {}
      )
      expect(scheduledHandles).toHaveLength(2)
      const hDelete = scheduledHandles[1]!
      expect(clearedHandles.has(hDelete)).toBe(false)

      await withTimeout(t.host.delete('cw-delete'), TIMEOUT, 'delete')
      expect(clearedHandles.has(hDelete)).toBe(true)

      // 3) LRU 驱逐（maxIdleOpen: 1）清理最久未用会话的保活定时器
      const sLru1 = await t.open('cw-lru-1')
      t.kit.queue(highUsageReply())
      expect(await withTimeout(sLru1.submitUser('hi lru1'), TIMEOUT, 'submit lru1')).toEqual({})
      expect(scheduledHandles).toHaveLength(3)
      const hLru1 = scheduledHandles[2]!
      expect(clearedHandles.has(hLru1)).toBe(false)

      // 打开第二个空闲会话触发 LRU 驱逐 cw-lru-1，等关闭落定回调
      await t.open('cw-lru-2')
      await withTimeout(lruClosed, TIMEOUT, 'lru close')
      expect(t.host.openSessionIds()).not.toContain('cw-lru-1')
      expect(clearedHandles.has(hLru1)).toBe(true)
    },
    TIMEOUT
  )
})
