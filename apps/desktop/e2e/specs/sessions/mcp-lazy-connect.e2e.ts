/**
 * MCP 惰性启动 —— 「用到才连、重试在使用时、连不上不挡创建」。
 *
 * 改制前是「开机 connectAll + 增改自动重连 + 按连接状态算可用」。这三条各自有一个看不见的后果：
 * 启动时一台 npx 冷启动能把整个 app 拖住；在设置页改一个 header 就当场拉起连接；以及最隐蔽的
 * 那条 —— 用户勾好的服务器会在创建 Agent 的**前一刻**因为「还没连上」被判为不可用而抹掉，
 * 而它恰恰要在下一步才被连起来。本 spec 把三条都钉在真实例上。
 *
 * 确定性的失败样本是隔离实例里恒有的内置 `tavily`：url 含 `{{TAVILY_API_KEY}}` 而 env 为空，
 * 于是每次尝试都在 `resolveTemplates` 就断掉 —— **不走网络、立即失败**，没有任何超时抖动。
 *
 * ⚠️ 与用例清单的一处偏差：清单说失败会写 `connect failed: tavily`。实际不会 ——
 * 缺 env 的分支在造 transport 之前就 return 了，日志是 `skip tavily: env variable … is not set`
 * （见 `mcpManager.openConnection`）。它同样是**一次尝试一行**，「重试只在使用时」照样钉得住，
 * 故按实现的真实行文断言（`ATTEMPT_LINE`）。
 *
 * 断言优先走 IPC（`window.api.mcp.*` / `session.*` / `agent.*`）；失败提示只走 `error` ChatEvent
 * （**不落库**，只能用 eventRecorder 抓）；「没有发生过连接」这类否定断言走主进程日志。
 * 全程无 LLM：运行时靠 `agent.getInfo(sid, { ensure: true })` 懒建。
 *
 * 用例之间**故意不 clear() 事件缓冲**：E-3/E-4 要回看 E-2 留下的那几条。
 */
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { join } from 'node:path'
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createProject,
  eventRecorder,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  sidebarPane,
  toolPickerPane,
  type SidebarPane,
  type ToolPickerPane
} from '../../harness/pages'

/** 内置 Tavily（migrations.ts 种下的）—— 隔离实例里恒在，且必定连不上 */
const TAVILY_ID = 'builtin-mcp-tavily'
const TAVILY = 'mcp:tavily'
const MISSING_ENV = 'Missing required env variable: TAVILY_API_KEY'
/** 一次连接尝试在主进程日志里留下的那一行（缺 env 分支，见文件头说明） */
const ATTEMPT_LINE = 'skip tavily: env variable TAVILY_API_KEY is not set'
const PROJECT_NAME = 'MCPL-项目'

interface McpRow {
  id: string
  name: string
  status: string
  error?: string
  toolCount: number
  isEnabled: number
}

interface RuntimeInfo {
  tools: Array<{ name: string }>
}

let app: E2EApp
let recorder: EventRecorder
let sidebar: SidebarPane
let picker: ToolPickerPane
let projectId = ''

// ─── IPC 助手 ───

const mcpList = (): Promise<McpRow[]> => app.main.eval<McpRow[]>(`window.api.mcp.list()`)

const mcpAdd = (params: Record<string, unknown>): Promise<{ success: boolean; id: string }> =>
  app.main.eval(`window.api.mcp.add(${JSON.stringify(params)})`)

const mcpUpdate = (params: Record<string, unknown>): Promise<{ success: boolean }> =>
  app.main.eval(`window.api.mcp.update(${JSON.stringify(params)})`)

const mcpConnect = (id: string): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.mcp.connect(${JSON.stringify(id)})`)

const mcpDisconnect = (id: string): Promise<{ success: boolean }> =>
  app.main.eval(`window.api.mcp.disconnect(${JSON.stringify(id)})`)

const rowOf = async (id: string): Promise<McpRow> => {
  const row = (await mcpList()).find((r) => r.id === id)
  if (!row) throw new Error(`mcp row ${id} not found`)
  return row
}

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const storedTools = (sid: string): Promise<unknown> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings ? s.settings.enabledTools : undefined))`
  )

const writeTools = (sid: string, enabledTools: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
  )

