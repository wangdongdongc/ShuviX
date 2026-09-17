/**
 * 「按下回车到那句话真的落库」之间的那几秒 —— 乐观占位 + MCP 连接态。
 *
 * 用户消息由后端统一落库、经 `user_message` 事件回到列表；而创建运行时要先把这条会话勾上的
 * MCP 逐台连起来（惰性启动，单台上限 5 秒）。这几秒里输入框已经清空、列表里却还没有那句话，
 * 看上去就是「消息发丢了」。改法是两条并行的：
 *
 *   - **乐观占位**：发送方立刻把那句话画上去（固定 id `pending-prompt`，压淡、不给回退），
 *     `user_message` 一到就原地换成真实 entry。撤占位的地方只有两处：那个事件，以及发送方
 *     自己的 finally —— **`error` 事件不许碰它**，否则 MCP 连不上的报错会把刚发出的消息
 *     先抹掉几秒再补回来，正是占位要解决的那个毛病。
 *   - **连接态**：`mcp_connecting` 事件让占位卡上写明在等哪几台，工具选择器的触发钮同时转圈；
 *     `agent_created` 一到就都收掉。
 *
 * 观测手段：
 *   - 发送一律走 **UI**（`chatPane.typeAndSend`）—— 走 IPC `agent.prompt` 会绕过渲染进程的
 *     发送方，占位压根不会出现，等于什么都没测；
 *   - 「窗口内」的断言靠两台**永不应答**的 MCP（spec 进程里的 http server 收下连接就不作声），
 *     惰性连接因此稳定停在 5 秒超时上；
 *   - 「那句话一次都没从屏幕上消失过」是时段断言，轮询证不了（空窗只有几十毫秒），
 *     用页内 MutationObserver（`bubbleWatch`）记下每一次对话区变动。
 *
 * ⚠️ `[data-mcp-connecting]` 在助手卡与选择器触发钮上各有一个，必须分别定位
 * （`chatPane.mcpConnectingRow` / `toolPickerPane.connectingVisible`）。
 */
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { join } from 'node:path'
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  bubbleWatch,
  chatPane,
  sidebarPane,
  toolPickerPane,
  type BubbleFrame,
  type BubbleWatch,
  type ChatPane,
  type SidebarPane,
  type ToolPickerPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
/** 永不应答的两台（窗口就是它们撑出来的） */
const SLOW_A = 'e2e-slow-a'
const SLOW_B = 'e2e-slow-b'
/** 真连得上的一台（「已连上就不报连接态」那条的样本） */
const LIVE = 'e2elive'
/** 内置 tavily：url 里的 `{{TAVILY_API_KEY}}` 没有值，创建 Agent 时必定失败并广播 error */
const TAVILY_ID = 'builtin-mcp-tavily'

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
}

interface McpRow {
  id: string
  name: string
  status: string
}

let app: E2EApp
let provider: FakeProvider
let recorder: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let picker: ToolPickerPane
let watch: BubbleWatch
let projectId = ''
const slowServers: HttpServer[] = []
let liveServer: HttpServer | undefined

// ─── IPC 助手 ───

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const writeTools = (sid: string, enabledTools: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
  )

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 懒建运行时（不请求 LLM） */
const ensureRuntime = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)

const mcpAdd = (params: Record<string, unknown>): Promise<{ success: boolean; id: string }> =>
  app.main.eval(`window.api.mcp.add(${JSON.stringify(params)})`)

const mcpStatus = async (name: string): Promise<string> => {
  const rows = await app.main.eval<McpRow[]>(`window.api.mcp.list()`)
  return rows.find((r) => r.name === name)?.status ?? 'missing'
}

/** 本会话收到的事件（收集器是全局的，按 sessionId 过滤） */
const sessionEvents = async (sid: string): Promise<RecordedEvent[]> =>
  (await recorder.all<RecordedEvent>()).filter((e) => e.sessionId === sid)

