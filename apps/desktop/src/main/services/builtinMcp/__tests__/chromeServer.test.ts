/**
 * 内置能力服务器 `chrome` 的**桌面接线** —— 隔着真的 MCP 协议看，门后是**真的**安全模块
 * （内置策略一条不少，ask-on-new-site 在其中）。
 *
 * server 本体（按站点记账、排队、取消）在 agent-runtime 那边有自己的测试（mcpServer W 系列）；
 * 这里只问桌面给它的东西接得对不对：
 *   CS-1        工具面：按 Chrome 的端能力、list_tabs 后面接「这是用户自己的 Chrome」的说明；
 *   CS-4…8      网页按站点过 `{type:'url', browser:'chrome'}` 客体（规整过的写法、opts 的契约、
 *               ask-on-new-site 的卡片）：允许 / 拒绝 / 免询问 / 没有输入面板；导航同一个客体；
 *               放行过的站点这一台实例里不再问；不属于任何站点的页不问；
 *   CS-9…11     本地文件：file:// 按读那个路径（挂着的那一页显示的也一样），不指本机的地址逐字报错；
 *               本地文件交给网页、决定下载落在哪一律拒绝；
 *   CS-12       用户随消息带上的站点（siteGrants）：站点门与导航门都不问、哪个 tab 都一样；
 *               按会话记；授权现读；挂着的那一页**不**因为「是它」就放行；file:// 从不因授权放行；
 *   CS-13       「看上去不是网页、其实是某个站点」的页（blob: / view-source: / filesystem:）按里面那个站点问；
 *   CS-14…15    按会话实例化：后端每会话一个；同一浏览器的会话共用那个浏览器的 tab 队列；
 *               不是标签页会话的根本不碰浏览器状态。
 *
 * mock 掉的：`getDesktopSecurityContext`（换成同形态的真 `createSecurityContext`，外面包一层记下
 * enforcePath / enforceUrl 的实参）、会话设置（sessionDao 的替身）、Chrome 桥（后端换成假的，
 * 浏览器状态只给一条可观察的 tab 队列；站点授权用**真的** siteGrants）。用例按 POSIX 路径写，
 * Windows 上跳过。工具失败回来的是原话 + isError（`[MCP Error]` 前缀是 McpManager 加的）。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import {
  browserToolsForCaps,
  buildBuiltinPolicies,
  type BrowserCaps,
  type BrowserTabQueue
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

// mock 路径按**测试文件**解析：被测模块在 services/builtinMcp/，测试在其 __tests__/ 下

/** 安全门的现场：记下的实参、免询问开关 */
const gate = vi.hoisted(() => ({
  pathCalls: [] as Array<{ mode: unknown; path: unknown; opts: unknown }>,
  urlCalls: [] as Array<{ object: unknown; opts: unknown }>,
  autoAllow: false
}))

vi.mock('../../toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { createInlinePolicyMdReader: reader } =
    await import('@shuvix/agent-runtime/security/builtinPolicies/inlineSources')
  const readBuiltinPolicyMd = reader()
  type Ctx = Parameters<typeof import('../../toolContext').getDesktopSecurityContext>[0]
  type Real = ReturnType<typeof createSecurityContext>
  return {
    TOOL_ABORTED: 'Aborted',
    // 主体 / 环境 / 变量表按 toolContext 的生产形态复刻，内置策略一条不少
    getDesktopSecurityContext: (ctx: Ctx): Real => {
      const real = createSecurityContext(
        { kind: 'agent', sessionId: ctx.sessionId, agentKind: 'root' },
        { host: 'desktop', platform: process.platform, workspaceDir: '/ws' },
        {
          host: 'desktop',
          pathSep: '/',
          getVars: () => ({
            workspace: '/ws',
            toolResultsBase: '/tool-results',
            skillsDirs: ['/skills'],
            memoryDirs: [],
            knowledgeRoot: '/kb',
            knowledgeSessionDirs: [],
            home: '/home/u',
            botsDir: '/home/u/.shuvix/bots',
            builtinKnowledgeDir: '/opt/shuvix/Resources/knowledge',
            systemDirs: []
          }),
          readBuiltinPolicyMd,
          getSessionGrants: () => ({ autoAllow: gate.autoAllow, allowList: [] }),
          getUserPolicies: () => [],
          requestUserInput: ctx.requestUserInput
        }
      )
      return {
        ...real,
        enforcePath: (mode, path, opts) => {
          gate.pathCalls.push({ mode, path, opts })
          return real.enforcePath(mode, path, opts)
        },
        enforceUrl: (object, opts) => {
          gate.urlCalls.push({ object, opts })
          return real.enforceUrl(object, opts)
        }
      }
    }
  }
})

