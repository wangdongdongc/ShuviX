/**
 * 内置能力服务器 `database` 在会话里 —— 工具从哪来、跑起来是什么样、结果怎么画（假提供商脚本化，
 * 后面是一台真的 PostgreSQL：PGlite + TCP bridge，见 harness/databaseFixtures.ts）。
 *
 * 数据库不再是 work / chat / coding 都带的内置工具，而是按会话勾选的 `mcp:database`：一条会话勾了
 * 它，创建根 Agent 的那一刻才起一台进程内 server（会话级实例），工具是 `mcp__database__
 * list-connections` / `mcp__database__query`。凭据留在 ShuviX（设置页存的 `db_credentials`），
 * 模型只按连接名引用 —— 用户名、密码、库名、主机与端口一样都不该出现在它看得见的地方。本 spec 分三段：
 *
 *   - **工具从哪来**（DBE-T）：五种会话形态缺省都没有；输入框的选择器里勾上、项目默认、agent 文件
 *     声明，三条路任一条都给这两个工具，而且发给模型的就是这两个；退役的裸名 `database` 什么也不给；
 *   - **主流程**（DBE-F，一条勾了 database 的会话，开在界面上）：列连接 → 只读连接上读、写不进去
 *     （预检挡一层、库自己挡一层，agent 也改不回可写）→ 可写连接上每条语句都问（卡片写明是哪个
 *     连接）：允许 / 拒绝 / 「其它」/ 中止 / 免询问 → 名字不对、连不上、一次几条语句。
 *     「SQL 到没到服务器」一律按 bridge 的语句日志断（含扩展协议的 `P`），行数按库里的真实行数断；
 *   - **呈现**（DBE-R）：两个工具的标签、图标与「连接名 · 说明」；模型还在叫退役的 `database`、
 *     旧会话里的 `database` 调用，都仍有数据库的标签与图标。
 *
 * 纪律：每条会话都给显式标题（缺省标题会让自动起标题的 hook 抢走脚本里的轮次）；询问一律手工应答。
 * 一台 bridge 只给一个连接用（PGlite 只有一个会话，只读标志会串）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createAgentSession,
  createPinnedChildSession,
  createProject,
  eventRecorder,
  securityDecisions,
  seedFakeProvider,
  waitRendererReady,
  writeAgentMd,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent,
  type SecurityDecisionEntry
} from '../../harness/seed'
import {
  chatPane,
  sidebarPane,
  toolPickerPane,
  type ChatPane,
  type ChatToolRowShot,
  type SidebarPane,
  type ToolPickerPane
} from '../../harness/pages'
import { browserDriver, type BrowserDriver } from '../../harness/browserFixtures'
import {
  DATABASE_TOOL_NAMES,
  DB_LABELS,
  ONE_STATEMENT,
  READONLY_PRECHECK,
  addDbCredential,
  dbTool,
  startPgBridge,
  type DbCredentialSeed,
  type PgBridge
} from '../../harness/databaseFixtures'

const MODEL = 'e2e-model'
const ALL_DB_TOOLS = DATABASE_TOOL_NAMES.map(dbTool).sort()
const QUERY = dbTool('query')
const LIST = dbTool('list-connections')
/** 一次会话级实例连上时 MCP 模块写下的那一行 */
const CONNECTED_LINE = `connected: database (${DATABASE_TOOL_NAMES.length} tools)`

/** 三条连接的用户名 / 密码 / 库名都是特征串：「有没有漏给模型」按它们断 */
const RO_SECRETS = {
  username: 'e2e_ro_user_q7',
  password: 'e2e-ro-secret-K9x',
  database: 'e2e_ro_db_m4'
}
const RW_SECRETS = {
  username: 'e2e_rw_user_z2',
  password: 'e2e-rw-secret-P5x',
  database: 'e2e_rw_db_h8'
}
const DOWN_SECRETS = {
  username: 'e2e_down_user_c3',
  password: 'e2e-down-secret-W1x',
  database: 'e2e_down_db_t6'
}
const ALL_SECRETS = [RO_SECRETS, RW_SECRETS, DOWN_SECRETS].flatMap((s) => Object.values(s))

/** 期望的连接列表（设置里存的顺序） */
const LISTED = [
  '3 saved connection(s):',
  '  e2e-ro  (postgresql, read-only)',
  '  e2e-rw  (postgresql)',
  '  e2e-down  (postgresql, read-only)'
]

interface RuntimeInfo {
  tools: Array<{ name: string }>
}

interface ListedTool {
  name: string
  isBuiltin?: boolean
  declaredBy?: string
}

interface ListedMessage {
  blocks?: Array<{ type: string; toolCallId?: string; isError?: boolean }>
}

/** 发给模型的一个工具（openai-completions 请求体里的 `tools[]`） */
interface RequestTool {
  function: { name: string; description?: string; parameters?: { required?: string[] } }
}

interface RuntimeEventShape extends RecordedEvent {
  runtimeId: string
  status: Record<string, unknown> | null
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let driver: BrowserDriver
let chat: ChatPane
let sidebar: SidebarPane
let picker: ToolPickerPane
let ro: PgBridge
let rw: PgBridge
let projectId = ''
/** ask-on-database 的显示名（随界面语言变 —— 从策略列表里取，不写死） */
let askOnDatabaseName = ''

// ─── IPC 助手 ───

const createSession = (opts: { title: string; projectId?: string }): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify(opts)}).then((s) => s.id)`)
const storedTools = (sid: string): Promise<unknown> =>
  app.main.eval(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings ? s.settings.enabledTools : undefined))`
  )
