/**
 * tool_search（2026-11-03）：没勾选的 MCP 服务器不占上下文，根 agent 自己按关键词找到它，用户批准之后整台开启，
 * 从下一次请求起是普通工具。真实例 + 假提供商 + spec 进程里的假 MCP 服务器（记下每个 HTTP 请求：「搜索不连接」
 * 要从服务器那边读，不信工具自己的话）。
 *
 *   TS-1  新会话：第一次请求有 tool_search、没有 mcp__browser__*；允许 → 下一次请求有了；system 文字一字不变；
 *         勾选写下、选择器勾着；agent 没有重建；mcp__browser__list_tabs 真的跑通
 *   TS-2  拒绝：工具结果是 User denied enabling …；设置与工具表都没变
 *   TS-3  停在卡片上：卡片收掉，勾选不变，服务器一个请求都没收到
 *   TS-4  端口没人听的服务器：Could not connect …；勾选不变；再搜一次照问（失败不留记忆）
 *   TS-5  挂着不应答的服务器：连接中回退 → 10 秒内 success（远小于 30 秒上限，等待和 signal 竞争才做得到）；
 *         勾选不变；下一条消息照常跑
 *   TS-6  两个命中：没有卡片，两个名字都列出来，服务器 0 个请求；接着叫精确的名字才问
 *   TS-7  用户 force-allow 策略：点名的那台不问就加载；别的照问
 *   TS-8  连过又断开的第三方服务器：描述里的词找得到它、有卡片；描述的内容不在任何一次请求里；
 *         搜索期间服务器没有新请求
 *   TS-9  Electron 自己的 ICU 下：`浏览器` / `データベース` 切得开、找得到，有卡片
 *   TS-10 派发的 coding（工具名单与根同款）：请求里没有 tool_search，system 里没有那一段；根的请求两样都有
 *
 * 会话都不带项目（chat 基座）、标题不是缺省标题（不跑自动标题，不会多出 titler 的请求）。发送走 UI（卡片要摆在
 * 这条会话的输入框上）；请求按 `lastUserText` 认领。
 *
 * 这些服务器在整个实例里都启用着，所以后面用例的提示词里会列着它们：断言只钉自己这一条用到的东西。
 */
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { until } from '../../harness/cdp'
import {
  messageTextsOf,
  startFakeProvider,
  toolTextsOf,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import { removeUserPolicy, writeUserPolicy } from '../../harness/networkFixtures'
import {
  chatPane,
  sidebarPane,
  toolPickerPane,
  type ChatPane,
  type PendingAskShot,
  type SidebarPane,
  type ToolPickerPane
} from '../../harness/pages'
import {
  eventRecorder,
  requestToolNames,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 4 }

/** 真能握手的一台：TS-3 / TS-6 看它一个请求都没收到 */
const LIVE = 'e2elive'
/** 端口没人听 */
const CLOSED = 'e2e-closed'
/** 收下连接就永不应答 */
const HANGING = 'e2e-hanging'
/** 用户起的名字带空格、工具描述里有记号：TS-8 */
const HOSTILE = 'e2e hostile'
const HOSTILE_LISTED = 'e2ehostile'
const HOSTILE_WORD = 'zebrafish'
const HOSTILE_MARKER = 'SECRET_DESCRIPTION_MARKER'

const LOCALES = [en, zh, ja]

interface McpFixture {
  server: HttpServer
  port: number
  /** 这台收到过几个 HTTP 请求（服务器这一侧的事实） */
  requests: number
}

interface ListedMessage {
  id: string
  role: string
  content: string
  blocks?: Array<{ type: string; toolName?: string; isError?: boolean; result?: unknown }>
}

let app: E2EApp
let provider: FakeProvider
let recorder: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let picker: ToolPickerPane
let live: McpFixture
let hanging: McpFixture
let hostile: McpFixture
let callSeq = 0

// ─── 假的 MCP 服务器（跑在 vitest 进程里） ───

function listen(server: HttpServer, count: () => void): Promise<McpFixture> {
  return new Promise((resolve, reject) => {
    const fixture: McpFixture = { server, port: 0, requests: 0 }
    server.on('request', () => {
      fixture.requests += 1
      count()
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      fixture.port = typeof addr === 'object' && addr ? addr.port : 0
      fixture.port ? resolve(fixture) : reject(new Error('no port'))
    })
  })
}

/** 真能握手（无状态：每个请求一套 Server / Transport，同 pending-and-mcp-connecting） */
function startLiveFixture(
  name: string,
  tools: Array<{ name: string; description: string }>
): Promise<McpFixture> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: unknown
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      } catch {
        body = undefined
      }
      const mcp = new McpSdkServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((tool) => ({ ...tool, inputSchema: { type: 'object' as const } }))
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      void mcp
        .connect(transport)
        .then(() => transport.handleRequest(req as IncomingMessage, res, body))
        .catch(() => {
          if (!res.headersSent) {
            res.statusCode = 500
            res.end()
          }
        })
    })
  })
  return listen(server, () => undefined)
}

