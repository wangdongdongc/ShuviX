/**
 * 内置 browser MCP server —— 隔着**真的 MCP 协议**看它。
 *
 * 用 SDK 的 `Client` + `InMemoryTransport.createLinkedPair()` 驱动，而不是直接调处理函数：
 * 取消（`notifications/cancelled` → 服务端的 AbortSignal）、`_meta` 里的 toolCallId / 调用方、
 * 结果形状的校验（图片必须是合法 base64）都在协议层，绕过它就把要测的那一层测没了。
 * 注意 InMemoryTransport 是同步投递的，而取消在服务端要晚一个微任务才生效 —— 所以凡是
 * 「某件事**没有**发生」的断言，前面都先 `settle()` 几轮。
 *
 * 后端是全假的（每个方法一个 vi.fn，默认回 `<方法名> ok`）：这一组问的是 server 自己的判断 ——
 *   T10     工具清单过线之后与目录逐项相同；
 *   D1–D13  分发：每个工具恰好调到哪个后端方法、收到什么对象；参数的宽进（数字字符串、
 *           "true"/"false"、空串 = 没给）与严出（类型不对逐字报错，后端与门一个都不碰）；
 *           未知工具、缺参数、导航目标必须是绝对地址、原生 cdp 的拦截表；
 *   R1–R4   后端输出 → MCP 结果（业务失败 = isError、去掉一层「Error: 」）；
 *   G1–G13  安全门：何时问、问什么（toolCallId 路由键、完整工具名、一句说明）、
 *           拒绝即失败、逐个过、参数错不弹卡，以及 cdp 里与专门工具等价的那几个方法；
 *   S1–S12  快照差异 / 全量的判定：按（调用方, tab）分账，失败 / 取消的快照之后必须全量；
 *   Q1–Q8   同一 tab 串行、不同 tab 并行，等门的调用也占着这个 tab；
 *   A1–A5   中止：卡死的后端不拖住队列、排队中被取消的永远到不了后端、门放行来晚了也不补跑，
 *           全程没有未处理的拒绝；
 *   L1–L6   生命周期：关连接回调一次、版本与能力、serverOptions 透传、经注册表按会话实例化；
 *   H1–H9   显示本地文件的 tab 按读那个文件过门（哪些工具看、问什么、记住什么、先后顺序）、
 *           view-source: 不开、参数错不排队、进程级共享队列、pdf 参数先于写门校验、
 *           「失败」只有一个口径、服务端关连接、包入口导出、三处工具描述的措辞。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  BROWSER_MCP_SERVER_NAME,
  connectBrowserMcpServer,
  createBrowserMcpServerFactory,
  createBrowserTabQueue,
  type BrowserGateContext,
  type BrowserMcpGates,
  type BrowserMcpServerOptions,
  type BrowserTabQueue
} from '../mcpServer'
import { browserToolsForCaps } from '../mcpTools'
import { devtoolsRecipes } from '../devtoolsRecipes'
import { blockedCdpReason } from '../cdpPolicy'
import { PDF_PAGE_SIZES, PDF_SCALE_RANGE } from '../backend'
import type { BrowserBackend, BrowserCaps, BrowserOpOutput } from '../backend'
import { BuiltinMcpRegistry, type BuiltinMcpScope } from '../../builtinMcpRegistry'

// ─── caps 预设 ───────────────────────────────────────────────────────────

const DESKTOP: BrowserCaps = {
  pdf: true,
  fullPageScreenshot: true,
  elementScreenshot: true,
  screenshotToFile: true,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true,
  upload: true
}

const EXTENSION: BrowserCaps = {
  pdf: false,
  fullPageScreenshot: false,
  elementScreenshot: false,
  screenshotToFile: false,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true,
  upload: false
}

const MINIMAL: BrowserCaps = {
  pdf: false,
  fullPageScreenshot: false,
  elementScreenshot: false,
  screenshotToFile: false,
  evaluate: false,
  network: false,
  console: false,
  rawCdp: false,
  upload: false
}

// ─── 假后端 ──────────────────────────────────────────────────────────────

const METHODS = [
  'listTabs',
  'openTab',
  'closeTab',
  'navigate',
  'snapshot',
  'readPage',
  'screenshot',
  'click',
  'fill',
  'type',
  'pressKey',
  'hover',
  'scroll',
  'waitFor',
  'evaluate',
  'network',
  'console',
  'cdp',
  'events',
  'uploadFile',
  'pdf'
] as const

type Method = (typeof METHODS)[number]
type OpParams = Record<string, unknown>
type OpMock = Mock<(p: OpParams) => Promise<BrowserOpOutput>>
type FakeBackend = { caps: BrowserCaps } & Record<Method, OpMock>

/** 每个方法一个 vi.fn，默认回 `<方法名> ok`；omit 里的方法干脆不实现 */
function fakeBackend(caps: BrowserCaps = DESKTOP, omit: readonly Method[] = []): FakeBackend {
  const backend = { caps } as FakeBackend
  for (const m of METHODS) {
    if (omit.includes(m)) continue
    backend[m] = vi.fn<(p: OpParams) => Promise<BrowserOpOutput>>(async () => ({
      text: `${m} ok`
    }))
  }
  return backend
}

/** 后端一共被调了几次（没实现的方法不算） */
const backendCalls = (b: FakeBackend): number =>
  METHODS.reduce((n, m) => n + (b[m]?.mock.calls.length ?? 0), 0)

// ─── 假安全门 ─────────────────────────────────────────────────────────────

interface GateSpies {
  navigate: Mock<(url: string, ctx: BrowserGateContext) => Promise<void>>
  fileRead: Mock<(path: string, ctx: BrowserGateContext) => Promise<string>>
  fileWrite: Mock<(path: string, ctx: BrowserGateContext) => Promise<string>>
}

/** 三道门都放行；两道文件门把路径解析成 `/abs/<原样>` */
function spyGates(): GateSpies {
  return {
    navigate: vi.fn<(url: string, ctx: BrowserGateContext) => Promise<void>>(async () => {}),
    fileRead: vi.fn<(path: string, ctx: BrowserGateContext) => Promise<string>>(
      async (p) => `/abs/${p}`
    ),
    fileWrite: vi.fn<(path: string, ctx: BrowserGateContext) => Promise<string>>(
      async (p) => `/abs/${p}`
    )
  }
}

const gateCalls = (g: GateSpies): number =>
  g.navigate.mock.calls.length + g.fileRead.mock.calls.length + g.fileWrite.mock.calls.length

// ─── 协议线束 ─────────────────────────────────────────────────────────────