const writeTools = (sid: string, enabledTools: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
  )
const ensureRuntime = async (sid: string): Promise<string[]> => {
  const info = await app.main.eval<RuntimeInfo | null>(
    `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`
  )
  return (info?.tools ?? []).map((t) => t.name)
}
const dbToolsOf = (names: string[]): string[] =>
  names.filter((n) => n.startsWith('mcp__database__')).sort()
const toolsList = (sid: string): Promise<ListedTool[]> =>
  app.main.eval<ListedTool[]>(`window.api.tools.list(${JSON.stringify(sid)})`)
const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)
const runtimeStatuses = (sid: string): Promise<Record<string, unknown>> =>
  app.main.eval(`window.api.runtime.statuses(${JSON.stringify(sid)})`)
const setAutoAllow = (sid: string, on: boolean): Promise<unknown> =>
  app.main.eval(`window.api.session.updateAutoAllow(${JSON.stringify({ id: sid, autoAllow: on })})`)
/** 建一条勾了 mcp:database 的会话，让运行时起来，回会话 id */
const tickedSession = async (title: string): Promise<string> => {
  const sid = await createSession({ title })
  expect((await writeTools(sid, ['mcp:database'])).success).toBe(true)
  expect(dbToolsOf(await ensureRuntime(sid))).toEqual(ALL_DB_TOOLS)
  return sid
}

const countInLog = (needle: string): number => app.mainLog().split(needle).length - 1

/** 这次调用的安全决策（按 toolCallId 认） */
const decisionsOf = (toolCallId: string): SecurityDecisionEntry[] =>
  securityDecisions(app).filter((d) => d.toolCallId === toolCallId)
/** 等这次调用的那一条决策落进日志 */
const decisionOf = (toolCallId: string): Promise<SecurityDecisionEntry> =>
  until(() => decisionsOf(toolCallId)[0], `security decision of ${toolCallId}`)

/** 最近一次发给模型的请求里的工具 */
const lastRequestTools = (): RequestTool[] => {
  const reqs = provider.chatRequests()
  return (reqs[reqs.length - 1]?.body.tools ?? []) as RequestTool[]
}

/** 起点之后这条会话的 `db` 运行时事件 */
const dbEvents = async (since: number, sid: string): Promise<RuntimeEventShape[]> =>
  (await driver.eventsSince<RuntimeEventShape>(since, 'runtime_event', sid)).filter(
    (e) => e.runtimeId === 'db'
  )

/** 状态条上 `db` 那一条 */
const banner = (database: string, more = 0): Record<string, unknown> => ({
  label: `postgresql ${database}${more > 0 ? ` +${more}` : ''}`,
  icon: 'Database',
  color: '#f59e0b',
  description: '127.0.0.1'
})

/** 一次 query 调用 */
const q = (
  id: string,
  connection: string,
  sql: string,
  description: string
): { id: string; tool: string; args: Record<string, unknown> } => ({
  id,
  tool: QUERY,
  args: { connection, sql, description }
})

const waitSidebarRow = (title: string): Promise<boolean> =>
  until(async () => (await sidebar.titles()).includes(title), `sidebar row "${title}"`)
const openInUi = async (title: string): Promise<void> => {
  await waitSidebarRow(title)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

/** 一行已落定的工具行（按工具名 + 摘要认；摘要可省） */
const settledRow = (
  name: string,
  status: 'done' | 'error',
  detail?: string
): Promise<ChatToolRowShot> =>
  until(
    async () => {
      const rows = await chat.toolRowShots()
      return (
        rows.find(
          (r) =>
            r.name === name && r.status === status && (detail === undefined || r.detail === detail)
        ) ?? null
      )
    },
    `${name} row settled as ${status}${detail ? ` (${detail})` : ''}`
  )

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  driver = browserDriver({ main: app.main, provider, events })
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  picker = toolPickerPane(app.main)

  ro = await startPgBridge(
    [
      'CREATE TABLE users (id int PRIMARY KEY, name text NOT NULL);',
      "INSERT INTO users VALUES (1, 'ada'), (2, 'grace'), (3, 'linus');"
    ].join('\n')
  )
  rw = await startPgBridge('CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL);')
  const seeds: DbCredentialSeed[] = [
    {
      name: 'e2e-ro',
      dbType: 'postgresql',
      host: '127.0.0.1',
      port: ro.port,
      readonly: true,
      ...RO_SECRETS
    },
    {
      name: 'e2e-rw',
      dbType: 'postgresql',
      host: '127.0.0.1',
      port: rw.port,
      readonly: false,
      ...RW_SECRETS
    },
    {
      name: 'e2e-down',
      dbType: 'postgresql',
      host: '127.0.0.1',
      port: 9,
      readonly: true,
      ...DOWN_SECRETS
    }
  ]
  for (const seed of seeds) {
    await addDbCredential(app.main, seed)
    // 列表按 createdAt 排：隔一毫秒以上，顺序才是确定的
    await sleep(5)
  }

  const projDir = join(app.home, 'db-session-proj')
  mkdirSync(join(projDir, 'notes'), { recursive: true })
  writeFileSync(join(projDir, 'notes', 'db-note.md'), '# DB note\n')
  projectId = (await createProject(app.main, { name: 'DB-Session-Proj', path: projDir })).id

  const policies =
    await app.main.eval<Array<{ name: string; displayName: string }>>(`window.api.policy.list()`)
  askOnDatabaseName = policies.find((p) => p.name === 'ask-on-database')?.displayName ?? ''
  expect(askOnDatabaseName).not.toBe('')
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
  await ro?.close()
  await rw?.close()
})