/** 占一个端口再放开：之后连它是 ECONNREFUSED */
async function freePort(): Promise<number> {
  const fixture = await listen(
    createServer(() => {}),
    () => undefined
  )
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
  return fixture.port
}

async function closeFixture(fixture: McpFixture | undefined): Promise<void> {
  if (!fixture) return
  fixture.server.closeAllConnections()
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
}

// ─── IPC 助手 ───

const mcpAdd = async (name: string, port: number): Promise<string> => {
  const result = await app.main.eval<{ success: boolean; id: string }>(
    `window.api.mcp.add(${JSON.stringify({ type: 'http', name, url: `http://127.0.0.1:${port}/mcp` })})`
  )
  expect(result.success, `mcp.add ${name}`).toBe(true)
  return result.id
}

const enabledTools = async (sid: string): Promise<string[]> =>
  app.main.eval<string[]>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings && s.settings.enabledTools) || [])`
  )

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 发一句并等它跑完（IPC，不经输入框） */
const promptAwaited = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `(async () => {
      await window.api.agent
        .prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
    })()`
  )

const rollback = (sid: string, messageId: string): Promise<{ success: boolean }> =>
  app.main.eval(`window.api.message.rollback(${JSON.stringify({ sessionId: sid, messageId })})`)

/** 建一条不带项目的会话并打开它（标题不是缺省标题：不跑自动标题） */
async function openChat(title: string): Promise<string> {
  const sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
  )
  await until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  return sid
}

// ─── 脚本与请求 ───

const forPrompt =
  (text: string) =>
  (req: FakeRequest): boolean =>
    req.lastUserText === text

const searchTurn = (text: string, query: string): FakeTurn => ({
  when: forPrompt(text),
  toolCalls: [
    { id: `call_search_${++callSeq}`, name: 'tool_search', args: JSON.stringify({ query }) }
  ],
  usage: USAGE
})

const answerTurn = (text: string): FakeTurn => ({
  when: forPrompt(text),
  text: 'done',
  usage: USAGE
})

const requestsFor = (text: string): FakeRequest[] =>
  provider.chatRequests().filter((req) => req.lastUserText === text)

/** 一次请求里 system 的文字（pi-ai 按模型发成 system 或 developer） */
const systemTexts = (req: FakeRequest): string[] =>
  messageTextsOf(req)
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => m.text)

const mcpTools = (req: FakeRequest, server: string): string[] =>
  requestToolNames(req).filter((name) => name.startsWith(`mcp__${server}__`))

/** 等第 n 次请求发出（n 从 1 数）：它只有在上一个工具调用落定之后才发 */
const waitRequests = (text: string, n: number): Promise<FakeRequest[]> =>
  until(() => {
    const requests = requestsFor(text)
    return requests.length >= n ? requests : null
  }, `request ${n} for "${text}"`)

const waitCard = (): Promise<PendingAskShot> =>
  until(() => chat.pendingAskShot(), 'extension ask card')

const expectExtensionCard = (card: PendingAskShot, server: string): void => {
  expect(LOCALES.map((locale) => locale.toolCall.extensionAskEnable)).toContain(card.title)
  expect(card.icon).toBe('lucide-puzzle')
  // 内置服务器的名字只差大小写时不摆两遍（英文 Browser 对 browser）
  expect(card.preview.toLowerCase()).toContain(server.toLowerCase())
}

/** 发一句；回发送前的事件游标 */
async function send(text: string): Promise<number> {
  const since = await recorder.mark()
  await chat.typeAndSend(text)
  return since
}

async function turnEnd(sid: string, since: number): Promise<void> {
  await recorder.waitFor('agent_end', { sessionId: sid, since, timeoutMs: 30_000 })
  await chat.waitIdle()
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  recorder = eventRecorder(app.main)
  await recorder.install()
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  picker = toolPickerPane(app.main)

  live = await startLiveFixture(LIVE, [{ name: 'ping', description: 'ping' }])
  await mcpAdd(LIVE, live.port)
  await mcpAdd(CLOSED, await freePort())
  hanging = await listen(
    createServer(() => {}),
    () => undefined
  )
  await mcpAdd(HANGING, hanging.port)
}, 120_000)

afterAll(async () => {
  for (const fixture of [live, hanging, hostile]) await closeFixture(fixture)
  await provider?.close()
  await app?.stop()
})

// ─── 用例 ───

describe('tool_search 开启一台服务器', () => {
  it('TS-1 允许：下一次请求起有了它的工具；system 不变；勾选写下；agent 没重建；工具真能调', async () => {
    const TEXT = 'TS-1 open a page'
    const sid = await openChat('TS-1 search and allow')
    provider.reset()
    provider.script(
      searchTurn(TEXT, 'browser'),
      {
        when: forPrompt(TEXT),
        toolCalls: [{ id: 'call_ts1_tabs', name: 'mcp__browser__list_tabs', args: '{}' }],
        usage: USAGE
      },
      answerTurn(TEXT)
    )

    const since = await send(TEXT)
    const card = await waitCard()
    expectExtensionCard(card, 'browser')
    // 卡片等着的时候还什么都没写
    expect(await enabledTools(sid)).not.toContain('mcp:browser')
    await chat.answerPendingAsk('allow')
    await turnEnd(sid, since)

    const [first, second, third] = requestsFor(TEXT)
    expect(requestToolNames(first)).toContain('tool_search')
    expect(mcpTools(first, 'browser')).toEqual([])
    expect(mcpTools(second, 'browser')).toContain('mcp__browser__list_tabs')
    expect(requestToolNames(second)).toContain('tool_search')

    // 只改工具：system 一字不变（不是一次人设重写）
    expect(systemTexts(first).length).toBeGreaterThan(0)
    expect(systemTexts(second)).toEqual(systemTexts(first))

    const loaded = toolTextsOf(second).at(-1)!
    expect(loaded.startsWith('Loaded ')).toBe(true)
    expect(loaded).toContain('mcp__browser__list_tabs')

    expect(await enabledTools(sid)).toContain('mcp:browser')
    await picker.open()
    const row = (await picker.items()).find((item) => item.name === 'mcp:browser')
    expect(row?.checked).toBe(true)
    await picker.close()

    const lifecycle = (await recorder.allSince<RecordedEvent>(since))
      .filter((event) => event.sessionId === sid)
      .map((event) => event.type)
    expect(lifecycle).not.toContain('agent_closing')
    expect(lifecycle.filter((type) => type === 'agent_created').length).toBeLessThanOrEqual(1)

    // 工具真的跑了：结果回到了下一次请求，块上没有失败记号
    expect(toolTextsOf(third).at(-1)).not.toContain('MCP Error')
    const blocks = (await listMessages(sid)).flatMap((message) => message.blocks ?? [])
    const tabs = blocks.find((block) => block.toolName === 'mcp__browser__list_tabs')
    expect(tabs).toBeDefined()
    expect(tabs!.isError).toBeFalsy()
  })

  it('TS-2 拒绝：工具结果说用户拒绝了；勾选与工具表都没变', async () => {
    const TEXT = 'TS-2 open a page'
    const sid = await openChat('TS-2 search and deny')
    provider.reset()
    provider.script(searchTurn(TEXT, 'browser'), answerTurn(TEXT))

    const since = await send(TEXT)
    expectExtensionCard(await waitCard(), 'browser')
    await chat.answerPendingAsk('deny')
    await turnEnd(sid, since)

    const [first, second] = requestsFor(TEXT)
    expect(toolTextsOf(second).at(-1)).toContain('User denied enabling')
    expect(toolTextsOf(second).at(-1)).toContain('browser')
    expect(requestToolNames(second)).toEqual(requestToolNames(first))
    expect(await enabledTools(sid)).not.toContain('mcp:browser')
  })

  it('TS-3 停在卡片上：卡片收掉，勾选不变，服务器一个请求都没收到', async () => {
    const TEXT = 'TS-3 use the live server'
    const sid = await openChat('TS-3 stop at the card')
    provider.reset()
    provider.script(searchTurn(TEXT, LIVE))
    const before = live.requests

    const since = await send(TEXT)
    expectExtensionCard(await waitCard(), LIVE)
    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    await until(async () => (await chat.pendingAskShot()) === null, 'card gone')
    await recorder.waitFor('agent_end', { sessionId: sid, since })

    expect(await enabledTools(sid)).not.toContain(`mcp:${LIVE}`)
    expect(live.requests).toBe(before)
  })

  it('TS-4 连不上：Could not connect，勾选不变；再搜一次照问', async () => {
    const TEXT = 'TS-4 use the closed server'
    const sid = await openChat('TS-4 connection refused')
    provider.reset()
    provider.script(searchTurn(TEXT, CLOSED), searchTurn(TEXT, CLOSED), answerTurn(TEXT))

    const since = await send(TEXT)
    expectExtensionCard(await waitCard(), CLOSED)
    await chat.answerPendingAsk('allow')

    const [, second] = await waitRequests(TEXT, 2)
    const failure = toolTextsOf(second).at(-1)!
    expect(failure).toContain(`Could not connect to ${CLOSED}`)
    expect(failure).toContain('Nothing was changed')
    expect(await enabledTools(sid)).not.toContain(`mcp:${CLOSED}`)
    expect(mcpTools(second, CLOSED)).toEqual([])

    // 第二次搜：失败没有留下记忆，还是问
    expectExtensionCard(await waitCard(), CLOSED)
    await chat.answerPendingAsk('deny')
    await turnEnd(sid, since)
    expect(toolTextsOf(requestsFor(TEXT)[2]).at(-1)).toContain('User denied enabling')
    expect(await enabledTools(sid)).not.toContain(`mcp:${CLOSED}`)
  })

  it('TS-5 连接挂着时回退：10 秒内成功（不等 30 秒上限）；勾选不变；下一条消息照常跑', async () => {
    const FIRST = 'TS-5 first turn'
    const SECOND = 'TS-5 use the hanging server'
    const THIRD = 'TS-5 after the rollback'
    const sid = await openChat('TS-5 rollback while connecting')
    provider.reset()
    provider.script(answerTurn(FIRST))
    await turnEnd(sid, await send(FIRST))

    provider.script(searchTurn(SECOND, HANGING))
    const before = hanging.requests
    await send(SECOND)
    expectExtensionCard(await waitCard(), HANGING)
    await chat.answerPendingAsk('allow')
    await until(() => hanging.requests > before, 'the server got the connection')

    const target = (await listMessages(sid)).find((m) => m.content === SECOND)
    expect(target).toBeDefined()
    const started = Date.now()
    expect(await rollback(sid, target!.id)).toEqual({ success: true })
    expect(Date.now() - started).toBeLessThan(10_000)

    expect(await enabledTools(sid)).not.toContain(`mcp:${HANGING}`)
    expect((await listMessages(sid)).some((m) => m.content === SECOND)).toBe(false)

    provider.script(answerTurn(THIRD))
    await promptAwaited(sid, THIRD)
    const [after] = requestsFor(THIRD)
    expect(after).toBeDefined()
    expect(mcpTools(after, HANGING)).toEqual([])
    expect((await listMessages(sid)).map((m) => m.content)).toContain('done')
  })
})

describe('tool_search 找到几台', () => {
  it('TS-6 两个命中：没有卡片，两个名字都列出来，服务器 0 个请求；接着叫精确的名字才问', async () => {
    const TEXT = 'TS-6 two matches'
    const sid = await openChat('TS-6 two hits')
    provider.reset()
    provider.script(searchTurn(TEXT, `${LIVE} browser`), searchTurn(TEXT, LIVE), answerTurn(TEXT))
    const before = live.requests

    const since = await send(TEXT)
    const [, second] = await waitRequests(TEXT, 2)
    const list = toolTextsOf(second).at(-1)!
    expect(list).toContain('Several extensions match')
    expect(list).toContain(`- ${LIVE}`)
    expect(list).toContain('- browser: ')
    expect(live.requests).toBe(before)

    // 第二次调用是精确的名字：这才问。第一次之前没有卡片 —— 否则第二次请求根本发不出来
    expectExtensionCard(await waitCard(), LIVE)
    await chat.answerPendingAsk('deny')
    await turnEnd(sid, since)
    expect(toolTextsOf(requestsFor(TEXT)[2]).at(-1)).toContain('User denied enabling')
    expect(live.requests).toBe(before)
  })

  it('TS-7 用户 force-allow：点名的那台不问就加载；别的照问', async () => {
    const TEXT = 'TS-7 trusted server'
    const POLICY = 'e2e-trust-browser.md'
    writeUserPolicy(
      app.home,
      POLICY,
      [
        '---',
        'shuvix: policy v1',
        'name: e2e-trust-browser',
        'shuvix-policy-scope:',
        '  subject.kind: [agent]',
        '  object.type: [extension]',
        'shuvix-policy-rules:',
        '  - effect: force-allow',
        '    action: [enable]',
        `    match: "object.server == 'browser'"`,
        '---',
        ''
      ].join('\n')
    )
    await app.main.eval<boolean>(`window.api.policy.list().then(() => true)`)
    try {
      const sid = await openChat('TS-7 force allow')
      provider.reset()
      provider.script(searchTurn(TEXT, 'browser'), searchTurn(TEXT, 'database'), answerTurn(TEXT))

      const since = await send(TEXT)
      // 第二次请求发得出来，就是第一次调用没停在卡片上
      const [, second] = await waitRequests(TEXT, 2)
      expect(toolTextsOf(second).at(-1)!.startsWith('Loaded ')).toBe(true)
      expect(mcpTools(second, 'browser')).toContain('mcp__browser__list_tabs')
      expect(await enabledTools(sid)).toContain('mcp:browser')

      expectExtensionCard(await waitCard(), 'database')
      await chat.answerPendingAsk('deny')
      await turnEnd(sid, since)
      expect(await enabledTools(sid)).not.toContain('mcp:database')
    } finally {
      removeUserPolicy(app.home, POLICY)
      await app.main.eval<boolean>(`window.api.policy.list().then(() => true)`)
    }
  })

  it('TS-8 连过又断开的第三方：描述里的词找得到它；描述的内容不进任何请求；搜索不连接', async () => {
    const TEXT = 'TS-8 hostile description'
    hostile = await startLiveFixture(HOSTILE, [
      { name: 'paint', description: `${HOSTILE_WORD} browser ${HOSTILE_MARKER}` }
    ])
    const id = await mcpAdd(HOSTILE, hostile.port)
    const connected = await app.main.eval<{ success: boolean }>(
      `window.api.mcp.connect(${JSON.stringify(id)})`
    )
    expect(connected.success).toBe(true)
    await app.main.eval(`window.api.mcp.disconnect(${JSON.stringify(id)})`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const before = hostile.requests
    expect(before).toBeGreaterThan(0)

    const sid = await openChat('TS-8 hostile')
    provider.reset()
    provider.script(
      // 同时撞上这台（两个词都在描述里）和 browser（名字）：列表
      searchTurn(TEXT, `${HOSTILE_WORD} browser`),
      // 只有描述里有的词：单个命中，有卡片
      searchTurn(TEXT, HOSTILE_WORD),
      answerTurn(TEXT)
    )

    const since = await send(TEXT)
    const [, second] = await waitRequests(TEXT, 2)
    const list = toolTextsOf(second).at(-1)!
    expect(list).toContain('Several extensions match')
    expect(list).toContain(`- ${HOSTILE_LISTED} (tools: paint)`)

    const card = await waitCard()
    expectExtensionCard(card, HOSTILE)
    expect(card.preview).not.toContain(HOSTILE_MARKER)
    await chat.answerPendingAsk('deny')
    await turnEnd(sid, since)

    expect(toolTextsOf(requestsFor(TEXT)[2]).at(-1)).toContain(
      `User denied enabling extension ${HOSTILE_LISTED}`
    )
    expect(hostile.requests).toBe(before)
    // 系统提示词里列的是过滤后的名字
    expect(systemTexts(requestsFor(TEXT)[0]).join('\n')).toContain(`\`${HOSTILE_LISTED}\``)
    for (const req of provider.requests()) {
      expect(req.raw).not.toContain(HOSTILE_MARKER)
      expect(req.raw).not.toContain(HOSTILE)
    }
    expect(await enabledTools(sid)).not.toContain(`mcp:${HOSTILE}`)
  })

  it('TS-9 Electron 自己的 ICU：中文、日文的词都切得开，各自有卡片', async () => {
    const TEXT = 'TS-9 cjk queries'
    const sid = await openChat('TS-9 cjk')
    provider.reset()
    provider.script(searchTurn(TEXT, '浏览器'), searchTurn(TEXT, 'データベース'), answerTurn(TEXT))

    const since = await send(TEXT)
    expectExtensionCard(await waitCard(), 'browser')
    await chat.answerPendingAsk('deny')

    await waitRequests(TEXT, 2)
    expectExtensionCard(await waitCard(), 'database')
    await chat.answerPendingAsk('deny')
    await turnEnd(sid, since)
  })

  it('TS-10 派发的 coding：请求里没有 tool_search，system 里没有那一段；根的两样都有', async () => {
    const TEXT = 'TS-10 hand it to coding'
    const DISPATCHED = 'TS-10 dispatched prompt'
    const sid = await openChat('TS-10 dispatched')
    provider.reset()
    provider.script(
      {
        when: forPrompt(TEXT),
        toolCalls: [
          {
            id: 'call_ts10_spawn',
            name: 'agent',
            args: JSON.stringify({ description: 'sub task', name: 'coding', prompt: DISPATCHED })
          }
        ],
        usage: USAGE
      },
      {
        when: (req) => req.raw.includes(DISPATCHED) && req.lastUserText !== TEXT,
        text: 'sub done',
        usage: USAGE
      },
      answerTurn(TEXT)
    )

    const since = await send(TEXT)
    await turnEnd(sid, since)

    const [root] = requestsFor(TEXT)
    expect(requestToolNames(root)).toContain('tool_search')
    expect(systemTexts(root).join('\n')).toContain('`tool_search`')

    const spawned = provider
      .chatRequests()
      .find((req) => req.raw.includes(DISPATCHED) && req.lastUserText !== TEXT)
    expect(spawned).toBeDefined()
    // 工具名单与根同款，只少这一个：否则这条可能只是认错了请求
    expect(requestToolNames(spawned!)).toContain('read')
    expect(requestToolNames(spawned!)).not.toContain('tool_search')
    const system = systemTexts(spawned!).join('\n')
    expect(system).not.toContain('tool_search')
    for (const heading of [
      'Extensions you can ask for',
      '可以申请开启的扩展',
      '申請できる拡張機能'
    ]) {
      expect(system).not.toContain(heading)
    }
    expect(await enabledTools(sid)).toEqual([])
  })
})
