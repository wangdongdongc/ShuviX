/**
 * web_search 工具（tools/webSearch.ts）：注册项、参数校验、结果页地址过门、交给 services/browser 去搜、
 * 搜索引擎要人机验证时这次调用失败（不出卡、不等用户）。services/browser 整个桩掉（浏览器那一半在
 * services/browser/__tests__/webSearch.test.ts）。
 *
 *   WT-1..2   注册项与形状
 *   WT-3..4   参数校验（不过门、不搜）
 *   WT-5..9   门：上报的地址、选项、拒绝、中止、搜索引擎只读一次
 *   WT-10..12 交给 runWebSearch 的参数、结果、失败
 *   WT-13..15 人机验证：SearchNeedsHumanCheck 成为普通的失败结果，不问用户，没有询问通道也一样
 *   WT-23..24 工具从不打开浏览器窗口、不碰询问通道；人机验证的文案键已删
 *
 * 搜索 API 方式（2026-11-16，设置里选了 Tavily / Exa；services/webSearchApiService 桩掉，失败用真的
 * WebSearchApiError 造）：
 *   WT-30..31 浏览器方式不变；选的方式每次调用读一次，工具的名字 / 描述 / 参数不随它变
 *   WT-32..43 API 方式：过门的是那家的端点、门先于请求、条数（1–10）、结果的排版与浏览器方式同形、没有结果
 *   WT-44..51 不换方式：每一种失败都是失败的工具结果，浏览器一次都不碰；密钥不进结果
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  registered: [] as Array<Record<string, unknown>>,
  run: vi.fn(),
  engineOf: vi.fn(),
  enforceUrl: vi.fn(),
  respond: vi.fn(),
  ask: vi.fn(),
  t: vi.fn(),
  format: vi.fn(),
  providerOf: vi.fn(),
  api: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/shuvix-web-search-test' } }))
vi.mock('../../services/browser', () => ({
  runWebSearch: h.run,
  configuredSearchEngine: h.engineOf,
  formatResults: h.format,
  WEB_SEARCH_MAX_RESULTS: 10
}))
vi.mock('../../services/webSearchApiService', () => ({
  configuredWebSearchProvider: h.providerOf,
  searchWithApi: h.api
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: () => ({ enforceUrl: h.enforceUrl }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/toolAgent', () => ({ withCallAgent: (ctx: unknown) => ctx }))
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: (meta: Record<string, unknown>) => {
    h.registered.push(meta)
  }
}))
vi.mock('../../services/userInputBroker', () => ({ respondToUserInput: h.respond }))
vi.mock('../../i18n', () => ({ t: h.t }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { urlObjectOf } from '@shuvix/agent-runtime'
import {
  failureText,
  invokeTool,
  resultText,
  type InvokeToolOptions,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { searchUrl } from '../../../shared/browserSearchEngines'
import type { ToolContext } from '../../services/toolContext'
import {
  WebSearchApiError,
  missingKeyError,
  networkError,
  parseApiSearchResponse
} from '../../utils/toolUtils/webSearchApi'
import { WEB_SEARCH_DESCRIPTION, WebSearchParamsSchema, WebSearchTool } from '../webSearch'

// ─── 夹具 ───────────────────────────────────────────────

/** services/browser/webSearch.ts 里 SearchNeedsHumanCheck 的消息（那一头的测试钉住它的内容） */
const CHECK_MESSAGE =
  'Google is asking for a human check before it shows results, so this search returned nothing. ' +
  "The check page is open in a tab of ShuviX's browser. Tell the user that they can open ShuviX's browser and complete the check in that tab, and that searches will work again once it is passed. " +
  'Do not wait for them and do not call web_search again in this turn: get what you need another way if you can (for example read a page whose address you already know), or carry on without it and say what you could not look up.'
function needsHumanCheck(): Error {
  const error = new Error(CHECK_MESSAGE)
  error.name = 'SearchNeedsHumanCheck'
  return Object.assign(error, { engineName: 'Google' })
}

const ctx = { sessionId: 'S', requestUserInput: h.ask } as unknown as ToolContext
const tool = (context: ToolContext = ctx): WebSearchTool => new WebSearchTool(context)