interface ContentItem {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

interface ToolResult {
  content: ContentItem[]
  isError?: boolean
}

type Meta = Record<string, unknown>

interface Harness {
  client: Client
  clientTransport: Transport
  backend: FakeBackend
  call(name: string, args?: OpParams, meta?: Meta, signal?: AbortSignal): Promise<ToolResult>
}

interface OpenOpts {
  backend?: FakeBackend
  caps?: BrowserCaps
  gates?: BrowserMcpGates
  hostNote?: string
  serverOptions?: BrowserMcpServerOptions['serverOptions']
  onClose?: () => void
  /** 进程级的 tab 队列（H4）；不给 = 这台 server 自己一份 */
  tabQueue?: BrowserTabQueue
}

const clients: Client[] = []

afterEach(async () => {
  // 关连接会中止还挂着的处理函数（卡死的后端调用也就此放手）
  for (const c of clients.splice(0)) await c.close().catch(() => {})
})

function wrapClient(client: Client, clientTransport: Transport, backend: FakeBackend): Harness {
  clients.push(client)
  return {
    client,
    clientTransport,
    backend,
    call: async (name, args = {}, meta, signal) =>
      (await client.callTool(
        { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
        undefined,
        signal ? { signal } : undefined
      )) as unknown as ToolResult
  }
}

/** 造一台 browser server 接到一对真 InMemoryTransport 上，再连一个真 Client */
async function open(opts: OpenOpts = {}): Promise<Harness> {
  const backend = opts.backend ?? fakeBackend(opts.caps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await connectBrowserMcpServer(
    {
      backend: backend as unknown as BrowserBackend,
      gates: opts.gates,
      hostNote: opts.hostNote,
      serverOptions: opts.serverOptions,
      onClose: opts.onClose,
      tabQueue: opts.tabQueue
    },
    serverTransport
  )
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  return wrapClient(client, clientTransport, backend)
}

const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n')

/** 一条失败结果：isError 且只有这一句 */
function expectFailure(r: ToolResult, message: string): void {
  expect(r.isError).toBe(true)
  expect(r.content).toEqual([{ type: 'text', text: message }])
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T = BrowserOpOutput>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 让已经排上的回调都跑完（几轮宏任务）—— 「没有发生」的断言之前用 */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

/**
 * promise 必须在 ms 内落定；没落定当场判红，不拖到用例超时。
 * 这里等的都不经过计时器（微任务就能走完），上限只是兜底，留足全量并发跑时的余量。
 */
async function within<T>(work: Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// ─── T10 工具清单过线 ─────────────────────────────────────────────────────

describe('T10 tools/list 过线之后', () => {
  it('T10 与目录逐项相同（含接在 list_tabs 后的宿主说明），再列一次不变', async () => {
    const h = await open({ hostNote: 'Tabs live in the built-in panel.' })
    const tools = (await h.client.listTools()).tools
    expect(tools).toEqual(browserToolsForCaps(DESKTOP, 'Tabs live in the built-in panel.'))
    expect((await h.client.listTools()).tools).toEqual(tools)
    expect(backendCalls(h.backend)).toBe(0)
  })

  it('T10 扩展的后端：线上没有 upload_file / pdf', async () => {
    const h = await open({ caps: EXTENSION })
    const names = (await h.client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(browserToolsForCaps(EXTENSION).map((t) => t.name))
    expect(names).not.toContain('upload_file')
    expect(names).not.toContain('pdf')
  })
})

// ─── D 分发 ──────────────────────────────────────────────────────────────

/** [工具, 实参, 该调到的后端方法（null = 不碰后端）, 该方法收到的实参列表] */
const DISPATCH: Array<[string, OpParams, Method | null, unknown[]]> = [
  ['list_tabs', {}, 'listTabs', []],
  ['open_tab', { url: 'https://a.com/' }, 'openTab', [{ url: 'https://a.com/' }]],
  ['close_tab', { tabId: 't1' }, 'closeTab', [{ tabId: 't1' }]],
  [
    'navigate',
    { tabId: 't1', url: 'https://a.com/x' },
    'navigate',
    [{ tabId: 't1', nav: 'goto', url: 'https://a.com/x' }]
  ],
  ['snapshot', { tabId: 't1' }, 'snapshot', [{ tabId: 't1', full: true, viewer: '' }]],
  ['read_page', { tabId: 't1' }, 'readPage', [{ tabId: 't1' }]],
  [
    'screenshot',
    { tabId: 't1', fullPage: true, uid: 'e3' },
    'screenshot',
    [{ tabId: 't1', fullPage: true, uid: 'e3' }]
  ],
  ['click', { tabId: 't1', uid: 'e1' }, 'click', [{ tabId: 't1', uid: 'e1' }]],
  [
    'fill',
    { tabId: 't1', uid: 'e1', text: 'hello' },
    'fill',
    [{ tabId: 't1', uid: 'e1', text: 'hello' }]
  ],
  [
    'type',
    { tabId: 't1', text: 'q', uid: 'e2', submitKey: 'Enter' },
    'type',
    [{ tabId: 't1', text: 'q', uid: 'e2', submitKey: 'Enter' }]
  ],
  ['press_key', { tabId: 't1', key: 'Control+A' }, 'pressKey', [{ tabId: 't1', key: 'Control+A' }]],
  ['hover', { tabId: 't1', uid: 'e4' }, 'hover', [{ tabId: 't1', uid: 'e4' }]],
  [
    'upload_file',
    { tabId: 't1', uid: 'e5', paths: ['/tmp/a.txt', '/tmp/b.txt'] },
    'uploadFile',
    [{ tabId: 't1', uid: 'e5', paths: ['/tmp/a.txt', '/tmp/b.txt'] }]
  ],
  [
    'scroll',
    { tabId: 't1', direction: 'up', amount: 120, uid: 'e6' },
    'scroll',
    [{ tabId: 't1', direction: 'up', amount: 120, uid: 'e6' }]
  ],
  [
    'wait_for',
    { tabId: 't1', text: 'Done', timeout: 3000 },
    'waitFor',
    [{ tabId: 't1', text: 'Done', timeout: 3000, signal: expect.any(AbortSignal) }]
  ],
  [
    'evaluate',
    { tabId: 't1', expression: 'document.title' },
    'evaluate',
    [{ tabId: 't1', expression: 'document.title' }]
  ],
  ['network', { tabId: 't1', limit: 5 }, 'network', [{ tabId: 't1', limit: 5 }]],
  ['console', { tabId: 't1', limit: 7 }, 'console', [{ tabId: 't1', limit: 7 }]],
  [
    'pdf',
    { tabId: 't1', outputPath: '/tmp/o.pdf', pageSize: 'Letter', landscape: true, scale: 0.5 },
    'pdf',
    [{ tabId: 't1', outputPath: '/tmp/o.pdf', pageSize: 'Letter', landscape: true, scale: 0.5 }]
  ],
  [
    'cdp',
    { tabId: 't1', method: 'DOM.getDocument', params: { depth: 2 } },
    'cdp',
    [{ tabId: 't1', method: 'DOM.getDocument', params: { depth: 2 } }]
  ],
  [
    'events',
    { tabId: 't1', event: 'Network.responseReceived', sinceSeq: 3, limit: 10 },
    'events',
    [{ tabId: 't1', event: 'Network.responseReceived', sinceSeq: 3, limit: 10 }]
  ],
  ['cdp_recipes', {}, null, []]
]

/** 某个后端方法唯一一次调用收到的对象 */
function onlyCall(b: FakeBackend, m: Method): OpParams {
  expect(b[m]).toHaveBeenCalledTimes(1)
  return b[m].mock.calls[0][0]
}

describe('D 分发与参数', () => {
  it('D1 分发表覆盖目录里的每一个工具', () => {
    expect(DISPATCH.map(([name]) => name).sort()).toEqual(
      browserToolsForCaps(DESKTOP)
        .map((t) => t.name)
        .sort()
    )
  })

  it.each(DISPATCH)(
    'D1 %s → 恰好调一次对应的后端方法、收到的就是这个对象',
    async (name, args, method, expected) => {
      const h = await open()
      const r = await h.call(name, args)
      expect(r.isError).toBeFalsy()
      if (method) {
        expect(r.content).toEqual([{ type: 'text', text: `${method} ok` }])
        expect(h.backend[method].mock.calls).toEqual([expected])
      }
      for (const m of METHODS) {
        if (m !== method) expect(h.backend[m], m).not.toHaveBeenCalled()
      }
    }
  )

  it.each<[string, OpParams, Method, string[]]>([
    ['screenshot', { tabId: 't1' }, 'screenshot', ['fullPage', 'uid']],
    ['type', { tabId: 't1', text: 'q' }, 'type', ['uid', 'submitKey']],
    ['scroll', { tabId: 't1' }, 'scroll', ['direction', 'amount', 'uid']],
    ['wait_for', { tabId: 't1', text: 'x' }, 'waitFor', ['timeout']],
    ['network', { tabId: 't1' }, 'network', ['limit']],
    ['console', { tabId: 't1' }, 'console', ['limit']],
    ['pdf', { tabId: 't1', outputPath: '/o.pdf' }, 'pdf', ['pageSize', 'landscape', 'scale']],
    ['cdp', { tabId: 't1', method: 'DOM.getDocument' }, 'cdp', ['params']],
    ['events', { tabId: 't1' }, 'events', ['event', 'sinceSeq', 'limit']]
  ])('D2 %s 没给的可选参数到后端是 undefined', async (name, args, method, optional) => {
    const h = await open()
    await h.call(name, args)
    const got = onlyCall(h.backend, method)
    for (const [k, v] of Object.entries(args)) expect(got[k], k).toBe(v)
    for (const k of optional) expect(got[k], k).toBeUndefined()
  })

  it.each<[string, OpParams, Method, OpParams]>([
    ['screenshot', { tabId: 't1', uid: '' }, 'screenshot', { uid: undefined }],
    [
      'type',
      { tabId: 't1', text: 'q', uid: '', submitKey: '' },
      'type',
      { text: 'q', uid: undefined, submitKey: undefined }
    ],
    [
      'scroll',
      { tabId: 't1', direction: '', amount: '', uid: '' },
      'scroll',
      { direction: undefined, amount: undefined, uid: undefined }
    ],
    ['scroll', { tabId: 't1', amount: '   ' }, 'scroll', { amount: undefined }],
    ['wait_for', { tabId: 't1', text: 'x', timeout: '' }, 'waitFor', { timeout: undefined }],
    ['network', { tabId: 't1', limit: ' ' }, 'network', { limit: undefined }],
    [
      'pdf',
      { tabId: 't1', outputPath: '/o.pdf', pageSize: '', scale: '' },
      'pdf',
      { pageSize: undefined, scale: undefined }
    ],
    [
      'events',
      { tabId: 't1', event: '', sinceSeq: '', limit: '' },
      'events',
      { event: undefined, sinceSeq: undefined, limit: undefined }
    ],
    [
      'navigate',
      { tabId: 't1', nav: '', url: 'https://a.com/' },
      'navigate',
      { nav: 'goto', url: 'https://a.com/' }
    ]
  ])('D3 %s 的可选参数给空串 = 没给', async (name, args, method, expected) => {
    const h = await open()
    const r = await h.call(name, args)
    expect(r.isError).toBeFalsy()
    const got = onlyCall(h.backend, method)
    for (const [k, v] of Object.entries(expected)) expect(got[k], k).toBe(v)
  })

  it.each<[string, OpParams, Method, OpParams]>([
    ['scroll', { tabId: 't1', amount: '250' }, 'scroll', { amount: 250 }],
    ['scroll', { tabId: 't1', amount: ' 250 ' }, 'scroll', { amount: 250 }],
    [
      'pdf',
      { tabId: 't1', outputPath: '/o.pdf', scale: '1.5', landscape: 'true' },
      'pdf',
      { scale: 1.5, landscape: true }
    ],
    ['pdf', { tabId: 't1', outputPath: '/o.pdf', landscape: 'false' }, 'pdf', { landscape: false }],
    ['wait_for', { tabId: 't1', text: 'x', timeout: '500' }, 'waitFor', { timeout: 500 }],
    ['network', { tabId: 't1', limit: '5' }, 'network', { limit: 5 }],
    ['events', { tabId: 't1', sinceSeq: '3', limit: '10' }, 'events', { sinceSeq: 3, limit: 10 }],
    ['screenshot', { tabId: 't1', fullPage: 'true' }, 'screenshot', { fullPage: true }],
    ['screenshot', { tabId: 't1', fullPage: 'false' }, 'screenshot', { fullPage: false }]
  ])('D4 %s：数字字符串转数字，"true"/"false" 转布尔', async (name, args, method, expected) => {
    const h = await open()
    const r = await h.call(name, args)
    expect(r.isError).toBeFalsy()
    const got = onlyCall(h.backend, method)
    for (const [k, v] of Object.entries(expected)) expect(got[k], k).toBe(v)
  })

  it.each<[string, OpParams, string]>([
    ['click', { tabId: 't1', uid: 7 }, '"uid" must be a string.'],
    ['scroll', { tabId: 5 }, '"tabId" must be a string.'],
    ['scroll', { tabId: 't1', amount: 'far' }, '"amount" must be a number.'],
    ['scroll', { tabId: 't1', amount: true }, '"amount" must be a number.'],
    ['snapshot', { tabId: 't1', full: 'yes' }, '"full" must be true or false.'],
    ['snapshot', { tabId: 't1', full: 1 }, '"full" must be true or false.'],
    ['screenshot', { tabId: 't1', fullPage: '' }, '"fullPage" must be true or false.'],
    [
      'scroll',
      { tabId: 't1', direction: 'sideways' },
      '"direction" must be one of "up", "down", "left", "right".'
    ],
    ['scroll', { tabId: 't1', direction: 3 }, '"direction" must be a string.'],
    [
      'navigate',
      { tabId: 't1', nav: 'home', url: 'https://a.com/' },
      '"nav" must be one of "goto", "back", "forward", "reload".'
    ],
    [
      'cdp',
      { tabId: 't1', method: 'DOM.getDocument', params: 'depth=1' },
      '"params" must be an object.'
    ],
    ['cdp', { tabId: 't1', method: 'DOM.getDocument', params: [1] }, '"params" must be an object.'],
    [
      'upload_file',
      { tabId: 't1', uid: 'e1', paths: [] },
      '"paths" must be a non-empty list of file paths.'
    ],
    [
      'upload_file',
      { tabId: 't1', uid: 'e1', paths: '/tmp/a.txt' },
      '"paths" must be a non-empty list of file paths.'
    ],
    [
      'upload_file',
      { tabId: 't1', uid: 'e1', paths: ['/tmp/a.txt', '  '] },
      '"paths" must be a non-empty list of file paths.'
    ],
    [
      'upload_file',
      { tabId: 't1', uid: 'e1', paths: ['/tmp/a.txt', 5] },
      '"paths" must be a non-empty list of file paths.'
    ],
    [
      'pdf',
      { tabId: 't1', outputPath: '/o.pdf', landscape: 'yes' },
      '"landscape" must be true or false.'
    ],
    ['pdf', { tabId: 't1', outputPath: '/o.pdf', scale: 'big' }, '"scale" must be a number.'],
    ['wait_for', { tabId: 't1', text: 5 }, '"text" must be a string.'],
    ['events', { tabId: 't1', sinceSeq: 'x' }, '"sinceSeq" must be a number.']
  ])('D5 %s %j → 逐字报类型错，后端与门一个都不碰', async (name, args, message) => {
    const gates = spyGates()
    const h = await open({ gates })
    expectFailure(await h.call(name, args), message)
    expect(backendCalls(h.backend)).toBe(0)
    expect(gateCalls(gates)).toBe(0)
  })

  it.each<[string, BrowserCaps, string]>([
    ['help', DESKTOP, '旧 multiplex 工具的 help 动作'],
    ['browser', DESKTOP, '旧 multiplex 工具本身'],
    ['SNAPSHOT', DESKTOP, '大小写敏感'],
    ['toString', DESKTOP, '原型链上的名字'],
    ['__proto__', DESKTOP, '原型链上的名字'],
    ['upload_file', EXTENSION, '扩展没有这个能力'],
    ['pdf', EXTENSION, '扩展没有这个能力'],
    ['cdp_recipes', MINIMAL, '没有原生 cdp'],
    ['evaluate', MINIMAL, '关掉了 evaluate']
  ])('D6 %s（%#）→ Unknown tool，连接照旧可用', async (name, caps) => {
    const h = await open({ caps })
    expectFailure(
      await h.call(name, { tabId: 't1', paths: ['/a'], outputPath: '/o.pdf' }),
      `Unknown tool "${name}".`
    )
    expect(backendCalls(h.backend)).toBe(0)
    expect(textOf(await h.call('list_tabs'))).toBe('listTabs ok')
  })

  it.each<[string, OpParams, string]>([
    ['click', {}, 'Missing required parameters "tabId", "uid".'],
    ['click', { tabId: 't1' }, 'Missing required parameter "uid".'],
    ['click', { tabId: '', uid: '' }, 'Missing required parameters "tabId", "uid".'],
    ['click', { tabId: null, uid: 'e1' }, 'Missing required parameter "tabId".'],
    ['fill', { text: 'x' }, 'Missing required parameters "tabId", "uid".'],
    ['fill', { tabId: 't1', uid: 'e1' }, 'Missing required parameter "text".'],
    ['fill', { tabId: 't1', uid: 'e1', text: null }, 'Missing required parameter "text".'],
    ['upload_file', {}, 'Missing required parameters "tabId", "uid", "paths".'],
    ['open_tab', {}, 'Missing required parameter "url".'],
    ['open_tab', { url: '' }, 'Missing required parameter "url".'],
    ['type', { tabId: 't1', text: '' }, 'Missing required parameter "text".'],
    ['press_key', { tabId: 't1', key: '' }, 'Missing required parameter "key".'],
    ['wait_for', { tabId: 't1' }, 'Missing required parameter "text".'],
    ['evaluate', { tabId: 't1', expression: '' }, 'Missing required parameter "expression".'],
    ['pdf', { tabId: 't1' }, 'Missing required parameter "outputPath".'],
    ['cdp', { method: 'DOM.getDocument' }, 'Missing required parameter "tabId".'],
    ['cdp', { tabId: 't1' }, 'Missing required parameter "method".'],
    ['close_tab', {}, 'Missing required parameter "tabId".']
  ])('D7 %s %j → 按必填表的顺序列出缺的（缺席、null、空串都算缺）', async (name, args, message) => {
    const gates = spyGates()
    const h = await open({ gates })
    expectFailure(await h.call(name, args), message)
    expect(backendCalls(h.backend)).toBe(0)
    expect(gateCalls(gates)).toBe(0)
  })

  it('D7 fill 的 text 可以是空串（清空字段），照常分发', async () => {
    const h = await open()
    const r = await h.call('fill', { tabId: 't1', uid: 'e1', text: '' })
    expect(r.isError).toBeFalsy()
    expect(h.backend.fill.mock.calls).toEqual([[{ tabId: 't1', uid: 'e1', text: '' }]])
  })

  it.each<[string, OpParams]>([
    ['不给 url', { tabId: 't1' }],
    ['nav 写明 goto、url 是空串', { tabId: 't1', nav: 'goto', url: '' }]
  ])('D8 navigate goto %s → 「goto 要 url」', async (_l, args) => {
    const gates = spyGates()
    const h = await open({ gates })
    expectFailure(await h.call('navigate', args), '"url" is required for navigate (goto).')
    expect(backendCalls(h.backend)).toBe(0)
    expect(gateCalls(gates)).toBe(0)
  })

  it('D8 navigate 的 url 若给了也必须是字符串（哪怕 nav 用不上它）', async () => {
    const h = await open()
    expectFailure(
      await h.call('navigate', { tabId: 't1', nav: 'back', url: 5 }),
      '"url" must be a string.'
    )
  })

  describe('D9 导航目标必须是带协议的绝对地址', () => {
    const refusals: Array<[string, string]> = [
      [
        'example.com',
        '"example.com" is not an absolute URL — include the scheme, e.g. https://example.com.'
      ],
      [
        'www.example.com/path?q=1',
        '"www.example.com/path?q=1" is not an absolute URL — include the scheme, e.g. https://www.example.com/path?q=1.'
      ],
      [
        'localhost:3000',
        '"localhost:3000" is not an absolute URL — include the scheme, e.g. https://localhost:3000.'
      ],
      [
        'localhost:3000/app',
        '"localhost:3000/app" is not an absolute URL — include the scheme, e.g. https://localhost:3000/app.'
      ],
      [
        'example.com:8080',
        '"example.com:8080" is not an absolute URL — include the scheme, e.g. https://example.com:8080.'
      ],
      ['http://', '"http://" is not an absolute URL.'],
      ['https://exa mple.com/', '"https://exa mple.com/" is not an absolute URL.'],
      [
        'javascript:alert(1)',
        'javascript: URLs are not navigated to — run code in the page with evaluate.'
      ],
      [
        'JavaScript:void(0)',
        'javascript: URLs are not navigated to — run code in the page with evaluate.'
      ]
    ]

    /** 四条导航入口：[工具, 由目标造出实参, 后端方法] */
    const entries: Array<[string, (url: string) => OpParams, Method]> = [
      ['open_tab', (url) => ({ url }), 'openTab'],
      ['navigate', (url) => ({ tabId: 't1', url }), 'navigate'],
      [
        'cdp Page.navigate',
        (url) => ({ tabId: 't1', method: 'Page.navigate', params: { url } }),
        'cdp'
      ],
      [
        'cdp Network.loadNetworkResource',
        (url) => ({
          tabId: 't1',
          method: 'Network.loadNetworkResource',
          params: { frameId: 'F', url, options: { disableCache: true, includeCredentials: false } }
        }),
        'cdp'
      ]
    ]

    it.each(refusals)('D9 open_tab %s → 拒绝，门与后端都不碰', async (url, message) => {
      const gates = spyGates()
      const h = await open({ gates })
      expectFailure(await h.call('open_tab', { url }), message)
      expect(backendCalls(h.backend)).toBe(0)
      expect(gateCalls(gates)).toBe(0)
    })

    it.each(entries)('D9 %s 走同一套判定', async (label, argsOf, method) => {
      const gates = spyGates()
      const h = await open({ gates })
      for (const [url, message] of refusals.filter(([u]) =>
        ['example.com', 'localhost:3000', 'javascript:alert(1)'].includes(u)
      )) {
        const tool = label.startsWith('cdp') ? 'cdp' : label
        expectFailure(await h.call(tool, argsOf(url)), message)
      }
      expect(h.backend[method]).not.toHaveBeenCalled()
      expect(gateCalls(gates)).toBe(0)
    })

    it('D9 端上关掉了 evaluate → javascript: 的拒绝不再指向 evaluate', async () => {
      const h = await open({ caps: { ...DESKTOP, evaluate: false } })
      expectFailure(
        await h.call('open_tab', { url: 'javascript:alert(1)' }),
        'javascript: URLs are not navigated to.'
      )
    })

    it.each([
      'https://a.com/',
      'http://localhost:3000/',
      'file:///tmp/a.html',
      'about:blank',
      'data:text/html,<p>hi</p>'
    ])('D9 %s 放行，原样交给后端', async (url) => {
      const h = await open()
      expect((await h.call('open_tab', { url })).isError).toBeFalsy()
      expect(h.backend.openTab.mock.calls).toEqual([[{ url }]])
      expect((await h.call('navigate', { tabId: 't1', url })).isError).toBeFalsy()
      expect(onlyCall(h.backend, 'navigate')).toEqual({ tabId: 't1', nav: 'goto', url })
    })
  })

  it.each([
    'Browser.close',
    'Browser.setDownloadBehavior',
    'Target.createTarget',
    'Tracing.start',
    'SystemInfo.getInfo',
    'Tethering.bind',
    'Page.close',
    'Page.crash',
    'Security.setIgnoreCertificateErrors',
    'Network.setUserAgentOverride',
    'Foo.bar',
    'Network',
    'Network.'
  ])('D10 cdp %s → 拒绝并给出拦截表的原因，门与后端都不碰', async (method) => {
    const gates = spyGates()
    const h = await open({ gates })
    const reason = blockedCdpReason(method)
    expect(reason).toBeTruthy()
    expectFailure(
      await h.call('cdp', { tabId: 't1', method, params: { url: 'file:///x', files: ['a'] } }),
      `CDP method "${method}" is blocked: ${reason}.`
    )
    expect(backendCalls(h.backend)).toBe(0)
    expect(gateCalls(gates)).toBe(0)
  })

  it('D10 拦截原因逐字（指向替代做法）', async () => {
    const h = await open()
    const blocked = async (method: string): Promise<string> =>
      textOf(await h.call('cdp', { tabId: 't1', method }))
    expect(await blocked('Page.close')).toBe(
      'CDP method "Page.close" is blocked: closes the tab out-of-band — use close_tab instead.'
    )
    expect(await blocked('Network.setUserAgentOverride')).toBe(
      'CDP method "Network.setUserAgentOverride" is blocked: use Emulation.setUserAgentOverride instead.'
    )
    expect(await blocked('Network')).toBe(
      'CDP method "Network" is blocked: malformed method — expected "Domain.method".'
    )
    expect(await blocked('Foo.bar')).toBe(
      'CDP method "Foo.bar" is blocked: unknown CDP domain "Foo".'
    )
  })

  it('D10 放行的方法：params 原样交给后端（uid 宏由后端解析，server 不动它）', async () => {
    const h = await open()
    const params = {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      nested: { backendNodeId: { $uid: 'e7' }, list: [{ $uidX: 'e7' }] }
    }
    await h.call('cdp', { tabId: 't1', method: 'Emulation.setDeviceMetricsOverride', params })
    expect(h.backend.cdp.mock.calls).toEqual([
      [{ tabId: 't1', method: 'Emulation.setDeviceMetricsOverride', params }]
    ])
  })

  it('D11 cdp_recipes 回的就是按这台 server 的 caps 生成的配方，不碰后端', async () => {
    const desktop = await open()
    const ext = await open({ caps: EXTENSION })
    const d = await desktop.call('cdp_recipes')
    const e = await ext.call('cdp_recipes')
    expect(d.content).toEqual([{ type: 'text', text: devtoolsRecipes(DESKTOP) }])
    expect(e.content).toEqual([{ type: 'text', text: devtoolsRecipes(EXTENSION) }])
    expect(textOf(d)).not.toBe(textOf(e))
    expect(backendCalls(desktop.backend) + backendCalls(ext.backend)).toBe(0)
    expectFailure(
      await (await open({ caps: MINIMAL })).call('cdp_recipes'),
      'Unknown tool "cdp_recipes".'
    )
  })

  it.each<[string, OpParams]>([
    ['合法值', { tabId: 't1', fullPage: true, uid: 'e3' }],
    ['类型都不对', { tabId: 't1', fullPage: 'yes', uid: 5 }]
  ])('D12 端上没有的截图参数（%s）被忽略：不报错、到后端是 undefined', async (_l, args) => {
    const h = await open({ caps: EXTENSION })
    const r = await h.call('screenshot', args)
    expect(r.isError).toBeFalsy()
    expect(h.backend.screenshot.mock.calls).toEqual([
      [{ tabId: 't1', fullPage: undefined, uid: undefined }]
    ])
  })

  it('D13 caps 声称有、后端却没实现 → 这一次 isError，server 不崩', async () => {
    const h = await open({
      backend: fakeBackend(DESKTOP, ['uploadFile', 'evaluate', 'pdf', 'cdp'])
    })
    for (const [name, args] of [
      ['upload_file', { tabId: 't1', uid: 'e1', paths: ['/a'] }],
      ['evaluate', { tabId: 't1', expression: '1' }],
      ['pdf', { tabId: 't1', outputPath: '/o.pdf' }],
      ['cdp', { tabId: 't1', method: 'DOM.getDocument' }]
    ] as Array<[string, OpParams]>) {
      const r = await h.call(name, args)
      expect(r.isError, name).toBe(true)
      expect(textOf(r), name).not.toBe('')
    }
    expect(textOf(await h.call('scroll', { tabId: 't1' }))).toBe('scroll ok')
  })
})

// ─── R 结果翻译 ──────────────────────────────────────────────────────────

describe('R 后端输出 → MCP 结果', () => {
  /** 让 read_page 回给定的输出 */
  async function readPageReturning(out: BrowserOpOutput): Promise<ToolResult> {
    const h = await open()
    h.backend.readPage.mockResolvedValueOnce(out)
    return h.call('read_page', { tabId: 't1' })
  }

  it('R1 先文本、后图片（按原顺序），不标 isError', async () => {
    const h = await open()
    h.backend.screenshot.mockResolvedValueOnce({
      text: 'shot',
      images: [
        { data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { data: '/9j/4AAQ', mimeType: 'image/jpeg' }
      ]
    })
    const r = await h.call('screenshot', { tabId: 't1' })
    expect(r.isError).toBeUndefined()
    expect(r.content).toEqual([
      { type: 'text', text: 'shot' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' }
    ])
  })

  it.each<[string, BrowserOpOutput, ContentItem[]]>([
    ['什么都没有', {}, [{ type: 'text', text: '' }]],
    [
      '只有图片',
      { images: [{ data: 'AAAA', mimeType: 'image/png' }] },
      [
        { type: 'text', text: '' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]
    ]
  ])('R2 没有文本（%s）→ 仍以一个空文本块打头', async (_l, out, content) => {
    const r = await readPageReturning(out)
    expect(r.isError).toBeUndefined()
    expect(r.content).toEqual(content)
  })

  it.each<[string, BrowserOpOutput, string]>([
    ['「Error: 」开头', { text: 'Error: boom', details: { error: 'boom' } }, 'boom'],
    ['前缀后多个空白', { text: 'Error:   boom', details: { error: 'x' } }, 'boom'],
    [
      '没有前缀的原样保留',
      { text: 'Timeout: text "a" not found after 1000ms.', details: { error: 'timeout' } },
      'Timeout: text "a" not found after 1000ms.'
    ],
    [
      '只去开头那一层',
      { text: 'CDP error (X.y): Error: boom', details: { error: 'boom' } },
      'CDP error (X.y): Error: boom'
    ],
    ['没有文本 → 用 details.error', { details: { error: 'aborted' } }, 'aborted'],
    [
      '只有前缀 → 用 details.error',
      { text: 'Error: ', details: { error: 'fallback' } },
      'fallback'
    ],
    [
      '带图片的失败只回文本',
      {
        text: 'Error: covered',
        images: [{ data: 'AAAA', mimeType: 'image/png' }],
        details: { error: 'covered' }
      },
      'covered'
    ],
    ['details.error 是数字', { text: 'Error: 42', details: { error: 42 } }, '42'],
    ['details.error 是 true、没有文本', { details: { error: true } }, 'true'],
    [
      'details.error 是对象、有文本',
      { text: 'went wrong', details: { error: { code: 7 } } },
      'went wrong'
    ]
  ])('R3 业务失败（%s）→ isError，只回一句', async (_l, out, message) => {
    expectFailure(await readPageReturning(out), message)
  })

  it.each<[string, unknown]>([
    ['false', false],
    ['空串', ''],
    ['null', null],
    ['undefined', undefined]
  ])('R3 details.error 为 %s 不算失败', async (_l, error) => {
    const r = await readPageReturning({
      text: 'page md',
      details: { error, url: 'https://a.com/' }
    })
    expect(r.isError).toBeUndefined()
    expect(r.content).toEqual([{ type: 'text', text: 'page md' }])
  })

  it.each<[string, unknown, string]>([
    ['Error', new Error('no such tab'), 'no such tab'],
    ['字符串', 'tab crashed', 'tab crashed'],
    ['数字', 42, '42']
  ])('R4 后端抛出 %s → isError，文本是它的 message / 字符串形式', async (_l, thrown, message) => {
    const h = await open()
    h.backend.click.mockRejectedValueOnce(thrown)
    expectFailure(await h.call('click', { tabId: 't1', uid: 'e1' }), message)
    // 这个 tab 没被一次失败卡住
    expect(textOf(await h.call('click', { tabId: 't1', uid: 'e1' }))).toBe('click ok')
  })
})

// ─── G 安全门 ────────────────────────────────────────────────────────────

const TC = { 'shuvix.dev/toolCallId': 'tc-7' }

describe('G 安全门', () => {
  it('G1 open_tab：先问一次导航门（路由键、完整工具名、一句说明），放行后才开', async () => {
    const timeline: string[] = []
    const gates = spyGates()
    gates.navigate.mockImplementation(async (url) => void timeline.push(`gate ${url}`))
    const h = await open({ gates })
    h.backend.openTab.mockImplementation(async (p) => {
      timeline.push(`openTab ${String(p.url)}`)
      return { text: 'opened t2' }
    })

    const r = await h.call('open_tab', { url: 'file:///tmp/report.html' }, TC)
    expect(textOf(r)).toBe('opened t2')
    expect(gates.navigate.mock.calls).toEqual([
      [
        'file:///tmp/report.html',
        {
          toolCallId: 'tc-7',
          toolName: 'mcp__browser__open_tab',
          description: 'Open file:///tmp/report.html'
        }
      ]
    ])
    expect(timeline).toEqual(['gate file:///tmp/report.html', 'openTab file:///tmp/report.html'])
    expect(gates.fileRead).not.toHaveBeenCalled()
    expect(gates.fileWrite).not.toHaveBeenCalled()
  })

  it.each<[string, string, OpParams, Method]>([
    ['open_tab', 'open_tab', { url: 'file:///etc/hosts' }, 'openTab'],
    ['navigate goto', 'navigate', { tabId: 't1', url: 'file:///etc/hosts' }, 'navigate']
  ])('G1/G2 %s：门拒绝 → 门的原话作为失败回去，后端不碰', async (_l, name, args, method) => {
    const gates = spyGates()
    gates.navigate.mockRejectedValueOnce(
      new Error('Access denied by policy protect-system: /etc/hosts')
    )
    const h = await open({ gates })
    expectFailure(
      await h.call(name, args, TC),
      'Access denied by policy protect-system: /etc/hosts'
    )
    expect(h.backend[method]).not.toHaveBeenCalled()
  })

  it('G2 navigate goto：同一道门，工具名是 navigate', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    await h.call('navigate', { tabId: 't1', url: 'https://a.com/' }, TC)
    expect(gates.navigate.mock.calls).toEqual([
      [
        'https://a.com/',
        {
          toolCallId: 'tc-7',
          toolName: 'mcp__browser__navigate',
          description: 'Open https://a.com/'
        }
      ]
    ])
    expect(onlyCall(h.backend, 'navigate')).toEqual({
      tabId: 't1',
      nav: 'goto',
      url: 'https://a.com/'
    })
  })

  it.each(['back', 'forward', 'reload'])(
    'G3 navigate %s 不问门（哪怕顺手带了个 url）',
    async (nav) => {
      const gates = spyGates()
      const h = await open({ gates })
      await h.call('navigate', { tabId: 't1', nav, url: 'javascript:alert(1)' })
      expect(gateCalls(gates)).toBe(0)
      expect(h.backend.navigate.mock.calls).toEqual([[{ tabId: 't1', nav, url: undefined }]])
    }
  )

  it('G4 upload_file：逐个过读门，前一个落定才问下一个；解析后的路径按原顺序交给后端', async () => {
    const gates = spyGates()
    const pending: Array<Deferred<string>> = []
    gates.fileRead.mockImplementation(() => {
      const d = deferred<string>()
      pending.push(d)
      return d.promise
    })
    const h = await open({ gates })
    const result = h.call(
      'upload_file',
      { tabId: 't1', uid: 'e5', paths: ['a.txt', 'b.txt', 'c.txt'] },
      TC
    )

    for (const [i, name] of ['a.txt', 'b.txt', 'c.txt'].entries()) {
      await vi.waitFor(() => expect(gates.fileRead).toHaveBeenCalledTimes(i + 1))
      await settle()
      // 这一个没落定之前，下一个不问
      expect(gates.fileRead).toHaveBeenCalledTimes(i + 1)
      expect(gates.fileRead.mock.calls[i]).toEqual([
        name,
        {
          toolCallId: 'tc-7',
          toolName: 'mcp__browser__upload_file',
          description: 'Upload to the web page in tab t1'
        }
      ])
      expect(h.backend.uploadFile).not.toHaveBeenCalled()
      pending[i].resolve(`/ws/${name}`)
    }
    expect((await result).isError).toBeFalsy()
    expect(h.backend.uploadFile.mock.calls).toEqual([
      [{ tabId: 't1', uid: 'e5', paths: ['/ws/a.txt', '/ws/b.txt', '/ws/c.txt'] }]
    ])
  })

  it('G4 第二个路径被拒 → 停在那里：第三个不问，后端不碰，门的原话回去', async () => {
    const gates = spyGates()
    gates.fileRead.mockImplementation(async (p) => {
      if (p === 'b.txt') throw new Error('Access denied: b.txt is outside the workspace')
      return `/ws/${p}`
    })
    const h = await open({ gates })
    expectFailure(
      await h.call('upload_file', { tabId: 't1', uid: 'e5', paths: ['a.txt', 'b.txt', 'c.txt'] }),
      'Access denied: b.txt is outside the workspace'
    )
    expect(gates.fileRead.mock.calls.map((c) => c[0])).toEqual(['a.txt', 'b.txt'])
    expect(h.backend.uploadFile).not.toHaveBeenCalled()
  })

  it('G5 pdf：输出位置过写门，后端拿到解析后的路径；拒绝则不导出', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    await h.call('pdf', { tabId: 't1', outputPath: 'out/page.pdf', landscape: true }, TC)
    expect(gates.fileWrite.mock.calls).toEqual([
      [
        'out/page.pdf',
        { toolCallId: 'tc-7', toolName: 'mcp__browser__pdf', description: 'Save the page as a PDF' }
      ]
    ])
    expect(h.backend.pdf.mock.calls).toEqual([
      [
        {
          tabId: 't1',
          outputPath: '/abs/out/page.pdf',
          pageSize: undefined,
          landscape: true,
          scale: undefined
        }
      ]
    ])

    gates.fileWrite.mockRejectedValueOnce(new Error('Access denied: ~/.ssh is protected'))
    expectFailure(
      await h.call('pdf', { tabId: 't1', outputPath: '~/.ssh/x.pdf' }),
      'Access denied: ~/.ssh is protected'
    )
    expect(h.backend.pdf).toHaveBeenCalledTimes(1)
  })

  it.each<[string, OpParams]>([
    ['Page.navigate', { url: 'file:///etc/hosts', transitionType: 'typed' }],
    [
      'Network.loadNetworkResource',
      {
        frameId: 'F',
        url: 'file:///etc/hosts',
        options: { disableCache: true, includeCredentials: false }
      }
    ]
  ])(
    'G6 cdp %s ≡ 导航：问同一道门（工具名是 cdp），params 原样交给后端；拒绝则不发',
    async (method, params) => {
      const gates = spyGates()
      const h = await open({ gates })
      await h.call('cdp', { tabId: 't1', method, params }, TC)
      expect(gates.navigate.mock.calls).toEqual([
        [
          'file:///etc/hosts',
          {
            toolCallId: 'tc-7',
            toolName: 'mcp__browser__cdp',
            description: 'Open file:///etc/hosts'
          }
        ]
      ])
      expect(h.backend.cdp.mock.calls).toEqual([[{ tabId: 't1', method, params }]])

      gates.navigate.mockRejectedValueOnce(new Error('Access denied: /etc/hosts'))
      expectFailure(
        await h.call('cdp', { tabId: 't1', method, params }),
        'Access denied: /etc/hosts'
      )
      expect(h.backend.cdp).toHaveBeenCalledTimes(1)
    }
  )

  it('G7 cdp DOM.setFileInputFiles ≡ upload_file：逐个过读门，文件换成解析后的路径，其余键原样', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    await h.call(
      'cdp',
      {
        tabId: 't1',
        method: 'DOM.setFileInputFiles',
        params: { files: ['a.txt', 'b.txt'], backendNodeId: 42 }
      },
      TC
    )
    expect(gates.fileRead.mock.calls).toEqual([
      [
        'a.txt',
        { toolCallId: 'tc-7', toolName: 'mcp__browser__cdp', description: 'Upload to the web page' }
      ],
      [
        'b.txt',
        { toolCallId: 'tc-7', toolName: 'mcp__browser__cdp', description: 'Upload to the web page' }
      ]
    ])
    expect(h.backend.cdp.mock.calls).toEqual([
      [
        {
          tabId: 't1',
          method: 'DOM.setFileInputFiles',
          params: { files: ['/abs/a.txt', '/abs/b.txt'], backendNodeId: 42 }
        }
      ]
    ])
  })

  it('G7 cdp DOM.setFileInputFiles 的读门也是一个一个问，第一个被拒就不问第二个', async () => {
    const gates = spyGates()
    const first = deferred<string>()
    gates.fileRead.mockImplementationOnce(() => first.promise)
    const h = await open({ gates })
    const result = h.call('cdp', {
      tabId: 't1',
      method: 'DOM.setFileInputFiles',
      params: { files: ['a.txt', 'b.txt'], nodeId: 3 }
    })
    await vi.waitFor(() => expect(gates.fileRead).toHaveBeenCalledTimes(1))
    await settle()
    expect(gates.fileRead).toHaveBeenCalledTimes(1)
    first.reject(new Error('Access denied: a.txt'))
    expectFailure(await result, 'Access denied: a.txt')
    expect(gates.fileRead).toHaveBeenCalledTimes(1)
    expect(h.backend.cdp).not.toHaveBeenCalled()
  })

  it('G7 读门不看 upload 能力：扩展上的 DOM.setFileInputFiles 照样过门（逃生口不是旁路）', async () => {
    const gates = spyGates()
    const h = await open({ caps: EXTENSION, gates })
    await h.call('cdp', {
      tabId: 't1',
      method: 'DOM.setFileInputFiles',
      params: { files: ['a.txt'] }
    })
    expect(gates.fileRead).toHaveBeenCalledTimes(1)
    expect(onlyCall(h.backend, 'cdp').params).toEqual({ files: ['/abs/a.txt'] })
  })

  it('G7b cdp Input.dispatchDragEvent 的 data.files ≡ 上传：逐个过读门，其余键（上下两层）原样', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    const params = {
      type: 'drop',
      x: 10,
      y: 20,
      modifiers: 0,
      data: {
        items: [{ mimeType: 'text/plain', data: 'hi' }],
        files: ['a.txt', 'b.txt'],
        dragOperationsMask: 1
      }
    }
    await h.call('cdp', { tabId: 't1', method: 'Input.dispatchDragEvent', params }, TC)
    expect(gates.fileRead.mock.calls.map((c) => c[0])).toEqual(['a.txt', 'b.txt'])
    expect(gates.fileRead.mock.calls[0][1]).toEqual({
      toolCallId: 'tc-7',
      toolName: 'mcp__browser__cdp',
      description: 'Upload to the web page'
    })
    expect(onlyCall(h.backend, 'cdp').params).toEqual({
      ...params,
      data: { ...params.data, files: ['/abs/a.txt', '/abs/b.txt'] }
    })
  })

  it('G7b 没带 files 的拖拽事件不问门，params 原样', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    const params = { type: 'dragEnter', x: 1, y: 2, data: { items: [], dragOperationsMask: 1 } }
    await h.call('cdp', { tabId: 't1', method: 'Input.dispatchDragEvent', params })
    expect(gateCalls(gates)).toBe(0)
    expect(onlyCall(h.backend, 'cdp').params).toEqual(params)
  })

  it('G8 cdp Page.setDownloadBehavior 的 downloadPath ≡ 一次写：过写门，换成解析后的路径', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    await h.call(
      'cdp',
      {
        tabId: 't1',
        method: 'Page.setDownloadBehavior',
        params: { behavior: 'allow', downloadPath: 'dl' }
      },
      TC
    )
    expect(gates.fileWrite.mock.calls).toEqual([
      [
        'dl',
        { toolCallId: 'tc-7', toolName: 'mcp__browser__cdp', description: 'Save downloads here' }
      ]
    ])
    expect(onlyCall(h.backend, 'cdp').params).toEqual({
      behavior: 'allow',
      downloadPath: '/abs/dl'
    })

    // 不带 downloadPath（deny / default）没有要写的位置，不问
    await h.call('cdp', {
      tabId: 't1',
      method: 'Page.setDownloadBehavior',
      params: { behavior: 'deny' }
    })
    expect(gates.fileWrite).toHaveBeenCalledTimes(1)
    expect(h.backend.cdp.mock.calls[1][0].params).toEqual({ behavior: 'deny' })
  })

  it.each([
    'Page.navigate',
    'Network.loadNetworkResource',
    'DOM.setFileInputFiles',
    'Input.dispatchDragEvent',
    'Page.setDownloadBehavior'
  ])('G9 需要过门的 cdp 方法 %s 不带 params → 不问门，params 为 undefined', async (method) => {
    const gates = spyGates()
    const h = await open({ gates })
    await h.call('cdp', { tabId: 't1', method })
    expect(gateCalls(gates)).toBe(0)
    expect(h.backend.cdp.mock.calls).toEqual([[{ tabId: 't1', method, params: undefined }]])
  })

  it.each<[string, OpParams]>([
    ['Runtime.evaluate', { expression: 'location.href' }],
    [
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
    ],
    ['Network.getResponseBody', { requestId: 'r1' }],
    ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 2 }]
  ])('G9 其余方法（%s）不问任何门', async (method, params) => {
    const gates = spyGates()
    const h = await open({ gates })
    await h.call('cdp', { tabId: 't1', method, params })
    expect(gateCalls(gates)).toBe(0)
    expect(onlyCall(h.backend, 'cdp')).toEqual({ tabId: 't1', method, params })
  })

  /** 五条受门约束的动作，以及门缺席时后端该收到的原值 / 门在场时的解析值 */
  async function runGatedOps(h: Harness): Promise<void> {
    await h.call('open_tab', { url: 'file:///tmp/a.html' })
    await h.call('upload_file', { tabId: 't1', uid: 'e1', paths: ['a.txt'] })
    await h.call('pdf', { tabId: 't1', outputPath: 'o.pdf' })
    await h.call('cdp', {
      tabId: 't1',
      method: 'DOM.setFileInputFiles',
      params: { files: ['b.txt'] }
    })
    await h.call('cdp', {
      tabId: 't1',
      method: 'Page.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: 'dl' }
    })
  }

  it.each<[string, (g: GateSpies) => BrowserMcpGates | undefined]>([
    ['没有门', () => undefined],
    ['空对象', () => ({})],
    ['只有导航门', (g) => ({ navigate: g.navigate })],
    ['只有读门', (g) => ({ fileRead: g.fileRead })],
    ['只有写门', (g) => ({ fileWrite: g.fileWrite })]
  ])('G10 %s：缺的那道门 = 这一类不设门，原值直通（no policy = allow）', async (_l, pick) => {
    const spies = spyGates()
    const gates = pick(spies)
    const h = await open({ gates })
    await runGatedOps(h)
    const read = (p: string): string => (gates?.fileRead ? `/abs/${p}` : p)
    const write = (p: string): string => (gates?.fileWrite ? `/abs/${p}` : p)
    expect(h.backend.openTab.mock.calls).toEqual([[{ url: 'file:///tmp/a.html' }]])
    expect(onlyCall(h.backend, 'uploadFile').paths).toEqual([read('a.txt')])
    expect(onlyCall(h.backend, 'pdf').outputPath).toBe(write('o.pdf'))
    expect(h.backend.cdp.mock.calls.map((c) => c[0].params)).toEqual([
      { files: [read('b.txt')] },
      { behavior: 'allow', downloadPath: write('dl') }
    ])
    expect(spies.navigate).toHaveBeenCalledTimes(gates?.navigate ? 1 : 0)
    expect(spies.fileRead).toHaveBeenCalledTimes(gates?.fileRead ? 2 : 0)
    expect(spies.fileWrite).toHaveBeenCalledTimes(gates?.fileWrite ? 2 : 0)
  })

  it('G11 客户端没带 toolCallId（或带的不是字符串）→ 回落成 browser-…，每次调用各不相同', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    await h.call('open_tab', { url: 'https://a.com/' })
    await h.call('open_tab', { url: 'https://b.com/' })
    await h.call('open_tab', { url: 'https://c.com/' }, { 'shuvix.dev/toolCallId': 42 })
    const ids = gates.navigate.mock.calls.map((c) => c[1].toolCallId)
    for (const id of ids) expect(id).toMatch(/^browser-.+$/)
    expect(new Set(ids).size).toBe(3)
  })

  it.each<[string, OpParams, string]>([
    ['upload_file', { tabId: 't1', uid: 7, paths: ['a.txt'] }, '"uid" must be a string.'],
    [
      'upload_file',
      { tabId: 't1', uid: 'e1', paths: ['a.txt', 5] },
      '"paths" must be a non-empty list of file paths.'
    ],
    [
      'pdf',
      { tabId: 't1', outputPath: 'o.pdf', landscape: 'yes' },
      '"landscape" must be true or false.'
    ],
    ['pdf', { tabId: 't1', outputPath: 'o.pdf', pageSize: 5 }, '"pageSize" must be a string.'],
    [
      'cdp',
      { tabId: 't1', method: 'DOM.setFileInputFiles', params: { files: ['a', 5] } },
      '"files" must be a list of file paths.'
    ],
    [
      'cdp',
      {
        tabId: 't1',
        method: 'Input.dispatchDragEvent',
        params: { type: 'drop', data: { files: ['a', null] } }
      },
      '"files" must be a list of file paths.'
    ],
    [
      'cdp',
      { tabId: 't1', method: 'Page.navigate', params: { url: 'javascript:alert(1)' } },
      'javascript: URLs are not navigated to — run code in the page with evaluate.'
    ],
    [
      'navigate',
      { tabId: 't1', nav: 'jump', url: 'https://a.com/' },
      '"nav" must be one of "goto", "back", "forward", "reload".'
    ]
  ])('G13 %s %j：参数错在过门之前就报，一张卡都不弹', async (name, args, message) => {
    const gates = spyGates()
    const h = await open({ gates })
    expectFailure(await h.call(name, args), message)
    expect(gateCalls(gates)).toBe(0)
    expect(backendCalls(h.backend)).toBe(0)
  })
})