/** 会话 → 它的 settings.chromeTab（没列出的会话 = 不是标签页会话） */
const db = vi.hoisted(() => ({ bindings: {} as Record<string, unknown> }))

vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: {
    pickSettings: vi.fn((sid: string) =>
      sid in db.bindings ? { chromeTab: db.bindings[sid] } : undefined
    )
  }
}))

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
  'events'
] as const

/** Chrome 的端能力（与 chromeBridge/backend 的 CHROME_BROWSER_CAPS 同一份，见 backend.test CBB-P6） */
const CHROME_CAPS: BrowserCaps = {
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

interface FakeBackend {
  caps: BrowserCaps
  /** tab → 它此刻显示的地址（tabUrl 读这里；没列出的 tab → undefined） */
  urls: Record<string, string | undefined>
  [method: string]: unknown
}

/** Chrome 桥换成假的：后端每会话一个；浏览器状态只给一条（按 installId）可观察的 tab 队列 */
const chrome = vi.hoisted(() => ({
  /** createChromeBrowserBackend 收到的 sessionId，按调用顺序 */
  created: [] as string[],
  last: undefined as unknown,
  /** installId → 那个浏览器的 tab 队列（run 是个包着真队列的 spy） */
  queues: new Map<string, { run: Mock }>()
}))

vi.mock('../../chromeBridge', async () => {
  const grants = await vi.importActual<typeof import('../../chromeBridge/siteGrants')>(
    '../../chromeBridge/siteGrants'
  )
  const { createBrowserTabQueue } = await import('@shuvix/agent-runtime')
  return {
    ...grants,
    createChromeBrowserBackend: (sessionId: string) => {
      chrome.created.push(sessionId)
      const backend: FakeBackend = { caps: CHROME_CAPS, urls: {} }
      for (const m of METHODS) backend[m] = vi.fn(async () => ({ text: `${m} ok` }))
      backend.tabUrl = vi.fn(async ({ tabId }: { tabId: string }) => backend.urls[tabId])
      chrome.last = backend
      return backend
    },
    chromeBrowserState: vi.fn((installId: string) => {
      let queue = chrome.queues.get(installId)
      if (!queue) {
        const real: BrowserTabQueue = createBrowserTabQueue()
        queue = {
          run: vi.fn((tabId: string, work: () => Promise<unknown>) => real.run(tabId, work))
        }
        chrome.queues.set(installId, queue)
      }
      return { tabQueue: queue }
    })
  }
})

import { chromeBrowserState, forgetSiteGrants, grantSite } from '../../chromeBridge'
import { CHROME_MCP_SERVER_NAME, createChromeMcpServerFactory } from '../chromeServer'

// ─── 素材 ────────────────────────────────────────────────────────────────

const POSIX = process.platform !== 'win32'

const policyEn = buildBuiltinPolicies({ readMd: createInlinePolicyMdReader() }).find(
  (p) => p.name === 'ask-on-new-site'
)!
const NEW_SITE_POLICY = policyEn.displayName
const NEW_SITE_PROMPT = policyEn.rules[0].prompt!

let seq = 0
const sid = (): string => `cs-session-${++seq}`
const iid = (): string => `cs-install-${++seq}`

beforeEach(() => {
  gate.pathCalls.length = 0
  gate.urlCalls.length = 0
  gate.autoAllow = false
  chrome.created.length = 0
  ;(chromeBrowserState as unknown as Mock).mockClear()
})

const clients: Client[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const key of Object.keys(db.bindings)) delete db.bindings[key]
})

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