/** 懒建运行时（不请求 LLM）并回快照 */
const ensureRuntime = (sid: string): Promise<RuntimeInfo | null> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)

/** 本会话收到的 error ChatEvent（会话 id 唯一，不必再按序号切片） */
const errorsOf = async (sid: string): Promise<RecordedEvent[]> =>
  (await recorder.all<RecordedEvent>()).filter((e) => e.type === 'error' && e.sessionId === sid)

// ─── 主进程日志助手 ───

/** 某行文案在日志里出现的次数（一次连接尝试 = 一行） */
const countInLog = (needle: string): number => app.mainLog().split(needle).length - 1

/** MCP 模块自己的日志行（electron-log 把 scope 渲染成 ` (MCP)`），别的模块的 skip/connect 不算数 */
const mcpLogLines = (): string[] =>
  app
    .mainLog()
    .split('\n')
    .filter((l) => l.includes('(MCP)'))

/**
 * 日志里所有「真发生过一次连接尝试」的行：连上 / 连失败 / 缺 env 跳过。
 * `connected: ` 必须排掉 `disconnected: <id>`（后者是前者的子串）。
 */
const connectionLines = (): string[] =>
  mcpLogLines().filter(
    (l) => /(?<!dis)connected: /.test(l) || l.includes('connect failed: ') || l.includes('skip ')
  )

const waitRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)

const pickerItem = async (
  name: string
): Promise<{ checked: boolean; offline: boolean } | undefined> =>
  (await picker.items()).find((it) => it.name === name)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  recorder = eventRecorder(app.main)
  await recorder.install()
  sidebar = sidebarPane(app.main)
  picker = toolPickerPane(app.main)

  const dir = join(app.home, 'mcpl-project')
  mkdirSync(dir, { recursive: true })
  projectId = (await createProject(app.main, { name: PROJECT_NAME, path: dir })).id
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('启动与配置变更都不连（IPC + 主进程日志）', () => {
  it('MCPL-E-1 刚起的实例一台都没连；add / update 也不连', async () => {
    // 没有 connectAll 了：实例起来这么久，日志里不该有任何一次连接
    expect(connectionLines()).toEqual([])
    const initial = await mcpList()
    expect(initial.length).toBeGreaterThan(0)
    for (const row of initial) {
      expect(row.status, row.name).toBe('disconnected')
      expect(row.error, row.name).toBeFalsy()
    }

    // 新增一台（handler 落库即启用）：仍然不连 —— 连不连由「哪条会话用到它」决定
    const added = await mcpAdd({
      type: 'http',
      name: 'e2e-lazy',
      url: 'http://127.0.0.1:1/mcp'
    })
    expect(added.success).toBe(true)

    // 改配置（这里是启用内置 tavily）：只断开旧连接，绝不重连
    expect(await mcpUpdate({ id: TAVILY_ID, isEnabled: true })).toEqual({ success: true })

    await sleep(1000)
    expect(connectionLines()).toEqual([])
    const after = await mcpList()
    for (const row of after) {
      expect(row.status, row.name).toBe('disconnected')
      expect(row.error, row.name).toBeFalsy()
    }
    // 没连过就没有 cachedTools —— 0 个工具不是错误状态
    const lazyRow = after.find((r) => r.id === added.id)!
    expect(lazyRow.toolCount).toBe(0)
    expect(lazyRow.status).toBe('disconnected')
    expect(lazyRow.error).toBeFalsy()
  })
})

