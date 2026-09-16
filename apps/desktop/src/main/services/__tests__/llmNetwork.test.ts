/**
 * llmNetwork 单测 —— 桌面端的 RuntimeNetwork 实现。
 *
 * 被测的是一层**全局 fetch 包装**，所以每条用例都得拿到一个干净的模块实例：
 * 模块级有 `installed` 幂等位和一个懒建的单例 Agent，跨用例复用就会互相污染 ——
 * 故统一 `vi.resetModules()` + 动态 import，并在每条用例前后存取 `globalThis.fetch`。
 *
 * 两条不变量是这个文件的全部意义：
 *  - **作用域外逐字节透传**。主进程还有一大堆 fetch（litellm 目录、provider 探活、
 *    telegram getMe、MCP 的 HTTP 传输…），它们不该因为装了这层包装而改变行为，
 *    连 `init` 都不该被换成新对象。
 *  - **成因不再被抹平**。SDK 把 fetch 失败一律换成固定文案，真相全在 `cause` 链上；
 *    这里是唯一还看得见它的地方，摊平格式要逐字钉住（`UND_ERR_*` / `ECONNRESET`
 *    才是能搜的那个词，message 本身太含糊）。
 *
 * undici 在这里是 mock 的 —— 这个文件要断言的是「传给构造函数的参数」；
 * 真 undici + 真 http 服务端的那半边在 llmNetworkDispatcher.test.ts。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentCtor: vi.fn(),
  warn: vi.fn()
}))

vi.mock('undici', () => {
  class FakeAgent {
    readonly options: unknown
    constructor(options: unknown) {
      mocks.agentCtor(options)
      this.options = options
    }
  }
  return { Agent: FakeAgent }
})
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn() })
}))

type LlmNetworkModule = typeof import('../llmNetwork')
type FetchFn = typeof globalThis.fetch

const URL_UNDER_TEST = 'https://api.example.test/v1/messages'
/** 「压根没抛」与「抛了个 undefined」要能分开 */
const NOTHING_THROWN = Symbol('nothing-thrown')

let realFetch: FetchFn

/** 新建一个干净的模块实例，并把 fetchImpl 作为被包装的「原件」装上 */
async function install(fetchImpl: FetchFn): Promise<LlmNetworkModule> {
  vi.resetModules()
  globalThis.fetch = fetchImpl
  const mod = await import('../llmNetwork')
  mod.installLlmNetwork()
  return mod
}

function okFetch(response: Response): { spy: ReturnType<typeof vi.fn>; fetch: FetchFn } {
  const spy = vi.fn().mockResolvedValue(response)
  return { spy, fetch: spy as unknown as FetchFn }
}

