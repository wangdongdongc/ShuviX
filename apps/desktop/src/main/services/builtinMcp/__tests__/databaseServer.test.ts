/**
 * 内置能力服务器 `database` —— 隔着**真的 MCP 协议**看它（与 sshServer.test 同一个架子）。
 *
 * `InMemoryTransport.createLinkedPair()` + SDK 的 `Client`，安全门后面是**真的**安全模块
 * （内置策略一条不少，ask-on-database / session-auto-allow 都是 md 里那一份）。换成假的只有：
 * 连接池（`../dbConnections`，这一组问的是 server 的判断，连接池的行为在 dbConnections.test
 * 对着真 PostgreSQL 问）、凭据 DAO（better-sqlite3 进不了 vitest 的 Node 进程）与日志。
 *
 * 钉的是：
 *   DBSV-1…4    **工具面**：恰好两个工具、四项 annotations 显式写出、schema、描述是固定文本；
 *   DBSV-5…10   **list-connections**：文本与 structuredContent、凭据内容一个字都不出现、
 *               「本会话已连上」按会话算、每次现读、从不过安全门；
 *   DBSV-11…15  **门之前**：未知连接名 / 必填项在任何询问与建连之前就回绝；
 *   DBSV-16…29  **安全门**：客体与 opts 的契约、询问卡片的路由键与内容（连接名写在 SQL 上方）、
 *               可写问 / 只读放行、五种应答、没有输入面板、免询问、用户策略；
 *   DBSV-30…31  **结果**：驱动报错、未知工具；
 *   DBSV-32…35  **状态条与寿命**：状态条跟着连接池的 onChange 走、关闭时断开本会话全部连接、
 *               会话之间互不相干、关两次只断一次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'

// mock 路径按**测试文件**解析：被测模块在 services/builtinMcp/，测试在其 __tests__/ 下
const logged = vi.hoisted(() => ({ lines: [] as string[] }))

/** 安全门：抄下 enforceDatabase 的实参，门后仍是真引擎 */
const gate = vi.hoisted(() => ({
  calls: [] as Array<{ object: unknown; opts: unknown }>,
  /** 这条会话的用户策略；空 = 只有内置那套 */
  policies: [] as unknown[],
  /** 免询问开关（session-auto-allow 的 force-allow） */
  autoAllow: false
}))

/**
 * 设置里保存的连接。DAO 的 `findAllNamesWithType` 按 createdAt 升序回三列；`fullRows` 置位时
 * 连主机 / 用户名 / 密码一起回 —— 问的是「server 自己只取它需要的那三样」，而不是「DAO 恰好没给」。
 */
const saved = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  fullRows: false,
  /** 谁去读了解密过的整行（server 不该读：密码只在连接池里解密） */
  decrypted: [] as string[]
}))

/** 连接池的假件：可编程的查询结果、按会话记的「连着哪些」、onChange 的监听者 */
const pool = vi.hoisted(() => ({
  connected: new Map<string, string[]>(),
  status: new Map<string, RuntimeStatus>(),
  queries: [] as Array<{ sessionId: string; name: string; sql: string; mode: unknown }>,
  /** 下一次 connectAndQuery 的应答；Error = 抛出；函数 = 现算（可在里面模拟「连上了」） */
  result: 'OK' as string | Error | ((sessionId: string, name: string) => string | Error),
  disconnects: [] as string[],
  listeners: new Set<(sessionId: string) => void>()
}))

vi.mock('../../toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { createInlinePolicyMdReader } =
    await import('@shuvix/agent-runtime/security/builtinPolicies/inlineSources')
  type Ctx = Parameters<typeof import('../../toolContext').getDesktopSecurityContext>[0]
  const readBuiltinPolicyMd = createInlinePolicyMdReader()
  return {
    TOOL_ABORTED: 'Aborted',
    getDesktopSecurityContext: (ctx: Ctx) => {
      const real = createSecurityContext(
        // 逐字复刻 toolContext 今天上报的主体（同 sshServer.test）
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
          getUserPolicies: () => gate.policies as never,
          // 询问通道由 scope 注入：缺席就是「这条会话没有输入面板」，fail-closed 用例靠它
          requestUserInput: ctx.requestUserInput
        }
      )
      return {
        ...real,
        enforceDatabase: (object: never, opts: never) => {
          gate.calls.push({ object, opts })
          return real.enforceDatabase(object, opts)
        }
      }
    }
  }
})

vi.mock('../../../dao/dbCredentialDao', () => ({
  dbCredentialDao: {
    findAllNamesWithType: () =>
      saved.rows.map((r) =>
        saved.fullRows ? { ...r } : { name: r.name, dbType: r.dbType, readonly: r.readonly }
      ),
    findByName: (name: string) => {
      saved.decrypted.push(`findByName ${name}`)
      return saved.rows.find((r) => r.name === name)
    },
    findAll: () => {
      saved.decrypted.push('findAll')
      return saved.rows
    }
  }
}))

