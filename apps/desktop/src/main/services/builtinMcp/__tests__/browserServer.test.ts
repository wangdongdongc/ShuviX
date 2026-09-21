/**
 * 内置能力服务器 `browser` 的**桌面接线** —— 隔着真的 MCP 协议看，门后是**真的**安全模块。
 *
 * server 本体（分发、排队、参数校验）在 agent-runtime 那边有自己的测试；这里只问桌面给它的
 * 两样东西接得对不对：
 *   BS-1        list_tabs 后面接的宿主说明；
 *   BS-2…6      http(s) 等地址上报 `{type:'url'}` 客体（规整过的写法、opts 的契约）—— 出厂放行，
 *               用户的 deny / ask 策略照样管得到；
 *   BS-7…13     `file://` 就是读那个路径：路径怎么从地址里解出来（大写协议、localhost、`..`、
 *               百分号编码、根本不指本机文件的地址），走的是 ask-on-read / protect-credentials；
 *               显示本地文件的 tab 上做事也一样（BS-7b）；
 *   BS-14…18    upload_file 的读门：相对路径按工作目录解析、先问策略再查存在、绝对路径也 resolve；
 *   BS-19…21    pdf 的写门：工作区里也问（ask-on-write）、区外问而不拒、系统 / 凭据目录拒绝；
 *   BS-22       原生 cdp 里等价的那几个方法不是绕开门的旁路；
 *   BS-23…25    每条会话一台 server（后端与询问通道各归各）、策略不缓存、各会话共用一条 tab 队列。
 *
 * mock 掉的只是会拉起 Electron 的两条取用路径：`getDesktopSecurityContext`（换成同形态的真
 * `createSecurityContext`，外面包一层记下 enforcePath / enforceUrl 的实参）与浏览器面板
 * （`createDesktopBrowserBackend` 换成假后端）。工作目录是**真的临时目录** —— upload_file 的门
 * 会 stat 真文件；也**不 realpath** 它：macOS 上那会变成 /private/var/…，落进 protect-system
 * 的禁写名单。用例按 POSIX 路径写，Windows 上跳过。
 *
 * 工具失败回来的是原话 + isError（`[MCP Error]` 前缀是 McpManager 加的，这里绕过了它）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { ParsedPolicyFile, PolicyRuleSpec } from '@shuvix/agent-runtime'

// mock 路径按**测试文件**解析：被测模块在 services/builtinMcp/，测试在其 __tests__/ 下

/** 安全门的现场：工作目录、记下的实参、这条会话的用户策略与免询问开关 */
const gate = vi.hoisted(() => ({
  /** 工作目录（真的临时目录）—— resolveProjectConfig 与 vars.workspace 必须是同一个值 */
  ws: '',
  pathCalls: [] as Array<{ mode: unknown; path: unknown; opts: unknown }>,
  urlCalls: [] as Array<{ object: unknown; opts: unknown }>,
  policies: [] as unknown[],
  autoAllow: false
}))

