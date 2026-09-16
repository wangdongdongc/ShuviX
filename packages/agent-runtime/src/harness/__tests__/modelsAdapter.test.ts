/**
 * modelsAdapter 单测 —— 钉死「RuntimeNetwork 这条可选缝」的三件事：
 *
 *  1. **不注入 = 逐字节维持原状**。扩展宿主没有 undici / AsyncLocalStorage，
 *     `network` 恒为 undefined —— 那条路径上一次 `describeLastFailure` 都不该发生。
 *  2. **作用域包住整条异步泵**。宿主的成因是记在 AsyncLocalStorage 里的，
 *     只有 `getApiKey`、内层流、以及**事件流过 annotate 的那一刻**都还在
 *     `runInRequestScope` 里，详情才读得到。这条靠「作用域外读就抛」的假 seam 钉住。
 *  3. **贴文案的边界条件**。provider 用状态码答复的错误不该被网络细节污染；
 *     已经贴过的不重复贴；pi 的事件对象不可就地改（下游还在读原件）。
 *
 * 约定：只 partial-mock `streamSimple` / `completeSimple`，
 * `createAssistantMessageEventStream` 保持**真身** —— 好几条用例断言的正是 pi
 * EventStream 自己的语义（推入终结事件即置 done 并 resolve result()，适配器从不调 end()）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  Models
} from '@earendil-works/pi-ai'
import type { RuntimeNetwork } from '../../types'

const piMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  completeSimple: vi.fn()
}))

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/compat')>()
  return { ...actual, streamSimple: piMocks.streamSimple, completeSimple: piMocks.completeSimple }
})

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat'
import { createModelsAdapter } from '../modelsAdapter'

// ─────────────────────────── fakes ───────────────────────────

const MODEL = { provider: 'p1', id: 'm1' } as unknown as Model<Api>
const CONTEXT = {} as Context

function fakeAssistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    timestamp: 1
  } as unknown as AssistantMessage
}

function textDelta(delta: string): AssistantMessageEvent {
  return {
    type: 'text_delta',
    contentIndex: 0,
    delta,
    partial: fakeAssistant(delta)
  } as AssistantMessageEvent
}

function doneEvent(text = '答完了'): AssistantMessageEvent {
  return { type: 'done', reason: 'stop', message: fakeAssistant(text) } as AssistantMessageEvent
}

/** provider 侧的 error 事件（pi 在自己的 catch 里压成的那种：只剩 errorMessage） */
function errorEvent(
  errorMessage: string | undefined,
  opts: { reason?: 'error' | 'aborted'; extra?: Record<string, unknown> } = {}
): AssistantMessageEvent {
  return {
    type: 'error',
    reason: opts.reason ?? 'error',
    error: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage,
      ...opts.extra
    } as unknown as AssistantMessage
  } as AssistantMessageEvent
}