vi.mock('../dbConnections', () => ({
  dbManager: {
    connectedNames: (sessionId: string) => [...(pool.connected.get(sessionId) ?? [])],
    connectAndQuery: async (sessionId: string, name: string, sql: string, mode?: unknown) => {
      pool.queries.push({ sessionId, name, sql, mode })
      const r = typeof pool.result === 'function' ? pool.result(sessionId, name) : pool.result
      if (r instanceof Error) throw r
      return r
    },
    disconnect: async (sessionId: string) => {
      pool.disconnects.push(sessionId)
      const had = pool.connected.get(sessionId)?.length ?? 0
      pool.connected.delete(sessionId)
      pool.status.delete(sessionId)
      // 真连接池每断开一条就通知一次（见 dbConnections.disconnectByKey）
      for (let i = 0; i < had; i++) for (const l of [...pool.listeners]) l(sessionId)
    },
    runtimeStatus: (sessionId: string) => pool.status.get(sessionId),
    onChange: (listener: (sessionId: string) => void) => {
      pool.listeners.add(listener)
      return () => {
        pool.listeners.delete(listener)
      }
    }
  }
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: (m: string) => void logged.lines.push(`info ${m}`),
    warn: (m: string) => void logged.lines.push(`warn ${m}`),
    error: (m: string) => void logged.lines.push(`error ${m}`)
  })
}))

import { clearSessionDecisions, getSessionDecisions } from '@shuvix/agent-runtime'
import { BUILTIN_MCP_PRESENTATIONS } from '@shuvix/chat-protocol/builtinMcpPresentations'
import {
  createDatabaseMcpServerFactory,
  DATABASE_MCP_SERVER_NAME,
  DATABASE_TOOLS
} from '../databaseServer'

// ─── 素材 ────────────────────────────────────────────────────────────────

const WHERE_TO_ADD =
  "Ask the user to add one in ShuviX's settings: MCP → the built-in database server → saved connections."

/** 一条已保存的连接（整行：主机 / 用户名 / 密码都取可辨认的值） */
function row(name: string, dbType: string, readonly: boolean): Record<string, unknown> {
  return {
    id: `id-${name}`,
    name,
    dbType,
    host: `${name}.db-host.internal`,
    port: 55432,
    username: `user-of-${name}`,
    password: `pw-of-${name}-s3cret`,
    database: `db-of-${name}`,
    readonly
  }
}

/** 惯用的两条：只读 PostgreSQL + 可写 MySQL（创建顺序即此顺序） */
function saveDefaults(): void {
  saved.rows.push(row('ro-pg', 'postgresql', true), row('rw-my', 'mysql', false))
}

interface Session {
  client: Client
  clientTransport: Transport
  serverTransport: Transport
  /** 这条会话弹出的询问卡片（安全门经 scope.requestUserInput 挂的那些） */
  asks: InputRequest[]
  /** 运行时状态条事件 */
  events: Array<Record<string, unknown>>
}

interface OpenOpts {
  sessionId?: string
  /** 询问应答；`null` = 这条会话没有输入面板 */
  respond?: ((req: InputRequest) => Promise<InputResponse>) | null
}

const opened: Session[] = []

/** 把一台 database server 接到一对真 InMemoryTransport 上，并连一个真 Client */
async function open(opts: OpenOpts = {}): Promise<Session> {
  const asks: InputRequest[] = []
  const events: Array<Record<string, unknown>> = []
  const respond =
    opts.respond === undefined
      ? async (): Promise<InputResponse> => ({ kind: 'ask', allowed: true })
      : opts.respond
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await createDatabaseMcpServerFactory()(
    {
      sessionId: opts.sessionId ?? 's1',
      requestUserInput: respond
        ? async (req: InputRequest): Promise<InputResponse> => {
            asks.push(req)
            return respond(req)
          }
        : undefined,
      emitChatEvent: (e) => void events.push(e as unknown as Record<string, unknown>)
    },
    serverTransport
  )
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  const session = { client, clientTransport, serverTransport, asks, events }
  opened.push(session)
  return session
}

interface ToolResult {
  content: Array<{ type: string; text?: string }>
  structuredContent?: {
    connections: Array<{ name: string; engine: string; readonly: boolean; connected: boolean }>
  }
  isError?: boolean
}

const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  meta?: Record<string, unknown>
): Promise<ToolResult> =>
  (await client.callTool({
    name,
    arguments: args,
    ...(meta ? { _meta: meta } : {})
  })) as unknown as ToolResult

const listConnections = (client: Client): Promise<ToolResult> =>
  callTool(client, 'list-connections')

/** query 的一组齐全实参 —— 用例按需覆写其中一两个 */
const queryArgs = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  connection: 'rw-my',
  sql: 'INSERT INTO t VALUES (1)',
  description: 'add a row',
  ...patch
})

const textOf = (r: ToolResult): string =>
  r.content
    .map((c) => c.text ?? '')
    .join('\n')
    .trim()

/** 一份用户策略（同 security/__tests__ 的 userPolicy） */
const userPolicy = (name: string, rules: unknown[]): unknown => ({
  name,
  displayName: name,
  description: '',
  rules,
  body: ''
})

/** 门后拿到的 opts */
const optsOf = (i = 0): Record<string, unknown> => gate.calls[i].opts as Record<string, unknown>