describe('可用性来自配置，不来自连接状态', () => {
  let s1 = ''
  let s2 = ''

  it('MCPL-E-2 停用的被滤掉（零尝试）；启用但没连上的被保留（有尝试）', async () => {
    // ① 停用态下勾上它：勾选照原样落库（写入口不按可用性过滤）
    expect(await mcpUpdate({ id: TAVILY_ID, isEnabled: false })).toEqual({ success: true })
    s1 = await createSession('MCPL-E2-停用')
    expect((await writeTools(s1, [TAVILY])).success).toBe(true)
    expect(await storedTools(s1)).toEqual([TAVILY])

    await ensureRuntime(s1)
    await sleep(500)
    // 配置里停用 = 真的不可用：创建 Agent 时它被滤掉，一次连接尝试都没有
    expect(await errorsOf(s1)).toEqual([])
    expect(countInLog(ATTEMPT_LINE)).toBe(0)
    expect((await rowOf(TAVILY_ID)).status).toBe('disconnected')
    // 勾选没有被创建过程改写
    expect(await storedTools(s1)).toEqual([TAVILY])

    // ② 启用之后同样的勾选：这一次它是可用的，于是在创建 Agent 那一刻被连（并失败）
    expect(await mcpUpdate({ id: TAVILY_ID, isEnabled: true })).toEqual({ success: true })
    s2 = await createSession('MCPL-E2-启用')
    expect((await writeTools(s2, [TAVILY])).success).toBe(true)

    await ensureRuntime(s2)
    await recorder.waitFor<RecordedEvent>('error', { sessionId: s2 })
    expect(await errorsOf(s2)).toHaveLength(1)
    expect((await rowOf(TAVILY_ID)).status).toBe('error')
    expect(await storedTools(s2)).toEqual([TAVILY])
  })

  it('MCPL-E-3 连不上不挡创建：Agent 照常建出来，失败以会话里的一条错误提示落地', async () => {
    const info = await ensureRuntime(s2)
    expect(info).not.toBeNull()
    const names = info!.tools.map((t) => t.name)
    // 少的只是这台服务器的工具，内置工具一个不缺
    expect(names).toContain('read')
    expect(names.filter((n) => n.startsWith('mcp__'))).toEqual([])

    // 失败要让人看见：用户刚发出的那条消息就在眼前，不能让工具凭空消失
    const [ev] = await errorsOf(s2)
    expect(String(ev.error)).toContain('tavily')
    expect(String(ev.error)).toContain(MISSING_ENV)

    // 设置页读到的是同一个原因
    const row = await rowOf(TAVILY_ID)
    expect(row.status).toBe('error')
    expect(row.error).toBe(MISSING_ENV)
    expect(countInLog(ATTEMPT_LINE)).toBe(1)
  })

  it('MCPL-E-4 重试在使用时，不在后台', async () => {
    const attemptsBefore = countInLog(ATTEMPT_LINE)
    const errorsBefore = (await recorder.all<RecordedEvent>()).filter(
      (e) => e.type === 'error'
    ).length

    // 静置：没有重试队列，也没有定时器 —— 这几秒里什么都不该发生
    await sleep(6000)
    expect(countInLog(ATTEMPT_LINE)).toBe(attemptsBefore)
    expect((await recorder.all<RecordedEvent>()).filter((e) => e.type === 'error').length).toBe(
      errorsBefore
    )
    expect((await rowOf(TAVILY_ID)).status).toBe('error')

    // 下一条会话用到它：原地再试**恰好一次**（上次失败的状态不会把它永久拉黑）
    const s3 = await createSession('MCPL-E4-再用一次')
    expect((await writeTools(s3, [TAVILY])).success).toBe(true)
    await ensureRuntime(s3)
    await recorder.waitFor<RecordedEvent>('error', { sessionId: s3 })

    expect(countInLog(ATTEMPT_LINE)).toBe(attemptsBefore + 1)
    expect(await errorsOf(s3)).toHaveLength(1)
  })

  it('MCPL-E-5 设置页手动连接把失败原因回传（不再是恒 success）', async () => {
    expect(await mcpConnect(TAVILY_ID)).toEqual({ success: false, error: MISSING_ENV })
    expect((await rowOf(TAVILY_ID)).status).toBe('error')
  })
})