/** 在一个作用域里跑一次注定失败的 fetch，回收「抛了什么」和「作用域里读到的成因」 */
async function recordFailure(thrown: unknown): Promise<{
  detail: string | undefined
  caught: unknown
  mod: LlmNetworkModule
}> {
  const spy = vi.fn().mockImplementation(() => Promise.reject(thrown))
  const mod = await install(spy as unknown as FetchFn)
  return mod.llmNetwork.runInRequestScope(async () => {
    let caught: unknown = NOTHING_THROWN
    try {
      await globalThis.fetch(URL_UNDER_TEST)
    } catch (err) {
      caught = err
    }
    // 必须在作用域**内**读 —— 成因记在 AsyncLocalStorage 的 store 上
    return { detail: mod.llmNetwork.describeLastFailure(), caught, mod }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  realFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// ─────────────────────────── 作用域外 ───────────────────────────

describe('llmNetwork —— 作用域外原样透传', () => {
  it('原件收到的是同一个 input 与同一个 init 对象，返回的也是同一个 Response', async () => {
    const response = new Response('ok')
    const { spy, fetch } = okFetch(response)
    await install(fetch)
    const init: RequestInit = { method: 'POST', body: 'payload' }

    const got = await globalThis.fetch(URL_UNDER_TEST, init)

    expect(got).toBe(response)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe(URL_UNDER_TEST)
    // 连浅拷都不做：主进程其余 fetch 的行为要一字不变
    expect(spy.mock.calls[0][1]).toBe(init)
    expect('dispatcher' in init).toBe(false)
  })

  it('不带 init 时原件收到的是 undefined，而不是被顺手补出来的 {}', async () => {
    const { spy, fetch } = okFetch(new Response('ok'))
    await install(fetch)

    await globalThis.fetch(URL_UNDER_TEST)

    expect(spy.mock.calls[0][1]).toBeUndefined()
  })

  it('失败按引用上抛，既不记成因也不写 warn（那是别人的 fetch，不归这层管）', async () => {
    const boom = new TypeError('fetch failed')
    const spy = vi.fn().mockRejectedValue(boom)
    const mod = await install(spy as unknown as FetchFn)

    let caught: unknown = NOTHING_THROWN
    try {
      await globalThis.fetch(URL_UNDER_TEST)
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(boom)
    expect(mod.llmNetwork.describeLastFailure()).toBeUndefined()
    expect(mocks.warn).not.toHaveBeenCalled()
  })
})

// ─────────────────────────── 作用域内：dispatcher ───────────────────────────

describe('llmNetwork —— 作用域内注入 dispatcher', () => {
  it('原件收到的是一个新 init：带上 dispatcher，method/headers/body/signal 全部留存', async () => {
    const { spy, fetch } = okFetch(new Response('ok'))
    const mod = await install(fetch)
    const controller = new AbortController()
    const headers = { 'content-type': 'application/json' }
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: '{"model":"m1"}',
      signal: controller.signal
    }

    await mod.llmNetwork.runInRequestScope(async () => globalThis.fetch(URL_UNDER_TEST, init))

    const passed = spy.mock.calls[0][1] as RequestInit & { dispatcher?: unknown }
    expect(passed).not.toBe(init)
    expect(passed.method).toBe('POST')
    expect(passed.headers).toBe(headers)
    expect(passed.body).toBe('{"model":"m1"}')
    expect(passed.signal).toBe(controller.signal)
    expect(passed.dispatcher).toBeDefined()
    // 调用方那个对象不该被就地改
    expect('dispatcher' in init).toBe(false)
  })

  it('dispatcher 是**懒建且只建一次**的 undici Agent，两个超时都是 15 分钟', async () => {
    // 这条是那个 15 分钟数字的唯一落点：改动它必须先在这里改，不然悄无声息。
    // 15 分钟 = 让 SDK 自己那道 10 分钟请求超时先响，同时给流式正文留一个仍然有限的兜底。
    const { fetch } = okFetch(new Response('ok'))
    const mod = await install(fetch)

    // 装上但没进过作用域 = 一个 Agent 都不该建（主进程启动路径上不该多出连接池）
    expect(mocks.agentCtor).not.toHaveBeenCalled()

    await mod.llmNetwork.runInRequestScope(async () => globalThis.fetch(URL_UNDER_TEST))
    await mod.llmNetwork.runInRequestScope(async () => globalThis.fetch(URL_UNDER_TEST))

    expect(mocks.agentCtor).toHaveBeenCalledTimes(1)
    expect(mocks.agentCtor).toHaveBeenCalledWith({
      headersTimeout: 900_000,
      bodyTimeout: 900_000
    })
  })

  it('两个作用域共用同一个 Agent 实例（连接池要能复用才有意义）', async () => {
    const { spy, fetch } = okFetch(new Response('ok'))
    const mod = await install(fetch)

    await mod.llmNetwork.runInRequestScope(async () => globalThis.fetch(URL_UNDER_TEST))
    await mod.llmNetwork.runInRequestScope(async () => globalThis.fetch(URL_UNDER_TEST))

    const first = (spy.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher
    const second = (spy.mock.calls[1][1] as { dispatcher?: unknown }).dispatcher
    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  it('调用方自带的 dispatcher 被 LLM 这套覆盖掉（放宽超时是这层的职责，不容商量）', async () => {
    const { spy, fetch } = okFetch(new Response('ok'))
    const mod = await install(fetch)
    // 假的 dispatcher：这条用例只关心「它有没有被换掉」，不需要真 Dispatcher 的方法面
    const callerDispatcher = { marker: 'caller' }

    await mod.llmNetwork.runInRequestScope(async () =>
      globalThis.fetch(URL_UNDER_TEST, {
        dispatcher: callerDispatcher
      } as unknown as RequestInit)
    )

    const passed = spy.mock.calls[0][1] as { dispatcher?: unknown }
    expect(passed.dispatcher).not.toBe(callerDispatcher)
    expect(mocks.agentCtor).toHaveBeenCalledTimes(1)
  })

  it('作用域里隔了一个宏任务才发的 fetch，照样带 dispatcher、照样记进这个作用域', async () => {
    // 真实链路正是这样：取 apiKey → 建连 → 重试，都在 await 之后
    const boom = new TypeError('fetch failed')
    const spy = vi.fn().mockRejectedValue(boom)
    const mod = await install(spy as unknown as FetchFn)

    const detail = await mod.llmNetwork.runInRequestScope(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await globalThis.fetch(URL_UNDER_TEST).catch(() => undefined)
      return mod.llmNetwork.describeLastFailure()
    })

    expect((spy.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher).toBeDefined()
    expect(detail).toBe('TypeError: fetch failed')
  })
})

// ─────────────────────────── 成因链 ───────────────────────────

describe('llmNetwork —— 成因链的记录与摊平', () => {
  it('失败按引用上抛；作用域里读得到摊平后的链子，并且只写一条 warn', async () => {
    const socket = new Error('other side closed')
    socket.name = 'SocketError'
    ;(socket as NodeJS.ErrnoException).code = 'UND_ERR_SOCKET'
    const boom = new TypeError('fetch failed', { cause: socket })

    const { detail, caught } = await recordFailure(boom)

    expect(caught).toBe(boom)
    expect(detail).toBe(
      'TypeError: fetch failed <- SocketError: other side closed (UND_ERR_SOCKET)'
    )
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    expect(mocks.warn.mock.calls[0][0]).toContain(detail)
  })

  it('摊平格式逐字钉死：`名字: 文案 (code)` 用 ` <- ` 串起，没有 code 就不带那对括号', async () => {
    const headers = new Error('Headers Timeout Error')
    headers.name = 'HeadersTimeoutError'
    ;(headers as NodeJS.ErrnoException).code = 'UND_ERR_HEADERS_TIMEOUT'
    const boom = new TypeError('fetch failed', { cause: headers })

    const { detail } = await recordFailure(boom)

    expect(detail).toBe(
      'TypeError: fetch failed <- HeadersTimeoutError: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)'
    )
  })

  it('cause 自指不会把遍历转死', async () => {
    const loop = new Error('loop')
    loop.name = 'LoopError'
    loop.cause = loop

    const { detail } = await recordFailure(loop)

    expect(detail).toBe('LoopError: loop')
  })

  it('链子超过 5 环就截断（错误文案里拖一条无限长的链子没有意义）', async () => {
    let cur = new Error('link-0')
    for (let i = 1; i < 7; i++) cur = new Error(`link-${i}`, { cause: cur })

    const { detail } = await recordFailure(cur)

    expect(detail?.split(' <- ')).toHaveLength(5)
    expect(detail?.startsWith('Error: link-6')).toBe(true)
  })

  it('链子中间冒出个非 Error → 按 String(x) 写出并就此打住', async () => {
    const mid = {
      toString: () => 'MID-NOT-AN-ERROR',
      // 这个 cause 不该被走到：非 Error 没有稳定的 cause 语义，继续爬只会爬出乱七八糟的东西
      cause: new Error('should-not-appear')
    }
    const boom = new TypeError('fetch failed', { cause: mid })

    const { detail } = await recordFailure(boom)

    expect(detail).toBe('TypeError: fetch failed <- MID-NOT-AN-ERROR')
    expect(detail).not.toContain('should-not-appear')
  })

  it('抛的直接是个字符串 → 原样记下来', async () => {
    const { detail, caught } = await recordFailure('kaboom')

    expect(caught).toBe('kaboom')
    expect(detail).toBe('kaboom')
  })

  it.each([
    ['undefined', undefined],
    ['0', 0]
  ])('抛的是假值（%s）→ 答 undefined 而不是空串，也不写 warn', async (_label, thrown) => {
    // 契约只有 string | undefined 两种答案。空串会一路漏到 modelsAdapter 的
    // `if (!detail)` 之外吗？不会 —— 但「有成因」与「没失败过」必须是同一个答案形状，
    // 否则 warn 里会出现一行空的「fetch 失败：」。
    const { detail } = await recordFailure(thrown)

    expect(detail).toBeUndefined()
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('同一个作用域里失败之后又成功 → 成因被清掉（"最近一次"才不会骗人）', async () => {
    const boom = new TypeError('fetch failed')
    const spy = vi.fn().mockRejectedValueOnce(boom).mockResolvedValueOnce(new Response('ok'))
    const mod = await install(spy as unknown as FetchFn)

    const seen = await mod.llmNetwork.runInRequestScope(async () => {
      await globalThis.fetch(URL_UNDER_TEST).catch(() => undefined)
      const afterFailure = mod.llmNetwork.describeLastFailure()
      await globalThis.fetch(URL_UNDER_TEST)
      return { afterFailure, afterSuccess: mod.llmNetwork.describeLastFailure() }
    })

    expect(seen.afterFailure).toBe('TypeError: fetch failed')
    expect(seen.afterSuccess).toBeUndefined()
  })

  it('两个并发作用域各读各的：A 失败、B 成功，谁都不串台', async () => {
    const boom = new TypeError('fetch failed', { cause: new Error('A-only') })
    const failingUrl = `${URL_UNDER_TEST}?scope=fails`
    const spy = vi.fn().mockImplementation((url: string) => {
      if (url === failingUrl) return Promise.reject(boom)
      return Promise.resolve(new Response('ok'))
    })
    const mod = await install(spy as unknown as FetchFn)

    // 两条同时在飞：作用域若共享（比如把成因记成模块级变量），B 会读到 A 的
    const [a, b] = await Promise.all([
      mod.llmNetwork.runInRequestScope(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        await globalThis.fetch(failingUrl).catch(() => undefined)
        return mod.llmNetwork.describeLastFailure()
      }),
      mod.llmNetwork.runInRequestScope(async () => {
        await globalThis.fetch(`${URL_UNDER_TEST}?scope=ok`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return mod.llmNetwork.describeLastFailure()
      })
    ])

    expect(a).toBe('TypeError: fetch failed <- Error: A-only')
    expect(b).toBeUndefined()
  })

  it('作用域外问成因 → 答 undefined，不抛', async () => {
    const { fetch } = okFetch(new Response('ok'))
    const mod = await install(fetch)

    expect(() => mod.llmNetwork.describeLastFailure()).not.toThrow()
    expect(mod.llmNetwork.describeLastFailure()).toBeUndefined()
  })
})

// ─────────────────────────── 作用域的返回值语义 ───────────────────────────

describe('llmNetwork —— runInRequestScope 的返回值', () => {
  it('同步值、Promise 原样返回；同步抛出原样上抛', async () => {
    const { fetch } = okFetch(new Response('ok'))
    const mod = await install(fetch)

    expect(mod.llmNetwork.runInRequestScope(() => 42)).toBe(42)

    const promise = Promise.resolve('结果')
    const returned = mod.llmNetwork.runInRequestScope(() => promise)
    expect(returned).toBe(promise)
    await expect(returned).resolves.toBe('结果')

    const boom = new Error('同步就炸')
    expect(() =>
      mod.llmNetwork.runInRequestScope(() => {
        throw boom
      })
    ).toThrow(boom)
  })
})

// ─────────────────────────── 幂等 ───────────────────────────

describe('llmNetwork —— installLlmNetwork 幂等', () => {
  it('装第二次不换 globalThis.fetch，也不会让原件被调两遍 / warn 写两条', async () => {
    // 不幂等的话就是层层套娃：一次请求调原件 N 次、一次失败写 N 条 warn
    const boom = new TypeError('fetch failed')
    const spy = vi.fn().mockResolvedValueOnce(new Response('ok')).mockRejectedValueOnce(boom)
    const mod = await install(spy as unknown as FetchFn)
    const patched = globalThis.fetch

    mod.installLlmNetwork()
    expect(globalThis.fetch).toBe(patched)

    await mod.llmNetwork.runInRequestScope(async () => globalThis.fetch(URL_UNDER_TEST))
    expect(spy).toHaveBeenCalledTimes(1)

    await mod.llmNetwork.runInRequestScope(async () =>
      globalThis.fetch(URL_UNDER_TEST).catch(() => undefined)
    )
    expect(spy).toHaveBeenCalledTimes(2)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
  })
})