vi.mock('../../toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { createInlinePolicyMdReader } =
    await import('@shuvix/agent-runtime/security/builtinPolicies/inlineSources')
  const readBuiltinPolicyMd = createInlinePolicyMdReader()
  type Ctx = Parameters<typeof import('../../toolContext').getDesktopSecurityContext>[0]
  type Real = ReturnType<typeof createSecurityContext>
  return {
    TOOL_ABORTED: 'Aborted',
    resolveProjectConfig: () => ({ workingDirectory: gate.ws }),
    // 主体 / 环境 / 变量表按 toolContext 的生产形态复刻，内置策略一条不少
    getDesktopSecurityContext: (ctx: Ctx): Real => {
      const real = createSecurityContext(
        { kind: 'agent', sessionId: ctx.sessionId, agentKind: 'root' },
        { host: 'desktop', platform: process.platform, workspaceDir: gate.ws },
        {
          host: 'desktop',
          pathSep: '/',
          getVars: () => ({
            workspace: gate.ws,
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
          getUserPolicies: () => gate.policies as never,
          // 询问通道由 scope 注入：缺席就是「这条会话没有输入面板」
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

type OpMock = ReturnType<typeof vi.fn>

interface FakeBackend {
  caps: Record<string, boolean>
  /** tab → 它此刻显示的地址（tabUrl 读这里；没列出的 tab → undefined） */
  urls: Record<string, string | undefined>
  [method: string]: unknown
}

/** 浏览器面板换成假后端：每条会话一个（与生产一样，createDesktopBrowserBackend 按会话调） */
const browser = vi.hoisted(() => ({
  /** createDesktopBrowserBackend 收到的 sessionId，按调用顺序 */
  created: [] as string[],
  /** 最近一次造出来的后端 */
  last: undefined as unknown
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
  'events',
  'uploadFile',
  'pdf'
] as const

vi.mock('../../browser', () => ({
  createDesktopBrowserBackend: (sessionId: string) => {
    browser.created.push(sessionId)
    const backend: FakeBackend = {
      // 桌面的端能力：上传与 pdf 都有
      caps: {
        pdf: true,
        fullPageScreenshot: true,
        elementScreenshot: true,
        screenshotToFile: true,
        evaluate: true,
        network: true,
        console: true,
        rawCdp: true,
        upload: true
      },
      urls: {}
    }
    for (const m of METHODS) backend[m] = vi.fn(async () => ({ text: `${m} ok` }))
    backend.tabUrl = vi.fn(async ({ tabId }: { tabId: string }) => backend.urls[tabId])
    browser.last = backend
    return backend
  }
}))

import { createDesktopBrowserMcpServerFactory } from '../browserServer'

// ─── 素材 ────────────────────────────────────────────────────────────────

const POSIX = process.platform !== 'win32'

/** 工作目录里放一个真文件和一个目录（upload_file 的门要 stat 它们） */
beforeAll(() => {
  gate.ws = mkdtempSync(join(tmpdir(), 'shuvix-browsersrv-'))
  mkdirSync(join(gate.ws, 'notes'), { recursive: true })
  writeFileSync(join(gate.ws, 'notes', 'a.txt'), 'hello')
})

afterAll(() => {
  if (gate.ws) rmSync(gate.ws, { recursive: true, force: true })
})

beforeEach(() => {
  gate.pathCalls.length = 0
  gate.urlCalls.length = 0
  gate.policies.length = 0
  gate.autoAllow = false
  browser.created.length = 0
})

const clients: Client[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
})

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

interface Session {
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
  /** 询问应答；缺省 = 一律允许；`null` = 这条会话没有输入面板（fail-closed 用例） */
  respond?: ((req: InputRequest) => Promise<InputResponse>) | null
}

/** 把一台桌面 browser server 接到一对真 InMemoryTransport 上，并连一个真 Client */
async function open(opts: OpenOpts = {}): Promise<Session> {
  const asks: InputRequest[] = []
  const respond =
    opts.respond === undefined
      ? async (): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
      : opts.respond
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createDesktopBrowserMcpServerFactory()(
    {
      sessionId: opts.sessionId ?? 's1',
      requestUserInput: respond
        ? async (req: InputRequest): Promise<InputResponse> => {
            asks.push(req)
            return respond(req)
          }
        : undefined
    },
    serverTransport
  )
  const backend = browser.last as Session['backend']
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  clients.push(client)
  return {
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

const userPolicy = (name: string, rules: PolicyRuleSpec[]): ParsedPolicyFile => ({
  name,
  displayName: name,
  description: '',
  rules,
  body: ''
})

/** 按主机的用户 url 策略（规则自带 type 守卫） */
const hostPolicy = (
  name: string,
  effect: PolicyRuleSpec['effect'],
  host: string
): ParsedPolicyFile =>
  userPolicy(name, [{ effect, match: `object.type == 'url' && object.host == '${host}'` }])

/** enforce 的 opts 契约（displayPath 不给时就是 undefined —— toEqual 视同缺席） */
const enforceOpts = (
  toolName: string,
  description: string,
  displayPath?: string,
  toolCallId = 'tc-1'
): Record<string, unknown> => ({
  toolCallId,
  toolName: `mcp__browser__${toolName}`,
  description,
  displayPath,
  abortError: 'Aborted',
  missingChannel: 'deny'
})

const WS = (): string => gate.ws

// ─── 宿主说明 ────────────────────────────────────────────────────────────

describe.skipIf(!POSIX)('browser 桌面接线 —— 工具面', () => {
  it('BS-1 list_tabs 的描述接着桌面的宿主说明（ShuviX 自己的浏览器），别的工具都没有', async () => {
    const s = await open()
    const tools = (await s.client.listTools()).tools
    expect(
      tools.filter((t) => t.description?.includes("ShuviX's own browser")).map((t) => t.name)
    ).toEqual(['list_tabs'])
  })
})

// ─── http(s) 等地址：{type:'url'} 客体 ────────────────────────────────────

describe.skipIf(!POSIX)('browser 桌面接线 —— 地址上报 url 客体', () => {
  it('BS-2 open_tab https：恰好一次 enforceUrl，客体四个属性、opts 带路由键与完整工具名；不走路径门、不问，后端拿原地址', async () => {
    const s = await open()
    expect((await s.call('open_tab', { url: 'https://a.example/p?q=1' }, TC)).isError).toBeFalsy()

    expect(gate.urlCalls).toEqual([
      {
        object: {
          url: 'https://a.example/p?q=1',
          scheme: 'https',
          host: 'a.example',
          origin: 'https://a.example'
        },
        opts: enforceOpts('open_tab', 'Open https://a.example/p?q=1')
      }
    ])
    expect(gate.pathCalls).toEqual([])
    expect(s.asks).toEqual([])
    expect(s.backend.openTab.mock.calls).toEqual([[{ url: 'https://a.example/p?q=1' }]])
  })

  it.each<[string, Record<string, string>]>([
    [
      'https://User:pw@Evil.Example:8443/a?b#c',
      {
        url: 'https://evil.example:8443/a?b#c',
        scheme: 'https',
        host: 'evil.example',
        origin: 'https://evil.example:8443'
      }
    ],
    [
      'https://Evil.Example./x',
      {
        url: 'https://evil.example/x',
        scheme: 'https',
        host: 'evil.example',
        origin: 'https://evil.example'
      }
    ],
    [
      'http://[::1]:3000/',
      { url: 'http://[::1]:3000/', scheme: 'http', host: '[::1]', origin: 'http://[::1]:3000' }
    ]
  ])(
    'BS-3 %s → 给策略看的客体是规整过的（小写、去结尾的点、不带账号口令）；后端拿到的仍是原话',
    async (url, object) => {
      const s = await open()
      await s.call('open_tab', { url })
      expect(gate.urlCalls.map((c) => c.object)).toEqual([object])
      expect(s.backend.openTab.mock.calls).toEqual([[{ url }]])
    }
  )

  it.each<[string, Record<string, string>]>([
    ['data:text/html,x', { url: 'data:text/html,x', scheme: 'data', host: '', origin: 'null' }],
    ['about:blank', { url: 'about:blank', scheme: 'about', host: '', origin: 'null' }]
  ])('BS-4 %s：不是网络地址也走 url 客体；出厂没有 url 策略 → 放行、不问', async (url, object) => {
    const s = await open()
    expect((await s.call('open_tab', { url })).isError).toBeFalsy()
    expect(gate.urlCalls.map((c) => c.object)).toEqual([object])
    expect(s.asks).toEqual([])
    expect(s.backend.openTab).toHaveBeenCalledTimes(1)
  })

  it('BS-5 用户按主机禁：open_tab 与 navigate goto 都拦（结尾带点、大小写换了也拦），后端不碰；别的主机照常', async () => {
    gate.policies.push(hostPolicy('no-evil', 'deny', 'evil.example'))
    const s = await open()
    const denied = "Denied by security policy rule 'no-evil#0'"

    expectFailure(await s.call('open_tab', { url: 'https://evil.example/x' }), denied)
    expectFailure(await s.call('navigate', { tabId: 't1', url: 'https://evil.example/x' }), denied)
    expectFailure(await s.call('open_tab', { url: 'https://Evil.Example./x' }), denied)
    expectFailure(
      await s.call('navigate', { tabId: 't1', url: 'https://evil.example./login' }),
      denied
    )
    expect(s.backend.openTab).not.toHaveBeenCalled()
    expect(s.backend.navigate).not.toHaveBeenCalled()

    expect((await s.call('open_tab', { url: 'https://good.example/' })).isError).toBeFalsy()
    expect(s.backend.openTab).toHaveBeenCalledTimes(1)
    expect(s.asks).toEqual([])
  })

  describe('BS-6 用户按主机要问', () => {
    const URL = 'https://a.example/p?q=1'
    beforeEach(() => void gate.policies.push(hostPolicy('ask-a', 'ask', 'a.example')))

    it('BS-6 允许 → 卡片是地址本身与工具的一句说明（路由键是 toolCallId），放行之后才开', async () => {
      const s = await open()
      expect((await s.call('open_tab', { url: URL }, TC)).isError).toBeFalsy()
      expect(s.asks).toHaveLength(1)
      expect(s.asks[0]).toMatchObject({
        kind: 'ask',
        id: 'tc-1',
        toolName: 'mcp__browser__open_tab',
        command: URL,
        description: `Open ${URL}`
      })
      expect(s.backend.openTab.mock.calls).toEqual([[{ url: URL }]])
    })

    it.each<[string, InputResponse, string]>([
      ['拒绝', { kind: 'ask', allowed: false }, `User denied opening ${URL}`],
      ['取消', { kind: 'cancel', reason: 'aborted' }, 'Aborted']
    ])('BS-6 %s → 原话回去，后端不碰', async (_l, response, message) => {
      const s = await open({ respond: async () => response })
      expectFailure(await s.call('open_tab', { url: URL }, TC), message)
      expect(s.backend.openTab).not.toHaveBeenCalled()
    })

    it('BS-6 没有输入面板 → fail-closed，地址写全', async () => {
      const s = await open({ respond: null })
      expectFailure(
        await s.call('open_tab', { url: URL }),
        `Access denied: this needs your confirmation but there is no way to ask: ${URL}`
      )
      expect(s.backend.openTab).not.toHaveBeenCalled()
    })
  })
})

// ─── file:// 就是读那个路径 ─────────────────────────────────────────────

describe.skipIf(!POSIX)('browser 桌面接线 —— file:// 按读路径过门', () => {
  it('BS-7 工作区里的文件：一次 enforcePath(read)，展示路径就是它；不走 url 客体、不问，后端拿原地址', async () => {
    const s = await open()
    const url = `file://${WS()}/page.html`
    expect((await s.call('open_tab', { url }, TC)).isError).toBeFalsy()
    expect(gate.pathCalls).toEqual([
      {
        mode: 'read',
        path: `${WS()}/page.html`,
        opts: enforceOpts('open_tab', `Open ${url}`, `${WS()}/page.html`)
      }
    ])
    expect(gate.urlCalls).toEqual([])
    expect(s.asks).toEqual([])
    expect(s.backend.openTab.mock.calls).toEqual([[{ url }]])
  })

  it('BS-7b 在一个显示 ~/.ssh/id_rsa 的 tab 上拍快照 = 读那个文件：凭据询问弹出、写明哪个 tab；拒绝则不拍', async () => {
    const s = await open({ respond: async () => ({ kind: 'ask', allowed: false }) })
    s.backend.urls.t1 = 'file:///home/u/.ssh/id_rsa'
    expectFailure(
      await s.call('snapshot', { tabId: 't1' }, TC),
      'User denied access to /home/u/.ssh/id_rsa'
    )
    expect(gate.pathCalls.map((c) => [c.mode, c.path])).toEqual([['read', '/home/u/.ssh/id_rsa']])
    expect(s.asks).toHaveLength(1)
    expect(s.asks[0]).toMatchObject({
      kind: 'ask',
      id: 'tc-1',
      toolName: 'mcp__browser__snapshot',
      command: 'Read(/home/u/.ssh/id_rsa)',
      description: 'Read the local file shown in tab t1'
    })
    expect(s.backend.snapshot).not.toHaveBeenCalled()
  })

  it('BS-8 file:///home/u/.ssh/id_rsa，没有输入面板 → 拒绝（路径写全），后端不碰', async () => {
    const s = await open({ respond: null })
    expectFailure(
      await s.call('open_tab', { url: 'file:///home/u/.ssh/id_rsa' }),
      'Access denied: path outside workspace and no way to ask: /home/u/.ssh/id_rsa'
    )
    expect(s.backend.openTab).not.toHaveBeenCalled()
  })

  it('BS-8 有输入面板 → 卡片是 Read(/home/u/.ssh/id_rsa) 并带策略提示语；拒绝 → User denied access to …', async () => {
    const s = await open({ respond: async () => ({ kind: 'ask', allowed: false }) })
    expectFailure(
      await s.call('open_tab', { url: 'file:///home/u/.ssh/id_rsa' }, TC),
      'User denied access to /home/u/.ssh/id_rsa'
    )
    expect(s.asks).toHaveLength(1)
    const ask = s.asks[0] as AskInputRequest
    expect(ask.command).toBe('Read(/home/u/.ssh/id_rsa)')
    expect(ask.policyPrompt?.text).toBeTruthy()
    expect(gate.urlCalls).toEqual([])
    expect(s.backend.openTab).not.toHaveBeenCalled()
  })

  it("BS-9 FILE:///… 大写协议照样走路径门，不走 url 客体（不是 startsWith('file:') 那种判断）", async () => {
    const s = await open({ respond: null })
    await s.call('open_tab', { url: 'FILE:///home/u/.ssh/id_rsa' })
    expect(gate.pathCalls.map((c) => [c.mode, c.path])).toEqual([['read', '/home/u/.ssh/id_rsa']])
    expect(gate.urlCalls).toEqual([])
    expect(s.backend.openTab).not.toHaveBeenCalled()
  })

  it('BS-10 file://localhost/etc/hosts → 读 /etc/hosts', async () => {
    const s = await open({ respond: null })
    expectFailure(
      await s.call('open_tab', { url: 'file://localhost/etc/hosts' }),
      'Access denied: path outside workspace and no way to ask: /etc/hosts'
    )
    expect(gate.pathCalls.map((c) => [c.mode, c.path])).toEqual([['read', '/etc/hosts']])
  })

  it.each([
    ['%2e%2e', (ws: string) => `file://${ws}/%2e%2e/x.txt`],
    ['..', (ws: string) => `file://${ws}/../x.txt`]
  ])('BS-11 地址里的 %s 段先折叠：落到工作目录外，没有输入面板就拒绝', async (_l, urlOf) => {
    const s = await open({ respond: null })
    const outside = `${dirname(WS())}/x.txt`
    expectFailure(
      await s.call('open_tab', { url: urlOf(WS()) }),
      `Access denied: path outside workspace and no way to ask: ${outside}`
    )
    expect(gate.pathCalls.map((c) => [c.mode, c.path])).toEqual([['read', outside]])
    expect(s.backend.openTab).not.toHaveBeenCalled()
  })

  it('BS-12 百分号编码解开之后才是路径（a%20b → a b）；后端拿的仍是编码过的原地址', async () => {
    const s = await open()
    const url = `file://${WS()}/a%20b.html`
    expect((await s.call('open_tab', { url })).isError).toBeFalsy()
    expect(gate.pathCalls.map((c) => [c.mode, c.path])).toEqual([['read', `${WS()}/a b.html`]])
    expect(s.backend.openTab.mock.calls).toEqual([[{ url }]])
  })

  it.each(['file://server/share/x', 'file:///tmp/a%2Fb'])(
    'BS-13 %s 不指本机上的文件 → 逐字报错；两道门都不问，后端不碰',
    async (url) => {
      const s = await open()
      expectFailure(
        await s.call('open_tab', { url }),
        `"${url}" does not name a file on this machine.`
      )
      expect(gate.pathCalls).toEqual([])
      expect(gate.urlCalls).toEqual([])
      expect(s.asks).toEqual([])
      expect(s.backend.openTab).not.toHaveBeenCalled()
    }
  )
})

// ─── upload_file 的读门 ─────────────────────────────────────────────────

describe.skipIf(!POSIX)('browser 桌面接线 —— upload_file 的读门', () => {
  it('BS-14 相对路径按工作目录解析后过读门（展示原话），工作区里不问；后端拿绝对路径', async () => {
    const s = await open()
    expect(
      (await s.call('upload_file', { tabId: 't1', uid: 'e1', paths: ['notes/a.txt'] }, TC)).isError
    ).toBeFalsy()
    expect(gate.pathCalls).toEqual([
      {
        mode: 'read',
        path: `${WS()}/notes/a.txt`,
        opts: enforceOpts('upload_file', 'Upload to the web page in tab t1', 'notes/a.txt')
      }
    ])
    expect(s.asks).toEqual([])
    expect(s.backend.uploadFile.mock.calls).toEqual([
      [{ tabId: 't1', uid: 'e1', paths: [`${WS()}/notes/a.txt`] }]
    ])
  })

  it.each(['notes/missing.txt', 'notes'])(
    'BS-15 %s 不是一个存在的文件（不存在 / 是目录）→ No such file，后端不碰',
    async (path) => {
      const s = await open()
      expectFailure(
        await s.call('upload_file', { tabId: 't1', uid: 'e1', paths: [path] }),
        `No such file: ${path}`
      )
      expect(s.backend.uploadFile).not.toHaveBeenCalled()
    }
  )

  it('BS-16 工作区外、又不存在的路径：先问策略 —— 用户拒绝就只是拒绝，不先透露它存不存在', async () => {
    const missing = `../${basename(WS())}-nope.txt`
    const denying = await open({ respond: async () => ({ kind: 'ask', allowed: false }) })
    expectFailure(
      await denying.call('upload_file', { tabId: 't1', uid: 'e1', paths: [missing] }),
      `User denied access to ${missing}`
    )
    expect(denying.asks).toHaveLength(1)

    const allowing = await open()
    expectFailure(
      await allowing.call('upload_file', { tabId: 't1', uid: 'e1', paths: [missing] }),
      `No such file: ${missing}`
    )
    expect(allowing.asks).toHaveLength(1)
    expect(allowing.backend.uploadFile).not.toHaveBeenCalled()
  })

  it('BS-17 绝对路径里的 .. 也折叠：过门的是 /home/u/.ssh/id_rsa（凭据询问弹出）；没有面板时拒绝文案用原话', async () => {
    const sneaky = `${WS()}/${'../'.repeat(WS().split('/').length)}home/u/.ssh/id_rsa`

    const asking = await open({ respond: async () => ({ kind: 'ask', allowed: false }) })
    expectFailure(
      await asking.call('upload_file', { tabId: 't1', uid: 'e1', paths: [sneaky] }),
      `User denied access to ${sneaky}`
    )
    expect(gate.pathCalls.map((c) => c.path)).toEqual(['/home/u/.ssh/id_rsa'])
    expect(asking.asks).toHaveLength(1)
    expect((asking.asks[0] as AskInputRequest).command).toBe('Read(/home/u/.ssh/id_rsa)')

    const closed = await open({ respond: null })
    expectFailure(
      await closed.call('upload_file', { tabId: 't1', uid: 'e1', paths: [sneaky] }),
      `Access denied: path outside workspace and no way to ask: ${sneaky}`
    )
    expect(closed.backend.uploadFile).not.toHaveBeenCalled()
  })

  it('BS-18 ~ 不展开：~/x 就是工作目录下一个叫 ~ 的目录里的 x', async () => {
    const s = await open()
    expectFailure(
      await s.call('upload_file', { tabId: 't1', uid: 'e1', paths: ['~/x'] }),
      'No such file: ~/x'
    )
    expect(gate.pathCalls.map((c) => c.path)).toEqual([`${WS()}/~/x`])
    expect(s.asks).toEqual([])
  })
})

// ─── pdf 的写门 ─────────────────────────────────────────────────────────

describe.skipIf(!POSIX)('browser 桌面接线 —— pdf 的写门', () => {
  it('BS-19 输出位置过写门：工作区里也问（ask-on-write 对每一次写都问）；允许后后端拿绝对路径，上级目录不必已存在', async () => {
    const s = await open()
    expect(
      (await s.call('pdf', { tabId: 't1', outputPath: 'out/page.pdf' }, TC)).isError
    ).toBeFalsy()
    expect(gate.pathCalls).toEqual([
      {
        mode: 'write',
        path: `${WS()}/out/page.pdf`,
        opts: enforceOpts('pdf', 'Save the page as a PDF', 'out/page.pdf')
      }
    ])
    expect(s.asks).toHaveLength(1)
    expect(s.asks[0]).toMatchObject({
      kind: 'ask',
      toolName: 'mcp__browser__pdf',
      command: `Write(${WS()}/out/page.pdf)`
    })
    expect(s.backend.pdf.mock.calls).toEqual([
      [
        {
          tabId: 't1',
          outputPath: `${WS()}/out/page.pdf`,
          pageSize: undefined,
          landscape: undefined,
          scale: undefined
        }
      ]
    ])
  })

  it('BS-19 免询问开着 → 不问，照样写', async () => {
    gate.autoAllow = true
    const s = await open()
    expect((await s.call('pdf', { tabId: 't1', outputPath: 'out/page.pdf' })).isError).toBeFalsy()
    expect(s.asks).toEqual([])
    expect(s.backend.pdf).toHaveBeenCalledTimes(1)
  })

  it('BS-20 工作区外的位置是问而不是拒：允许之后后端拿到的就是那个路径', async () => {
    const s = await open()
    expect(
      (await s.call('pdf', { tabId: 't1', outputPath: '/tmp/else/page.pdf' })).isError
    ).toBeFalsy()
    expect(s.asks).toHaveLength(1)
    expect((s.asks[0] as AskInputRequest).command).toBe('Write(/tmp/else/page.pdf)')
    expect(s.backend.pdf.mock.calls[0][0]).toMatchObject({ outputPath: '/tmp/else/page.pdf' })
  })

  it.each<[string, string]>([
    ['/etc/page.pdf', 'protect-system#0'],
    ['/home/u/.ssh/page.pdf', 'protect-credentials#0']
  ])('BS-21 %s → %s 直接拒绝（免询问也不管用）：不弹卡、不导出', async (outputPath, rule) => {
    gate.autoAllow = true
    const s = await open()
    const r = await s.call('pdf', { tabId: 't1', outputPath })
    expect(r.isError).toBe(true)
    expect(textOf(r).startsWith(`Denied by security policy rule '${rule}'`)).toBe(true)
    expect(s.asks).toEqual([])
    expect(s.backend.pdf).not.toHaveBeenCalled()
  })
})

// ─── 原生 cdp 不是旁路 ──────────────────────────────────────────────────

describe.skipIf(!POSIX)('browser 桌面接线 —— 原生 cdp', () => {
  const KEY = '/home/u/.ssh/id_rsa'
  const NO_WAY = `Access denied: path outside workspace and no way to ask: ${KEY}`

  it.each<[string, Record<string, unknown>]>([
    ['Page.navigate', { url: `file://${KEY}` }],
    [
      'Network.loadNetworkResource',
      {
        frameId: 'F',
        url: `file://${KEY}`,
        options: { disableCache: true, includeCredentials: false }
      }
    ],
    ['DOM.setFileInputFiles', { files: [KEY], backendNodeId: 42 }],
    [
      'Input.dispatchDragEvent',
      { type: 'drop', x: 1, y: 2, data: { items: [], files: [KEY], dragOperationsMask: 1 } }
    ]
  ])(
    'BS-22 cdp %s 碰凭据文件 → 与专门工具同一道读门，没有面板就拒绝，命令不发',
    async (method, params) => {
      const s = await open({ respond: null })
      expectFailure(await s.call('cdp', { tabId: 't1', method, params }), NO_WAY)
      expect(gate.pathCalls.map((c) => [c.mode, c.path])).toEqual([['read', KEY]])
      expect(s.backend.cdp).not.toHaveBeenCalled()
    }
  )

  it('BS-22 cdp Page.setDownloadBehavior 把下载落到 /etc → protect-system 拒绝，命令不发', async () => {
    const s = await open()
    const r = await s.call('cdp', {
      tabId: 't1',
      method: 'Page.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: '/etc' }
    })
    expect(r.isError).toBe(true)
    expect(textOf(r).startsWith("Denied by security policy rule 'protect-system#0'")).toBe(true)
    expect(gate.pathCalls.map((c) => [c.mode, c.path])).toEqual([['write', '/etc']])
    expect(s.asks).toEqual([])
    expect(s.backend.cdp).not.toHaveBeenCalled()
  })
})

// ─── 按会话实例化、不缓存、共用 tab 队列 ─────────────────────────────────

describe.skipIf(!POSIX)('browser 桌面接线 —— 会话', () => {
  it('BS-23 每条会话一台 server：后端按 sessionId 各造一个，询问只到发起那条会话的面板', async () => {
    gate.policies.push(hostPolicy('ask-a', 'ask', 'a.example'))
    const one = await open({ sessionId: 's1' })
    const two = await open({ sessionId: 's2' })
    expect(browser.created).toEqual(['s1', 's2'])
    expect(one.backend).not.toBe(two.backend)

    await two.call('open_tab', { url: 'https://a.example/' })
    expect(two.asks).toHaveLength(1)
    expect(one.asks).toEqual([])
    expect(two.backend.openTab).toHaveBeenCalledTimes(1)
    expect(one.backend.openTab).not.toHaveBeenCalled()
  })

  it('BS-24 不缓存：两次调用之间加的 deny 策略，第二次就生效', async () => {
    const s = await open()
    expect((await s.call('open_tab', { url: 'https://evil.example/' })).isError).toBeFalsy()
    gate.policies.push(hostPolicy('no-evil', 'deny', 'evil.example'))
    expectFailure(
      await s.call('open_tab', { url: 'https://evil.example/' }),
      "Denied by security policy rule 'no-evil#0'"
    )
    expect(s.backend.openTab).toHaveBeenCalledTimes(1)
  })

  it('BS-25 tab 是全 app 共享的：两条会话在同一个 tab 上的操作一次一个，别的 tab 不等', async () => {
    const one = await open({ sessionId: 's1' })
    const two = await open({ sessionId: 's2' })
    let release!: (v: unknown) => void
    one.backend.click.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))

    const first = one.call('click', { tabId: 'shared-1', uid: 'e1' })
    await vi.waitFor(() => expect(one.backend.click).toHaveBeenCalledTimes(1))
    const sameTab = two.call('scroll', { tabId: 'shared-1' })
    expect(textOf(await two.call('scroll', { tabId: 'shared-2' }))).toBe('scroll ok')
    await new Promise((r) => setTimeout(r, 20))
    expect(two.backend.scroll.mock.calls.map(([p]) => (p as { tabId: string }).tabId)).toEqual([
      'shared-2'
    ])

    release({ text: 'clicked' })
    expect(textOf(await first)).toBe('clicked')
    expect(textOf(await sameTab)).toBe('scroll ok')
    expect(two.backend.scroll.mock.calls.map(([p]) => (p as { tabId: string }).tabId)).toEqual([
      'shared-2',
      'shared-1'
    ])
  })
})