/** 询问卡片的 ask 分支（判别联合先收窄 —— 弹出来的是不是一张 ask 本身就是断言的一部分） */
const askCards = (asks: InputRequest[]): AskInputRequest[] =>
  asks.map((r, i) => {
    if (r.kind !== 'ask') throw new Error(`asks[${i}] 是 ${r.kind}，不是一张 ask 卡片`)
    return r
  })

/** 让出事件循环几拍（transport 关闭后的收尾是异步的） */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

/** 连接池通知「这个会话的连接集合变了」（真连接池在连上 / 断开 / 空闲断开 / 凭据改动时这么做） */
const fire = (sessionId: string): void => {
  for (const l of [...pool.listeners]) l(sessionId)
}

const STATUS: RuntimeStatus = {
  label: 'postgresql db-of-ro-pg',
  icon: 'Database',
  color: '#f59e0b',
  description: 'ro-pg.db-host.internal'
}

beforeEach(() => {
  logged.lines.length = 0
  gate.calls.length = 0
  gate.policies.length = 0
  gate.autoAllow = false
  saved.rows.length = 0
  saved.fullRows = false
  saved.decrypted.length = 0
  pool.connected.clear()
  pool.status.clear()
  pool.queries.length = 0
  pool.result = 'OK'
  pool.disconnects.length = 0
  pool.listeners.clear()
  for (const sid of ['s1', 's2']) clearSessionDecisions(sid)
})

afterEach(async () => {
  for (const s of opened.splice(0)) await s.clientTransport.close()
})

// ─── 工具面 ──────────────────────────────────────────────────────────────

describe('database 内置服务器的工具声明', () => {
  it('DBSV-1 恰好两个工具；与界面呈现表的防冒名名单、与导出的 DATABASE_TOOLS 一致', async () => {
    const { client } = await open()
    const names = (await client.listTools()).tools.map((t) => t.name)

    expect(names).toEqual(['list-connections', 'query'])
    // 名单漏一个，那个工具在界面上就丢了图标、标签与折叠摘要
    expect([...BUILTIN_MCP_PRESENTATIONS.database.toolNames].sort()).toEqual([...names].sort())
    expect(DATABASE_TOOLS.map((t) => t.name)).toEqual(names)
    // server 名就是工具名前缀，也是 builtin-mcp-database 那一行的 name
    expect(DATABASE_MCP_SERVER_NAME).toBe('database')
  })

  it('DBSV-2 四项 annotations 每个工具都显式写出（规范的缺省是「破坏性、开放世界」）', async () => {
    const { client } = await open()
    const tools = (await client.listTools()).tools
    const ann = (name: string): Record<string, unknown> =>
      tools.find((t) => t.name === name)!.annotations as Record<string, unknown>

    for (const name of ['list-connections', 'query']) {
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof ann(name)[key], `${name}.${key}`).toBe('boolean')
      }
    }
    expect(ann('list-connections')).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    })
    // 可写连接上一条 SQL 能做任何事 —— 这几位是给策略用的，不因「多数查询只是读」调软
    expect(ann('query')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    })
  })

  it('DBSV-3 schema：query 三个必填且只收这三个键；list-connections 只收空对象，outputSchema 四列必有', async () => {
    const { client } = await open()
    const tools = (await client.listTools()).tools
    const query = tools.find((t) => t.name === 'query')!
    const list = tools.find((t) => t.name === 'list-connections')!

    const qs = query.inputSchema as unknown as Record<string, unknown>
    expect(qs.required).toEqual(['connection', 'sql', 'description'])
    expect(qs.additionalProperties).toBe(false)
    expect(Object.keys(qs.properties as object)).toEqual(['connection', 'sql', 'description'])

    expect(list.inputSchema).toEqual({ type: 'object', additionalProperties: false })
    const out = list.outputSchema as unknown as {
      required: string[]
      properties: { connections: { items: { required: string[] } } }
    }
    expect(out.required).toEqual(['connections'])
    expect(out.properties.connections.items.required).toEqual([
      'name',
      'engine',
      'readonly',
      'connected'
    ])
  })

  it('DBSV-4 描述是固定文本：已保存连接的名字、主机从不出现，有没有连接工具面都一样', async () => {
    const { client } = await open()
    const empty = JSON.stringify((await client.listTools()).tools)

    saved.rows.push(row('prod-billing', 'postgresql', false))
    const withOne = JSON.stringify((await client.listTools()).tools)

    expect(withOne).toBe(empty)
    for (const secret of ['prod-billing', 'db-host.internal', 'pw-of-', 'user-of-']) {
      expect(withOne).not.toContain(secret)
    }
    // query 的描述把三件模型必须知道的事说出来：一次一条、写语句报影响行数、只读由服务端的只读事务兜底
    const query = DATABASE_TOOLS.find((t) => t.name === 'query')!.description
    expect(query).toMatch(/exactly one SQL statement/)
    expect(query).toMatch(/how many rows it affected/)
    expect(query).toMatch(/read-only transaction/)
  })
})

// ─── list-connections ───────────────────────────────────────────────────