// ─── S 快照的差异 / 全量判定 ──────────────────────────────────────────────

const AGENT_A = { 'shuvix.dev/agentId': 'agent-A' }
const AGENT_B = { 'shuvix.dev/agentId': 'agent-B' }

/** 最近一次交给 backend.snapshot 的实参 */
const lastSnapshot = (h: Harness): OpParams => h.backend.snapshot.mock.calls.at(-1)![0]

/** 最近一次快照要的是不是全量 */
async function snapFull(
  h: Harness,
  tabId = 't1',
  meta?: Meta,
  extra: OpParams = {}
): Promise<unknown> {
  await h.call('snapshot', { tabId, ...extra }, meta)
  return lastSnapshot(h).full
}

/** 在 tab 上做 n 次便宜的非快照操作 */
async function scrolls(h: Harness, n: number, tabId = 't1', meta?: Meta): Promise<void> {
  for (let i = 0; i < n; i++) await h.call('scroll', { tabId }, meta)
}

describe('S 快照的差异 / 全量判定（按 调用方 × tab 分账）', () => {
  it('S1/S2 这个调用方第一次拍这个 tab → 全量；紧接着再拍 → 允许差异', async () => {
    const h = await open()
    expect(await snapFull(h)).toBe(true)
    expect(lastSnapshot(h)).toEqual({ tabId: 't1', full: true, viewer: '' })
    expect(await snapFull(h)).toBe(false)
  })

  it('S3 边界：隔 8 次操作仍允许差异，隔 9 次回全量', async () => {
    const h = await open()
    await snapFull(h)
    await scrolls(h, 8)
    expect(await snapFull(h)).toBe(false)
    await scrolls(h, 9)
    expect(await snapFull(h)).toBe(true)
    // 那次全量成功了，账清零
    expect(await snapFull(h)).toBe(false)
  })

  it('S4 full:true / "true" 无条件全量；full:false / "false" 管不了第一次', async () => {
    const h = await open()
    expect(await snapFull(h, 't1', undefined, { full: false })).toBe(true)
    expect(await snapFull(h, 't1', undefined, { full: true })).toBe(true)
    expect(await snapFull(h, 't1', undefined, { full: 'true' })).toBe(true)
    expect(await snapFull(h, 't1', undefined, { full: 'false' })).toBe(false)
    expect(await snapFull(h, 't1', undefined, { full: false })).toBe(false)
  })

  it('S5 按调用方分账：各自第一次都是全量，viewer 就是调用方；B 的操作不记到 A 头上', async () => {
    const h = await open()
    expect(await snapFull(h, 't1', AGENT_A)).toBe(true)
    expect(lastSnapshot(h).viewer).toBe('agent-A')
    // A 刚拍过，B 仍是第一次
    expect(await snapFull(h, 't1', AGENT_B)).toBe(true)
    expect(lastSnapshot(h).viewer).toBe('agent-B')
    await scrolls(h, 9, 't1', AGENT_B)
    expect(await snapFull(h, 't1', AGENT_A)).toBe(false)
    expect(await snapFull(h, 't1', AGENT_B)).toBe(true)
  })

  it('S6 按 tab 分账：别的 tab 上的操作不算，另一个 tab 的第一次仍是全量', async () => {
    const h = await open()
    await snapFull(h, 't1')
    await scrolls(h, 9, 't2')
    expect(await snapFull(h, 't1')).toBe(false)
    expect(await snapFull(h, 't2')).toBe(true)
  })

  it('S7 两台 server 实例（两条会话、同一个后端）各记各的', async () => {
    const backend = fakeBackend()
    const one = await open({ backend })
    const two = await open({ backend })
    expect(await snapFull(one)).toBe(true)
    expect(await snapFull(two)).toBe(true)
    expect(await snapFull(one)).toBe(false)
  })

  it.each<[string, (h: Harness) => void]>([
    ['后端抛错', (h) => h.backend.snapshot.mockRejectedValueOnce(new Error('Target closed'))],
    [
      '业务失败',
      (h) =>
        h.backend.snapshot.mockResolvedValueOnce({
          text: 'Error: no such tab',
          details: { error: 'no such tab' }
        })
    ]
  ])('S8/S9 快照失败（%s）→ 下一次必须全量', async (_l, fail) => {
    const h = await open()
    await snapFull(h)
    fail(h)
    const r = await h.call('snapshot', { tabId: 't1' })
    expect(r.isError).toBe(true)
    expect(lastSnapshot(h).full).toBe(false)
    expect(await snapFull(h)).toBe(true)
  })

  it('S9 details.error 为假值的快照算成功 → 下一次照常差异', async () => {
    const h = await open()
    h.backend.snapshot.mockResolvedValueOnce({
      text: 'snap',
      details: { error: '', elementCount: 3 }
    })
    await snapFull(h)
    expect(await snapFull(h)).toBe(false)
  })

  it('S10 快照被取消（后端随后成功落定）→ 下一次必须全量', async () => {
    const h = await open()
    await snapFull(h)
    const stuck = deferred()
    h.backend.snapshot.mockReturnValueOnce(stuck.promise)
    const ac = new AbortController()
    const cancelled = h.call('snapshot', { tabId: 't1' }, undefined, ac.signal)
    await vi.waitFor(() => expect(h.backend.snapshot).toHaveBeenCalledTimes(2))
    ac.abort()
    await expect(cancelled).rejects.toThrow()
    // 控制器里这份基线模型没收到 —— 成功落定也不能拿它做下一次差异的起点
    stuck.resolve({ text: 'snapshot nobody saw' })
    await settle()
    expect(await snapFull(h)).toBe(true)
  })

  it.each<[string, (h: Harness, gates: GateSpies) => Promise<void>]>([
    [
      '后端抛错的 click',
      async (h) => {
        h.backend.click.mockRejectedValueOnce(new Error('boom'))
        await h.call('click', { tabId: 't1', uid: 'e1' })
      }
    ],
    [
      '业务失败的 click',
      async (h) => {
        h.backend.click.mockResolvedValueOnce({
          text: 'Error: covered',
          details: { error: 'covered' }
        })
        await h.call('click', { tabId: 't1', uid: 'e1' })
      }
    ],
    [
      '门拒绝的 navigate',
      async (h, gates) => {
        gates.navigate.mockRejectedValueOnce(new Error('denied'))
        await h.call('navigate', { tabId: 't1', url: 'https://a.com/' })
      }
    ]
  ])('S11 进了分发的失败操作照样记一笔：8 次成功 + 1 次%s → 全量', async (_l, failingOp) => {
    const gates = spyGates()
    const h = await open({ gates })
    await snapFull(h)
    await scrolls(h, 8)
    await failingOp(h, gates)
    expect(await snapFull(h)).toBe(true)
  })

  // 参数不对的调用在排队、过门、碰页面之前就被退回 —— 页面上什么都没发生，不记
  it('S11 缺参数 / 参数类型错 / 未知工具 / 不带 tabId 的调用不记', async () => {
    const h = await open()
    await snapFull(h)
    await scrolls(h, 8)
    await h.call('click', { tabId: 't1' })
    await h.call('scroll', { tabId: 't1', amount: 'far' })
    await h.call('no_such_tool', { tabId: 't1' })
    await h.call('list_tabs')
    await h.call('open_tab', { url: 'https://a.com/' })
    await h.call('cdp_recipes')
    expect(await snapFull(h)).toBe(false)
  })

  it('S12 调用方身份不是字符串 → viewer 是空串，与不带身份的同一本账', async () => {
    const h = await open()
    expect(await snapFull(h, 't1', { 'shuvix.dev/agentId': 42 })).toBe(true)
    expect(lastSnapshot(h).viewer).toBe('')
    expect(await snapFull(h)).toBe(false)
    expect(await snapFull(h, 't1', AGENT_A)).toBe(true)
  })
})