/** 打开一条会话（等它的侧栏行出现）并等输入框就绪 */
async function openSession(title: string): Promise<void> {
  await until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

/** 建一条勾好扩展能力的会话并打开它 */
async function seedSession(title: string, tools: string[]): Promise<string> {
  const sid = await createSession(title)
  if (tools.length > 0) expect((await writeTools(sid, tools)).success).toBe(true)
  await openSession(title)
  return sid
}

/** 屏幕上「正文等于 text」的真实用户气泡（剔除占位与流式合成项） */
const realUserBubbles = async (text: string): Promise<string[]> =>
  (await chat.settledItems()).filter((i) => i.role === 'user' && i.text === text).map((i) => i.id)

/**
 * 等本轮真的跑完。
 *
 * 不能只等 `chat.waitIdle()`：它的判据是「流式占位卡不在屏」，而连接失败的 error 会先把流式态
 * 收掉（`finishStreaming`），重新生成那条路压根就不置流式态 —— 两种情形下「没有流式卡」都不等于
 * 「这一轮结束了」，等出来的空闲是假的，后面的断言就跑在半路上。
 */
async function waitTurnEnd(sid: string, since: number): Promise<void> {
  await recorder.waitFor('agent_end', { sessionId: sid, since })
  await chat.waitIdle()
}

/** 发一句并等这一轮跑完（不关心过程的那些步骤用它） */
async function sendAndWait(sid: string, text: string): Promise<void> {
  const since = await recorder.mark()
  await chat.typeAndSend(text)
  await waitTurnEnd(sid, since)
}

/**
 * 那句话在屏幕上的整段经历 —— 正常换手（E-4）与中途报错（E-9）共用这一套判据。
 *
 * 观察器记的是**每一次**对话区变动，所以「消失过没有」是真的能答的。唯一要跳过的是列表
 * **首次挂载**的头几帧：react-virtuoso 自己会把行撤下再铺回来（实测空档 ~180ms），这与占位
 * 无关 —— 同一段脚本在「列表已经挂好」的会话上一帧空窗都没有。判据因此从流式卡铺好、
 * 列表稳定下来那一帧起算；在那之前只断「占位确实上过屏」。
 */
function expectSeamlessHandover(frames: BubbleFrame[]): void {
  // 任何时刻都不会同时出现两条 —— 用户会看成自己那句话被发了两遍
  expect(frames.map((f) => f.total).filter((n) => n > 1)).toEqual([])
  expect(
    frames.some((f) => f.pending === 1),
    'the optimistic placeholder was on screen'
  ).toBe(true)

  const settled = frames.findIndex((f) => f.live)
  expect(settled, 'the conversation list finished its first mount').toBeGreaterThanOrEqual(0)
  // 列表稳定之后：等连接的那几秒、报错、换手，那句话一帧都没有从屏幕上消失过
  expect(frames.slice(settled).map((f) => f.total)).toEqual(frames.slice(settled).map(() => 1))

  // 换手原地发生：最后一帧占位的紧邻下一帧就是真实 entry —— 中间但凡插进一帧空窗，
  // 就是「消息先消失再补回来」那个毛病
  const lastPending = frames.map((f) => f.pending === 1).lastIndexOf(true)
  expect(frames[lastPending + 1]).toMatchObject({ pending: 0, real: 1 })
  expect(frames.at(-1)).toMatchObject({ pending: 0, real: 1 })
}

// ─── 假的 MCP 服务器（都跑在 vitest 进程里） ───

/** 收下连接就**永不应答** —— 惰性连接因此稳定停在 5s 超时，这就是所有「窗口内」断言的观测期 */
function startSlowServer(): Promise<{ server: HttpServer; port: number }> {
  return listen(createServer(() => {}))
}

/** 真能握手的一台（照搬 mcp-lazy-connect 的无状态写法：每请求一套 Server/Transport） */
function startLiveServer(): Promise<{ server: HttpServer; port: number }> {
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
      const mcp = new McpSdkServer(
        { name: LIVE, version: '1.0.0' },
        { capabilities: { tools: {} } }
      )
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' as const } }]
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
  return listen(server)
}

function listen(server: HttpServer): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      port ? resolve({ server, port }) : reject(new Error('no port'))
    })
  })
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const dir = join(app.home, 'pending-proj')
  mkdirSync(dir, { recursive: true })
  projectId = (await createProject(app.main, { name: 'PendingProj', path: dir })).id

  recorder = eventRecorder(app.main)
  await recorder.install()
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  picker = toolPickerPane(app.main)
  watch = bubbleWatch(app.main)

  for (const name of [SLOW_A, SLOW_B]) {
    const { server, port } = await startSlowServer()
    slowServers.push(server)
    expect(
      (await mcpAdd({ type: 'http', name, url: `http://127.0.0.1:${port}/mcp` })).success
    ).toBe(true)
  }
  const live = await startLiveServer()
  liveServer = live.server
  expect(
    (await mcpAdd({ type: 'http', name: LIVE, url: `http://127.0.0.1:${live.port}/mcp` })).success
  ).toBe(true)
  // 缺 env 的那台（UIF-E-9 的失败样本）：启用，但 url 模板永远补不上值
  expect(
    await app.main.eval(
      `window.api.mcp.update(${JSON.stringify({ id: TAVILY_ID, isEnabled: true })})`
    )
  ).toEqual({ success: true })
}, 120_000)