/** 把一串事件塞进真 EventStream（最后一条必须是终结事件，否则消费端会挂住） */
function queued(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  for (const event of events) stream.push(event)
  return stream
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

function errorTextOf(event: AssistantMessageEvent): string | undefined {
  if (event.type !== 'error') throw new Error(`期望 error 事件，拿到 ${event.type}`)
  return (event.error as unknown as { errorMessage?: string }).errorMessage
}

interface AdapterOpts {
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>
  network?: RuntimeNetwork
}

function makeAdapter(opts: AdapterOpts = {}): Models {
  return createModelsAdapter({
    getApiKey: opts.getApiKey ?? (async () => 'KEY'),
    network: opts.network
  })
}

// ─────────────────────────── 假 seam ───────────────────────────

/** 最简 seam：不真切作用域，只回一个固定详情；顺带数「被问了几次」 */
function detailSeam(detail?: string): { network: RuntimeNetwork; reads: () => number } {
  let reads = 0
  return {
    network: {
      runInRequestScope: (fn) => fn(),
      describeLastFailure: () => {
        reads++
        return detail
      }
    },
    reads: () => reads
  }
}

/**
 * 真 AsyncLocalStorage 撑的 seam —— 与桌面实现同构。
 * 只有它能验「并发两次请求各读各的详情」以及「详情是在作用域里读到的」。
 */
function alsSeam(): {
  network: RuntimeNetwork
  scopeRuns: () => number
  inScope: () => boolean
  recordFailure: (detail: string) => void
} {
  const als = new AsyncLocalStorage<{ failure?: string }>()
  let runs = 0
  return {
    network: {
      runInRequestScope: (fn) => {
        runs++
        return als.run({}, fn)
      },
      describeLastFailure: () => als.getStore()?.failure
    },
    scopeRuns: () => runs,
    inScope: () => als.getStore() !== undefined,
    recordFailure: (detail) => {
      const scope = als.getStore()
      if (!scope) throw new Error('recordFailure 跑在作用域外 —— 用例自己写错了')
      scope.failure = detail
    }
  }
}

beforeEach(() => {
  piMocks.streamSimple.mockReset()
  piMocks.completeSimple.mockReset()
})

// ─────────────────────────── 不注入 network ───────────────────────────

describe('createModelsAdapter —— 不注入 network（扩展宿主那条路）', () => {
  it('流式事件按引用原样透传，error 事件也不例外', async () => {
    const deltaA = textDelta('甲')
    const deltaB = textDelta('乙')
    const failed = errorEvent('Connection error.')
    piMocks.streamSimple.mockReturnValue(queued([deltaA, deltaB, failed]))

    const events = await collect(makeAdapter().streamSimple(MODEL, CONTEXT))

    // === 而非 toEqual：没有 network 时适配器连浅拷都不该做
    expect(events).toHaveLength(3)
    expect(events[0]).toBe(deltaA)
    expect(events[1]).toBe(deltaB)
    expect(events[2]).toBe(failed)
  })

  it('getApiKey 抛错 → 合成事件的文案就是原 message，不带括号也不带尾空格', async () => {
    piMocks.streamSimple.mockReturnValue(queued([doneEvent()]))
    const adapter = makeAdapter({
      getApiKey: async () => {
        throw new Error('no key')
      }
    })

    const events = await collect(adapter.streamSimple(MODEL, CONTEXT))

    expect(errorTextOf(events[0])).toBe('no key')
    // 取 key 就炸了，内层流压根不该被调用
    expect(piMocks.streamSimple).not.toHaveBeenCalled()
  })

  it('completeSimple 抛错 → 同一个 Error 实例原样上抛，message 一字不改', async () => {
    const boom = new Error('Request timed out.')
    piMocks.completeSimple.mockRejectedValue(boom)

    await expect(makeAdapter().completeSimple(MODEL, CONTEXT)).rejects.toBe(boom)
    expect(boom.message).toBe('Request timed out.')
  })

  it('抛出来的不是 Error（字符串 boom）→ 文案取 String(err)', async () => {
    const adapter = makeAdapter({
      getApiKey: async () => {
        throw 'boom'
      }
    })

    const events = await collect(adapter.streamSimple(MODEL, CONTEXT))

    expect(errorTextOf(events[0])).toBe('boom')
  })
})

// ─────────────────────────── 作用域 ───────────────────────────

describe('createModelsAdapter —— 请求作用域', () => {
  it('每次 streamSimple 恰好开一次作用域，getApiKey 与内层流都跑在里面', async () => {
    const seam = alsSeam()
    const seen: Record<string, boolean> = {}
    piMocks.streamSimple.mockImplementation(() => {
      seen.inner = seam.inScope()
      return queued([doneEvent()])
    })
    const adapter = makeAdapter({
      network: seam.network,
      getApiKey: async () => {
        seen.apiKey = seam.inScope()
        return 'KEY'
      }
    })

    await collect(adapter.streamSimple(MODEL, CONTEXT))

    expect(seam.scopeRuns()).toBe(1)
    expect(seen.apiKey).toBe(true)
    expect(seen.inner).toBe(true)
  })

  it('completeSimple 同理：一次调用一个作用域，取 key 与补全都在里面', async () => {
    const seam = alsSeam()
    const seen: Record<string, boolean> = {}
    piMocks.completeSimple.mockImplementation(async () => {
      seen.inner = seam.inScope()
      return fakeAssistant('摘要')
    })
    const adapter = makeAdapter({
      network: seam.network,
      getApiKey: async () => {
        seen.apiKey = seam.inScope()
        return 'KEY'
      }
    })

    await adapter.completeSimple(MODEL, CONTEXT)

    expect(seam.scopeRuns()).toBe(1)
    expect(seen.apiKey).toBe(true)
    expect(seen.inner).toBe(true)
  })

  it('详情是在作用域内读的：seam 在作用域外被问就抛，贴文案照样发生', async () => {
    // 这条是 2 的反证 —— 如果哪天 annotate 被挪到 scope 之外（比如提到 return 前），
    // describeLastFailure 会抛，合成路径把它吞成一条 message 不同的 error 事件，用例立刻红。
    const als = new AsyncLocalStorage<object>()
    const strict: RuntimeNetwork = {
      runInRequestScope: (fn) => als.run({}, fn),
      describeLastFailure: () => {
        if (!als.getStore()) throw new Error('作用域外读详情')
        return 'ECONNRESET'
      }
    }
    piMocks.streamSimple.mockReturnValue(queued([errorEvent('Connection error.')]))

    const events = await collect(makeAdapter({ network: strict }).streamSimple(MODEL, CONTEXT))

    expect(errorTextOf(events[0])).toBe('Connection error. (ECONNRESET)')
  })

  it('error 事件隔了几个 await 和一个宏任务才到，详情依旧读得到', async () => {
    const seam = alsSeam()
    piMocks.streamSimple.mockImplementation(() => {
      const stream = createAssistantMessageEventStream()
      void (async () => {
        seam.recordFailure('UND_ERR_HEADERS_TIMEOUT')
        await Promise.resolve()
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        stream.push(errorEvent('Connection error.'))
      })()
      return stream
    })

    const events = await collect(
      makeAdapter({ network: seam.network }).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe('Connection error. (UND_ERR_HEADERS_TIMEOUT)')
  })

  it('stream / complete 就是 streamSimple / completeSimple 本体（四个入口都带作用域）', async () => {
    const seam = alsSeam()
    piMocks.streamSimple.mockReturnValue(queued([doneEvent()]))
    piMocks.completeSimple.mockResolvedValue(fakeAssistant('好'))
    const adapter = makeAdapter({ network: seam.network })

    expect(adapter.stream).toBe(adapter.streamSimple)
    expect(adapter.complete).toBe(adapter.completeSimple)

    // 走 stream / complete 这两个别名同样开作用域 —— harness 压缩走的正是 complete
    await collect(adapter.stream(MODEL, CONTEXT))
    await adapter.complete(MODEL, CONTEXT)
    expect(seam.scopeRuns()).toBe(2)
  })
})

// ─────────────────────────── 贴文案（流式） ───────────────────────────

describe('createModelsAdapter —— 给 error 事件贴成因', () => {
  it('确有 fetch 失败 → 文案后面接一对括号', async () => {
    piMocks.streamSimple.mockReturnValue(queued([errorEvent('Connection error.')]))
    const seam = detailSeam('TypeError: fetch failed <- SocketError: other side closed')

    const events = await collect(
      makeAdapter({ network: seam.network }).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe(
      'Connection error. (TypeError: fetch failed <- SocketError: other side closed)'
    )
  })

  it('不就地改 pi 的对象：原事件与其 error 原封不动，转发的是浅拷贝，其余字段留存', async () => {
    const original = errorEvent('Connection error.', {
      extra: { usage: { input: 3, output: 0 }, requestId: 'req-7' }
    })
    const originalError = original.type === 'error' ? original.error : undefined
    piMocks.streamSimple.mockReturnValue(queued([original]))

    const events = await collect(
      makeAdapter({ network: detailSeam('ECONNRESET').network }).streamSimple(MODEL, CONTEXT)
    )
    const forwarded = events[0]

    // 原件：下游（比如派生 agent 的转述）还在读它，改了就是污染
    expect(errorTextOf(original)).toBe('Connection error.')
    expect(forwarded).not.toBe(original)
    if (forwarded.type !== 'error' || original.type !== 'error') throw new Error('期望 error 事件')
    expect(forwarded.error).not.toBe(originalError)
    expect(forwarded.reason).toBe('error')
    const carried = forwarded.error as unknown as Record<string, unknown>
    expect(carried.requestId).toBe('req-7')
    expect(carried.usage).toEqual({ input: 3, output: 0 })
    expect(carried.stopReason).toBe('error')
  })

  it('stream.result() 拿到的是**贴过成因**的 AssistantMessage（eventHandler 读的就是它）', async () => {
    piMocks.streamSimple.mockReturnValue(queued([errorEvent('Connection error.')]))

    const stream = makeAdapter({ network: detailSeam('ECONNRESET').network }).streamSimple(
      MODEL,
      CONTEXT
    )
    const result = (await stream.result()) as unknown as { errorMessage?: string }

    expect(result.errorMessage).toBe('Connection error. (ECONNRESET)')
  })

  it('没有 fetch 失败 → provider 的状态码错误原样透传，文案不被网络细节污染', async () => {
    // 429/400/5xx 这类是 provider 用状态码答复的，本身就有内容 —— 贴上 fetch 细节只会误导
    const rateLimited = errorEvent('429 rate_limit')
    piMocks.streamSimple.mockReturnValue(queued([rateLimited]))

    const events = await collect(
      makeAdapter({ network: detailSeam(undefined).network }).streamSimple(MODEL, CONTEXT)
    )

    expect(events[0]).toBe(rateLimited)
    expect(errorTextOf(events[0])).toBe('429 rate_limit')
  })

  it('文案里已经有这段成因 → 不贴第二遍，事件按引用透传', async () => {
    // 同一条消息可能经过多层（派生 agent 转述给父级），重复贴会越滚越长
    const already = errorEvent('Connection error. (TypeError: fetch failed)')
    piMocks.streamSimple.mockReturnValue(queued([already]))

    const events = await collect(
      makeAdapter({ network: detailSeam('TypeError: fetch failed').network }).streamSimple(
        MODEL,
        CONTEXT
      )
    )

    expect(events[0]).toBe(already)
    expect(errorTextOf(events[0])).toBe('Connection error. (TypeError: fetch failed)')
  })

  it('errorMessage 本来是 undefined → 文案正好等于成因（不带括号、不带前导空格）', async () => {
    piMocks.streamSimple.mockReturnValue(queued([errorEvent(undefined)]))

    const events = await collect(
      makeAdapter({ network: detailSeam('ECONNRESET').network }).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe('ECONNRESET')
  })

  it('干净的流（增量 + done）一次都不问详情 —— 热路径提前返回', async () => {
    const seam = detailSeam('ECONNRESET')
    piMocks.streamSimple.mockReturnValue(
      queued([textDelta('甲'), textDelta('乙'), textDelta('丙'), doneEvent()])
    )

    await collect(makeAdapter({ network: seam.network }).streamSimple(MODEL, CONTEXT))

    expect(seam.reads()).toBe(0)
  })

  it('文案两端的空白先 trim 再拼', async () => {
    piMocks.streamSimple.mockReturnValue(queued([errorEvent('  Connection error.  ')]))

    const events = await collect(
      makeAdapter({ network: detailSeam('ECONNRESET').network }).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe('Connection error. (ECONNRESET)')
  })

  it('reason: aborted 原样带过去（贴成因不该把中止改判成失败）', async () => {
    piMocks.streamSimple.mockReturnValue(queued([errorEvent('Aborted.', { reason: 'aborted' })]))

    const events = await collect(
      makeAdapter({ network: detailSeam('ECONNRESET').network }).streamSimple(MODEL, CONTEXT)
    )

    const forwarded = events[0]
    if (forwarded.type !== 'error') throw new Error('期望 error 事件')
    expect(forwarded.reason).toBe('aborted')
    expect(errorTextOf(forwarded)).toBe('Aborted. (ECONNRESET)')
  })
})

// ─────────────────────────── 合成错误事件（取 key / 建连阶段） ───────────────────────────

describe('createModelsAdapter —— 建连阶段失败合成 error 事件', () => {
  it('合成事件逐字段固定：与 provider 侧 error 路径同构，harness 只需处理一条分支', async () => {
    const adapter = makeAdapter({
      network: detailSeam('UND_ERR_HEADERS_TIMEOUT').network,
      getApiKey: async () => {
        throw new Error('Connection error.')
      }
    })

    const events = await collect(adapter.streamSimple(MODEL, CONTEXT))

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Connection error. (UND_ERR_HEADERS_TIMEOUT)',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        timestamp: expect.any(Number)
      }
    })
  })

  it('合成事件即终结流：迭代自然结束、result() 落定，虽然没人调 end()', async () => {
    const adapter = makeAdapter({
      getApiKey: async () => {
        throw new Error('no key')
      }
    })

    const stream = adapter.streamSimple(MODEL, CONTEXT)
    // 挂住就是 5s 超时 —— 正是要防的回归
    const events = await collect(stream)
    const result = (await stream.result()) as unknown as { errorMessage?: string }

    expect(events).toHaveLength(1)
    expect(result.errorMessage).toBe('no key')
  })

  it('内层 streamSimple 自己抛（同步）→ 走同一条合成路径', async () => {
    piMocks.streamSimple.mockImplementation(() => {
      throw new Error('Mismatched api: openai expected anthropic')
    })

    const events = await collect(
      makeAdapter({ network: detailSeam('ECONNRESET').network }).streamSimple(MODEL, CONTEXT)
    )

    expect(errorTextOf(events[0])).toBe('Mismatched api: openai expected anthropic (ECONNRESET)')
  })

  it('内层先发终结事件再抛 → 多推的那条被 EventStream 的 done 闸吞掉，消费端只看到第一条', async () => {
    const message = fakeAssistant('先把话说完')
    const settled = { type: 'done', reason: 'stop', message } as AssistantMessageEvent
    async function* lateBoom(): AsyncGenerator<AssistantMessageEvent> {
      yield settled
      throw new Error('late boom')
    }
    piMocks.streamSimple.mockReturnValue(lateBoom() as unknown as AssistantMessageEventStream)

    const stream = makeAdapter({ network: detailSeam('ECONNRESET').network }).streamSimple(
      MODEL,
      CONTEXT
    )
    const events = await collect(stream)

    expect(events).toEqual([settled])
    expect(await stream.result()).toBe(message)
  })
})

// ─────────────────────────── 贴文案（非流式） ───────────────────────────

describe('createModelsAdapter —— complete 路径的成因回贴', () => {
  it('抛的是同一个 Error 实例（不重新包），只有 message 被接上成因', async () => {
    const boom = new Error('Request timed out.')
    const stackBefore = boom.stack
    piMocks.completeSimple.mockRejectedValue(boom)

    const caught = await makeAdapter({ network: detailSeam('UND_ERR_HEADERS_TIMEOUT').network })
      .completeSimple(MODEL, CONTEXT)
      .catch((err: unknown) => err)

    // 身份守住才谈得上 stack / cause 不丢 —— 换成 new Error(...) 这两条都会变
    expect(caught).toBe(boom)
    expect(boom.stack).toBe(stackBefore)
    expect(boom.message).toBe('Request timed out. (UND_ERR_HEADERS_TIMEOUT)')
  })

  it('抛的不是 Error（即便有成因）→ 原样上抛，不硬塞 message', async () => {
    piMocks.completeSimple.mockRejectedValue('plain string failure')

    const caught = await makeAdapter({ network: detailSeam('ECONNRESET').network })
      .completeSimple(MODEL, CONTEXT)
      .catch((err: unknown) => err)

    expect(caught).toBe('plain string failure')
  })

  it('没有成因 → message 一字不改', async () => {
    const boom = new Error('Request timed out.')
    piMocks.completeSimple.mockRejectedValue(boom)

    const caught = await makeAdapter({ network: detailSeam(undefined).network })
      .completeSimple(MODEL, CONTEXT)
      .catch((err: unknown) => err)

    expect(caught).toBe(boom)
    expect(boom.message).toBe('Request timed out.')
  })

  it('成功返回 → 一次都不问详情，AssistantMessage 按引用回传', async () => {
    const summary = fakeAssistant('这是压缩摘要')
    const seam = detailSeam('ECONNRESET')
    piMocks.completeSimple.mockResolvedValue(summary)

    const got = await makeAdapter({ network: seam.network }).completeSimple(MODEL, CONTEXT)

    expect(got).toBe(summary)
    expect(seam.reads()).toBe(0)
  })
})

// ─────────────────────────── 并发与复用 ───────────────────────────

describe('createModelsAdapter —— 作用域隔离', () => {
  /**
   * 两次 streamSimple 交错在跑：A 的 fetch 失败了、B 的没有。
   * 作用域若是共享的（比如把详情记成模块级变量），B 会被贴上 A 的成因 —— 这才是这条的靶子。
   */
  async function overlapping(
    seam: ReturnType<typeof alsSeam>,
    details: { a: string; b?: string }
  ): Promise<{ a: AssistantMessageEvent; b: AssistantMessageEvent }> {
    // 闸门先建好：适配器是**同步返回空流、异步补泵**的，mock 要到取完 key 才被调到,
    // 在 mock 里现建闸门的话主用例根本拿不到它
    const gates: Record<string, { opened: Promise<void>; open: () => void }> = {}
    for (const provider of ['A', 'B']) {
      let open = (): void => {}
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      gates[provider] = { opened, open }
    }
    piMocks.streamSimple.mockImplementation((model: Model<Api>) => {
      const stream = createAssistantMessageEventStream()
      void (async () => {
        await gates[model.provider].opened
        const detail = model.provider === 'A' ? details.a : details.b
        if (detail) seam.recordFailure(detail)
        stream.push(errorEvent('Connection error.'))
      })()
      return stream
    })
    const adapter = makeAdapter({ network: seam.network })

    // 两条都先开出去，谁都还没落定 —— 这才叫交错
    const streamA = adapter.streamSimple({ ...MODEL, provider: 'A' } as Model<Api>, CONTEXT)
    const streamB = adapter.streamSimple({ ...MODEL, provider: 'B' } as Model<Api>, CONTEXT)
    const collectedA = collect(streamA)
    const collectedB = collect(streamB)

    gates.B.open()
    const b = (await collectedB)[0]
    gates.A.open()
    const a = (await collectedA)[0]
    return { a, b }
  }

  it('并发两次请求：只有失败的那条被贴成因，另一条一点不沾', async () => {
    const seam = alsSeam()
    const { a, b } = await overlapping(seam, { a: 'ECONNRESET' })

    expect(errorTextOf(a)).toBe('Connection error. (ECONNRESET)')
    expect(errorTextOf(b)).toBe('Connection error.')
    expect(seam.scopeRuns()).toBe(2)
  })

  it('并发两次请求各自失败 → 各贴各的成因，不串台', async () => {
    const seam = alsSeam()
    const { a, b } = await overlapping(seam, {
      a: 'UND_ERR_HEADERS_TIMEOUT',
      b: 'UND_ERR_SOCKET'
    })

    expect(errorTextOf(a)).toBe('Connection error. (UND_ERR_HEADERS_TIMEOUT)')
    expect(errorTextOf(b)).toBe('Connection error. (UND_ERR_SOCKET)')
  })

  it('同一个适配器连着跑两次 → 后一次读到的是自己的成因，不是上一次的残留', async () => {
    const seam = alsSeam()
    const details = ['详情X', '详情Y']
    let call = 0
    piMocks.streamSimple.mockImplementation(() => {
      seam.recordFailure(details[call++])
      return queued([errorEvent('Connection error.')])
    })
    const adapter = makeAdapter({ network: seam.network })

    const first = await collect(adapter.streamSimple(MODEL, CONTEXT))
    const second = await collect(adapter.streamSimple(MODEL, CONTEXT))

    expect(errorTextOf(first[0])).toBe('Connection error. (详情X)')
    expect(errorTextOf(second[0])).toBe('Connection error. (详情Y)')
  })
})

// ─────────────────────────── 转发给内层的参数 ───────────────────────────

describe('createModelsAdapter —— 转发给 pi 的参数', () => {
  it('getApiKey 返回空串 → 内层收到的是 undefined（空串当凭证会被 provider 当成「带了个错的 key」）', async () => {
    piMocks.streamSimple.mockReturnValue(queued([doneEvent()]))

    await collect(makeAdapter({ getApiKey: async () => '' }).streamSimple(MODEL, CONTEXT))

    const options = piMocks.streamSimple.mock.calls[0][2] as Record<string, unknown>
    expect('apiKey' in options).toBe(true)
    expect(options.apiKey).toBeUndefined()
  })

  it('调用方的 options 合并转发，且调用方那个对象不被就地改', async () => {
    piMocks.streamSimple.mockReturnValue(queued([doneEvent()]))
    // 传的就是这个对象本身 —— 适配器若写成 `options.apiKey = …` 而不是浅拷，下面第二条会红
    const callerOptions: { reasoning: 'high' } = { reasoning: 'high' }

    await collect(makeAdapter().streamSimple(MODEL, CONTEXT, callerOptions))

    const forwarded = piMocks.streamSimple.mock.calls[0][2] as Record<string, unknown>
    expect(forwarded).not.toBe(callerOptions)
    expect(forwarded).toEqual({ reasoning: 'high', apiKey: 'KEY' })
    expect(callerOptions).toEqual({ reasoning: 'high' })
  })
})