// ─── Q 按 tab 排队 ───────────────────────────────────────────────────────

describe('Q 同一 tab 串行、不同 tab 并行', () => {
  /** 让某个后端方法的下一次调用卡在一个手动落定的 promise 上 */
  function hold(h: Harness, m: Method): Deferred<BrowserOpOutput> {
    const d = deferred()
    h.backend[m].mockImplementationOnce(() => d.promise)
    return d
  }

  it('Q1 同一 tab 上的第二个调用等第一个落定才开始', async () => {
    const h = await open()
    const clickDone = hold(h, 'click')
    const first = h.call('click', { tabId: 't1', uid: 'e1' })
    await vi.waitFor(() => expect(h.backend.click).toHaveBeenCalledTimes(1))
    const second = h.call('scroll', { tabId: 't1' })
    await settle()
    expect(h.backend.scroll).not.toHaveBeenCalled()

    clickDone.resolve({ text: 'clicked' })
    expect(textOf(await first)).toBe('clicked')
    expect(textOf(await within(second))).toBe('scroll ok')
  })

  it('Q2 不同 tab 互不等待', async () => {
    const h = await open()
    const one = hold(h, 'readPage')
    const two = hold(h, 'readPage')
    const p1 = h.call('read_page', { tabId: 't1' })
    const p2 = h.call('read_page', { tabId: 't2' })
    await vi.waitFor(() => expect(h.backend.readPage).toHaveBeenCalledTimes(2))
    two.resolve({ text: 'page 2' })
    expect(textOf(await within(p2))).toBe('page 2')
    one.resolve({ text: 'page 1' })
    expect(textOf(await p1)).toBe('page 1')
  })

  it('Q3 先来先做（FIFO）', async () => {
    const h = await open()
    const order: number[] = []
    const releases: Array<Deferred<BrowserOpOutput>> = []
    h.backend.scroll.mockImplementation(async (p) => {
      order.push(Number(p.amount))
      const d = deferred()
      releases.push(d)
      return d.promise
    })
    const calls = [1, 2, 3].map((amount) => h.call('scroll', { tabId: 't1', amount }))
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(order).toHaveLength(i + 1))
      await settle()
      expect(order).toHaveLength(i + 1)
      releases[i].resolve({ text: `done ${i + 1}` })
    }
    expect((await Promise.all(calls)).map(textOf)).toEqual(['done 1', 'done 2', 'done 3'])
    expect(order).toEqual([1, 2, 3])
  })

  it('Q4 前一个失败不卡住后面的', async () => {
    const h = await open()
    const failing = hold(h, 'click')
    const first = h.call('click', { tabId: 't1', uid: 'e1' })
    const second = h.call('scroll', { tabId: 't1' })
    await vi.waitFor(() => expect(h.backend.click).toHaveBeenCalledTimes(1))
    failing.reject(new Error('Target closed'))
    expectFailure(await first, 'Target closed')
    expect(textOf(await within(second))).toBe('scroll ok')
  })

  it('Q5 tab 被占着时，不属于任何 tab 的调用照常进行', async () => {
    const h = await open()
    const blocked = hold(h, 'click')
    const first = h.call('click', { tabId: 't1', uid: 'e1' })
    await vi.waitFor(() => expect(h.backend.click).toHaveBeenCalledTimes(1))
    expect(textOf(await within(h.call('list_tabs')))).toBe('listTabs ok')
    expect(textOf(await within(h.call('open_tab', { url: 'https://a.com/' })))).toBe('openTab ok')
    expect(textOf(await within(h.call('cdp_recipes')))).toBe(devtoolsRecipes(DESKTOP))
    expect(textOf(await within(h.call('scroll', { tabId: 't2' })))).toBe('scroll ok')
    blocked.resolve({ text: 'clicked' })
    await first
  })

  it('Q6 不同调用方在同一个 tab 上也排队', async () => {
    const h = await open()
    const blocked = hold(h, 'click')
    const first = h.call('click', { tabId: 't1', uid: 'e1' }, AGENT_A)
    await vi.waitFor(() => expect(h.backend.click).toHaveBeenCalledTimes(1))
    const second = h.call('scroll', { tabId: 't1' }, AGENT_B)
    await settle()
    expect(h.backend.scroll).not.toHaveBeenCalled()
    blocked.resolve({ text: 'clicked' })
    await first
    expect(textOf(await within(second))).toBe('scroll ok')
  })

  it('Q7 缺参数、未知工具的调用不排队：tab 被占着也立刻回', async () => {
    const h = await open()
    const blocked = hold(h, 'click')
    const first = h.call('click', { tabId: 't1', uid: 'e1' })
    await vi.waitFor(() => expect(h.backend.click).toHaveBeenCalledTimes(1))
    expectFailure(
      await within(h.call('click', { tabId: 't1' })),
      'Missing required parameter "uid".'
    )
    expectFailure(
      await within(h.call('no_such_tool', { tabId: 't1' })),
      'Unknown tool "no_such_tool".'
    )
    blocked.resolve({ text: 'clicked' })
    await first
    expect(h.backend.click).toHaveBeenCalledTimes(1)
  })

  it('Q8 在门上等着的调用也占着这个 tab：门放行、它做完，后面的才开始', async () => {
    const gates = spyGates()
    const gate = deferred<void>()
    gates.navigate.mockImplementationOnce(() => gate.promise)
    const h = await open({ gates })
    const order: string[] = []
    h.backend.navigate.mockImplementation(async () => {
      order.push('navigate')
      return { text: 'navigated' }
    })
    h.backend.scroll.mockImplementation(async () => {
      order.push('scroll')
      return { text: 'scrolled' }
    })
    const nav = h.call('navigate', { tabId: 't1', url: 'https://a.com/' })
    await vi.waitFor(() => expect(gates.navigate).toHaveBeenCalledTimes(1))
    const scroll = h.call('scroll', { tabId: 't1' })
    await settle()
    expect(order).toEqual([])
    gate.resolve()
    expect(textOf(await nav)).toBe('navigated')
    expect(textOf(await within(scroll))).toBe('scrolled')
    expect(order).toEqual(['navigate', 'scroll'])
  })
})