afterAll(async () => {
  for (const server of [...slowServers, liveServer]) {
    if (!server) continue
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await provider?.close()
  await app?.stop()
})

describe('乐观占位：发送那一刻就上屏', () => {
  it('UIF-E-3 回车即上屏：原文、压淡、无回退，输入框已清空，而树上还没有这条', async () => {
    const TEXT = 'UIF 占位一句话'
    const sid = await seedSession('UIF-E3-占位上屏', [`mcp:${SLOW_A}`])
    provider.reset()
    provider.script({ text: 'E3 answered' })

    const since = await recorder.mark()
    await chat.typeAndSend(TEXT)

    // 慢 MCP 把创建运行时按在 5 秒里 —— 下面几条都落在这个窗口内
    const pending = await until(() => chat.pendingItem(), 'optimistic placeholder on screen')
    expect(pending).toMatchObject({
      id: 'pending-prompt',
      role: 'user',
      type: 'text',
      text: TEXT,
      // 压淡一档：与真实 entry 的区别只有这一个，不另画别的东西
      pendingLook: true,
      // 回退的目标 entry 还不存在，给了就是点下去必错
      rollback: false
    })
    expect(await chat.inputValue()).toBe('')
    // 「看到的确实是乐观占位」：此刻树上一条用户消息都没有
    expect((await listMessages(sid)).filter((m) => m.role === 'user')).toEqual([])

    await waitTurnEnd(sid, since)
  })

  it('UIF-E-4 落库后原地换成真的那条：全程恰好一条，一次都没空过', async () => {
    const TEXT = 'UIF 换手一句话'
    const sid = await seedSession('UIF-E4-换手', [`mcp:${SLOW_A}`])
    provider.reset()
    provider.script({ text: 'E4 answered' })

    // 页内观察器：每次对话区变动记一帧。空窗哪怕只闪一帧也会被记下来 ——
    // 轮询做不到这件事（它只能证明「某几个时刻成立」）
    await watch.start(TEXT)
    const since = await recorder.mark()
    await chat.typeAndSend(TEXT)
    await until(() => chat.pendingItem(), 'optimistic placeholder on screen')
    await waitTurnEnd(sid, since)
    await watch.stop()

    expectSeamlessHandover(await watch.frames())

    // 落定后：那条气泡是树上的 entry，压淡标记没了，回退按钮回来了
    const ids = await realUserBubbles(TEXT)
    expect(ids).toHaveLength(1)
    expect(ids[0]).not.toBe('pending-prompt')
    expect(await chat.pendingItem()).toBeNull()
    expect(await chat.pendingLookCount()).toBe(0)
    expect(await chat.rollbackVisible(ids[0])).toBe(true)
    const listed = await listMessages(sid)
    expect(listed.find((m) => m.id === ids[0])).toMatchObject({ role: 'user', content: TEXT })
  })
})

describe('MCP 连接态：这几秒在等什么', () => {
  it('UIF-E-5 连接行写明 server 名、触发钮转圈；agent_created 之后都收掉并改挂锁', async () => {
    const TEXT = 'UIF 连接态一句话'
    const sid = await seedSession('UIF-E5-连接态', [`mcp:${SLOW_A}`])
    provider.reset()
    provider.script({ text: 'E5 answered' })
    await recorder.clear()

    await chat.typeAndSend(TEXT)

    // ① 占位卡上那一行念出在等哪台（只比名字，不比整句本地化文案）
    const row = await until(() => chat.mcpConnectingRow(), 'connecting row on the streaming card')
    expect(row).toContain(SLOW_A)
    // ② 触发钮上同时转着圈；此刻运行时还没出生，所以还没有锁
    expect(await picker.connectingVisible()).toBe(true)
    expect(await picker.lockIndicatorVisible()).toBe(false)

    // ③ 事件成对且有序：连接开始 → 落定 → 运行时出生
    await recorder.waitFor('agent_created', { sessionId: sid })
    const marks = (await sessionEvents(sid))
      .filter((e) => e.type === 'mcp_connecting' || e.type === 'agent_created')
      .map((e) => (e.type === 'mcp_connecting' ? `connecting:${e.connecting}` : e.type))
    expect(marks).toEqual(['connecting:true', 'connecting:false', 'agent_created'])

    // ④ 两处都收掉，只读的锁接上来
    await until(async () => (await chat.mcpConnectingRow()) === null, 'connecting row gone')
    expect(await picker.connectingVisible()).toBe(false)
    await until(() => picker.lockIndicatorVisible(), 'lock on the trigger once the runtime exists')

    // 本轮剩下的时间里不再冒出来
    await waitTurnEnd(sid, 0)
    expect(await chat.mcpConnectingRow()).toBeNull()
    expect(await picker.connectingVisible()).toBe(false)
  })

  it('UIF-E-6 已经连上的服务器一声不吭：没有事件，也没有连接行', async () => {
    // 第一条会话先把它连起来（不走 LLM）
    const first = await createSession('UIF-E6-首次连接')
    expect((await writeTools(first, [`mcp:${LIVE}`])).success).toBe(true)
    await ensureRuntime(first)
    expect(await mcpStatus(LIVE)).toBe('connected')

    const TEXT = 'UIF 已连上一句话'
    const sid = await seedSession('UIF-E6-复用连接', [`mcp:${LIVE}`])
    provider.reset()
    provider.script({ text: 'E6 answered' })
    await recorder.clear()

    await chat.typeAndSend(TEXT)
    // 报了才是缺陷：已连上的那台瞬间落定，写出来只会闪一下
    expect(await chat.mcpConnectingRow()).toBeNull()
    expect(await picker.connectingVisible()).toBe(false)

    await waitTurnEnd(sid, 0)
    expect((await sessionEvents(sid)).filter((e) => e.type === 'mcp_connecting')).toEqual([])
    expect(await chat.mcpConnectingRow()).toBeNull()
    expect(await realUserBubbles(TEXT)).toHaveLength(1)
  })

  it('UIF-E-7 占位与连接态都按会话隔离：切走看不见，切回来还在', async () => {
    const TEXT = 'UIF 隔离一句话'
    const other = await createSession('UIF-E7-B-干净')
    const sid = await seedSession('UIF-E7-A-在连', [`mcp:${SLOW_A}`])
    expect(other).not.toBe('')
    // B 先打开一次：窗口只有 5 秒，别把它花在首次挂载上
    await openSession('UIF-E7-B-干净')
    await openSession('UIF-E7-A-在连')

    provider.reset()
    provider.script({ text: 'E7 answered' })
    await recorder.clear()

    await chat.typeAndSend(TEXT)
    await recorder.waitFor('mcp_connecting', { sessionId: sid })
    await until(() => chat.pendingItem(), 'A: placeholder on screen')

    // 切到 B：A 的占位与连接行都不该跟过来
    await openSession('UIF-E7-B-干净')
    expect(await chat.pendingItem()).toBeNull()
    expect(await chat.mcpConnectingRow()).toBeNull()
    expect(await picker.connectingVisible()).toBe(false)

    // 切回 A：两样都还在（等一下列表重新渲染 —— 虚拟列表的行是逐帧铺出来的；
    // 窗口若已关，这里会直接超时，那说明切换比 5 秒还慢，不是实现问题）
    await openSession('UIF-E7-A-在连')
    const back = await until(
      () => chat.pendingItem(),
      'A: placeholder still there after coming back'
    )
    expect(back.text).toBe(TEXT)
    expect(await chat.mcpConnectingRow()).toContain(SLOW_A)

    await waitTurnEnd(sid, 0)
  })

  it('UIF-E-8 多台同时在连：那一行把名字都写出来', async () => {
    const TEXT = 'UIF 两台一句话'
    const sid = await seedSession('UIF-E8-两台', [`mcp:${SLOW_A}`, `mcp:${SLOW_B}`])
    provider.reset()
    provider.script({ text: 'E8 answered' })

    const since = await recorder.mark()
    await chat.typeAndSend(TEXT)
    const row = await until(() => chat.mcpConnectingRow(), 'connecting row lists both servers')
    expect(row).toContain(SLOW_A)
    expect(row).toContain(SLOW_B)

    await waitTurnEnd(sid, since)
  })
})

describe('收尾：错误与轮末都不该留下残影', () => {
  it('UIF-E-9 MCP 连接失败的 error 不撤还没落库的占位', async () => {
    const TEXT = 'UIF 报错一句话'
    // 慢的那台撑住窗口，tavily 提供一条必定到达的 error（缺 env，造 transport 之前就断）
    const sid = await seedSession('UIF-E9-报错', [`mcp:${SLOW_A}`, 'mcp:tavily'])
    provider.reset()
    provider.script({ text: 'E9 answered' })
    await recorder.clear()

    await watch.start(TEXT)
    await chat.typeAndSend(TEXT)
    await until(() => chat.pendingItem(), 'optimistic placeholder on screen')

    await recorder.waitFor<RecordedEvent>('error', { sessionId: sid })
    await waitTurnEnd(sid, 0)
    await watch.stop()

    // 报错到达时那条用户消息还没落库：事件序上 error 在 user_message 之前 —— 也就是说这条
    // error 整个落在占位的生命周期里。它若去撤占位，下面那串帧里必然出现一帧 0
    const errors = (await sessionEvents(sid)).filter((e) => e.type === 'error')
    expect(errors.some((e) => String(e.error).includes('tavily'))).toBe(true)
    const types = (await sessionEvents(sid)).map((e) => e.type)
    expect(types.indexOf('error')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('error')).toBeLessThan(types.indexOf('user_message'))

    expectSeamlessHandover(await watch.frames())

    // 错误照常上屏，且本轮落定后仍只有一条真实用户气泡
    expect(await chat.errorRows()).toBeGreaterThanOrEqual(1)
    expect(await realUserBubbles(TEXT)).toHaveLength(1)
    expect(await chat.pendingItem()).toBeNull()
  })

  it('UIF-E-10 本轮结束 / 模型调用失败后，占位与连接态都不残留', async () => {
    // a) 正常跑完一轮
    const OK_TEXT = 'UIF 收尾正常一句话'
    const okSid = await seedSession('UIF-E10a-正常', [`mcp:${SLOW_A}`])
    provider.reset()
    provider.script({ text: 'E10 answered' })
    await sendAndWait(okSid, OK_TEXT)

    expect(await chat.pendingItem()).toBeNull()
    expect(await chat.pendingLookCount()).toBe(0)
    expect(await chat.mcpConnectingRow()).toBeNull()
    expect(await picker.connectingVisible()).toBe(false)
    expect(await realUserBubbles(OK_TEXT)).toHaveLength(1)

    // b) 模型调用直接失败（provider 回 500）：占位同样由发送方的 finally 收尾
    const FAIL_TEXT = 'UIF 收尾失败一句话'
    const failSid = await seedSession('UIF-E10b-失败', [`mcp:${SLOW_A}`])
    provider.reset()
    provider.script({ httpStatus: 500 })
    await recorder.clear()
    await chat.typeAndSend(FAIL_TEXT)
    await recorder.waitFor('error', { sessionId: failSid })
    await chat.waitIdle()
    // 失败那一轮不等 agent_end（`error` 之后本轮可能直接收场）：等占位自己撤下就够了 ——
    // 它的收尾在发送方的 finally 里，`agent.prompt` 落定即跑
    await until(
      async () => (await chat.pendingItem()) === null,
      'placeholder cleaned up after the failure'
    )

    expect(await chat.pendingItem()).toBeNull()
    expect(await chat.pendingLookCount()).toBe(0)
    expect(await chat.mcpConnectingRow()).toBeNull()
    expect(await picker.connectingVisible()).toBe(false)
    expect(await realUserBubbles(FAIL_TEXT)).toHaveLength(1)
    expect(await chat.errorRows()).toBeGreaterThanOrEqual(1)
  })

  it('UIF-E-11 重新生成同样先上屏：回退把那条用户消息拿掉之后，位置上顶着占位', async () => {
    const TEXT = 'UIF 重新生成一句话'
    // 只有一轮的会话：回退会把列表清空，而重新生成那条路不置流式态 —— 占位是这几秒里
    // 屏幕上唯一的东西（空态分支若不认它，这里就是整片空白，见文件末尾的说明）
    const sid = await seedSession('UIF-E11-重新生成', [`mcp:${SLOW_A}`])
    provider.reset()
    provider.script({ text: 'first answer' }, { text: 'second answer' })

    await sendAndWait(sid, TEXT)
    const answered = await chat.settledItems()
    const lastAssistant = answered.filter((i) => i.role === 'assistant').at(-1)
    expect(lastAssistant?.text).toBe('first answer')

    // 重新生成 = 回退到那条用户消息之前 + 重发（回退顺带关停运行时，于是重建窗口又开着）
    const since = await recorder.mark()
    await chat.clickRegenerate(lastAssistant!.id)
    const pending = await until(() => chat.pendingItem(), 'placeholder while regenerating')
    expect(pending.text).toBe(TEXT)
    // 此刻树上那条已经没了、列表也空了 —— 没有占位的话，整个重建窗口里对话流是一片空白
    expect(await realUserBubbles(TEXT)).toEqual([])
    expect((await listMessages(sid)).filter((m) => m.content === TEXT)).toEqual([])

    await waitTurnEnd(sid, since)
    expect(await chat.pendingItem()).toBeNull()
    expect(await realUserBubbles(TEXT)).toHaveLength(1)
    expect((await listMessages(sid)).filter((m) => m.content === TEXT)).toHaveLength(1)
  })
})

/*
 * ── 给后来者的一句：空态分支必须把占位算作内容 ────────────────────────────────
 *
 * `Conversation` 的空态分支是 `messages.length === 0 && !isStreaming && !pendingPrompt`。
 * 少了最后那一项，「新会话的第一条消息」与「只有一轮时点重新生成」这两条路上，刚发出的那句话
 * 会被整片空态盖住（两者都是列表为空 + 流式态没开着）—— 占位还在 store 里，只是画不出来。
 * UIF-E-4 / E-9 / E-11 就跑在这两条路上，改坏了它们会直接红。
 */