describe('database 内置服务器的 list-connections', () => {
  it('DBSV-5 一条都没存：不是错误，而是告诉用户去哪加；structuredContent 是空数组', async () => {
    const { client } = await open()
    await client.listTools() // 先发现：之后 callTool 会拿 outputSchema 校验 structuredContent
    const r = await listConnections(client)

    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe(`No database connections are saved yet. ${WHERE_TO_ADD}`)
    expect(r.structuredContent).toEqual({ connections: [] })
  })

  it('DBSV-6 两条（按创建顺序）：人读的清单与四列的 structuredContent', async () => {
    saveDefaults()
    const { client } = await open()
    await client.listTools()
    const r = await listConnections(client)

    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe(
      '2 saved connection(s):\n  ro-pg  (postgresql, read-only)\n  rw-my  (mysql)'
    )
    expect(r.structuredContent!.connections[0]).toStrictEqual({
      name: 'ro-pg',
      engine: 'postgresql',
      readonly: true,
      connected: false
    })
    expect(r.structuredContent!.connections[1]).toStrictEqual({
      name: 'rw-my',
      engine: 'mysql',
      readonly: false,
      connected: false
    })
  })

  it('DBSV-7 就算拿到整行，也只露四列 —— 主机、端口、用户名、库名、密码一个字都不出现', async () => {
    saveDefaults()
    saved.fullRows = true
    const { client } = await open()
    await client.listTools()
    const r = await listConnections(client)

    for (const item of r.structuredContent!.connections) {
      expect(Object.keys(item).sort()).toEqual(['connected', 'engine', 'name', 'readonly'])
    }
    const everything = JSON.stringify(r)
    for (const secret of [
      'db-host.internal',
      '55432',
      'user-of-',
      'db-of-',
      'pw-of-',
      's3cret',
      'id-ro-pg'
    ]) {
      expect(everything).not.toContain(secret)
    }
    // 密码只在连接池里解密 —— server 从不读解密过的整行
    expect(saved.decrypted).toEqual([])
  })

  it('DBSV-8 「已连上」按会话算：s1 连着 ro-pg，s2 的实例看到的是没连', async () => {
    saveDefaults()
    pool.connected.set('s1', ['ro-pg'])
    const s1 = await open({ sessionId: 's1' })
    const s2 = await open({ sessionId: 's2' })
    await s1.client.listTools()
    await s2.client.listTools()

    const r1 = await listConnections(s1.client)
    expect(textOf(r1)).toBe(
      '2 saved connection(s):\n  ro-pg  (postgresql, read-only)  [connected]\n  rw-my  (mysql)'
    )
    expect(r1.structuredContent!.connections.map((c) => c.connected)).toEqual([true, false])

    const r2 = await listConnections(s2.client)
    expect(textOf(r2)).not.toContain('[connected]')
    expect(r2.structuredContent!.connections.map((c) => c.connected)).toEqual([false, false])
  })

  it('DBSV-9 每次调用现读 —— 用户可能刚在设置里加了一条', async () => {
    saved.rows.push(row('a', 'postgresql', true))
    const { client } = await open()
    expect(textOf(await listConnections(client))).toBe(
      '1 saved connection(s):\n  a  (postgresql, read-only)'
    )

    saved.rows.push(row('b', 'mysql', false))
    expect(textOf(await listConnections(client))).toBe(
      '2 saved connection(s):\n  a  (postgresql, read-only)\n  b  (mysql)'
    )
  })

  it('DBSV-10 从不过安全门：有可写连接、没有输入面板时也一样 —— 不询问、不记决策', async () => {
    saved.rows.push(row('rw-a', 'postgresql', false), row('rw-b', 'mysql', false))
    const { client, asks } = await open({ respond: null })

    const r = await listConnections(client)
    expect(r.isError).toBeFalsy()
    expect(gate.calls).toEqual([])
    expect(asks).toEqual([])
    expect(getSessionDecisions('s1')).toEqual([])
  })
})

// ─── query：门之前 ───────────────────────────────────────────────────────