// ─── A 中止 ──────────────────────────────────────────────────────────────

describe('A 中止', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }

  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
  })

  /** 几轮宏任务之后仍没有未处理的拒绝 */
  async function expectNoUnhandled(): Promise<void> {
    await settle(10)
    await new Promise((r) => setTimeout(r, 10))
    expect(unhandled).toEqual([])
  }

  it('A1 后端卡死 + 取消 → 调用方立刻拿到拒绝；同一 tab 的下一个调用照常完成', async () => {
    const h = await open()
    h.backend.readPage.mockImplementationOnce(() => new Promise<never>(() => {}))
    const ac = new AbortController()
    const stuck = h.call('read_page', { tabId: 't1' }, undefined, ac.signal)
    await vi.waitFor(() => expect(h.backend.readPage).toHaveBeenCalledTimes(1))
    ac.abort()
    await within(expect(stuck).rejects.toThrow(), 500)
    expect(textOf(await within(h.call('scroll', { tabId: 't1' })))).toBe('scroll ok')
    await expectNoUnhandled()
  })

  it('A2 排队中被取消 → 轮到它时也不碰后端，没有未处理的拒绝', async () => {
    const h = await open()
    const blocked = deferred()
    h.backend.click.mockImplementationOnce(() => blocked.promise)
    const first = h.call('click', { tabId: 't1', uid: 'e1' })
    await vi.waitFor(() => expect(h.backend.click).toHaveBeenCalledTimes(1))

    const ac = new AbortController()
    const queued = h.call('scroll', { tabId: 't1' }, undefined, ac.signal)
    await settle()
    ac.abort()
    await expect(queued).rejects.toThrow()

    blocked.resolve({ text: 'clicked' })
    expect(textOf(await first)).toBe('clicked')
    await settle()
    expect(h.backend.scroll).not.toHaveBeenCalled()
    // 队列仍然通畅
    expect(textOf(await within(h.call('hover', { tabId: 't1', uid: 'e2' })))).toBe('hover ok')
    await expectNoUnhandled()
  })

  interface PendingGateCase {
    tool: string
    args: OpParams
    gate: keyof GateSpies
    /** 门最后放行时给的值 */
    allow: string | undefined
    backend: Method
  }

  const PENDING_GATE: Array<[string, PendingGateCase]> = [
    [
      'open_tab',
      {
        tool: 'open_tab',
        args: { url: 'https://a.com/' },
        gate: 'navigate',
        allow: undefined,
        backend: 'openTab'
      }
    ],
    [
      'navigate',
      {
        tool: 'navigate',
        args: { tabId: 't1', url: 'https://a.com/' },
        gate: 'navigate',
        allow: undefined,
        backend: 'navigate'
      }
    ],
    [
      'upload_file（两个路径）',
      {
        tool: 'upload_file',
        args: { tabId: 't1', uid: 'e1', paths: ['a.txt', 'b.txt'] },
        gate: 'fileRead',
        allow: '/abs/a.txt',
        backend: 'uploadFile'
      }
    ],
    [
      'pdf',
      {
        tool: 'pdf',
        args: { tabId: 't1', outputPath: 'o.pdf' },
        gate: 'fileWrite',
        allow: '/abs/o.pdf',
        backend: 'pdf'
      }
    ],
    [
      'cdp Page.navigate',
      {
        tool: 'cdp',
        args: { tabId: 't1', method: 'Page.navigate', params: { url: 'https://a.com/' } },
        gate: 'navigate',
        allow: undefined,
        backend: 'cdp'
      }
    ],
    [
      'cdp DOM.setFileInputFiles（两个文件）',
      {
        tool: 'cdp',
        args: {
          tabId: 't1',
          method: 'DOM.setFileInputFiles',
          params: { files: ['a.txt', 'b.txt'], nodeId: 3 }
        },
        gate: 'fileRead',
        allow: '/abs/a.txt',
        backend: 'cdp'
      }
    ],
    [
      'cdp Page.setDownloadBehavior',
      {
        tool: 'cdp',
        args: {
          tabId: 't1',
          method: 'Page.setDownloadBehavior',
          params: { behavior: 'allow', downloadPath: 'dl' }
        },
        gate: 'fileWrite',
        allow: '/abs/dl',
        backend: 'cdp'
      }
    ]
  ]

  it.each(PENDING_GATE)(
    'A3 %s：卡片挂着时被取消、门随后放行 → 不补跑，后面的门不再问，与同 tab 的下一个调用不重叠',
    async (_l, c) => {
      const gates = spyGates()
      const gate = deferred<string | undefined>()
      ;(gates[c.gate] as unknown as Mock<() => Promise<string | undefined>>).mockImplementationOnce(
        () => gate.promise
      )
      const h = await open({ gates })
      const ac = new AbortController()
      const pending = h.call(c.tool, c.args, undefined, ac.signal)
      await vi.waitFor(() => expect(gates[c.gate]).toHaveBeenCalledTimes(1))
      ac.abort()
      await expect(pending).rejects.toThrow()

      // 取消即放手：同一个 tab 上的下一个调用不必等那张卡，它在做的时候门才放行
      const later = deferred()
      h.backend.scroll.mockImplementationOnce(() => later.promise)
      const next = h.call('scroll', { tabId: 't1' })
      await vi.waitFor(() => expect(h.backend.scroll).toHaveBeenCalledTimes(1))

      gate.resolve(c.allow)
      await settle()
      expect(h.backend[c.backend]).not.toHaveBeenCalled()
      // 两个路径 / 两个文件的：第二个的门没被问
      expect(gateCalls(gates)).toBe(1)

      later.resolve({ text: 'scrolled' })
      expect(textOf(await next)).toBe('scrolled')
      await expectNoUnhandled()
    }
  )

  it('A3 门在取消之后才拒绝 → 同样安静地结束', async () => {
    const gates = spyGates()
    const gate = deferred<void>()
    gates.navigate.mockImplementationOnce(() => gate.promise)
    const h = await open({ gates })
    const ac = new AbortController()
    const pending = h.call('open_tab', { url: 'https://a.com/' }, undefined, ac.signal)
    await vi.waitFor(() => expect(gates.navigate).toHaveBeenCalledTimes(1))
    ac.abort()
    await expect(pending).rejects.toThrow()
    gate.reject(new Error('Aborted'))
    await expectNoUnhandled()
    expect(h.backend.openTab).not.toHaveBeenCalled()
  })

  it('A4 wait_for 拿到的 signal 随取消而中止', async () => {
    const h = await open()
    let signal: AbortSignal | undefined
    h.backend.waitFor.mockImplementationOnce((p) => {
      signal = p.signal as AbortSignal
      return new Promise<never>(() => {})
    })
    const ac = new AbortController()
    const pending = h.call('wait_for', { tabId: 't1', text: 'Done' }, undefined, ac.signal)
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal!.aborted).toBe(false)
    ac.abort()
    await expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(signal!.aborted).toBe(true))
    await expectNoUnhandled()
  })

  it('A5 取消 t1 上的调用不影响 t2 上正在做的', async () => {
    const h = await open()
    const signals = new Map<string, AbortSignal>()
    const t2Done = deferred()
    h.backend.waitFor.mockImplementation((p) => {
      signals.set(String(p.tabId), p.signal as AbortSignal)
      return p.tabId === 't1' ? new Promise<never>(() => {}) : t2Done.promise
    })
    const ac = new AbortController()
    const one = h.call('wait_for', { tabId: 't1', text: 'x' }, undefined, ac.signal)
    const two = h.call('wait_for', { tabId: 't2', text: 'y' })
    await vi.waitFor(() => expect(signals.size).toBe(2))
    ac.abort()
    await expect(one).rejects.toThrow()
    await settle()
    expect(signals.get('t1')!.aborted).toBe(true)
    expect(signals.get('t2')!.aborted).toBe(false)
    t2Done.resolve({ text: 'Found text "y" on page.' })
    expect(textOf(await within(two))).toBe('Found text "y" on page.')
    await expectNoUnhandled()
  })
})