describe('「没连上」不再被画成离线（DOM）', () => {
  it('MCPL-E-6 未启动的行不标红，失败过的才标红', async () => {
    // 复位成「没启动」（惰性启动下这是常态，与「从没连过」同一档状态）
    await mcpDisconnect(TAVILY_ID)
    expect((await rowOf(TAVILY_ID)).status).toBe('disconnected')

    const title = 'MCPL-E6-选择器'
    const s = await createSession(title)
    expect((await writeTools(s, [TAVILY])).success).toBe(true)
    await waitRow(title)
    expect(await sidebar.openSession(title)).toBe(true)

    await until(() => picker.present(), 'tool picker present')
    await picker.open()
    const notStarted = await until(() => pickerItem(TAVILY), 'tavily listed in the picker')
    // 惰性启动下「还没连」是常态：勾着、正常颜色，绝不画成离线
    expect(notStarted).toMatchObject({ checked: true, offline: false })
    await picker.close()

    // 走一次失败的创建，让它变成 error
    await ensureRuntime(s)
    await recorder.waitFor<RecordedEvent>('error', { sessionId: s })
    expect((await rowOf(TAVILY_ID)).status).toBe('error')

    // 重开面板才会重新拉 tools.list（ToolPicker 在 open 时刷新）
    await picker.open()
    await until(
      async () => (await pickerItem(TAVILY))?.offline === true,
      'a failed server is painted offline'
    )
    expect(await pickerItem(TAVILY)).toMatchObject({ checked: true })
    await picker.close()
  })
})

// ─── 成功路径：spec 进程里起一台真的 MCP HTTP server ───

/** 这台真服务器暴露的工具 —— 名字要能在运行时快照里原样认出来（`mcp__e2elive__<tool>`） */
const LIVE_TOOLS = [
  {
    name: 'echo',
    description: 'echo back the text',
    inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } }
  },
  { name: 'ping', description: 'ping', inputSchema: { type: 'object' as const } }
]
const LIVE_NAME = 'e2elive'

/**
 * 无状态（`sessionIdGenerator: undefined`）+ **每请求一套 Server/Transport** —— SDK 文档的
 * stateless 写法。复用同一套实例时 `notifications/initialized` 那一发会 500。
 */
function startLiveMcpServer(): Promise<{ server: HttpServer; port: number }> {
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
        { name: LIVE_NAME, version: '1.0.0' },
        { capabilities: { tools: {} } }
      )
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LIVE_TOOLS }))
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
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      port ? resolve({ server, port }) : reject(new Error('no port'))
    })
  })
}

describe('惰性连接的成功路径（真 MCP server）', () => {
  let live: { server: HttpServer; port: number } | undefined
  let liveId = ''

  beforeAll(async () => {
    live = await startLiveMcpServer()
    const added = await mcpAdd({
      type: 'http',
      name: LIVE_NAME,
      url: `http://127.0.0.1:${live.port}/mcp`
    })
    liveId = added.id
    // 加完不连 —— 与 E-1 同一条规则，这里顺手再确认一次
    expect((await rowOf(liveId)).status).toBe('disconnected')
    expect(countInLog(`connected: ${LIVE_NAME}`)).toBe(0)
  }, 60_000)

  afterAll(async () => {
    if (!live) return
    live.server.closeAllConnections()
    await new Promise<void>((resolve) => live!.server.close(() => resolve()))
  })

  it('MCPL-E-7 用到那一刻才连上，工具进到 Agent；第二条会话复用活连接', async () => {
    const s1 = await createSession('MCPL-E7-第一条')
    expect((await writeTools(s1, [`mcp:${LIVE_NAME}`])).success).toBe(true)

    const info = await ensureRuntime(s1)
    expect(info).not.toBeNull()
    const names = info!.tools.map((t) => t.name)
    expect(names).toContain(`mcp__${LIVE_NAME}__echo`)
    expect(names).toContain(`mcp__${LIVE_NAME}__ping`)
    expect(await errorsOf(s1)).toEqual([])

    const row = await rowOf(liveId)
    expect(row.status).toBe('connected')
    // 工具数走 cachedTools（这一次连上时发现的）
    expect(row.toolCount).toBe(LIVE_TOOLS.length)
    expect(countInLog(`connected: ${LIVE_NAME}`)).toBe(1)

    // 第二条会话：已连上就直接用，不重开一条连接（stdio 的话就是不重开一个子进程）
    const s2 = await createSession('MCPL-E7-第二条')
    expect((await writeTools(s2, [`mcp:${LIVE_NAME}`])).success).toBe(true)
    const info2 = await ensureRuntime(s2)
    expect(info2!.tools.map((t) => t.name)).toContain(`mcp__${LIVE_NAME}__echo`)
    expect(countInLog(`connected: ${LIVE_NAME}`)).toBe(1)
    expect(await errorsOf(s2)).toEqual([])
  })
})