describe('database 内置服务器 query：门之前就回绝的', () => {
  it('DBSV-11 未知连接名：列出已保存的名字；不评估、不询问、不记决策、不建连', async () => {
    saved.rows.push(row('a', 'postgresql', true), row('b', 'mysql', false))
    const { client, asks } = await open()

    const r = await callTool(client, 'query', queryArgs({ connection: 'x' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('No saved connection named "x". Saved connections: a, b.')
    expect(gate.calls).toEqual([])
    expect(asks).toEqual([])
    expect(getSessionDecisions('s1')).toEqual([])
    expect(pool.queries).toEqual([])
  })

  it('DBSV-12 一条都没存时换一句话 —— 指向设置里去加', async () => {
    const { client } = await open()

    const r = await callTool(client, 'query', queryArgs({ connection: 'x' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(
      `No database connections are saved yet, so "x" cannot be used. ${WHERE_TO_ADD}`
    )
    expect(pool.queries).toEqual([])
  })

  it('DBSV-13 connection 缺席 / 不是字符串 / 只有空白，sql 缺席 / 只有空白 —— 各一句「必填」，都不过门', async () => {
    saveDefaults()
    const { client, asks } = await open()

    for (const patch of [{ connection: undefined }, { connection: 42 }, { connection: '   ' }]) {
      const r = await callTool(client, 'query', queryArgs(patch))
      expect(r.isError).toBe(true)
      expect(textOf(r)).toBe('A `connection` name is required — see list-connections.')
    }
    for (const patch of [{ sql: undefined }, { sql: '  \n ' }, { sql: 7 }]) {
      const r = await callTool(client, 'query', queryArgs(patch))
      expect(r.isError).toBe(true)
      expect(textOf(r)).toBe('An `sql` statement is required.')
    }
    expect(gate.calls).toEqual([])
    expect(asks).toEqual([])
    expect(pool.queries).toEqual([])
  })

  it('DBSV-14 连接名去掉两端空白再比；大小写不同就是另一个名字', async () => {
    saveDefaults()
    const { client } = await open()

    await callTool(client, 'query', queryArgs({ connection: ' rw-my ' }))
    expect((gate.calls[0].object as Record<string, unknown>).credential).toBe('rw-my')
    expect(pool.queries.map((q) => q.name)).toEqual(['rw-my'])

    const r = await callTool(client, 'query', queryArgs({ connection: 'RW-MY' }))
    expect(textOf(r)).toBe('No saved connection named "RW-MY". Saved connections: ro-pg, rw-my.')
    expect(pool.queries).toHaveLength(1)
  })

  it('DBSV-15 缺 description 时 server 不拒（低层 Server 不按 schema 校验入参）—— 门拿到 description: undefined', async () => {
    // 「必填」只在 McpManager 那一侧由 pi 的 validateToolArguments 把关；直连这台 server 的客户端
    // 不带说明也能过，询问卡片上那一栏就空着
    saveDefaults()
    const { client } = await open()

    const r = await callTool(client, 'query', { connection: 'rw-my', sql: 'SELECT 1' })
    expect(r.isError).toBeFalsy()
    expect(optsOf()).toHaveProperty('description', undefined)
    expect(pool.queries).toHaveLength(1)
  })
})

// ─── query：安全门 ───────────────────────────────────────────────────────

describe('database 内置服务器 query 的安全门', () => {
  it('DBSV-16 客体恰是 {sql, credential, dbType, readonly}：readonly 是真布尔，多行 SQL 原样', async () => {
    saveDefaults()
    const { client } = await open()
    const multi = 'SELECT *\n  FROM orders\n WHERE id = 1;'

    await callTool(client, 'query', queryArgs({ sql: multi }))
    await callTool(client, 'query', queryArgs({ connection: 'ro-pg', sql: 'SELECT 1' }))

    expect(gate.calls[0].object).toStrictEqual({
      sql: multi,
      credential: 'rw-my',
      dbType: 'mysql',
      readonly: false
    })
    expect(gate.calls[1].object).toStrictEqual({
      sql: 'SELECT 1',
      credential: 'ro-pg',
      dbType: 'postgresql',
      readonly: true
    })
  })

  it('DBSV-17 opts 恰是那六项', async () => {
    saveDefaults()
    const { client } = await open()

    await callTool(client, 'query', queryArgs({ description: 'count users' }), {
      'shuvix.dev/toolCallId': 'tc-7'
    })

    expect(gate.calls).toHaveLength(1)
    expect(gate.calls[0].opts).toStrictEqual({
      toolCallId: 'tc-7',
      toolName: 'mcp__database__query',
      description: 'count users',
      abortError: 'Aborted',
      // 用户选「其它」：不执行，反馈作为正常结果带回
      onOther: 'return',
      // 没有输入面板时 fail-closed —— 一条可写 SQL 不能因为「问不着」就自己跑了
      missingChannel: 'deny'
    })
  })

  it('DBSV-18 `_meta` 里的 toolCallId 就是门与卡片的路由键；没带时回落到 `database-<requestId>`，绝不是空串', async () => {
    saveDefaults()
    const { client, asks } = await open()

    await callTool(client, 'query', queryArgs(), { 'shuvix.dev/toolCallId': 'pi-call-9' })
    expect(optsOf(0).toolCallId).toBe('pi-call-9')
    expect(asks[0].id).toBe('pi-call-9')

    await callTool(client, 'query', queryArgs())
    const id = optsOf(1).toolCallId
    // 空串会让并发的询问挤在同一个路由键上 —— 用户答了 A 却放行了 B
    expect(id).toMatch(/^database-.+$/)
    expect(asks[1].id).toBe(id)
  })

  it('DBSV-19 可写连接：弹一张卡（连接名写在 SQL 上方、署名 ask-on-database），允许后才执行', async () => {
    saveDefaults()
    pool.result = 'OK: statement, 1 row affected'
    const { client, asks } = await open()
    const sql = 'DELETE FROM orders\nWHERE id = 3'

    const r = await callTool(client, 'query', queryArgs({ sql, description: 'drop order 3' }), {
      'shuvix.dev/toolCallId': 'tc-19'
    })

    const [card] = askCards(asks)
    expect(asks).toHaveLength(1)
    // 批准一条 DELETE 时必须看得见它落在哪个连接上（生产库还是测试库）
    expect(card).toMatchObject({
      id: 'tc-19',
      kind: 'ask',
      toolName: 'mcp__database__query',
      command: `-- rw-my\n${sql}`,
      description: 'drop order 3'
    })
    expect(card.policyPrompt).toEqual({
      text: 'This connection has write access, so the statement can change or delete data on the server.',
      policies: ['Ask Before Running SQL']
    })

    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe('OK: statement, 1 row affected')
    // 把刚读到的只读位带给连接池：它据此判断手里那条连接是否还按现在的配置建的
    expect(pool.queries).toEqual([
      { sessionId: 's1', name: 'rw-my', sql, mode: { readonly: false } }
    ])
    expect(getSessionDecisions('s1')).toEqual([
      expect.objectContaining({
        toolCallId: 'tc-19',
        toolName: 'mcp__database__query',
        objectKind: 'database',
        // 决策日志的摘要仍是 SQL 本身（连接名那一行只上卡片）
        objectSummary: sql,
        action: 'execute',
        effect: 'ask',
        winning: 'ask-on-database#0',
        userResponse: 'allowed'
      })
    ])
  })

  it('DBSV-20 只读连接：不询问直接执行；看起来像写的 SQL 也不问（问的是连接，不读 SQL）', async () => {
    saveDefaults()
    pool.result = '(0 rows)'
    const { client, asks } = await open()

    for (const sql of [
      'SELECT count(*) FROM users',
      'INSERT INTO users VALUES (1)',
      'WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x'
    ]) {
      const r = await callTool(client, 'query', queryArgs({ connection: 'ro-pg', sql }))
      expect(r.isError, sql).toBeFalsy()
    }

    expect(asks).toEqual([])
    // 只读的真保护在数据库那一侧（每条语句一个只读事务），SQL 原样交给连接池
    expect(pool.queries.map((q) => [q.sql, q.mode])).toEqual([
      ['SELECT count(*) FROM users', { readonly: true }],
      ['INSERT INTO users VALUES (1)', { readonly: true }],
      ['WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x', { readonly: true }]
    ])
    const decisions = getSessionDecisions('s1')
    expect(decisions).toHaveLength(3)
    for (const d of decisions) {
      expect(d).toMatchObject({
        effect: 'allow',
        winning: 'default:database',
        objectKind: 'database'
      })
    }
  })

  it('DBSV-21 用户拒绝 → 错误结果「User denied <SQL>」，一条没执行，决策记 denied', async () => {
    saveDefaults()
    const { client } = await open({ respond: async () => ({ kind: 'ask', allowed: false }) })

    const r = await callTool(client, 'query', queryArgs())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('User denied INSERT INTO t VALUES (1)')
    expect(pool.queries).toEqual([])
    expect(getSessionDecisions('s1')[0]).toMatchObject({ effect: 'ask', userResponse: 'denied' })
  })

  it('DBSV-22 用户改说「其它」→ 反馈逐字带回，是正常结果而不是错误，一条没执行', async () => {
    saveDefaults()
    const { client } = await open({
      respond: async () => ({ kind: 'other', text: 'use the staging database instead' })
    })

    const r = await callTool(client, 'query', queryArgs())
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toBe(
      'Query was not executed. User responded with feedback instead:\nuse the staging database instead'
    )
    expect(pool.queries).toEqual([])
    expect(getSessionDecisions('s1')[0]).toMatchObject({ userResponse: 'feedback' })
  })

  it('DBSV-23 用户在卡片上取消 → 以 Aborted 落定，一条没执行', async () => {
    saveDefaults()
    const { client } = await open({
      respond: async () => ({ kind: 'cancel', reason: 'aborted' })
    })

    const r = await callTool(client, 'query', queryArgs())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Aborted')
    expect(pool.queries).toEqual([])
    expect(getSessionDecisions('s1')[0]).toMatchObject({ userResponse: 'cancel' })
  })

  it('DBSV-24 卡片还挂着时这次调用被取消 → 批准来晚了也不再执行', async () => {
    saveDefaults()
    let release!: (r: InputResponse) => void
    const { client, asks } = await open({
      respond: () => new Promise<InputResponse>((r) => (release = r))
    })

    const ac = new AbortController()
    const pending = client.callTool({ name: 'query', arguments: queryArgs() }, undefined, {
      signal: ac.signal
    })
    // 等卡片真的挂起（门已经在等人答）
    while (asks.length === 0) await new Promise((r) => setTimeout(r, 1))

    ac.abort(new Error('user stopped the run'))
    await expect(pending).rejects.toThrow()

    release({ kind: 'ask', allowed: true })
    await settle()

    // SDK 对已取消的请求不发响应 —— 可观测的契约只有这一条：那条 SQL 没有补跑
    expect(pool.queries).toEqual([])
  })

  it('DBSV-25 这条会话没有输入面板：可写连接拒绝（fail-closed），只读连接照跑', async () => {
    saveDefaults()
    const { client } = await open({ respond: null })

    const rw = await callTool(client, 'query', queryArgs())
    expect(rw.isError).toBe(true)
    expect(textOf(rw)).toBe(
      'Access denied: this needs your confirmation but there is no way to ask: INSERT INTO t VALUES (1)'
    )
    expect(pool.queries).toEqual([])

    const ro = await callTool(client, 'query', queryArgs({ connection: 'ro-pg', sql: 'SELECT 1' }))
    expect(ro.isError).toBeFalsy()
    expect(pool.queries.map((q) => q.name)).toEqual(['ro-pg'])
  })

  it('DBSV-26 免询问开着：可写连接不弹卡直接执行，决策归到 session-auto-allow', async () => {
    saveDefaults()
    gate.autoAllow = true
    const { client, asks } = await open()

    const r = await callTool(client, 'query', queryArgs())
    expect(r.isError).toBeFalsy()
    expect(asks).toEqual([])
    expect(pool.queries).toHaveLength(1)
    expect(getSessionDecisions('s1')[0]).toMatchObject({
      effect: 'allow',
      winning: 'session-auto-allow#0'
    })
  })

  it('DBSV-27 用户按连接名写的 deny：错误结果带归因，一条没执行；免询问也压不过', async () => {
    saveDefaults()
    gate.policies.push(
      userPolicy('no-prod-writes', [
        { effect: 'deny', match: "object.type == 'database' && object.credential == 'rw-my'" }
      ])
    )
    const { client, asks } = await open()

    for (const autoAllow of [false, true]) {
      gate.autoAllow = autoAllow
      const r = await callTool(client, 'query', queryArgs())
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain("Denied by security policy rule 'no-prod-writes#0'")
    }
    expect(asks).toEqual([])
    expect(pool.queries).toEqual([])
    // 别的连接不受影响
    const other = await callTool(
      client,
      'query',
      queryArgs({ connection: 'ro-pg', sql: 'SELECT 1' })
    )
    expect(other.isError).toBeFalsy()
  })

  it.each<[string, string]>([
    ['连接名', "object.type == 'database' && object.credential == 'ro-pg'"],
    ['库类型', "object.type == 'database' && object.dbType == 'postgresql'"]
  ])('DBSV-28 用户按%s写的 ask 让只读连接也要问', async (_label, match) => {
    saveDefaults()
    gate.policies.push(userPolicy('ask-pg', [{ effect: 'ask', match }]))
    const { client, asks } = await open()

    const r = await callTool(client, 'query', queryArgs({ connection: 'ro-pg', sql: 'SELECT 1' }))
    expect(r.isError).toBeFalsy()
    expect(askCards(asks)).toHaveLength(1)
    expect(askCards(asks)[0].command).toBe('-- ro-pg\nSELECT 1')
    expect(getSessionDecisions('s1')[0]).toMatchObject({
      effect: 'ask',
      winning: 'ask-pg#0',
      userResponse: 'allowed'
    })
  })

  it('DBSV-29 策略看到的工具名是 mcp__database__query；照退役的 `database` 工具名写的规则不再命中', async () => {
    saveDefaults()
    gate.policies.push(
      userPolicy('old-name', [{ effect: 'deny', match: "tool.name == 'database'" }])
    )
    const { client } = await open()

    // 旧名字的规则静默失效 —— 用户的策略若是这么写的，升级之后要改
    expect(
      (await callTool(client, 'query', queryArgs({ connection: 'ro-pg' }))).isError
    ).toBeFalsy()

    gate.policies.length = 0
    gate.policies.push(
      userPolicy('new-name', [{ effect: 'deny', match: "tool.name == 'mcp__database__query'" }])
    )
    const r = await callTool(client, 'query', queryArgs({ connection: 'ro-pg' }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain("'new-name#0'")
  })

  it('DBSV-19b 两次调用之间连接被改成只读：第二次按只读评估（不问），并把只读位交给连接池', async () => {
    saveDefaults()
    const { client, asks } = await open()

    await callTool(client, 'query', queryArgs())
    expect(asks).toHaveLength(1)

    // 用户在设置里把 rw-my 改成了只读 —— server 每次现读，不缓存
    saved.rows[1] = { ...saved.rows[1], readonly: true }
    await callTool(client, 'query', queryArgs())

    expect(asks).toHaveLength(1)
    expect((gate.calls[1].object as Record<string, unknown>).readonly).toBe(true)
    expect(pool.queries.map((q) => q.mode)).toEqual([{ readonly: false }, { readonly: true }])
  })
})

// ─── 结果 ────────────────────────────────────────────────────────────────

describe('database 内置服务器 query 的结果', () => {
  it('DBSV-30 驱动报错 → 错误结果「Database error: …」并记一条 warn；不碰状态条', async () => {
    saveDefaults()
    pool.result = new Error('relation "nope" does not exist')
    const { client, events } = await open()

    const r = await callTool(
      client,
      'query',
      queryArgs({ connection: 'ro-pg', sql: 'SELECT * FROM nope' })
    )
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Database error: relation "nope" does not exist')
    expect(logged.lines).toContain(
      'warn query failed session=s1 connection=ro-pg: relation "nope" does not exist'
    )
    expect(events).toEqual([])
  })

  it('DBSV-30b 成功的结果原样是文本，不带 isError', async () => {
    saveDefaults()
    pool.result = '+---+\n| a |\n+---+\n| 1 |\n+---+\n(1 row)'
    const { client } = await open()

    const r = await callTool(
      client,
      'query',
      queryArgs({ connection: 'ro-pg', sql: 'SELECT 1 AS a' })
    )
    expect(r.isError).toBeFalsy()
    expect(r.content).toEqual([
      { type: 'text', text: '+---+\n| a |\n+---+\n| 1 |\n+---+\n(1 row)' }
    ])
  })

  it('DBSV-31 未知工具是一条普通的错误结果，连接照旧可用', async () => {
    saveDefaults()
    const { client } = await open()

    const bad = await callTool(client, 'nope')
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toBe('Unknown tool: nope')

    expect((await listConnections(client)).isError).toBeFalsy()
  })
})

// ─── 状态条与寿命 ────────────────────────────────────────────────────────

describe('database 内置服务器的状态条（跟着连接池的 onChange 走）', () => {
  it('DBSV-32a 连接池报「本会话变了」→ 发一条 runtime_event db，内容就是 runtimeStatus；别的会话变了不发', async () => {
    const { events } = await open()
    // 启动即订阅
    expect(pool.listeners.size).toBe(1)

    pool.status.set('s1', STATUS)
    fire('s1')
    expect(events).toEqual([{ type: 'runtime_event', runtimeId: 'db', status: STATUS }])

    fire('s2')
    expect(events).toHaveLength(1)

    // 本会话的连接都没了 → 清掉
    pool.status.delete('s1')
    fire('s1')
    expect(events[1]).toEqual({ type: 'runtime_event', runtimeId: 'db', status: null })
  })

  it('DBSV-32b 查询成功本身不再报状态条（连上那一刻连接池已经报过了）', async () => {
    saveDefaults()
    pool.status.set('s1', STATUS)
    const { client, events } = await open()

    await callTool(client, 'query', queryArgs({ connection: 'ro-pg', sql: 'SELECT 1' }))
    expect(events).toEqual([])
  })

  it('DBSV-32c 连上了、查询却失败：状态条照样亮着 —— 连接确实开着', async () => {
    saveDefaults()
    pool.result = (sessionId, name) => {
      // 连接池：建连成功（登记、通知），随后这条语句失败
      pool.connected.set(sessionId, [name])
      pool.status.set(sessionId, STATUS)
      fire(sessionId)
      return new Error('syntax error at or near "SELEC"')
    }
    const { client, events } = await open()

    const r = await callTool(client, 'query', queryArgs({ connection: 'ro-pg', sql: 'SELEC 1' }))
    expect(r.isError).toBe(true)
    expect(events).toEqual([{ type: 'runtime_event', runtimeId: 'db', status: STATUS }])
    expect((await listConnections(client)).structuredContent!.connections[0].connected).toBe(true)
  })
})

describe('database 内置服务器的寿命', () => {
  it('DBSV-33a 客户端断开 → 断开本会话全部连接（恰好一次），状态条清掉一次，前后各一行日志', async () => {
    pool.connected.set('s-close', ['ro-pg', 'rw-my'])
    pool.status.set('s-close', STATUS)
    const { clientTransport, events } = await open({ sessionId: 's-close' })
    expect(logged.lines).toContain('info database server ready session=s-close')

    await clientTransport.close()
    await settle()

    expect(pool.disconnects).toEqual(['s-close'])
    // 连接池在断开时自己也会通知 —— server 先退订再断开，所以状态条只清这一次
    expect(events).toEqual([{ type: 'runtime_event', runtimeId: 'db', status: null }])
    expect(logged.lines).toContain('info database server closed session=s-close (2 connection(s))')
    expect(pool.listeners.size).toBe(0)
  })

  it('DBSV-33b 本来一条都没连：照样断开一次（空操作），但不发状态条事件', async () => {
    const { clientTransport, events } = await open({ sessionId: 's-idle' })

    await clientTransport.close()
    await settle()

    expect(pool.disconnects).toEqual(['s-idle'])
    expect(events).toEqual([])
    expect(logged.lines).toContain('info database server closed session=s-idle (0 connection(s))')
  })

  it('DBSV-33c 关闭之后连接池再报变化，这个实例不再发任何事件', async () => {
    const { clientTransport, events } = await open({ sessionId: 's-gone' })
    await clientTransport.close()
    await settle()

    pool.status.set('s-gone', STATUS)
    fire('s-gone')
    expect(events).toEqual([])
  })

  it('DBSV-34 关 s1 的实例从不断开 s2；s1 的询问也到不了 s2 的面板', async () => {
    saveDefaults()
    pool.connected.set('s1', ['rw-my'])
    pool.connected.set('s2', ['rw-my'])
    const s1 = await open({ sessionId: 's1' })
    const s2 = await open({ sessionId: 's2' })

    await callTool(s1.client, 'query', queryArgs())
    expect(s1.asks).toHaveLength(1)
    expect(s2.asks).toEqual([])

    await s1.clientTransport.close()
    await settle()
    expect(pool.disconnects).toEqual(['s1'])
    expect(pool.connected.get('s2')).toEqual(['rw-my'])
    // s2 仍在订阅，仍能查
    expect(pool.listeners.size).toBe(1)
    expect((await callTool(s2.client, 'query', queryArgs())).isError).toBeFalsy()
  })

  it('DBSV-35 服务器那一侧的 transport 被关两次，也只断开一次', async () => {
    pool.connected.set('s-twice', ['ro-pg'])
    const { clientTransport, serverTransport } = await open({ sessionId: 's-twice' })

    await clientTransport.close()
    await serverTransport.close()
    await settle()

    expect(pool.disconnects).toEqual(['s-twice'])
    expect(
      logged.lines.filter((l) => l.includes('database server closed session=s-twice'))
    ).toHaveLength(1)
  })
})