// ─── L 生命周期 ──────────────────────────────────────────────────────────

describe('L 生命周期', () => {
  it.each<[string, (h: Harness) => Promise<void>]>([
    ['client.close()', (h) => h.client.close()],
    ['客户端 transport.close()', (h) => h.clientTransport.close()]
  ])('L1 %s → onClose 恰好一次（再关一次也不重复）', async (_l, close) => {
    const onClose = vi.fn()
    const h = await open({ onClose })
    await h.call('snapshot', { tabId: 't1' })
    expect(onClose).not.toHaveBeenCalled()
    await close(h)
    expect(onClose).toHaveBeenCalledTimes(1)
    await h.client.close()
    await h.clientTransport.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('L2 没给 onClose 时关连接不抛', async () => {
    const h = await open()
    await expect(h.client.close()).resolves.toBeUndefined()
  })

  it('L3 server 的身份与能力：shuvix-browser 1.0.0，只声明 tools', async () => {
    const h = await open()
    expect(h.client.getServerVersion()).toEqual({ name: 'shuvix-browser', version: '1.0.0' })
    expect(h.client.getServerCapabilities()).toEqual({ tools: {} })
    expect(h.client.getInstructions()).toBeUndefined()
  })

  it('L4 serverOptions 透传给 SDK Server（instructions 到得了客户端），但盖不掉 capabilities', async () => {
    const h = await open({
      serverOptions: {
        instructions: 'Start with list_tabs.',
        capabilities: { logging: {}, prompts: {} }
      } as unknown as BrowserMcpServerOptions['serverOptions']
    })
    expect(h.client.getInstructions()).toBe('Start with list_tabs.')
    expect(h.client.getServerCapabilities()).toEqual({ tools: {} })
  })

  it('L5 经 BuiltinMcpRegistry 按会话实例化：resolve 每条会话调一次，两条会话的后端与账本互不相干', async () => {
    type Scope = BuiltinMcpScope & { profile: string }
    const reg = new BuiltinMcpRegistry<Scope>()
    const backends = new Map<string, FakeBackend>()
    const resolve = vi.fn((scope: Scope): BrowserMcpServerOptions => {
      const backend = fakeBackend()
      backends.set(scope.sessionId, backend)
      return { backend: backend as unknown as BrowserBackend }
    })
    reg.register(BROWSER_MCP_SERVER_NAME, createBrowserMcpServerFactory(resolve))

    const connect = async (scope: Scope): Promise<Harness> => {
      const transport = await reg.createClientTransport(BROWSER_MCP_SERVER_NAME, scope)
      const client = new Client({ name: 'test', version: '0.0.0' })
      await client.connect(transport)
      return wrapClient(client, transport, backends.get(scope.sessionId)!)
    }

    const s1: Scope = { sessionId: 's1', profile: 'work' }
    const one = await connect(s1)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0]).toBe(s1)
    const two = await connect({ sessionId: 's2', profile: 'chat' })
    expect(resolve).toHaveBeenCalledTimes(2)

    expect(await snapFull(one)).toBe(true)
    expect(await snapFull(two)).toBe(true)
    expect(await snapFull(one)).toBe(false)
    expect(one.backend.snapshot).toHaveBeenCalledTimes(2)
    expect(two.backend.snapshot).toHaveBeenCalledTimes(1)
    expect(one.backend).not.toBe(two.backend)
  })

  it('L6 名字是 browser —— 也是客户端给工具名加的前缀', () => {
    expect(BROWSER_MCP_SERVER_NAME).toBe('browser')
  })
})

// ─── H 显示本地文件的 tab、view-source、参数先于排队、共享队列、pdf 校验、失败口径、关闭、导出 ───

type TabUrlMock = Mock<(p: { tabId: string }) => Promise<string | undefined>>
type DocBackend = FakeBackend & { tabUrl: TabUrlMock }

/**
 * 带 tabUrl 的假后端：`urls` 是 tab → 它**此刻**显示的地址。用例可以中途改它 ——
 * 模拟页面自己跳走（点了 file:// 链接、被 evaluate 改了 location）。
 */
function docBackend(
  urls: Record<string, string | undefined> = {},
  caps: BrowserCaps = DESKTOP
): DocBackend {
  const backend = fakeBackend(caps) as DocBackend
  backend.tabUrl = vi.fn<(p: { tabId: string }) => Promise<string | undefined>>(
    async ({ tabId }) => urls[tabId]
  )
  return backend
}

/** 碰 tab 里文档的工具 —— 做之前先看 tab 此刻显示的是不是本地文件 */
const DOCUMENT_TOOLS = [
  'snapshot',
  'read_page',
  'screenshot',
  'click',
  'fill',
  'type',
  'press_key',
  'hover',
  'upload_file',
  'scroll',
  'wait_for',
  'evaluate',
  'network',
  'console',
  'pdf',
  'cdp',
  'events'
]

/** 不看的：不属于任何 tab 的、关 tab 的、导航的（导航只回地址，不回内容） */
const DOCUMENT_FREE_TOOLS = ['list_tabs', 'open_tab', 'close_tab', 'navigate', 'cdp_recipes']

const DOC_GATE = (tabId = 't1'): string => `Read the local file shown in tab ${tabId}`

/** 四条导航入口：[标签, 工具, 由目标造出实参, 后端方法] */
const NAV_ENTRIES: Array<[string, string, (url: string) => OpParams, Method]> = [
  ['open_tab', 'open_tab', (url) => ({ url }), 'openTab'],
  ['navigate goto', 'navigate', (url) => ({ tabId: 't1', url }), 'navigate'],
  [
    'cdp Page.navigate',
    'cdp',
    (url) => ({ tabId: 't1', method: 'Page.navigate', params: { url } }),
    'cdp'
  ],
  [
    'cdp Network.loadNetworkResource',
    'cdp',
    (url) => ({
      tabId: 't1',
      method: 'Network.loadNetworkResource',
      params: { frameId: 'F', url, options: { disableCache: true, includeCredentials: false } }
    }),
    'cdp'
  ]
]