function call(
  args: Record<string, unknown>,
  options: InvokeToolOptions = {},
  context: ToolContext = ctx
): Promise<InvokedToolResult> {
  return invokeTool(tool(context), args as never, options).then((invocation) => invocation.result)
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
/** 让挂着的微任务与一轮宏任务跑完 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)

beforeEach(() => {
  for (const fn of [
    h.run,
    h.engineOf,
    h.enforceUrl,
    h.respond,
    h.ask,
    h.format,
    h.providerOf,
    h.api
  ])
    fn.mockReset()
  h.providerOf.mockReturnValue('browser')
  h.api.mockResolvedValue([])
  h.format.mockImplementation(
    (query: string, engineName: string, results: unknown[]) =>
      `FMT ${engineName} ${JSON.stringify(query)} ${results.length}`
  )
  h.t.mockClear()
  h.t.mockImplementation((key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key
  )
  h.engineOf.mockReturnValue('google')
  h.enforceUrl.mockResolvedValue(undefined)
  h.respond.mockReturnValue(false)
  h.run.mockResolvedValue({ engine: 'google', text: 'ok', resultCount: 1 })
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
})

afterEach(async () => {
  await settle()
  process.off('unhandledRejection', onUnhandled)
  expect(unhandled).toEqual([])
})

// ─── 注册项与形状 ───────────────────────────────────────

describe('注册项与形状', () => {
  it('WT-1 注册一次：name / group / 标签 / 提示 / presentation / describe / factory', () => {
    const metas = h.registered.filter((m) => m.name === 'web_search')
    expect(metas).toHaveLength(1)
    const meta = metas[0] as {
      group: string
      platforms?: unknown
      getLabel: () => string
      getHint: () => string
      presentation: unknown
      describe: () => unknown
      factory: (ctx: ToolContext) => unknown
    }
    expect(meta.group).toBe('general')
    expect(meta.platforms).toBeUndefined()
    expect(meta.getLabel()).toBe('tool.webSearchLabel')
    expect(meta.getHint()).toBe('tool.webSearchHint')
    expect(meta.presentation).toBe(BUILTIN_TOOL_PRESENTATIONS.web_search.presentation)
    expect(meta.describe()).toEqual({
      description: WEB_SEARCH_DESCRIPTION,
      parameters: WebSearchParamsSchema
    })
    expect(meta.factory(ctx)).toBeInstanceOf(WebSearchTool)
  })

  it('WT-2 replay safe；schema：query 必填、max_results 可选整数 1..10；描述不点名搜索引擎', () => {
    const t = tool()
    expect(t.name).toBe('web_search')
    expect(t.replay).toBe('safe')
    expect(t.description).toBe(WEB_SEARCH_DESCRIPTION)
    expect(t.parameters).toBe(WebSearchParamsSchema)
    const schema = WebSearchParamsSchema as unknown as {
      required?: string[]
      properties: Record<string, { type: string; minimum?: number; maximum?: number }>
    }
    expect(schema.required).toEqual(['query'])
    expect(schema.properties.query.type).toBe('string')
    expect(schema.properties.max_results).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 10
    })
    expect(WEB_SEARCH_DESCRIPTION).not.toMatch(/google|bing|baidu|百度|duckduckgo/i)
    expect(WEB_SEARCH_DESCRIPTION).toContain('use read')
    expect(WEB_SEARCH_DESCRIPTION).toContain('human check')
    // 最后一句：撞上人机验证这次调用就失败，告诉用户、先换个办法
    const last = WEB_SEARCH_DESCRIPTION.split('. ').at(-1) ?? ''
    expect(last).toContain('human check')
    expect(last).toContain('the call fails')
    expect(last).toContain('tell the user')
    expect(last).toContain("ShuviX's browser")
    expect(last).toContain('another way')
    expect(WEB_SEARCH_DESCRIPTION).not.toMatch(/asks? (you|the user) to complete|waits? for/i)
  })
})

// ─── 参数校验 ───────────────────────────────────────────

describe('参数校验', () => {
  it.each([[{}], [{ query: '' }], [{ query: '   ' }], [{ query: 42 }]])(
    'WT-3 %j → query must not be empty',
    async (args) => {
      expect(await failureText(call(args))).toBe('query must not be empty')
      expect(h.enforceUrl).not.toHaveBeenCalled()
      expect(h.run).not.toHaveBeenCalled()
    }
  )

  it('WT-4 401 字拒收（报出字数与上限）；400 字、两边带空白的 400 字照常', async () => {
    const text = await failureText(call({ query: 'a'.repeat(401) }))
    expect(text).toContain('is 401 characters')
    expect(text).toContain('at most 400')
    expect(h.enforceUrl).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()

    expect(resultText(await call({ query: 'a'.repeat(400) }))).toBe('ok')
    expect(resultText(await call({ query: `  ${'b'.repeat(400)}\n ` }))).toBe('ok')
    expect(h.run.mock.calls.map((c) => (c[0] as { query: string }).query)).toEqual([
      'a'.repeat(400),
      'b'.repeat(400)
    ])
  })
})

// ─── 门 ────────────────────────────────────────────────

describe('门', () => {
  it('WT-5 搜之前把结果页地址当一次浏览器导航上报', async () => {
    const order: string[] = []
    h.enforceUrl.mockImplementation(async () => void order.push('gate'))
    h.run.mockImplementation(async () => {
      order.push('run')
      return { text: 'ok' }
    })
    await call({ query: '  cats dogs ' }, { callId: 'call-gate', taskId: 4, conversationId: 7 })
    expect(order).toEqual(['gate', 'run'])
    expect(h.enforceUrl).toHaveBeenCalledTimes(1)
    const [object, options] = h.enforceUrl.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>
    ]
    expect(object).toEqual(urlObjectOf(searchUrl('cats dogs', 'google'), 'app'))
    expect(object).toMatchObject({
      browser: 'app',
      scheme: 'https',
      host: 'www.google.com'
    })
    expect(options).toMatchObject({
      toolCallId: 'call-gate',
      taskId: 4,
      conversationId: 7,
      toolName: 'web_search',
      abortError: 'Aborted',
      missingChannel: 'deny',
      description: `tool.webSearchAskDescription ${JSON.stringify({ engine: 'Google', query: 'cats dogs' })}`
    })
  })

  it('WT-6 搜索引擎是百度 → 上报百度的地址，说明里是它的名字', async () => {
    h.engineOf.mockReturnValue('baidu')
    await call({ query: 'cats' })
    const [object, options] = h.enforceUrl.mock.calls[0] as [
      { url: string; host: string },
      { description: string }
    ]
    expect(object.url).toBe('https://www.baidu.com/s?wd=cats')
    expect(object.host).toBe('www.baidu.com')
    expect(options.description).toBe(
      `tool.webSearchAskDescription ${JSON.stringify({ engine: '百度', query: 'cats' })}`
    )
    expect(h.run.mock.calls[0][0]).toMatchObject({ engine: 'baidu' })
  })

  it('WT-7 门拒绝 → 失败文字是它的消息，不搜', async () => {
    h.enforceUrl.mockRejectedValue(new Error('Denied by policy no-search'))
    expect(await failureText(call({ query: 'cats' }))).toBe('Denied by policy no-search')
    expect(h.run).not.toHaveBeenCalled()
  })

  it('WT-8 门还没答就被中止，之后门放行 → 以 reason 收场，不搜', async () => {
    const gate = deferred<void>()
    h.enforceUrl.mockImplementation(() => gate.promise)
    const abort = new AbortController()
    const work = call({ query: 'cats' }, { signal: abort.signal })
    await settle()
    const reason = new Error('stopped')
    abort.abort(reason)
    gate.resolve()
    await expect(work).rejects.toBe(reason)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('WT-9 一次调用只读一次搜索引擎设置：过门的地址与真正去搜的是同一个', async () => {
    h.engineOf.mockReset()
    h.engineOf.mockReturnValueOnce('google').mockReturnValue('bing')
    await call({ query: 'cats' })
    expect(h.engineOf).toHaveBeenCalledTimes(1)
    expect((h.enforceUrl.mock.calls[0][0] as { host: string }).host).toBe('www.google.com')
    expect(h.run.mock.calls[0][0]).toMatchObject({ engine: 'google' })
  })
})

// ─── 去搜 ──────────────────────────────────────────────

describe('交给 runWebSearch', () => {
  it('WT-10 参数：trim 过的搜索词、搜索引擎、缺省 8 条、会话、signal；不传 awaitVerification / followRedirect', async () => {
    const abort = new AbortController()
    await call({ query: '  cats  ' }, { signal: abort.signal })
    const opts = h.run.mock.calls[0][0] as Record<string, unknown>
    expect(opts).toEqual({
      query: 'cats',
      engine: 'google',
      limit: 8,
      sessionId: 'S',
      signal: expect.any(AbortSignal)
    })
    expect('followRedirect' in opts).toBe(false)
    expect('awaitVerification' in opts).toBe(false)
  })

  it.each([
    [3, 3],
    ['5', 8],
    [Number.NaN, 8],
    [undefined, 8]
  ])('WT-10 max_results %j → limit %s', async (max_results, limit) => {
    await call({ query: 'cats', max_results })
    expect(h.run.mock.calls[0][0]).toMatchObject({ limit })
  })

  it('WT-11 结果是一个文本块，就是搜到的那段文字；没有 details', async () => {
    h.run.mockResolvedValue({
      engine: 'google',
      text: 'Google results…',
      resultCount: 3
    })
    const result = await call({ query: 'cats' })
    expect(result.content).toEqual([{ type: 'text', text: 'Google results…' }])
    expect(result.details).toBeUndefined()
    expect(result.isError).toBeUndefined()
  })

  it('WT-12 搜索失败 → 失败文字是它的消息', async () => {
    h.run.mockRejectedValue(new Error('Google did not show a results page for this search.'))
    expect(await failureText(call({ query: 'cats' }))).toBe(
      'Google did not show a results page for this search.'
    )
  })
})

// ─── 人机验证 ──────────────────────────────────────────

describe('人机验证', () => {
  it('WT-13 runWebSearch 以 SearchNeedsHumanCheck 失败 → 普通的失败结果，文字就是那句话；不问用户、不重试', async () => {
    h.run.mockRejectedValue(needsHumanCheck())
    expect(await failureText(call({ query: 'cats' }, { callId: 'call-check' }))).toBe(CHECK_MESSAGE)
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.respond).not.toHaveBeenCalled()
  })

  it('WT-14 没有询问通道的上下文（无人值守）也是同一个失败，不多说别的', async () => {
    h.run.mockRejectedValue(needsHumanCheck())
    const bare = { sessionId: 'S' } as unknown as ToolContext
    expect(await failureText(call({ query: 'cats' }, {}, bare))).toBe(CHECK_MESSAGE)
  })

  it('WT-15 失败之后的下一次调用照常去搜（工具自己不记着验证）', async () => {
    h.run.mockRejectedValueOnce(needsHumanCheck())
    expect(await failureText(call({ query: 'cats' }))).toBe(CHECK_MESSAGE)
    expect(resultText(await call({ query: 'dogs' }))).toBe('ok')
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(h.enforceUrl).toHaveBeenCalledTimes(2)
  })
})

describe('不打扰用户', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, '../webSearch.ts'), 'utf8')

  it('WT-23 工具的源码里没有 openBrowserWindow，也不碰询问通道', () => {
    expect(source).not.toContain('openBrowserWindow')
    expect(source).not.toMatch(/\.(show|focus)\(/)
    expect(source).not.toContain('requestUserInput')
    expect(source).not.toContain('respondToUserInput')
    expect(source).not.toContain('userInputBroker')
    expect(source).not.toContain('awaitVerification')
  })

  it('WT-24 用到的文案键只有三个：标签、提示、过门的说明；没有 webSearchVerify*', async () => {
    expect(source).not.toContain('webSearchVerify')
    h.run.mockRejectedValueOnce(needsHumanCheck())
    await failureText(call({ query: 'cats' }))
    await call({ query: 'cats' })
    const keys = new Set(h.t.mock.calls.map((c) => c[0] as string))
    expect([...keys].filter((k) => k.includes('Verify'))).toEqual([])
    expect(keys.has('tool.webSearchAskDescription')).toBe(true)
  })
})

// ─── 搜索 API 方式 ─────────────────────────────────────

type ApiProvider = 'tavily' | 'exa'
const API: Record<ApiProvider, { name: string; endpoint: string }> = {
  tavily: { name: 'Tavily', endpoint: 'https://api.tavily.com/search' },
  exa: { name: 'Exa', endpoint: 'https://api.exa.ai/search' }
}
const KEY = ['tvly', 'SECRETSECRET', '1234'].join('-')
const hit = (n: number): { title: string; url: string; snippet: string } => ({
  title: `Title ${n}`,
  url: `https://example.com/${n}`,
  snippet: `Snippet ${n}`
})
/** 真的解析函数对一个回包抛出来的错 */
function apiError(provider: ApiProvider, status: number, body: unknown, key?: string): Error {
  try {
    parseApiSearchResponse(provider, status, body, 8, key)
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a failure')
}

describe('浏览器方式不变', () => {
  it('WT-30 选的是浏览器：过门的是结果页地址，去搜一次，不碰搜索 API', async () => {
    expect(resultText(await call({ query: 'cats' }))).toBe('ok')
    expect((h.enforceUrl.mock.calls[0][0] as { host: string }).host).toBe('www.google.com')
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.api).not.toHaveBeenCalled()
    expect(h.format).not.toHaveBeenCalled()
  })

  it('WT-31 选的方式每次调用读一次；工具的名字 / 描述 / 参数不随它变', async () => {
    const shapeOf = (): unknown => {
      const t = tool()
      return { name: t.name, description: t.description, parameters: t.parameters }
    }
    const asBrowser = shapeOf()
    h.providerOf.mockReturnValue('tavily')
    expect(shapeOf()).toEqual(asBrowser)
    expect(WEB_SEARCH_DESCRIPTION).not.toMatch(/tavily|exa\b/i)

    const t = tool()
    h.providerOf.mockClear()
    await invokeTool(t, { query: 'cats' } as never)
    expect(h.providerOf).toHaveBeenCalledTimes(1)
    expect(h.api).toHaveBeenCalledTimes(1)
    // 同一个工具实例：设置换了，下一次调用就按新的来
    h.providerOf.mockReturnValue('browser')
    await invokeTool(t, { query: 'cats' } as never)
    expect(h.providerOf).toHaveBeenCalledTimes(2)
    expect(h.api).toHaveBeenCalledTimes(1)
    expect(h.run).toHaveBeenCalledTimes(1)
  })
})

describe('API 方式', () => {
  beforeEach(() => {
    h.providerOf.mockReturnValue('tavily')
    h.api.mockResolvedValue([hit(1), hit(2), hit(3)])
  })

  it('WT-32 Tavily：过门的是它的端点，说明里是它的名字；搜索词去空白、缺省 8 条；浏览器不碰', async () => {
    await call({ query: '  rust async  ' }, { callId: 'call-api', taskId: 4, conversationId: 7 })
    expect(h.enforceUrl).toHaveBeenCalledTimes(1)
    const [object, options] = h.enforceUrl.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(object).toEqual(urlObjectOf(API.tavily.endpoint, 'app'))
    expect(object).toMatchObject({ browser: 'app', scheme: 'https', host: 'api.tavily.com' })
    expect(options).toMatchObject({
      toolCallId: 'call-api',
      taskId: 4,
      conversationId: 7,
      toolName: 'web_search',
      abortError: 'Aborted',
      missingChannel: 'deny',
      description: `tool.webSearchAskDescription ${JSON.stringify({ engine: 'Tavily', query: 'rust async' })}`
    })
    expect(h.api).toHaveBeenCalledTimes(1)
    expect(h.api.mock.calls[0].slice(0, 3)).toEqual(['tavily', 'rust async', 8])
    expect(h.run).not.toHaveBeenCalled()
    expect(h.engineOf).not.toHaveBeenCalled()
  })

  it('WT-33 Exa：端点、名字、搜的是 exa', async () => {
    h.providerOf.mockReturnValue('exa')
    await call({ query: 'cats' })
    const [object, options] = h.enforceUrl.mock.calls[0] as [
      { url: string },
      { description: string }
    ]
    expect(object).toEqual(urlObjectOf(API.exa.endpoint, 'app'))
    expect(options.description).toBe(
      `tool.webSearchAskDescription ${JSON.stringify({ engine: 'Exa', query: 'cats' })}`
    )
    expect(h.api.mock.calls[0][0]).toBe('exa')
    expect(h.run).not.toHaveBeenCalled()
  })

  it('WT-34 门先于请求：门没答之前不发请求', async () => {
    const gate = deferred<void>()
    h.enforceUrl.mockImplementation(() => gate.promise)
    const work = call({ query: 'cats' })
    await settle()
    expect(h.enforceUrl).toHaveBeenCalledTimes(1)
    expect(h.api).not.toHaveBeenCalled()
    gate.resolve()
    await work
    expect(h.api).toHaveBeenCalledTimes(1)
  })

  it('WT-35 门拒绝 → 失败文字是它的消息；不发请求，也不去浏览器', async () => {
    h.enforceUrl.mockRejectedValue(new Error('Denied by policy no-search'))
    expect(await failureText(call({ query: 'cats' }))).toBe('Denied by policy no-search')
    expect(h.api).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
  })

  it('WT-36 门还没答就被中止，之后门放行 → 以 reason 收场，不发请求', async () => {
    const gate = deferred<void>()
    h.enforceUrl.mockImplementation(() => gate.promise)
    const abort = new AbortController()
    const work = call({ query: 'cats' }, { signal: abort.signal })
    await settle()
    const reason = new Error('stopped')
    abort.abort(reason)
    gate.resolve()
    await expect(work).rejects.toBe(reason)
    expect(h.api).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
  })

  it.each([
    [1, 1],
    [3, 3],
    [10, 10],
    [undefined, 8]
  ])('WT-37 max_results %j → 条数 %i', async (max_results, limit) => {
    await call({ query: 'cats', max_results })
    expect(h.api.mock.calls[0][2]).toBe(limit)
  })

  it.each([
    [0, 1],
    [-4, 1],
    [50, 10],
    [2.7, 2],
    [Number.NaN, 8],
    ['5', 8]
  ])('WT-43 max_results %j（绕过 schema）→ 条数 %i：1–10 的整数', async (max_results, limit) => {
    await call({ query: 'cats', max_results })
    expect(h.api.mock.calls[0][2]).toBe(limit)
  })

  it('WT-38 结果交给 formatResults(搜索词, 名字, 结果)，工具结果就是它的返回值', async () => {
    const list = [hit(1), hit(2)]
    h.api.mockResolvedValue(list)
    const result = await call({ query: ' rust async ' })
    expect(h.format).toHaveBeenCalledTimes(1)
    expect(h.format.mock.calls[0][0]).toBe('rust async')
    expect(h.format.mock.calls[0][1]).toBe('Tavily')
    expect(h.format.mock.calls[0][2]).toBe(list)
    expect(result.content).toEqual([{ type: 'text', text: 'FMT Tavily "rust async" 2' }])
    expect(result.details).toBeUndefined()
    expect(result.isError).toBeUndefined()
  })

  it('WT-39 真的 formatResults：与浏览器方式同一种排版，抬头是这家的名字', async () => {
    const actual = await vi.importActual<{
      formatResults: (query: string, engineName: string, results: unknown[]) => string
    }>('../../services/browser/searchResults')
    h.format.mockImplementation(actual.formatResults)
    h.api.mockResolvedValue([
      hit(1),
      { title: 'No snippet', url: 'https://example.com/2', snippet: '' }
    ])
    expect(resultText(await call({ query: 'rust async' }))).toBe(
      'Tavily results for "rust async":\n\n' +
        '1. Title 1\n   https://example.com/1\n   Snippet 1\n\n' +
        '2. No snippet\n   https://example.com/2'
    )
  })

  it('WT-40 没有结果 → 一句话（不是失败）：哪家、搜的什么；不排版，也不去浏览器再搜', async () => {
    h.api.mockResolvedValue([])
    const result = await call({ query: 'rust "async"' })
    expect(result.isError).toBeUndefined()
    expect(resultText(result)).toBe('Tavily found no results for "rust \\"async\\"".')
    expect(h.format).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
  })

  it('WT-41 调用带 signal → 传给 searchWithApi；不带就没有这个键', async () => {
    const abort = new AbortController()
    await call({ query: 'cats' }, { signal: abort.signal })
    const withSignal = h.api.mock.calls[0][3] as { signal?: AbortSignal }
    expect(withSignal.signal).toBeInstanceOf(AbortSignal)
    expect(withSignal.signal!.aborted).toBe(false)
    abort.abort(new Error('later'))
    expect(withSignal.signal!.aborted).toBe(true)
  })

  it.each([[{ query: '' }], [{ query: '   ' }], [{ query: 'a'.repeat(401) }]])(
    'WT-42 搜索词不合格（%#）照旧拒收：不过门、不发请求、不去浏览器',
    async (args) => {
      await failureText(call(args))
      expect(h.enforceUrl).not.toHaveBeenCalled()
      expect(h.api).not.toHaveBeenCalled()
      expect(h.run).not.toHaveBeenCalled()
    }
  )
})

describe('不换方式', () => {
  const FAILURES: Array<[string, (provider: ApiProvider) => Error]> = [
    ['no-key', (p) => missingKeyError(p)],
    ['bad-key', (p) => apiError(p, 401, { detail: { error: 'Unauthorized' } })],
    ['quota', (p) => apiError(p, 402, { error: 'credits exhausted' })],
    ['quota', (p) => apiError(p, 432, {})],
    ['rate-limit', (p) => apiError(p, 429, {})],
    ['http', (p) => apiError(p, 500, {})],
    ['network', (p) => networkError(p, new TypeError('fetch failed'))],
    ['shape', (p) => apiError(p, 200, {})]
  ]
  const CASES = (['tavily', 'exa'] as ApiProvider[]).flatMap((provider) =>
    FAILURES.map(([kind, make], i) => [provider, kind, i, make] as const)
  )

  it.each(CASES)(
    'WT-44 %s %s（%#）→ 失败的工具结果，文字就是那句话；浏览器一次都不碰',
    async (provider, kind, _i, make) => {
      const error = make(provider)
      expect(error).toBeInstanceOf(WebSearchApiError)
      expect((error as WebSearchApiError).kind).toBe(kind)
      h.providerOf.mockReturnValue(provider)
      h.api.mockRejectedValue(error)
      // 浏览器那一头是好的：能搜也不搜
      h.run.mockResolvedValue({ engine: 'google', text: 'browser results', resultCount: 3 })

      const text = await failureText(call({ query: 'cats' }))
      expect(text).toBe(error.message)
      expect(h.run).not.toHaveBeenCalled()
      expect(h.engineOf).not.toHaveBeenCalled()
      expect(h.api).toHaveBeenCalledTimes(1)
      expect(h.api.mock.calls[0][0]).toBe(provider)
      expect(h.enforceUrl).toHaveBeenCalledTimes(1)
      expect(h.format).not.toHaveBeenCalled()
      expect(h.ask).not.toHaveBeenCalled()
      expect(h.respond).not.toHaveBeenCalled()

      // WT-45 给模型的话：哪一家、用户在设置里选的、不换方式、告诉用户、这一轮别再调
      const name = API[provider].name
      expect(text).toContain(name)
      expect(text).toContain(`The user chose ${name} for web search in ShuviX's settings`)
      expect(text).toContain('does not switch to another search method')
      expect(text).toContain('Tell the user')
      expect(text).toContain('do not call web_search again this turn')
    }
  )

  it('WT-46 意料之外的错（普通 Error）也是失败，照样不去浏览器', async () => {
    h.providerOf.mockReturnValue('tavily')
    h.api.mockRejectedValue(new Error('boom'))
    expect(await failureText(call({ query: 'cats' }))).toBe('boom')
    expect(h.run).not.toHaveBeenCalled()
  })

  it('WT-47 调用方中止 → 以 reason 收场，不是一句 API 失败的话；不去浏览器', async () => {
    h.providerOf.mockReturnValue('exa')
    const abort = new AbortController()
    const reason = new Error('stopped')
    h.api.mockImplementation(
      (_p: string, _q: string, _n: number, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
        )
    )
    const work = call({ query: 'cats' }, { signal: abort.signal })
    await settle()
    abort.abort(reason)
    await expect(work).rejects.toBe(reason)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('WT-49 失败之后把设置换回浏览器：下一次调用才去浏览器', async () => {
    h.providerOf.mockReturnValue('tavily')
    h.api.mockRejectedValue(missingKeyError('tavily'))
    await failureText(call({ query: 'cats' }))
    expect(h.run).not.toHaveBeenCalled()

    h.providerOf.mockReturnValue('browser')
    expect(resultText(await call({ query: 'cats' }))).toBe('ok')
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.api).toHaveBeenCalledTimes(1)
  })

  it('WT-50 API 方式从不出卡：成功、没有结果、失败都不碰询问通道', async () => {
    h.providerOf.mockReturnValue('tavily')
    h.api.mockResolvedValueOnce([hit(1)])
    await call({ query: 'cats' })
    h.api.mockResolvedValueOnce([])
    await call({ query: 'cats' })
    h.api.mockRejectedValueOnce(apiError('tavily', 429, {}))
    await failureText(call({ query: 'cats' }))
    expect(h.ask).not.toHaveBeenCalled()
    expect(h.respond).not.toHaveBeenCalled()
  })

  it('WT-51 服务方把密钥回显在 401 里：工具结果里没有它', async () => {
    h.providerOf.mockReturnValue('tavily')
    h.api.mockRejectedValue(
      apiError('tavily', 401, { detail: { error: `Invalid API key: ${KEY}` } }, KEY)
    )
    const text = await failureText(call({ query: 'cats' }))
    expect(text).toContain('Tavily rejected the API key (401)')
    expect(text).not.toContain(KEY)
  })
})