type OpMock = Mock<(p: Record<string, unknown>) => Promise<unknown>>

interface Session {
  sessionId: string
  installId: string
  client: Client
  /** 这条会话弹出的询问卡片 */
  asks: InputRequest[]
  backend: FakeBackend & Record<(typeof METHODS)[number] | 'tabUrl', OpMock>
  call(
    name: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<ToolResult>
}

interface OpenOpts {
  sessionId?: string
  /** 标签页会话的绑定；缺省 = 挂在 tab 5 上的一条（installId 各用各的）；null = 不是标签页会话 */
  binding?: { installId: string; runId: string; tabId: number } | null
  /** 询问应答；缺省 = 一律允许；`null` = 这条会话没有输入面板 */
  respond?: ((req: InputRequest) => Promise<InputResponse>) | null
}

/** 把一台桌面 chrome server 接到一对真 InMemoryTransport 上，并连一个真 Client */
async function open(opts: OpenOpts = {}): Promise<Session> {
  const sessionId = opts.sessionId ?? sid()
  const binding =
    opts.binding === undefined ? { installId: iid(), runId: 'run-1', tabId: 5 } : opts.binding
  if (binding) db.bindings[sessionId] = binding
  const asks: InputRequest[] = []
  const respond =
    opts.respond === undefined
      ? async (): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
      : opts.respond
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createChromeMcpServerFactory()(
    {
      sessionId,
      requestUserInput: respond
        ? async (req: InputRequest): Promise<InputResponse> => {
            asks.push(req)
            return respond(req)
          }
        : undefined
    },
    serverTransport
  )
  const backend = chrome.last as Session['backend']
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  clients.push(client)
  return {
    sessionId,
    installId: binding?.installId ?? '',
    client,
    asks,
    backend,
    call: async (name, args = {}, meta) =>
      (await client.callTool({
        name,
        arguments: args,
        ...(meta ? { _meta: meta } : {})
      })) as unknown as ToolResult
  }
}

const TC = { 'shuvix.dev/toolCallId': 'tc-1' }

const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n')

function expectFailure(r: ToolResult, message: string): void {
  expect(r.isError).toBe(true)
  expect(textOf(r)).toBe(message)
}

/** enforce 的 opts 契约（displayPath 不给时就是 undefined —— toEqual 视同缺席） */
const enforceOpts = (
  toolName: string,
  description: string,
  displayPath?: string,
  toolCallId = 'tc-1'
): Record<string, unknown> => ({
  toolCallId,
  toolName: `mcp__chrome__${toolName}`,
  description,
  displayPath,
  abortError: 'Aborted',
  missingChannel: 'deny'
})

/** 给策略看的 chrome url 客体 */
const chromeUrl = (
  url: string,
  scheme: string,
  host: string,
  origin: string
): Record<string, string> => ({ url, scheme, host, origin, browser: 'chrome' })

// ─── 工具面 ──────────────────────────────────────────────────────────────

describe.skipIf(!POSIX)('chrome 桌面接线 —— 工具面', () => {
  it('CS-1 工具按 Chrome 的端能力列（没有 upload_file / pdf）；只有 list_tabs 带「这是用户自己的 Chrome」的说明，并讲清哪些站点不问', async () => {
    const s = await open()
    const tools = (await s.client.listTools()).tools
    expect(tools.map((t) => t.name)).toEqual(browserToolsForCaps(CHROME_CAPS).map((t) => t.name))
    expect(tools.map((t) => t.name)).not.toContain('upload_file')
    expect(tools.map((t) => t.name)).not.toContain('pdf')

    const noted = tools.filter((t) =>
      t.description?.includes("These are the user's real Chrome tabs")
    )
    expect(noted.map((t) => t.name)).toEqual(['list_tabs'])
    expect(noted[0].description).toContain(
      'The sites of the tabs the user sent are already allowed'
    )
    expect(noted[0].description).toContain('the user is asked')
    expect(s.client.getServerVersion()).toEqual({ name: 'shuvix-chrome', version: '1.0.0' })
    expect(CHROME_MCP_SERVER_NAME).toBe('chrome')
  })
})

// ─── 网页：按站点过 url 客体 ─────────────────────────────────────────────

describe.skipIf(!POSIX)('chrome 桌面接线 —— 新站点先问（ask-on-new-site）', () => {
  const PAGE = 'https://a.example/p?q=1'

  it('CS-4 在显示新站点的 tab 上操作：恰好一次 enforceUrl（规整过的客体、browser chrome、opts 契约）→ 一张卡（地址本身 + 出厂策略的话与名字）；允许后才做', async () => {
    const s = await open()
    s.backend.urls['6'] = 'https://A.Example./p?q=1'
    expect(textOf(await s.call('read_page', { tabId: '6' }, TC))).toBe('readPage ok')

    expect(gate.urlCalls).toEqual([
      {
        object: chromeUrl(PAGE, 'https', 'a.example', 'https://a.example'),
        opts: enforceOpts('read_page', 'Use a.example in tab 6')
      }
    ])
    expect(gate.pathCalls).toEqual([])
    expect(s.asks).toHaveLength(1)
    expect(s.asks[0]).toEqual({
      id: 'tc-1',
      kind: 'ask',
      toolName: 'mcp__chrome__read_page',
      command: PAGE,
      description: 'Use a.example in tab 6',
      pathIsDirectory: false,
      policyPrompt: { text: NEW_SITE_PROMPT, policies: [NEW_SITE_POLICY] },
      createdAt: expect.any(Number)
    })
    expect(s.backend.readPage.mock.calls).toEqual([[{ tabId: '6' }]])
  })

  it('CS-4 放行过的站点，这台实例里不再问：别的 tab 上、导航过去都一样', async () => {
    const s = await open()
    s.backend.urls['6'] = PAGE
    s.backend.urls['7'] = 'https://a.example/other'
    await s.call('read_page', { tabId: '6' })
    await s.call('click', { tabId: '7', uid: 'e1' })
    await s.call('open_tab', { url: 'https://a.example/new' })
    await s.call('navigate', { tabId: '7', url: 'http://a.example:8080/' })
    expect(gate.urlCalls).toHaveLength(1)
    expect(s.asks).toHaveLength(1)
    expect(s.backend.click).toHaveBeenCalledTimes(1)
    expect(s.backend.openTab).toHaveBeenCalledTimes(1)
    expect(s.backend.navigate).toHaveBeenCalledTimes(1)
  })

  it('CS-5 用户拒绝 → 原话回去，后端不碰；不记，下一次照样问', async () => {
    const s = await open({ respond: async () => ({ kind: 'ask', allowed: false }) })
    s.backend.urls['6'] = PAGE
    expectFailure(await s.call('click', { tabId: '6', uid: 'e1' }), `User denied opening ${PAGE}`)
    expect(s.backend.click).not.toHaveBeenCalled()
    expectFailure(await s.call('click', { tabId: '6', uid: 'e1' }), `User denied opening ${PAGE}`)
    expect(s.asks).toHaveLength(2)
  })

  it('CS-6 免询问开着 → 不问，照做（session-auto-allow 压过 ask-on-new-site）', async () => {
    gate.autoAllow = true
    const s = await open()
    s.backend.urls['6'] = PAGE
    expect(textOf(await s.call('click', { tabId: '6', uid: 'e1' }))).toBe('click ok')
    expect(gate.urlCalls).toHaveLength(1)
    expect(s.asks).toEqual([])
  })

  it('CS-7 没有输入面板 → fail-closed，地址写全，后端不碰', async () => {
    const s = await open({ respond: null })
    s.backend.urls['6'] = PAGE
    expectFailure(
      await s.call('click', { tabId: '6', uid: 'e1' }),
      `Access denied: this needs your confirmation but there is no way to ask: ${PAGE}`
    )
    expect(s.backend.click).not.toHaveBeenCalled()
  })

  it('CS-8 导航到新站点同一个客体：open_tab / navigate goto / cdp Page.navigate 各带自己的工具名，一句说明是 Open <地址>', async () => {
    const s = await open()
    await s.call('open_tab', { url: 'https://x.example/' }, TC)
    await s.call('navigate', { tabId: '7', url: 'https://y.example/a' }, TC)
    await s.call(
      'cdp',
      { tabId: '8', method: 'Page.navigate', params: { url: 'https://z.example/' } },
      TC
    )
    expect(gate.urlCalls).toEqual([
      {
        object: chromeUrl('https://x.example/', 'https', 'x.example', 'https://x.example'),
        opts: enforceOpts('open_tab', 'Open https://x.example/')
      },
      {
        object: chromeUrl('https://y.example/a', 'https', 'y.example', 'https://y.example'),
        opts: enforceOpts('navigate', 'Open https://y.example/a')
      },
      {
        object: chromeUrl('https://z.example/', 'https', 'z.example', 'https://z.example'),
        opts: enforceOpts('cdp', 'Open https://z.example/')
      }
    ])
    expect(s.asks.map((a) => (a as AskInputRequest).command)).toEqual([
      'https://x.example/',
      'https://y.example/a',
      'https://z.example/'
    ])
    // 刚放行的站点：再去不再问
    await s.call('navigate', { tabId: '7', url: 'https://x.example/other' })
    expect(gate.urlCalls).toHaveLength(3)
    expect(s.backend.openTab.mock.calls).toEqual([[{ url: 'https://x.example/' }]])
  })

  it.each(['about:blank', 'data:text/html,x', 'chrome://settings'])(
    'CS-8b 导航到不属于任何站点的 %s：照样上报 chrome 客体，但出厂策略不问',
    async (url) => {
      const s = await open({ respond: null })
      expect((await s.call('open_tab', { url })).isError).toBeFalsy()
      expect(gate.urlCalls).toHaveLength(1)
      expect(gate.urlCalls[0].object).toMatchObject({ url, browser: 'chrome' })
      expect(s.backend.openTab).toHaveBeenCalledTimes(1)
    }
  )

  it.each([
    'about:blank',
    'data:text/html,x',
    'chrome://settings',
    'chrome-error://chromewebdata/'
  ])('CS-8b tab 显示 %s → 站点门不过（没有站点），不问、照做', async (shown) => {
    const s = await open({ respond: null })
    s.backend.urls['6'] = shown
    expect(textOf(await s.call('read_page', { tabId: '6' }))).toBe('readPage ok')
    expect(gate.urlCalls).toEqual([])
    expect(gate.pathCalls).toEqual([])
  })
})

// ─── 本地文件 ────────────────────────────────────────────────────────────

describe.skipIf(!POSIX)('chrome 桌面接线 —— 本地文件', () => {
  it.each(['file:///tmp/a.html', 'file://localhost/tmp/a.html'])(
    'CS-9 open_tab %s → 读 /tmp/a.html 过路径门（展示路径就是它），不走 url 客体',
    async (url) => {
      const s = await open()
      expect((await s.call('open_tab', { url }, TC)).isError).toBeFalsy()
      expect(gate.pathCalls).toEqual([
        {
          mode: 'read',
          path: '/tmp/a.html',
          opts: enforceOpts('open_tab', `Open ${url}`, '/tmp/a.html')
        }
      ])
      expect(gate.urlCalls).toEqual([])
      // 工作区外的读 → ask-on-read 问了一次，允许之后才开
      expect(s.asks).toHaveLength(1)
      expect((s.asks[0] as AskInputRequest).command).toBe('Read(/tmp/a.html)')
      expect(s.backend.openTab.mock.calls).toEqual([[{ url }]])
    }
  )

  it('CS-9 挂着的那一页显示 ~/.ssh/id_rsa：在上面做事 = 读凭据文件，照样问（本地文件从不因「是挂着的页」放行）；拒绝则不做', async () => {
    const s = await open({ respond: async () => ({ kind: 'ask', allowed: false }) })
    s.backend.urls['5'] = 'file:///home/u/.ssh/id_rsa'
    expectFailure(
      await s.call('click', { tabId: '5', uid: 'e1' }, TC),
      'User denied access to /home/u/.ssh/id_rsa'
    )
    expect(gate.pathCalls).toEqual([
      {
        mode: 'read',
        path: '/home/u/.ssh/id_rsa',
        opts: enforceOpts('click', 'Read the local file shown in tab 5', '/home/u/.ssh/id_rsa')
      }
    ])
    expect(s.asks).toHaveLength(1)
    expect((s.asks[0] as AskInputRequest).command).toBe('Read(/home/u/.ssh/id_rsa)')
    expect(s.backend.click).not.toHaveBeenCalled()
  })

  it('CS-10 file://server/share/x 不指本机上的文件 → 逐字报错；两道门都不问，后端不碰', async () => {
    const s = await open()
    expectFailure(
      await s.call('open_tab', { url: 'file://server/share/x' }),
      '"file://server/share/x" does not name a file on this machine.'
    )
    expect(gate.pathCalls).toEqual([])
    expect(gate.urlCalls).toEqual([])
    expect(s.asks).toEqual([])
    expect(s.backend.openTab).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, unknown>, string]>([
    [
      'DOM.setFileInputFiles',
      { files: ['/tmp/a'], backendNodeId: 3 },
      'Local files cannot be handed to a page in the user’s Chrome.'
    ],
    [
      'Input.dispatchDragEvent',
      { type: 'drop', x: 1, y: 2, data: { items: [], files: ['/tmp/a'], dragOperationsMask: 1 } },
      'Local files cannot be handed to a page in the user’s Chrome.'
    ],
    [
      'Page.setDownloadBehavior',
      { behavior: 'allow', downloadPath: '/tmp' },
      'ShuviX does not choose where the user’s Chrome saves files.'
    ]
  ])(
    'CS-11 cdp %s → 一律拒绝（逐字，U+2019 撇号）；命令不发，不弹卡、不过任何策略',
    async (method, params, message) => {
      const s = await open()
      expectFailure(await s.call('cdp', { tabId: '6', method, params }), message)
      expect(s.backend.cdp).not.toHaveBeenCalled()
      expect(s.asks).toEqual([])
      expect(gate.pathCalls).toEqual([])
      expect(gate.urlCalls).toEqual([])
    }
  )
})

// ─── 用户随消息带上的站点 ────────────────────────────────────────────────

describe.skipIf(!POSIX)('chrome 桌面接线 —— 用户带上的站点（siteGrants）', () => {
  it('CS-12 带上过的站点：哪个 tab 上操作、导航过去都不问（不过 url 客体）；写法规整后比', async () => {
    const s = await open({ respond: null })
    grantSite(s.sessionId, 'bank.example')
    s.backend.urls['6'] = 'https://bank.example/acct'
    s.backend.urls['9'] = 'https://Bank.Example./statements'

    expect(textOf(await s.call('click', { tabId: '6', uid: 'e1' }))).toBe('click ok')
    expect(textOf(await s.call('read_page', { tabId: '9' }))).toBe('readPage ok')
    expect((await s.call('open_tab', { url: 'https://bank.example/x' })).isError).toBeFalsy()
    expect(
      (await s.call('navigate', { tabId: '7', url: 'http://bank.example:8443/y' })).isError
    ).toBeFalsy()
    expect(gate.urlCalls).toEqual([])
    expect(s.asks).toEqual([])
  })

  it('CS-12 挂着的那一页不因「是它」就放行：它显示的站点没被带上过 → 照样问', async () => {
    const s = await open()
    grantSite(s.sessionId, 'bank.example')
    s.backend.urls['5'] = 'https://evil.example/'
    await s.call('click', { tabId: '5', uid: 'e1' }, TC)
    expect(gate.urlCalls).toEqual([
      {
        object: chromeUrl('https://evil.example/', 'https', 'evil.example', 'https://evil.example'),
        opts: enforceOpts('click', 'Use evil.example in tab 5')
      }
    ])
    expect(s.asks).toHaveLength(1)
  })

  it('CS-12 授权按会话记：A 带上过的站点，B 照样问', async () => {
    const a = await open()
    const b = await open()
    grantSite(a.sessionId, 'bank.example')
    b.backend.urls['6'] = 'https://bank.example/acct'
    await b.call('read_page', { tabId: '6' })
    expect(gate.urlCalls).toHaveLength(1)
    expect(b.asks).toHaveLength(1)
    expect(a.asks).toEqual([])
  })

  it('CS-12 授权现读：server 建好之后才带上的站点，下一步就不问', async () => {
    const s = await open({ respond: null })
    s.backend.urls['6'] = 'https://mail.example/'
    grantSite(s.sessionId, 'mail.example')
    expect(textOf(await s.call('read_page', { tabId: '6' }))).toBe('readPage ok')
    expect(gate.urlCalls).toEqual([])
  })

  it('CS-12 授权忘掉之后（会话没了），还没在这台实例里放行过的站点照样问', async () => {
    const s = await open({ respond: null })
    grantSite(s.sessionId, 'mail.example')
    forgetSiteGrants(s.sessionId)
    s.backend.urls['6'] = 'https://mail.example/'
    expectFailure(
      await s.call('read_page', { tabId: '6' }),
      'Access denied: this needs your confirmation but there is no way to ask: https://mail.example/'
    )
  })

  it('CS-12 file:// 从不因授权放行：带上过 localhost，打开 file://localhost/… 仍按读路径过门', async () => {
    const s = await open({ respond: null })
    grantSite(s.sessionId, 'localhost')
    expectFailure(
      await s.call('open_tab', { url: 'file://localhost/tmp/a.html' }),
      'Access denied: path outside workspace and no way to ask: /tmp/a.html'
    )
    expect(gate.pathCalls.map((c) => [c.mode, c.path])).toEqual([['read', '/tmp/a.html']])
  })

  it('CS-12 blob: 页属于创建它的那个站点：带上过那个站点就不问', async () => {
    const s = await open({ respond: null })
    grantSite(s.sessionId, 'bank.example')
    s.backend.urls['6'] = 'blob:https://bank.example/0b1c'
    expect(textOf(await s.call('read_page', { tabId: '6' }))).toBe('readPage ok')
    expect(gate.urlCalls).toEqual([])
  })
})

// ─── 看上去不是网页、其实是某个站点 ─────────────────────────────────────

describe.skipIf(!POSIX)(
  'chrome 桌面接线 —— blob: / view-source: / filesystem: 按里面那个站点问',
  () => {
    it('CS-13 blob:https://evil.example/… → 客体按创建它的那个源（scheme blob），出厂策略问', async () => {
      const s = await open()
      s.backend.urls['6'] = 'blob:https://evil.example/u'
      await s.call('read_page', { tabId: '6' })
      expect(gate.urlCalls.map((c) => c.object)).toEqual([
        chromeUrl('blob:https://evil.example/u', 'blob', 'evil.example', 'https://evil.example')
      ])
      expect(s.asks).toHaveLength(1)
      expect((s.asks[0] as AskInputRequest).policyPrompt?.policies).toEqual([NEW_SITE_POLICY])
    })

    it.each(['view-source:https://evil.example/', 'filesystem:https://evil.example/temporary/x'])(
      'CS-13 tab 显示 %s（带着 evil.example 的登录态）→ 像 evil.example 本身一样先问',
      async (shown) => {
        const s = await open({ respond: null })
        s.backend.urls['6'] = shown
        const r = await s.call('read_page', { tabId: '6' })
        expect(r.isError).toBe(true)
        expect(textOf(r)).toContain('there is no way to ask')
        expect(s.backend.readPage).not.toHaveBeenCalled()
      }
    )

    it('CS-13 在 view-source: 页上操作不能顺带把里面的站点放行：之后 evil.example 本身的页照样问', async () => {
      const s = await open({ respond: null })
      s.backend.urls['6'] = 'view-source:https://evil.example/'
      await s.call('read_page', { tabId: '6' })
      s.backend.urls['7'] = 'https://evil.example/inbox'
      const r = await s.call('click', { tabId: '7', uid: 'e1' })
      expect(r.isError).toBe(true)
      expect(s.backend.click).not.toHaveBeenCalled()
    })
  }
)

// ─── 按会话实例化 ────────────────────────────────────────────────────────

describe.skipIf(!POSIX)('chrome 桌面接线 —— 会话', () => {
  it('CS-14 标签页会话：tab 操作排在那个浏览器的 tab 队列上；list_tabs 这类不属于 tab 的不排', async () => {
    const s = await open()
    expect(chromeBrowserState).toHaveBeenCalledWith(s.installId)
    const queue = chrome.queues.get(s.installId)!
    await s.call('click', { tabId: '6', uid: 'e1' })
    await s.call('list_tabs')
    expect(queue.run.mock.calls.map(([tabId]) => tabId)).toEqual(['6'])
  })

  it('CS-14 同一浏览器的两条会话共用一条队列：同一 tab 上一次一个，别的 tab 不等', async () => {
    const installId = iid()
    const one = await open({ binding: { installId, runId: 'run-1', tabId: 5 } })
    const two = await open({ binding: { installId, runId: 'run-1', tabId: 8 } })
    let release!: (v: unknown) => void
    one.backend.click.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))

    const first = one.call('click', { tabId: '6', uid: 'e1' })
    await vi.waitFor(() => expect(one.backend.click).toHaveBeenCalledTimes(1))
    const sameTab = two.call('scroll', { tabId: '6' })
    expect(textOf(await two.call('scroll', { tabId: '7' }))).toBe('scroll ok')
    await new Promise((r) => setTimeout(r, 20))
    expect(two.backend.scroll.mock.calls.map(([p]) => p.tabId)).toEqual(['7'])

    release({ text: 'clicked' })
    expect(textOf(await first)).toBe('clicked')
    expect(textOf(await sameTab)).toBe('scroll ok')
    expect(two.backend.scroll.mock.calls.map(([p]) => p.tabId)).toEqual(['7', '6'])
    expect(chrome.queues.get(installId)!.run).toHaveBeenCalledTimes(3)
  })

  it('CS-14 不是标签页会话（不该发生）：不碰任何浏览器的状态，照样建得起来', async () => {
    const s = await open({ binding: null })
    expect(chromeBrowserState).not.toHaveBeenCalled()
    expect(textOf(await s.call('click', { tabId: '6', uid: 'e1' }))).toBe('click ok')
    expect(chromeBrowserState).not.toHaveBeenCalled()
  })

  it('CS-15 后端按会话各造一个（sessionId 原样传进去），询问只到发起那条会话', async () => {
    const one = await open({ sessionId: 'cs-a' })
    const two = await open({ sessionId: 'cs-b' })
    expect(chrome.created).toEqual(['cs-a', 'cs-b'])
    expect(one.backend).not.toBe(two.backend)

    two.backend.urls['6'] = 'https://a.example/'
    await two.call('read_page', { tabId: '6' })
    expect(two.asks).toHaveLength(1)
    expect(one.asks).toEqual([])
    expect(one.backend.readPage).not.toHaveBeenCalled()
  })
})