describe('H1 显示本地文件的 tab：在上面做任何事都是在读那个文件', () => {
  it('H1 工具分类表覆盖目录里的每一个工具（新工具必须先想清楚它碰不碰文档）', () => {
    expect([...DOCUMENT_TOOLS, ...DOCUMENT_FREE_TOOLS].sort()).toEqual(
      browserToolsForCaps(DESKTOP)
        .map((t) => t.name)
        .sort()
    )
  })

  it.each(DISPATCH)('H1a %s：做之前看不看 tab 此刻的地址', async (name, args) => {
    const gates = spyGates()
    const backend = docBackend({ t1: 'https://a.com/' })
    const h = await open({ backend, gates })
    expect((await h.call(name, args)).isError).toBeFalsy()
    if (DOCUMENT_TOOLS.includes(name)) {
      expect(backend.tabUrl.mock.calls).toEqual([[{ tabId: 't1' }]])
    } else {
      expect(backend.tabUrl).not.toHaveBeenCalled()
    }
    // 普通网页不过门：导航门只可能被导航目标本身问到
    expect(gates.navigate.mock.calls.every(([, ctx]) => ctx.description !== DOC_GATE())).toBe(true)
  })

  it.each(['goto', 'back', 'forward', 'reload'])(
    'H1a navigate %s 不看 tab 眼下的文档（哪怕它正显示本地文件）',
    async (nav) => {
      const gates = spyGates()
      const backend = docBackend({ t1: 'file:///etc/hosts' })
      const h = await open({ backend, gates })
      expect(
        (await h.call('navigate', { tabId: 't1', nav, url: 'https://a.com/' })).isError
      ).toBeFalsy()
      expect(backend.tabUrl).not.toHaveBeenCalled()
      // 只有 goto 的目标本身过门
      expect(gates.navigate.mock.calls.map(([url]) => url)).toEqual(
        nav === 'goto' ? ['https://a.com/'] : []
      )
    }
  )

  it('H1a close_tab 关一个显示本地文件的 tab 不问', async () => {
    const gates = spyGates()
    const backend = docBackend({ t1: 'file:///etc/hosts' })
    const h = await open({ backend, gates })
    expect(textOf(await h.call('close_tab', { tabId: 't1' }))).toBe('closeTab ok')
    expect(backend.tabUrl).not.toHaveBeenCalled()
    expect(gateCalls(gates)).toBe(0)
  })

  it.each<[string, OpParams, string]>([
    ['snapshot', { tabId: 't1' }, 'snapshot'],
    ['click', { tabId: 't1', uid: 'e1' }, 'click'],
    ['evaluate', { tabId: 't1', expression: 'document.title' }, 'evaluate'],
    ['cdp', { tabId: 't1', method: 'DOM.getDocument' }, 'cdp']
  ])(
    'H1b %s：先按读那个文件过导航门 —— 地址去掉 query 与片段、一句说明写明哪个 tab、工具名是调用的那个',
    async (name, args, method) => {
      const timeline: string[] = []
      const gates = spyGates()
      gates.navigate.mockImplementation(async (url) => void timeline.push(`gate ${url}`))
      const backend = docBackend({ t1: 'file:///tmp/report.html?x=1#top' })
      backend[method as Method].mockImplementation(async () => {
        timeline.push(method)
        return { text: 'done' }
      })
      const h = await open({ backend, gates })

      expect(textOf(await h.call(name, args, TC))).toBe('done')
      expect(gates.navigate.mock.calls).toEqual([
        [
          'file:///tmp/report.html',
          { toolCallId: 'tc-7', toolName: `mcp__browser__${name}`, description: DOC_GATE() }
        ]
      ])
      expect(timeline).toEqual(['gate file:///tmp/report.html', method])
    }
  )

  it.each<[string, string]>([
    ['view-source:file:///tmp/a.html', 'file:///tmp/a.html'],
    ['view-source:view-source:file:///tmp/a.html?q=1#f', 'file:///tmp/a.html'],
    ['VIEW-SOURCE:file:///tmp/a.html', 'file:///tmp/a.html'],
    ['View-Source:VIEW-SOURCE:file:///tmp/b.html', 'file:///tmp/b.html'],
    ['FILE:///tmp/c.html', 'file:///tmp/c.html']
  ])(
    'H1c tab 显示 %s → 剥掉 view-source: 外壳（叠几层、大小写都一样），问的是 %s',
    async (shown, asked) => {
      const gates = spyGates()
      const h = await open({ backend: docBackend({ t1: shown }), gates })
      await h.call('read_page', { tabId: 't1' })
      expect(gates.navigate.mock.calls.map(([url]) => url)).toEqual([asked])
    }
  )

  it('H1d 门拒绝 → 门的原话作为失败回去，后端一个都不碰；被拒的不记，下一次照样问', async () => {
    const gates = spyGates()
    gates.navigate.mockRejectedValueOnce(new Error('User denied access to /etc/hosts'))
    const h = await open({ backend: docBackend({ t1: 'file:///etc/hosts' }), gates })

    expectFailure(await h.call('read_page', { tabId: 't1' }), 'User denied access to /etc/hosts')
    expect(backendCalls(h.backend)).toBe(0)

    expect(textOf(await h.call('read_page', { tabId: 't1' }))).toBe('readPage ok')
    expect(gates.navigate).toHaveBeenCalledTimes(2)
  })

  it('H1e 放行按实例记住：同一个文件换了 query / 片段 / 结尾斜杠、换了 tab 都不再问；别的文件照问；另一台实例从头问', async () => {
    const gates = spyGates()
    const urls: Record<string, string | undefined> = { t1: 'file:///tmp/dir/' }
    const backend = docBackend(urls)
    const h = await open({ backend, gates })

    await h.call('snapshot', { tabId: 't1' })
    expect(gates.navigate.mock.calls.map(([url]) => url)).toEqual(['file:///tmp/dir/'])

    urls.t1 = 'file:///tmp/dir?x=1#y'
    await h.call('click', { tabId: 't1', uid: 'e1' })
    urls.t1 = 'file:///tmp/dir'
    await h.call('read_page', { tabId: 't1' })
    urls.t2 = 'file:///tmp/dir/'
    await h.call('scroll', { tabId: 't2' })
    expect(gates.navigate).toHaveBeenCalledTimes(1)

    urls.t1 = 'file:///tmp/other.html'
    await h.call('hover', { tabId: 't1', uid: 'e2' })
    expect(gates.navigate.mock.calls.map(([url]) => url)).toEqual([
      'file:///tmp/dir/',
      'file:///tmp/other.html'
    ])

    // 另一条会话的 server：它的用户没点过允许
    const other = await open({ backend, gates })
    urls.t1 = 'file:///tmp/dir/'
    await other.call('snapshot', { tabId: 't1' })
    expect(gates.navigate).toHaveBeenCalledTimes(3)
  })

  it.each(NAV_ENTRIES)(
    'H1f %s 打开本地文件时已经过了门 → 之后在显示它的 tab 上操作不再问',
    async (_label, tool, argsOf) => {
      const gates = spyGates()
      const urls: Record<string, string | undefined> = {}
      const h = await open({ backend: docBackend(urls), gates })

      expect((await h.call(tool, argsOf('file:///tmp/page.html?v=2'))).isError).toBeFalsy()
      expect(gates.navigate.mock.calls.map(([url, ctx]) => [url, ctx.description])).toEqual([
        ['file:///tmp/page.html?v=2', 'Open file:///tmp/page.html?v=2']
      ])

      urls.t1 = 'file:///tmp/page.html#section'
      expect(textOf(await h.call('snapshot', { tabId: 't1' }))).toBe('snapshot ok')
      expect(gates.navigate).toHaveBeenCalledTimes(1)
    }
  )

  it('H1f 导航目标被拒 → 不记：页面若照样显示了那个文件，在它上面的操作仍要问', async () => {
    const gates = spyGates()
    gates.navigate.mockRejectedValueOnce(new Error('denied'))
    const urls: Record<string, string | undefined> = {}
    const h = await open({ backend: docBackend(urls), gates })

    expectFailure(await h.call('open_tab', { url: 'file:///tmp/secret.html' }), 'denied')
    urls.t1 = 'file:///tmp/secret.html'
    await h.call('snapshot', { tabId: 't1' })
    expect(gates.navigate.mock.calls.map(([, ctx]) => ctx.description)).toEqual([
      'Open file:///tmp/secret.html',
      DOC_GATE()
    ])
  })

  it.each<[string, (g: GateSpies) => BrowserMcpGates | undefined]>([
    ['没有门', () => undefined],
    ['只有两道文件门', (g) => ({ fileRead: g.fileRead, fileWrite: g.fileWrite })]
  ])('H1g 宿主没给导航门（%s）→ 这层检查整个不做，连地址都不问', async (_l, pick) => {
    const spies = spyGates()
    const backend = docBackend({ t1: 'file:///etc/hosts' })
    const h = await open({ backend, gates: pick(spies) })
    expect(textOf(await h.call('read_page', { tabId: 't1' }))).toBe('readPage ok')
    expect(backend.tabUrl).not.toHaveBeenCalled()
    expect(spies.navigate).not.toHaveBeenCalled()
  })

  it('H1g 后端没实现 tabUrl → 不做这层检查（导航门在也一样）', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    expect(textOf(await h.call('read_page', { tabId: 't1' }))).toBe('readPage ok')
    expect(gates.navigate).not.toHaveBeenCalled()
  })

  it.each<[string, string | undefined]>([
    ['https', 'https://a.com/'],
    ['about:blank', 'about:blank'],
    ['加载失败页', 'chrome-error://chromewebdata/'],
    ['data:', 'data:text/html,<p>hi</p>'],
    ['view-source 包着的网页', 'view-source:https://a.com/'],
    ['没有这个 tab', undefined],
    ['空串', ''],
    ['解析不了', 'not a url']
  ])('H1h tab 显示的不是本地文件（%s）→ 不过门', async (_l, shown) => {
    const gates = spyGates()
    const backend = docBackend({ t1: shown })
    const h = await open({ backend, gates })
    expect(textOf(await h.call('read_page', { tabId: 't1' }))).toBe('readPage ok')
    expect(backend.tabUrl).toHaveBeenCalledTimes(1)
    expect(gates.navigate).not.toHaveBeenCalled()
  })

  it.each<[string, string, OpParams, string[]]>([
    [
      'upload_file',
      'upload_file',
      { tabId: 't1', uid: 'e1', paths: ['a.txt'] },
      ['fileRead a.txt', 'uploadFile']
    ],
    ['pdf', 'pdf', { tabId: 't1', outputPath: 'o.pdf' }, ['fileWrite o.pdf', 'pdf']],
    [
      'cdp DOM.setFileInputFiles',
      'cdp',
      { tabId: 't1', method: 'DOM.setFileInputFiles', params: { files: ['b.txt'] } },
      ['fileRead b.txt', 'cdp']
    ],
    [
      'cdp Page.setDownloadBehavior',
      'cdp',
      {
        tabId: 't1',
        method: 'Page.setDownloadBehavior',
        params: { behavior: 'allow', downloadPath: 'dl' }
      },
      ['fileWrite dl', 'cdp']
    ],
    [
      'cdp Page.navigate',
      'cdp',
      { tabId: 't1', method: 'Page.navigate', params: { url: 'https://b.com/' } },
      ['navigate https://b.com/', 'cdp']
    ]
  ])(
    'H1i %s：先后顺序是 看地址 → 读文件的门 → 工具自己的门 → 后端',
    async (_l, tool, args, rest) => {
      const timeline: string[] = []
      const gates = spyGates()
      gates.navigate.mockImplementation(async (url) => void timeline.push(`navigate ${url}`))
      gates.fileRead.mockImplementation(async (p) => {
        timeline.push(`fileRead ${p}`)
        return `/abs/${p}`
      })
      gates.fileWrite.mockImplementation(async (p) => {
        timeline.push(`fileWrite ${p}`)
        return `/abs/${p}`
      })
      const backend = docBackend()
      backend.tabUrl.mockImplementation(async ({ tabId }) => {
        timeline.push(`tabUrl ${tabId}`)
        return 'file:///tmp/a.html'
      })
      for (const m of ['uploadFile', 'pdf', 'cdp'] as const) {
        backend[m].mockImplementation(async () => {
          timeline.push(m)
          return { text: `${m} ok` }
        })
      }
      const h = await open({ backend, gates })
      expect((await h.call(tool, args)).isError).toBeFalsy()
      expect(timeline).toEqual(['tabUrl t1', 'navigate file:///tmp/a.html', ...rest])
    }
  )

  it.each<[string, OpParams, string]>([
    [
      'upload_file',
      { tabId: 't1', uid: 'e1', paths: [] },
      '"paths" must be a non-empty list of file paths.'
    ],
    ['click', { tabId: 't1', uid: 7 }, '"uid" must be a string.'],
    [
      'pdf',
      { tabId: 't1', outputPath: 'o.pdf', pageSize: 'B7' },
      '"pageSize" must be one of A0, A1, A2, A3, A4, A5, A6, Legal, Letter, Tabloid, Ledger.'
    ],
    [
      'cdp',
      { tabId: 't1', method: 'Page.navigate', params: { url: 'javascript:alert(1)' } },
      'javascript: URLs are not navigated to — run code in the page with evaluate.'
    ]
  ])('H1i 参数错在最前：%s %j 连 tab 的地址都不看', async (name, args, message) => {
    const gates = spyGates()
    const backend = docBackend({ t1: 'file:///etc/hosts' })
    const h = await open({ backend, gates })
    expectFailure(await h.call(name, args), message)
    expect(backend.tabUrl).not.toHaveBeenCalled()
    expect(gateCalls(gates)).toBe(0)
    expect(backendCalls(h.backend)).toBe(0)
  })

  it('H1j 读文件的门还挂着时被取消 → 门随后放行也不往下做：工具自己的门不问，后端不碰', async () => {
    const gates = spyGates()
    const docGate = deferred<void>()
    gates.navigate.mockImplementationOnce(() => docGate.promise)
    const h = await open({ backend: docBackend({ t1: 'file:///tmp/a.html' }), gates })

    const ac = new AbortController()
    const pending = h.call(
      'upload_file',
      { tabId: 't1', uid: 'e1', paths: ['a.txt'] },
      undefined,
      ac.signal
    )
    await vi.waitFor(() => expect(gates.navigate).toHaveBeenCalledTimes(1))
    ac.abort()
    await expect(pending).rejects.toThrow()

    docGate.resolve()
    await settle()
    expect(gates.fileRead).not.toHaveBeenCalled()
    expect(h.backend.uploadFile).not.toHaveBeenCalled()
    // 同一个 tab 没被这张卡卡住
    expect(textOf(await within(h.call('scroll', { tabId: 't1' })))).toBe('scroll ok')
  })
})

describe('H2 view-source: 不开', () => {
  const VIEW_SOURCE = 'view-source: URLs are not opened — open the page itself and read it.'

  it.each(NAV_ENTRIES)(
    'H2 %s：view-source: 一律拒绝（大小写、叠几层都一样），门与后端都不碰',
    async (_l, tool, argsOf, method) => {
      const gates = spyGates()
      const backend = docBackend({ t1: 'https://a.com/' })
      const h = await open({ backend, gates })
      for (const url of [
        'view-source:https://a.com/',
        'VIEW-SOURCE:file:///etc/hosts',
        'View-Source:view-source:file:///tmp/x.html'
      ]) {
        expectFailure(await h.call(tool, argsOf(url)), VIEW_SOURCE)
      }
      expect(h.backend[method]).not.toHaveBeenCalled()
      expect(backendCalls(h.backend)).toBe(0)
      expect(gateCalls(gates)).toBe(0)
      expect(backend.tabUrl).not.toHaveBeenCalled()
    }
  )
})