// ═══════════════════════════════════════════════════════════════════════
// 工具从哪来
// ═══════════════════════════════════════════════════════════════════════

describe('工具从哪来（DBE-T）', () => {
  let chatSid = ''

  it('DBE-T1 缺省一个都没有：work / chat / notebook / bot / 钉成 coding 的子会话', async () => {
    const mark = await events.mark()
    writeBotMd(app, 'db-bot', { displayName: 'DB Bot' })

    const work = await createAgentSession(app.main, { projectId, title: 'DBE-T1 work' })
    chatSid = (await createAgentSession(app.main, { title: 'DBE-T1 chat' })).sid
    const notebook = await createAgentSession(app.main, {
      projectId,
      title: 'DBE-T1 notebook',
      notebookPath: 'notes/db-note.md'
    })
    const bot = await createAgentSession(app.main, { bot: 'db-bot', title: 'DBE-T1 bot' })
    const child = await createPinnedChildSession(app, {
      parentSid: work.sid,
      agentProfile: 'coding',
      title: 'DBE-T1 coding child'
    })

    for (const [form, sid] of [
      ['work', work.sid],
      ['chat', chatSid],
      ['notebook', notebook.sid],
      ['bot', bot.sid],
      ['coding child', child]
    ] as const) {
      const names = await ensureRuntime(sid)
      expect(dbToolsOf(names), form).toEqual([])
      // 退役的内置工具也不在了（没有别名）
      expect(names, form).not.toContain('database')
      // 没有哪个基座档案声明它：选择器里它只是一个没勾的内置条目
      const item = (await toolsList(sid)).find((t) => t.name === 'mcp:database')
      expect(item, form).toMatchObject({ isBuiltin: true })
      expect(item?.declaredBy, form).toBeUndefined()
      expect(
        (await toolsList(sid)).some((t) => t.name === 'database'),
        form
      ).toBe(false)
      expect(await storedTools(sid), form).toEqual([])
    }

    // 没有谁用到它，所以谁都没连它
    expect(countInLog('connected: database')).toBe(0)
    const connecting = (await events.allSince<RecordedEvent>(mark)).filter(
      (e) => e.type === 'mcp_connecting' && e.server === 'database'
    )
    expect(connecting).toEqual([])
  }, 120_000)

  it('DBE-T2 发给模型的请求里也没有：既没有 mcp__database__*，也没有旧的 database', async () => {
    provider.reset()
    await driver.run(chatSid, [], 'hello')
    const names = lastRequestTools().map((t) => t.function.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => n.startsWith('mcp__database__'))).toEqual([])
    expect(names).not.toContain('database')
  }, 120_000)

  it('DBE-T3 输入框的选择器里勾上：存成 [mcp:database]；下一次请求恰好多出两个工具；连接过程可见且只连一次', async () => {
    provider.reset()
    const title = 'DBE-T3 picker'
    const sid = await createSession({ title })
    await openInUi(title)

    await picker.open()
    const item = await until(
      async () => (await picker.items()).find((i) => i.name === 'mcp:database'),
      'mcp:database listed in the picker'
    )
    expect(item).toMatchObject({ checked: false, disabled: false, declared: false })
    expect(await picker.toggle('mcp:database')).toBe(true)
    await until(
      async () => JSON.stringify(await storedTools(sid)) === JSON.stringify(['mcp:database']),
      'selection stored'
    )
    await picker.close()

    const connectedBefore = countInLog(CONNECTED_LINE)
    const mark = await events.mark()
    await driver.run(sid, [], 'hello with a database')

    const tools = lastRequestTools()
    const dbTools = tools.filter((t) => t.function.name.startsWith('mcp__database__'))
    expect(dbTools.map((t) => t.function.name).sort()).toEqual(ALL_DB_TOOLS)
    const query = dbTools.find((t) => t.function.name === QUERY)
    expect([...(query?.function.parameters?.required ?? [])].sort()).toEqual([
      'connection',
      'description',
      'sql'
    ])
    // 工具描述里只有名字这回事：一个连接名、一台主机都不会写进去
    const described = dbTools.map((t) => t.function.description ?? '').join('\n')
    expect(described).toContain('list-connections')
    expect(described).not.toContain('e2e-ro')
    expect(described).not.toContain('127.0.0.1')

    // 惰性连接的可见过程：转圈 → 停 → Agent 建好，中间没有错误
    const lifecycle = (await events.allSince<RecordedEvent>(mark))
      .filter(
        (e) =>
          e.sessionId === sid &&
          (e.type === 'mcp_connecting' || e.type === 'agent_created' || e.type === 'error')
      )
      .map((e) => (e.type === 'mcp_connecting' ? `mcp_connecting:${String(e.connecting)}` : e.type))
    expect(lifecycle).toEqual(['mcp_connecting:true', 'mcp_connecting:false', 'agent_created'])
    const connecting = (await events.allSince<RecordedEvent>(mark)).find(
      (e) => e.type === 'mcp_connecting'
    )
    expect(connecting?.server).toBe('database')
    await until(
      () => countInLog(CONNECTED_LINE) === connectedBefore + 1,
      'one session instance connected'
    )
  }, 120_000)

  it('DBE-T4 项目默认勾了它：新会话继承这份勾选，运行时拿到工具', async () => {
    const dir = join(app.home, 'db-default-proj')
    mkdirSync(dir, { recursive: true })
    const project = await app.main.eval<{ id: string }>(
      `window.api.project.create(${JSON.stringify({
        name: 'DB-Default-Proj',
        path: dir,
        enabledTools: ['mcp:database']
      })})`
    )
    const sid = await createSession({ title: 'DBE-T4 inherits', projectId: project.id })
    expect(await storedTools(sid)).toEqual(['mcp:database'])
    expect(dbToolsOf(await ensureRuntime(sid))).toEqual(ALL_DB_TOOLS)
  }, 120_000)

  it('DBE-T5 agent 文件声明它：钉了这份档案的子会话不勾也有，勾选里也不会多出它', async () => {
    writeAgentMd(app, 'dbby', { tools: 'read, mcp:database', displayName: 'Dbby' })
    const parent = await createSession({ title: 'DBE-T5 parent' })
    const child = await createPinnedChildSession(app, {
      parentSid: parent,
      agentProfile: 'dbby',
      title: 'DBE-T5 dbby child'
    })

    const names = await ensureRuntime(child)
    expect(dbToolsOf(names)).toEqual(ALL_DB_TOOLS)
    expect(names).toContain('read')

    const item = (await toolsList(child)).find((t) => t.name === 'mcp:database')
    expect(item?.declaredBy).toBe('Dbby')
    expect(await storedTools(child)).toEqual([])
  }, 120_000)

  it('DBE-T6 agent 文件还写着退役的裸名 database：只拿到 read，数据库什么都没有，也不报错', async () => {
    writeAgentMd(app, 'dbold', { tools: 'read, database', displayName: 'DbOld' })
    const parent = await createSession({ title: 'DBE-T6 parent' })
    const mark = await events.mark()
    const child = await createPinnedChildSession(app, {
      parentSid: parent,
      agentProfile: 'dbold',
      title: 'DBE-T6 dbold child'
    })

    const names = await ensureRuntime(child)
    expect(names).toEqual(['read'])
    const errors = (await events.allSince<RecordedEvent>(mark)).filter(
      (e) => e.type === 'error' && e.sessionId === child
    )
    expect(errors).toEqual([])
    // 选择器里的 mcp:database 仍是一个没勾、没被声明的普通条目
    expect(
      (await toolsList(child)).find((t) => t.name === 'mcp:database')?.declaredBy
    ).toBeUndefined()
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════

describe('主流程（DBE-F：一条勾了 database 的会话，开在界面上）', () => {
  const TITLE = 'DBE-F main flow'
  let sid = ''
  /** 这条会话在只读库上的那一条连接（bridge 的接受序号） */
  let roConn = 0

  beforeAll(async () => {
    sid = await tickedSession(TITLE)
    await openInUi(TITLE)
  })

  it('DBE-F1 list-connections：三条连接的名字 / 类型 / 只读，一条都没连；不问、不记决策；秘密一样都没给模型', async () => {
    provider.reset()
    const { ends, since } = await driver.run(sid, [{ id: 'dbf1_list', tool: LIST, args: {} }])
    const end = ends.dbf1_list
    expect(end.isError).toBe(false)
    expect(end.result).toBe(LISTED.join('\n'))
    expect(await driver.eventsSince(since, 'input_request', sid)).toEqual([])
    expect(decisionsOf('dbf1_list')).toEqual([])
    // 列连接不连任何库
    expect(ro.connections()).toBe(0)
    expect(rw.connections()).toBe(0)

    // 模型看得见的地方：工具结果，以及带着它的下一次请求（整份 payload）
    const seen = [end.result, ...provider.chatRequests().map((r) => r.raw)].join('\n')
    for (const secret of ALL_SECRETS) expect(seen).not.toContain(secret)
    for (const port of [ro.port, rw.port]) expect(seen).not.toContain(`:${port}`)

    // DBE-R1 行：数据库的标签与图标，列连接没有摘要
    const row = await settledRow(LIST, 'done')
    expect(DB_LABELS).toContain(row.label)
    expect(row.icon).toBe('lucide-database')
    expect(row.detail).toBe('')
  }, 120_000)

  it('DBE-T7 模型漏了 description：pi 的参数校验先拦下，没有决策、库一条语句都没收到', async () => {
    provider.reset()
    const { ends } = await driver.run(sid, [
      { id: 'dbt7_nodesc', tool: QUERY, args: { connection: 'e2e-ro', sql: 'SELECT 42 AS answer' } }
    ])
    expect(ends.dbt7_nodesc.isError).toBe(true)
    expect(ends.dbt7_nodesc.result).toContain('description')
    expect(decisionsOf('dbt7_nodesc')).toEqual([])
    expect(ro.saw('SELECT 42')).toBe(false)
    expect(ro.connections()).toBe(0)
  }, 120_000)

  it('DBE-F2 只读连接上的 SELECT：不问、真表格；连接先下只读标志、每条语句包在只读事务里；决策放行；状态条亮起', async () => {
    const SQL = 'SELECT id, name FROM users ORDER BY id'
    provider.reset()
    const { ends, since } = await driver.run(sid, [q('dbf2_select', 'e2e-ro', SQL, 'List users')])
    const end = ends.dbf2_select
    expect(end.isError).toBe(false)
    expect(end.result).toBe(
      [
        '+----+-------+',
        '| id | name  |',
        '+----+-------+',
        '| 1  | ada   |',
        '| 2  | grace |',
        '| 3  | linus |',
        '+----+-------+',
        '(3 rows)'
      ].join('\n')
    )
    expect(await driver.eventsSince(since, 'input_request', sid)).toEqual([])

    // 服务器那一侧：这条会话的第一条连接，建连先下只读标志，语句走扩展协议、包在只读事务里
    expect(ro.connections()).toBe(1)
    roConn = 1
    expect(ro.statementsOf(roConn)).toEqual([
      'SET default_transaction_read_only = on',
      'BEGIN TRANSACTION READ ONLY',
      SQL,
      'ROLLBACK'
    ])
    expect(ro.statements().find((s) => s.sql === SQL)?.kind).toBe('P')

    // 只读连接不在 ask-on-database 的范围里：没有规则命中，放行 —— 但门照样过了、照样记账
    expect(await decisionOf('dbf2_select')).toMatchObject({
      sessionId: sid,
      toolName: QUERY,
      objectKind: 'database',
      action: 'execute',
      effect: 'allow',
      winning: 'default:database',
      objectSummary: SQL
    })
    expect(decisionsOf('dbf2_select')).toHaveLength(1)

    // 状态条：连上的那一刻亮起（给用户看的，主机名在这里可以出现）
    const lit = await until(async () => (await dbEvents(since, sid)).at(-1), 'db banner lit')
    expect(lit.status).toEqual(banner(RO_SECRETS.database))
    expect((await runtimeStatuses(sid)).db).toEqual(banner(RO_SECRETS.database))

    // 列连接：这一条标上了 [connected]
    provider.reset()
    const listed = await driver.run(sid, [{ id: 'dbf2_list', tool: LIST, args: {} }])
    expect(listed.ends.dbf2_list.result.split('\n')[1]).toBe(
      '  e2e-ro  (postgresql, read-only)  [connected]'
    )

    // 行：数据库的标签与图标，摘要 = 连接名 · 说明
    const row = await settledRow(QUERY, 'done', 'e2e-ro · List users')
    expect(DB_LABELS).toContain(row.label)
    expect(row.icon).toBe('lucide-database')
  }, 120_000)

  it('DBE-F3 只读连接上写不进去：预检挡一层（注释也跳过），库自己挡一层，agent 也改不回可写；行数不变', async () => {
    const statementsBefore = ro.statements().length
    provider.reset()
    const { ends, since } = await driver.run(sid, [
      q('dbf3_plain', 'e2e-ro', "INSERT INTO users VALUES (4, 'mallory')", 'Add mallory'),
      q('dbf3_comment', 'e2e-ro', "/* sneaky */ INSERT INTO users VALUES (5, 'eve')", 'Add eve'),
      q(
        'dbf3_line',
        'e2e-ro',
        "-- just a note\nINSERT INTO users VALUES (8, 'peggy')",
        'Add peggy'
      ),
      q(
        'dbf3_cte',
        'e2e-ro',
        "WITH x AS (INSERT INTO users VALUES (6, 'trudy') RETURNING id) SELECT id FROM x",
        'Add trudy through a CTE'
      ),
      q('dbf3_flip', 'e2e-ro', 'SET default_transaction_read_only = off', 'Try to go writable'),
      q(
        'dbf3_after',
        'e2e-ro',
        "WITH x AS (INSERT INTO users VALUES (7, 'oscar') RETURNING id) SELECT id FROM x",
        'Add oscar after the flip'
      )
    ])

    // 第一层：常见写语句（开头的空白与注释跳过）在发出去之前就被挡下 —— 服务器一个字都没收到
    for (const [id, marker] of [
      ['dbf3_plain', 'mallory'],
      ['dbf3_comment', 'eve'],
      ['dbf3_line', 'peggy']
    ] as const) {
      expect(ends[id].isError, id).toBe(true)
      expect(ends[id].result, id).toBe(`[MCP Error] Database error: ${READONLY_PRECHECK}`)
      expect(ro.saw(marker), id).toBe(false)
    }
    // 第二层：预检认不出的写法（CTE 里的 INSERT）到了服务器，被只读事务拒绝
    expect(ends.dbf3_cte.isError).toBe(true)
    expect(ends.dbf3_cte.result).toContain('read-only transaction')
    expect(ro.saw('trudy')).toBe(true)
    // 改会话默认值：语句本身能跑（那是个读），但它落在只读事务里、随回滚作废；下一条写照样被拒
    expect(ends.dbf3_flip.isError).toBe(false)
    expect(ends.dbf3_flip.result).toBe('OK: SET')
    expect(ends.dbf3_after.isError).toBe(true)
    expect(ends.dbf3_after.result).toContain('read-only transaction')
    expect(ro.saw('oscar')).toBe(true)

    // 每条到了服务器的语句都裹在只读事务里：BEGIN … ROLLBACK
    const arrived = ro
      .statements()
      .slice(statementsBefore)
      .map((s) => s.sql)
    expect(arrived).toEqual([
      'BEGIN TRANSACTION READ ONLY',
      "WITH x AS (INSERT INTO users VALUES (6, 'trudy') RETURNING id) SELECT id FROM x",
      'ROLLBACK',
      'BEGIN TRANSACTION READ ONLY',
      'SET default_transaction_read_only = off',
      'ROLLBACK',
      'BEGIN TRANSACTION READ ONLY',
      "WITH x AS (INSERT INTO users VALUES (7, 'oscar') RETURNING id) SELECT id FROM x",
      'ROLLBACK'
    ])
    // 同一条连接，一次都没重连；一张卡都没有；一行都没写进去
    expect(ro.connections()).toBe(1)
    expect(
      ro
        .statements()
        .slice(statementsBefore)
        .every((s) => s.conn === roConn)
    ).toBe(true)
    expect(await driver.eventsSince(since, 'input_request', sid)).toEqual([])
    expect(await ro.count('users')).toBe(3)
  }, 120_000)

  it('DBE-F4 可写连接上的 INSERT：恰好一张卡（写明是哪个连接、带 ask-on-database 的提示）；答复之前库没见过它；允许之后写进去、报影响行数', async () => {
    const SQL = "INSERT INTO items (label) VALUES ('alpha'), ('beta')"
    provider.reset()
    const since = await driver.start(sid, [q('dbf4_insert', 'e2e-rw', SQL, 'Add two items')])
    const ask = await driver.waitAsk(sid, since)
    expect(ask).toMatchObject({
      id: 'dbf4_insert',
      kind: 'ask',
      toolName: QUERY,
      command: `-- e2e-rw\n${SQL}`,
      description: 'Add two items'
    })
    expect(ask.policyPrompt?.policies).toEqual([askOnDatabaseName])
    expect(ask.policyPrompt?.text).toBeTruthy()

    // 卡片在屏：数据库的标题与图标，预览里先写连接名、再是语句
    const card = await until(() => chat.pendingAskShot(), 'database ask card on screen')
    expect(DB_LABELS).toContain(card.title)
    expect(card.icon).toBe('lucide-database')
    expect(card.description).toBe('Add two items')
    expect(card.preview).toContain('-- e2e-rw')
    expect(card.preview).toContain(SQL)

    // 还没答复：可写库连一条连接都没有过
    await sleep(300)
    expect(rw.connections()).toBe(0)
    expect(rw.saw('alpha')).toBe(false)

    await driver.answer(sid, ask.id, true)
    const { ends } = await driver.finish(sid, since)
    expect(ends.dbf4_insert.isError).toBe(false)
    expect(ends.dbf4_insert.result).toBe('OK: INSERT, 2 rows affected')
    expect(await driver.eventsSince(since, 'input_request', sid)).toHaveLength(1)

    // 可写连接：不下只读标志、不包只读事务，语句原样一条
    expect(rw.connections()).toBe(1)
    expect(rw.statementsOf(1)).toEqual([SQL])
    expect(await rw.count('items')).toBe(2)

    expect(await decisionOf('dbf4_insert')).toMatchObject({
      toolName: QUERY,
      objectKind: 'database',
      action: 'execute',
      effect: 'ask',
      winning: 'ask-on-database#0',
      userResponse: 'allowed',
      objectSummary: SQL
    })

    // 状态条：同时连着两条，标上还有一条
    const lit = await until(async () => {
      const ev = (await dbEvents(since, sid)).at(-1)
      return ev && ev.status && String(ev.status.label).endsWith('+1') ? ev : null
    }, 'db banner shows +1')
    expect(lit.status).toEqual(banner(RO_SECRETS.database, 1))
  }, 120_000)

  it('DBE-F5 拒绝：错误回到模型，语句从没到过库，行数不变', async () => {
    const SQL = "DELETE FROM items WHERE label = 'alpha'"
    provider.reset()
    const since = await driver.start(sid, [q('dbf5_delete', 'e2e-rw', SQL, 'Drop alpha')])
    const ask = await driver.waitAsk(sid, since)
    expect(ask.command).toBe(`-- e2e-rw\n${SQL}`)
    await driver.answer(sid, ask.id, false)
    const { ends } = await driver.finish(sid, since)
    expect(ends.dbf5_delete.isError).toBe(true)
    expect(ends.dbf5_delete.result).toBe(`[MCP Error] User denied ${SQL}`)
    expect(rw.saw('DELETE')).toBe(false)
    expect(await rw.count('items')).toBe(2)
    expect(await decisionOf('dbf5_delete')).toMatchObject({
      effect: 'ask',
      userResponse: 'denied'
    })
  }, 120_000)

  it('DBE-F6 「其它」：不执行，反馈作为正常结果回给模型', async () => {
    const SQL = "UPDATE items SET label = 'gamma' WHERE label = 'beta'"
    const FEEDBACK = 'Use a staging copy first.'
    provider.reset()
    const since = await driver.start(sid, [q('dbf6_update', 'e2e-rw', SQL, 'Rename beta')])
    const ask = await driver.waitAsk(sid, since)
    await app.main.eval(
      `window.api.agent.respondToInput(${JSON.stringify({
        sessionId: sid,
        requestId: ask.id,
        response: { kind: 'other', text: FEEDBACK }
      })})`
    )
    const { ends } = await driver.finish(sid, since)
    expect(ends.dbf6_update.isError).toBe(false)
    expect(ends.dbf6_update.result).toBe(
      `Query was not executed. User responded with feedback instead:\n${FEEDBACK}`
    )
    expect(rw.saw('gamma')).toBe(false)
    expect(await decisionOf('dbf6_update')).toMatchObject({
      effect: 'ask',
      userResponse: 'feedback'
    })
  }, 120_000)

  it('DBE-F7 卡片挂着时中止：运行结束、询问记为取消，语句从没到过库（过一会儿也没有）', async () => {
    const SQL = 'TRUNCATE items'
    provider.reset()
    const since = await driver.start(sid, [q('dbf7_truncate', 'e2e-rw', SQL, 'Empty the table')])
    await driver.waitAsk(sid, since)
    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)
    await events.waitFor('agent_end', { sessionId: sid, since, timeoutMs: 30_000 })
    await chat.waitIdle()

    expect(await decisionOf('dbf7_truncate')).toMatchObject({
      effect: 'ask',
      userResponse: 'cancel'
    })
    await sleep(800)
    expect(rw.saw('TRUNCATE')).toBe(false)
    expect(await rw.count('items')).toBe(2)
  }, 120_000)

  it('DBE-F8 会话开了免询问：可写连接上的语句不问就跑，决策记在 session-auto-allow 名下', async () => {
    const SQL = "INSERT INTO items (label) VALUES ('delta')"
    await setAutoAllow(sid, true)
    try {
      provider.reset()
      const { ends, since } = await driver.run(sid, [q('dbf8_insert', 'e2e-rw', SQL, 'Add delta')])
      expect(await driver.eventsSince(since, 'input_request', sid)).toEqual([])
      expect(ends.dbf8_insert.isError).toBe(false)
      expect(ends.dbf8_insert.result).toBe('OK: INSERT, 1 row affected')
      expect(rw.saw("'delta'")).toBe(true)
      expect(await rw.count('items')).toBe(3)
      const decision = await decisionOf('dbf8_insert')
      expect(decision).toMatchObject({ objectKind: 'database', effect: 'allow' })
      expect(decision.winning.startsWith('session-auto-allow#')).toBe(true)
    } finally {
      await setAutoAllow(sid, false)
    }
  }, 120_000)

  it('DBE-F11 一次恰好一条语句：只读连接上两条 SELECT 被拒；可写连接上批准过的那一条带不进第二条', async () => {
    provider.reset()
    const readOnly = await driver.run(sid, [
      q('dbf11_ro', 'e2e-ro', 'SELECT 1 AS a; SELECT 2 AS b', 'Two selects')
    ])
    expect(readOnly.ends.dbf11_ro.isError).toBe(true)
    expect(readOnly.ends.dbf11_ro.result).toBe(`[MCP Error] Database error: ${ONE_STATEMENT}`)

    const SQL = "INSERT INTO items (label) VALUES ('epsilon'); DELETE FROM items"
    provider.reset()
    const since = await driver.start(sid, [q('dbf11_rw', 'e2e-rw', SQL, 'Add epsilon')])
    const ask = await driver.waitAsk(sid, since)
    expect(ask.command).toBe(`-- e2e-rw\n${SQL}`)
    await driver.answer(sid, ask.id, true)
    const { ends } = await driver.finish(sid, since)
    expect(ends.dbf11_rw.isError).toBe(true)
    expect(ends.dbf11_rw.result).toBe(`[MCP Error] Database error: ${ONE_STATEMENT}`)
    // 到了服务器（扩展协议在那边拒绝），但一条都没执行
    expect(rw.saw('epsilon')).toBe(true)
    expect(await rw.count('items')).toBe(3)
  }, 120_000)

  it('DBE-F9 名字不对：列出存着的名字；不过门、不连任何库', async () => {
    const before = [ro.connections(), rw.connections()]
    provider.reset()
    const { ends } = await driver.run(sid, [q('dbf9_unknown', 'nope', 'SELECT 1', 'Probe')])
    expect(ends.dbf9_unknown.isError).toBe(true)
    expect(ends.dbf9_unknown.result).toBe(
      '[MCP Error] No saved connection named "nope". Saved connections: e2e-ro, e2e-rw, e2e-down.'
    )
    expect(decisionsOf('dbf9_unknown')).toEqual([])
    expect([ro.connections(), rw.connections()]).toEqual(before)
  }, 120_000)

  it('DBE-F10 连不上：报连不上，主机抹成 <host>；状态条不动', async () => {
    provider.reset()
    const { ends, since } = await driver.run(sid, [
      q('dbf10_down', 'e2e-down', 'SELECT 1', 'Probe the down box')
    ])
    expect(ends.dbf10_down.isError).toBe(true)
    expect(ends.dbf10_down.result).toBe(
      '[MCP Error] Database error: Failed to connect using credential "e2e-down": connect ECONNREFUSED <host>:9'
    )
    expect(ends.dbf10_down.result).not.toContain('127.0.0.1')
    expect(await dbEvents(since, sid)).toEqual([])
    // 还是那两条连接
    expect((await runtimeStatuses(sid)).db).toEqual(banner(RO_SECRETS.database, 1))
  }, 120_000)

  it('DBE-B7 报错里不带连接的内容：服务器拒绝登录时报错里的主机、用户名、库名都抹掉', async () => {
    // 一台按 pg_hba.conf 拒绝登录的服务器：真的 PostgreSQL 拒绝时，报错里写着客户端地址、用户名与库名
    const refusing = await startPgBridge(undefined, {
      refuse: (startup, host) =>
        `no pg_hba.conf entry for host "${host}", user "${startup.user}", database "${startup.database}", no encryption`
    })
    const REFUSED = {
      name: 'e2e-refused',
      dbType: 'postgresql' as const,
      host: '127.0.0.1',
      port: refusing.port,
      username: 'e2e_refused_user_v5',
      password: 'e2e-refused-secret-R4x',
      database: 'e2e_refused_db_j2',
      readonly: true
    }
    const id = await addDbCredential(app.main, REFUSED)
    try {
      provider.reset()
      const { ends } = await driver.run(sid, [
        q('dbb7_refused', 'e2e-refused', 'SELECT 1', 'Probe the locked box')
      ])
      // 前置自检：这台服务器真的被连上并拒绝了（不是别的原因连不上）
      expect(refusing.connections()).toBe(1)
      expect(ends.dbb7_refused.isError).toBe(true)
      expect(ends.dbb7_refused.result).toBe(
        '[MCP Error] Database error: Failed to connect using credential "e2e-refused": ' +
          'no pg_hba.conf entry for host "<host>", user "<user>", database "<database>", no encryption'
      )
      for (const secret of [REFUSED.username, REFUSED.password, REFUSED.database, '127.0.0.1']) {
        expect(ends.dbb7_refused.result).not.toContain(secret)
      }
    } finally {
      await app.main.eval(`window.api.dbCredential.delete(${JSON.stringify(id)})`)
      await refusing.close()
    }
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 呈现：没写说明的调用，与退役的旧 database 工具
// ═══════════════════════════════════════════════════════════════════════

/**
 * 每条用例各开一条新会话来看行：对话列表是不跟随输出的 Virtuoso，经 IPC 发的 prompt 不会把它
 * 滚到底 —— 一条长会话后面几张卡片根本不在 DOM 里。
 */
describe('呈现：说明留空的摘要与退役的旧 database 工具（DBE-R）', () => {
  it('DBE-R4 说明留空：行上的摘要退到 SQL 第一行有内容的那一行', async () => {
    const title = 'DBE-R4 blank description'
    const sid = await tickedSession(title)
    await openInUi(title)
    provider.reset()
    const { ends } = await driver.run(sid, [
      q('dbr4_blank', 'e2e-ro', '\n   SELECT count(*)::int AS n FROM users\n   WHERE id > 1', '   ')
    ])
    expect(ends.dbr4_blank.isError).toBe(false)
    expect(ends.dbr4_blank.result).toContain('(1 row)')
    const row = await settledRow(QUERY, 'done', 'e2e-ro · SELECT count(*)::int AS n FROM users')
    expect(row.icon).toBe('lucide-database')
  }, 120_000)

  it('DBE-R2 模型还在叫旧的 database：找不到工具的错误行，仍有数据库的标签，摘要是说明', async () => {
    const title = 'DBE-R2 legacy call'
    const sid = await createSession({ title })
    await openInUi(title)
    provider.reset()
    const { ends } = await driver.run(sid, [
      {
        id: 'dbr2_legacy',
        tool: 'database',
        args: { credentialName: 'e2e-ro', sql: 'SELECT 1', description: 'Legacy probe' }
      }
    ])
    expect(ends.dbr2_legacy.isError).toBe(true)
    expect(ends.dbr2_legacy.result).toContain('Tool database not found')
    const block = (await listMessages(sid))
      .flatMap((m) => m.blocks ?? [])
      .find((b) => b.toolCallId === 'dbr2_legacy')
    expect(block?.isError).toBe(true)

    const row = await settledRow('database', 'error')
    expect(DB_LABELS).toContain(row.label)
    expect(row.detail).toBe('Legacy probe')
    // 出错标记顶掉了类型图标
    expect(row.icon).toBe('lucide-x')
  }, 120_000)

  it('DBE-R3 旧 database 的已完成调用（改写自真实转写）：同一工具的合并行，数据库图标，计数 2', async () => {
    // 先在一条勾了数据库的会话里真跑两次查询，拿到一份真实的转写
    const src = await tickedSession('DBE-R3 source')
    provider.reset()
    const { ends } = await driver.run(src, [
      q('dbr3_a', 'e2e-ro', 'SELECT count(*)::int AS n FROM users', 'Count users'),
      q('dbr3_b', 'e2e-ro', 'SELECT count(*)::int AS n FROM users', 'Count users')
    ])
    expect(ends.dbr3_a?.isError).toBe(false)
    expect(ends.dbr3_b?.isError).toBe(false)

    // 目标会话**建了但从没打开过**：会话树缓存不记「文件不存在」，文件放好之后第一次打开就读它
    const title = 'DBE-R3 legacy transcript'
    const dst = await createSession({ title })
    const sessionsDir = join(app.home, 'userdata', 'data', 'sessions')
    const srcFile = join(sessionsDir, `${src}.jsonl`)
    const raw = await until(() => {
      const text = existsSync(srcFile) ? readFileSync(srcFile, 'utf8') : ''
      return text.includes('dbr3_b') && text.includes('"done"') ? text : null
    }, 'source transcript flushed')
    writeFileSync(join(sessionsDir, `${dst}.jsonl`), asLegacyTranscript(raw, src, dst))

    await openInUi(title)
    const group = await until(async () => {
      const g = await chat.stepGroupShots()
      return g.length === 1 ? g[0] : null
    }, 'legacy calls folded into one group')
    expect(group).toMatchObject({
      size: 2,
      count: 2,
      icon: 'lucide-database',
      detail: 'Count users'
    })
    expect(DB_LABELS).toContain(group.label)

    await chat.expandGroups()
    const rows = (await chat.toolRowShots()).filter((r) => r.inGroup)
    expect(rows.map((r) => [r.name, r.status, r.icon, r.detail])).toEqual([
      ['database', 'done', 'lucide-database', 'Count users'],
      ['database', 'done', 'lucide-database', 'Count users']
    ])
  }, 120_000)
})

/**
 * 把一份真实转写改写成「旧内置 database 工具」时代的样子：`mcp__database__query` 的调用改名
 * `database`、参数换成旧的 `{credentialName, sql, description}`，结果的 toolName 跟着改；
 * 头行的会话 id 换成目标会话。
 */
function asLegacyTranscript(raw: string, srcId: string, dstId: string): string {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (!value || typeof value !== 'object') return
    const o = value as Record<string, unknown>
    if (o.type === 'toolCall' && o.name === QUERY) {
      const args = (o.arguments ?? {}) as Record<string, unknown>
      o.arguments = {
        credentialName: args.connection,
        sql: args.sql,
        description: args.description
      }
      o.name = 'database'
    }
    if (o.toolName === QUERY) o.toolName = 'database'
    for (const child of Object.values(o)) walk(child)
  }
  const lines = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type === 'session') {
        for (const [k, v] of Object.entries(entry)) if (v === srcId) entry[k] = dstId
      }
      walk(entry)
      return JSON.stringify(entry)
    })
  return lines.join('\n') + '\n'
}