describe('H3 参数错的调用不排队', () => {
  it('H3 tab 上正有操作在做：类型错 / 取值错 / 被拦的方法都立刻回，后端与门都不碰', async () => {
    const gates = spyGates()
    const h = await open({ gates })
    const blocked = deferred()
    h.backend.click.mockImplementationOnce(() => blocked.promise)
    const first = h.call('click', { tabId: 't1', uid: 'e1' })
    await vi.waitFor(() => expect(h.backend.click).toHaveBeenCalledTimes(1))

    const bad: Array<[string, OpParams, string]> = [
      ['scroll', { tabId: 't1', amount: 'far' }, '"amount" must be a number.'],
      ['snapshot', { tabId: 't1', full: 'yes' }, '"full" must be true or false.'],
      ['click', { tabId: 't1', uid: 7 }, '"uid" must be a string.'],
      [
        'navigate',
        { tabId: 't1', nav: 'jump', url: 'https://a.com/' },
        '"nav" must be one of "goto", "back", "forward", "reload".'
      ],
      [
        'navigate',
        { tabId: 't1', url: 'example.com' },
        '"example.com" is not an absolute URL — include the scheme, e.g. https://example.com.'
      ],
      [
        'navigate',
        { tabId: 't1', url: 'view-source:https://a.com/' },
        'view-source: URLs are not opened — open the page itself and read it.'
      ],
      [
        'pdf',
        { tabId: 't1', outputPath: 'o.pdf', pageSize: 'B7' },
        '"pageSize" must be one of A0, A1, A2, A3, A4, A5, A6, Legal, Letter, Tabloid, Ledger.'
      ],
      ['pdf', { tabId: 't1', outputPath: 'o.pdf', scale: 3 }, '"scale" must be between 0.1 and 2.'],
      [
        'cdp',
        { tabId: 't1', method: 'Browser.close' },
        `CDP method "Browser.close" is blocked: ${blockedCdpReason('Browser.close')}.`
      ],
      [
        'cdp',
        { tabId: 't1', method: 'Page.navigate', params: { url: 'javascript:alert(1)' } },
        'javascript: URLs are not navigated to — run code in the page with evaluate.'
      ],
      [
        'upload_file',
        { tabId: 't1', uid: 'e1', paths: [] },
        '"paths" must be a non-empty list of file paths.'
      ]
    ]
    for (const [name, args, message] of bad) {
      expectFailure(await within(h.call(name, args)), message)
    }
    expect(backendCalls(h.backend)).toBe(1)
    expect(gateCalls(gates)).toBe(0)

    blocked.resolve({ text: 'clicked' })
    expect(textOf(await first)).toBe('clicked')
  })
})

describe('H4 进程级的 tab 队列', () => {
  it('H4a 两台实例共用一条队列：同一 tab 上一次一个，不同 tab 互不等待', async () => {
    const tabQueue = createBrowserTabQueue()
    const one = await open({ tabQueue })
    const two = await open({ tabQueue })
    const held = deferred()
    one.backend.click.mockImplementationOnce(() => held.promise)

    const first = one.call('click', { tabId: 't1', uid: 'e1' })
    await vi.waitFor(() => expect(one.backend.click).toHaveBeenCalledTimes(1))
    const sameTab = two.call('scroll', { tabId: 't1' })
    // 另一个 tab 不必等
    expect(textOf(await within(two.call('scroll', { tabId: 't2' })))).toBe('scroll ok')
    await settle()
    expect(two.backend.scroll.mock.calls.map(([p]) => p.tabId)).toEqual(['t2'])

    held.resolve({ text: 'clicked' })
    expect(textOf(await first)).toBe('clicked')
    expect(textOf(await within(sameTab))).toBe('scroll ok')
    expect(two.backend.scroll.mock.calls.map(([p]) => p.tabId)).toEqual(['t2', 't1'])
  })

  it('H4b 一台实例上失败的操作不卡住另一台排在同一 tab 上的', async () => {
    const tabQueue = createBrowserTabQueue()
    const one = await open({ tabQueue })
    const two = await open({ tabQueue })
    const failing = deferred()
    one.backend.click.mockImplementationOnce(() => failing.promise)

    const first = one.call('click', { tabId: 't1', uid: 'e1' })
    await vi.waitFor(() => expect(one.backend.click).toHaveBeenCalledTimes(1))
    const queued = two.call('read_page', { tabId: 't1' })
    await settle()
    expect(two.backend.readPage).not.toHaveBeenCalled()

    failing.reject(new Error('Target closed'))
    expectFailure(await first, 'Target closed')
    expect(textOf(await within(queued))).toBe('readPage ok')
  })

  it('H4c 不给 tabQueue：两台实例各有一份，互不排队（只在本实例内串行）', async () => {
    const one = await open()
    const two = await open()
    const held = deferred()
    one.backend.click.mockImplementationOnce(() => held.promise)

    const first = one.call('click', { tabId: 't1', uid: 'e1' })
    await vi.waitFor(() => expect(one.backend.click).toHaveBeenCalledTimes(1))
    expect(textOf(await within(two.call('scroll', { tabId: 't1' })))).toBe('scroll ok')

    held.resolve({ text: 'clicked' })
    await first
  })

  it('H4d createBrowserTabQueue：回 work 的结果；同一 tab 先来先做；抛错原样回给调用方、后面的照跑；别的 tab 不等', async () => {
    const q = createBrowserTabQueue()
    const order: string[] = []
    const a = deferred<string>()
    const p1 = q.run('t1', async () => {
      order.push('a')
      return a.promise
    })
    const p2 = q.run('t1', async () => {
      order.push('b')
      throw new Error('b failed')
    })
    const p3 = q.run('t1', async () => {
      order.push('c')
      return 'c'
    })
    const p4 = q.run('t2', async () => {
      order.push('d')
      return 'd'
    })

    await expect(within(p4)).resolves.toBe('d')
    expect(order).toEqual(['a', 'd'])

    a.resolve('a')
    await expect(p1).resolves.toBe('a')
    await expect(p2).rejects.toThrow('b failed')
    await expect(p3).resolves.toBe('c')
    expect(order).toEqual(['a', 'd', 'b', 'c'])
    // 队列在失败之后仍然通畅
    await expect(within(q.run('t1', async () => 'e'))).resolves.toBe('e')
  })
})

describe('H5 pdf 的参数在过写门之前校验', () => {
  const PAGE_SIZE_ERROR =
    '"pageSize" must be one of A0, A1, A2, A3, A4, A5, A6, Legal, Letter, Tabloid, Ledger.'
  const SCALE_ERROR = '"scale" must be between 0.1 and 2.'

  it.each<[unknown, string]>([
    ['a4', 'A4'],
    [' letter ', 'Letter'],
    ['LEDGER', 'Ledger'],
    ['tabloid', 'Tabloid'],
    ['A0', 'A0']
  ])('H5 pageSize %j → 规范写法 %s 交给后端', async (pageSize, canonical) => {
    const gates = spyGates()
    const h = await open({ gates })
    expect(
      (await h.call('pdf', { tabId: 't1', outputPath: 'o.pdf', pageSize })).isError
    ).toBeFalsy()
    expect(onlyCall(h.backend, 'pdf').pageSize).toBe(canonical)
    expect(gates.fileWrite).toHaveBeenCalledTimes(1)
  })

  it('H5 目录里的每一种纸张写成小写都认，并按目录里的写法交给后端', async () => {
    const h = await open()
    for (const size of PDF_PAGE_SIZES) {
      await h.call('pdf', { tabId: 't1', outputPath: 'o.pdf', pageSize: size.toLowerCase() })
    }
    expect(h.backend.pdf.mock.calls.map(([p]) => p.pageSize)).toEqual([...PDF_PAGE_SIZES])
  })

  it.each(['', '   '])(
    'H5 pageSize %j = 没给（后端收到 undefined，用它自己的缺省）',
    async (pageSize) => {
      const h = await open()
      await h.call('pdf', { tabId: 't1', outputPath: 'o.pdf', pageSize })
      expect(onlyCall(h.backend, 'pdf').pageSize).toBeUndefined()
    }
  )

  it.each(['B7', 'A7', 'letter-size', 'A 4'])(
    'H5 不认识的纸张 %j → 逐字报错，写门不问、后端不碰',
    async (pageSize) => {
      const gates = spyGates()
      const h = await open({ gates })
      expectFailure(
        await h.call('pdf', { tabId: 't1', outputPath: 'o.pdf', pageSize }),
        PAGE_SIZE_ERROR
      )
      expect(gates.fileWrite).not.toHaveBeenCalled()
      expect(backendCalls(h.backend)).toBe(0)
    }
  )

  it.each<[unknown]>([[0.05], [2.5], ['3'], [0], [-1]])(
    'H5 scale %j 超出范围 → 逐字报错，写门不问、后端不碰',
    async (scale) => {
      const gates = spyGates()
      const h = await open({ gates })
      expectFailure(await h.call('pdf', { tabId: 't1', outputPath: 'o.pdf', scale }), SCALE_ERROR)
      expect(gates.fileWrite).not.toHaveBeenCalled()
      expect(backendCalls(h.backend)).toBe(0)
    }
  )

  it.each<[unknown, number]>([
    [0.1, 0.1],
    [2, 2],
    ['0.1', 0.1],
    ['2', 2],
    [1, 1]
  ])('H5 scale %j 在范围内（两端含）→ 交给后端的是数字 %s', async (scale, expected) => {
    const h = await open()
    expect((await h.call('pdf', { tabId: 't1', outputPath: 'o.pdf', scale })).isError).toBeFalsy()
    expect(onlyCall(h.backend, 'pdf').scale).toBe(expected)
  })

  it('H5 范围就是 PDF_SCALE_RANGE 写的那一段', () => {
    expect(PDF_SCALE_RANGE).toEqual({ min: 0.1, max: 2 })
  })
})

describe('H6 「失败」只有一个口径：details.error 为真', () => {
  it.each<[string, unknown]>([
    ['0', 0],
    ['空串', ''],
    ['false', false]
  ])('H6 details.error 为 %s → 结果不标 isError，快照账也算成功', async (_l, error) => {
    const h = await open()
    h.backend.readPage.mockResolvedValueOnce({ text: 'page md', details: { error } })
    const r = await h.call('read_page', { tabId: 't1' })
    expect(r.isError).toBeUndefined()
    expect(r.content).toEqual([{ type: 'text', text: 'page md' }])

    h.backend.snapshot.mockResolvedValueOnce({ text: 'snap', details: { error } })
    expect(await snapFull(h)).toBe(true)
    // 那一次算成功 → 紧接着允许差异
    expect(await snapFull(h)).toBe(false)
  })

  it.each<[string, unknown]>([
    ['1', 1],
    ['非空串', 'boom'],
    ['true', true],
    ['对象', { code: 7 }]
  ])('H6 details.error 为 %s → isError，快照之后必须全量', async (_l, error) => {
    const h = await open()
    h.backend.readPage.mockResolvedValueOnce({ text: 'Error: broke', details: { error } })
    expectFailure(await h.call('read_page', { tabId: 't1' }), 'broke')

    await snapFull(h)
    h.backend.snapshot.mockResolvedValueOnce({ text: 'Error: broke', details: { error } })
    expect((await h.call('snapshot', { tabId: 't1' })).isError).toBe(true)
    expect(await snapFull(h)).toBe(true)
  })
})

describe('H7 关连接', () => {
  async function openRaw(onClose: () => void): Promise<{
    client: Client
    clientTransport: Transport
    serverTransport: Transport
  }> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await connectBrowserMcpServer(
      { backend: fakeBackend() as unknown as BrowserBackend, onClose },
      serverTransport
    )
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(clientTransport)
    clients.push(client)
    return { client, clientTransport, serverTransport }
  }

  it('H7 服务端先关 → onClose 恰好一次；客户端随后再关也不重复', async () => {
    const onClose = vi.fn()
    const { client, clientTransport, serverTransport } = await openRaw(onClose)
    await client.callTool({ name: 'list_tabs', arguments: {} })
    expect(onClose).not.toHaveBeenCalled()

    await serverTransport.close()
    expect(onClose).toHaveBeenCalledTimes(1)
    await client.close()
    await clientTransport.close()
    await serverTransport.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('H7 客户端先关 → onClose 恰好一次；服务端随后再关也不重复', async () => {
    const onClose = vi.fn()
    const { client, serverTransport } = await openRaw(onClose)
    await client.close()
    expect(onClose).toHaveBeenCalledTimes(1)
    await serverTransport.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('H8 包入口', () => {
  it('H8 PDF_PAGE_SIZES / PDF_SCALE_RANGE / createBrowserTabQueue / urlObjectOf 从 @shuvix/agent-runtime 导出，且就是模块里的那几个', async () => {
    const runtime = await import('../../index')
    const { urlObjectOf } = await import('../../security/urlObject')
    expect(runtime.PDF_PAGE_SIZES).toBe(PDF_PAGE_SIZES)
    expect(runtime.PDF_SCALE_RANGE).toBe(PDF_SCALE_RANGE)
    expect(runtime.createBrowserTabQueue).toBe(createBrowserTabQueue)
    expect(runtime.urlObjectOf).toBe(urlObjectOf)
    expect([...runtime.PDF_PAGE_SIZES]).toEqual([
      'A0',
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'Legal',
      'Letter',
      'Tabloid',
      'Ledger'
    ])
  })
})

/** tools/list 里一项，只取这里要看的几处 */
interface ListedTool {
  name: string
  description?: string
  inputSchema: { properties?: Record<string, { description?: string }> }
}

describe('H9 工具描述（过线之后）', () => {
  async function toolsOf(caps: BrowserCaps): Promise<ListedTool[]> {
    const h = await open({ caps })
    return (await h.client.listTools()).tools as ListedTool[]
  }

  it.each<[string, BrowserCaps]>([
    ['桌面', DESKTOP],
    ['扩展', EXTENSION]
  ])(
    'H9 %s：open_tab 不再声称 file:// 「像任何本地读一样被检查」（查不查是宿主的门决定的）',
    async (_l, caps) => {
      const openTab = (await toolsOf(caps)).find((t) => t.name === 'open_tab')!
      expect(JSON.stringify(openTab)).not.toContain('checked like any other file read')
    }
  )

  it('H9 screenshot 只在有全页截图时才说 uid「wins over fullPage」', async () => {
    const shot = async (caps: BrowserCaps): Promise<string> =>
      (await toolsOf(caps)).find((t) => t.name === 'screenshot')!.description ?? ''
    expect(await shot(DESKTOP)).toContain('uid captures a single element (wins over fullPage).')
    const elementOnly = await shot({ ...DESKTOP, fullPageScreenshot: false })
    expect(elementOnly).toContain('uid captures a single element.')
    expect(elementOnly).not.toContain('wins over fullPage')
  })

  it('H9 pdf 的 pageSize 描述列出全部纸张 —— 与校验用的是同一张表', async () => {
    const pdf = (await toolsOf(DESKTOP)).find((t) => t.name === 'pdf')!
    expect(pdf.inputSchema.properties?.pageSize.description).toBe(
      `Paper size: ${PDF_PAGE_SIZES.join(', ')} (default A4).`
    )
  })
})
