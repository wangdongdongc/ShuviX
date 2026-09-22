/**
 * 内置能力服务器 `database` 的连接归谁、活多久，以及外面的改动怎么够到一条打开着的连接
 * （假提供商脚本化，后面是真的 PostgreSQL：PGlite + TCP bridge，见 harness/databaseFixtures.ts）。
 *
 * 连接池是按（会话，连接名）记账的：第一次查询才连、之后复用；会话的 server 实例关掉（删会话、在
 * 设置里停用这台内置 server）就把这条会话名下的连接全断；状态条上的「断开」只断连接、不动 server。
 * 状态条（`runtime_event` 'db'）跟着连接集合走 —— 连上就亮，哪怕紧接着的查询失败了；同时连着几条
 * 就标 `+N`；一条都不剩就熄。本 spec 分四段：
 *
 *   - **连接归谁**（DBE-L）：复用、状态条、断开按钮、清空消息不断、两条会话各一条、子会话自己一条；
 *   - **设置里改了连接**（DBE-B2）：把一条正开着的可写连接改成只读 —— 设置页那条路当场把它断开；
 *     绕过设置页改了库（第二道防线）—— 下一条语句发现模式对不上，重连成只读。两条路上 agent 的
 *     下一条写都不问（它现在是只读的）、也写不进去；
 *   - **用户自己的策略**（DBE-P）：按连接名问、按连接名拒（免询问也拒）、按工具 annotations 问；
 *   - **启用开关**（DBE-L4，放在最后）：停用断开所有会话的实例与连接，新会话勾了也拿不到工具。
 *
 * 「连没连、断没断」一律按 bridge 那一侧的连接数断（`connections()` 只增不减，`open()` 是此刻开着的）；
 * 「SQL 到没到服务器」按它的语句日志断。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  eventRecorder,
  securityDecisions,
  seedFakeProvider,
  sqlite,
  sqlLit,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent,
  type SecurityDecisionEntry
} from '../../harness/seed'
import { browserDriver, type BrowserDriver, type ToolEndEvent } from '../../harness/browserFixtures'
import {
  DATABASE_SERVER_ID,
  DATABASE_TOOL_NAMES,
  READONLY_PRECHECK,
  addDbCredential,
  dbTool,
  startPgBridge,
  type PgBridge
} from '../../harness/databaseFixtures'

const MODEL = 'e2e-model'
const ALL_DB_TOOLS = DATABASE_TOOL_NAMES.map(dbTool).sort()
const QUERY = dbTool('query')
const LIST = dbTool('list-connections')
const CONNECTED_LINE = `connected: database (${DATABASE_TOOL_NAMES.length} tools)`
const RO_DB = 'e2e_conn_ro_db'
const RW_DB = 'e2e_conn_rw_db'

interface RuntimeEventShape extends RecordedEvent {
  runtimeId: string
  status: Record<string, unknown> | null
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let driver: BrowserDriver
let ro: PgBridge
let rw: PgBridge
let flip: PgBridge

// ─── 助手 ───

const createSession = (opts: { title: string; parentId?: string }): Promise<string> =>
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
  const info = await app.main.eval<{ tools: Array<{ name: string }> } | null>(
    `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`
  )
  return (info?.tools ?? []).map((t) => t.name)
}
const dbToolsOf = (names: string[]): string[] =>
  names.filter((n) => n.startsWith('mcp__database__')).sort()
const runtimeStatuses = (sid: string): Promise<Record<string, unknown>> =>
  app.main.eval(`window.api.runtime.statuses(${JSON.stringify(sid)})`)
const destroyDb = (sid: string): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.runtime.destroy(${JSON.stringify({ sessionId: sid, runtimeId: 'db' })})`
  )
const deleteSession = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
const setAutoAllow = (sid: string, on: boolean): Promise<unknown> =>
  app.main.eval(`window.api.session.updateAutoAllow(${JSON.stringify({ id: sid, autoAllow: on })})`)
const createPolicy = (text: string): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.policy.create(${JSON.stringify({ text })})`)
const deletePolicy = (name: string): Promise<unknown> =>
  app.main.eval(`window.api.policy.delete(${JSON.stringify({ name })})`)
const mcpUpdate = (params: Record<string, unknown>): Promise<unknown> =>
  app.main.eval(`window.api.mcp.update(${JSON.stringify(params)})`)

/** 建一条勾了 mcp:database 的会话，让运行时起来，回会话 id */
const tickedSession = async (title: string): Promise<string> => {
  const sid = await createSession({ title })
  expect((await writeTools(sid, ['mcp:database'])).success).toBe(true)
  expect(dbToolsOf(await ensureRuntime(sid))).toEqual(ALL_DB_TOOLS)
  return sid
}

const countInLog = (needle: string): number => app.mainLog().split(needle).length - 1
const decisionsOf = (toolCallId: string): SecurityDecisionEntry[] =>
  securityDecisions(app).filter((d) => d.toolCallId === toolCallId)
const decisionOf = (toolCallId: string): Promise<SecurityDecisionEntry> =>
  until(() => decisionsOf(toolCallId)[0], `security decision of ${toolCallId}`)

const dbEvents = async (since: number, sid: string): Promise<RuntimeEventShape[]> =>
  (await driver.eventsSince<RuntimeEventShape>(since, 'runtime_event', sid)).filter(
    (e) => e.runtimeId === 'db'
  )

const banner = (database: string, more = 0): Record<string, unknown> => ({
  label: `postgresql ${database}${more > 0 ? ` +${more}` : ''}`,
  icon: 'Database',
  color: '#f59e0b',
  description: '127.0.0.1'
})

/** 一次不该有卡的查询：跑完，断言确实没有询问 */
const runQuery = async (
  sid: string,
  id: string,
  connection: string,
  sql: string,
  description = 'e2e query'
): Promise<ToolEndEvent> => {
  provider.reset()
  const { ends, since } = await driver.run(sid, [
    { id, tool: QUERY, args: { connection, sql, description } }
  ])
  expect(await driver.eventsSince(since, 'input_request', sid), id).toEqual([])
  return ends[id]
}

/** 一次可写连接上的查询：等卡、允许、跑完 */
const allowQuery = async (
  sid: string,
  id: string,
  connection: string,
  sql: string,
  description = 'e2e write'
): Promise<ToolEndEvent> => {
  provider.reset()
  const since = await driver.start(sid, [
    { id, tool: QUERY, args: { connection, sql, description } }
  ])
  const ask = await driver.waitAsk(sid, since)
  expect(ask.id).toBe(id)
  await driver.answer(sid, ask.id, true)
  return (await driver.finish(sid, since)).ends[id]
}

const listConnections = async (sid: string, id: string): Promise<string> => {
  provider.reset()
  const { ends } = await driver.run(sid, [{ id, tool: LIST, args: {} }])
  return ends[id].result
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  driver = browserDriver({ main: app.main, provider, events })

  ro = await startPgBridge(
    [
      'CREATE TABLE users (id int PRIMARY KEY, name text NOT NULL);',
      "INSERT INTO users VALUES (1, 'ada'), (2, 'grace'), (3, 'linus');"
    ].join('\n')
  )
  rw = await startPgBridge('CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL);')
  flip = await startPgBridge('CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL);')
  const common = { dbType: 'postgresql' as const, host: '127.0.0.1', password: 'e2e-conn-pw' }
  await addDbCredential(app.main, {
    ...common,
    name: 'e2e-ro',
    port: ro.port,
    username: 'e2e_conn_ro',
    database: RO_DB,
    readonly: true
  })
  await addDbCredential(app.main, {
    ...common,
    name: 'e2e-rw',
    port: rw.port,
    username: 'e2e_conn_rw',
    database: RW_DB,
    readonly: false
  })
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
  await ro?.close()
  await rw?.close()
  await flip?.close()
})

// ═══════════════════════════════════════════════════════════════════════
// 连接归谁
// ═══════════════════════════════════════════════════════════════════════

describe('连接归谁（DBE-L）', () => {
  let a = ''

  it('DBE-L1 同一条会话的第二次查询复用那一条连接', async () => {
    a = await tickedSession('DBE-L A')
    const first = await runQuery(a, 'dbl1_first', 'e2e-ro', 'SELECT 1 AS l1_first')
    expect(first.isError).toBe(false)
    expect(ro.connections()).toBe(1)
    const second = await runQuery(a, 'dbl1_second', 'e2e-ro', 'SELECT 2 AS l1_second')
    expect(second.isError).toBe(false)
    expect(ro.connections()).toBe(1)
    expect(ro.open()).toBe(1)
    const onConn = ro.statementsOf(1)
    expect(onConn).toContain('SELECT 1 AS l1_first')
    expect(onConn).toContain('SELECT 2 AS l1_second')
  }, 120_000)

  it('DBE-L7 第一次查询连上了、查询本身失败：状态条照样亮，列连接也说连着', async () => {
    const c = await tickedSession('DBE-L C')
    const before = ro.connections()
    const since = await events.mark()
    const end = await runQuery(c, 'dbl7_missing', 'e2e-ro', 'SELECT * FROM no_such_table')
    expect(end.isError).toBe(true)
    expect(end.result).toContain('no_such_table')
    expect(ro.connections()).toBe(before + 1)

    const lit = await until(async () => (await dbEvents(since, c)).at(-1), 'db banner lit for C')
    expect(lit.status).toEqual(banner(RO_DB))
    expect((await runtimeStatuses(c)).db).toEqual(banner(RO_DB))
    expect((await listConnections(c, 'dbl7_list')).split('\n')[1]).toBe(
      '  e2e-ro  (postgresql, read-only)  [connected]'
    )
    await deleteSession(c)
  }, 120_000)

  it('DBE-L8 同时连着两条：状态条标 +1（名字是先连上的那一条）', async () => {
    const since = await events.mark()
    const end = await allowQuery(a, 'dbl8_rw', 'e2e-rw', "INSERT INTO items (label) VALUES ('l8')")
    expect(end.isError).toBe(false)
    expect(end.result).toBe('OK: INSERT, 1 row affected')
    const lit = await until(async () => {
      const ev = (await dbEvents(since, a)).at(-1)
      return ev?.status && String(ev.status.label).endsWith('+1') ? ev : null
    }, 'db banner shows +1')
    expect(lit.status).toEqual(banner(RO_DB, 1))
    expect((await runtimeStatuses(a)).db).toEqual(banner(RO_DB, 1))
  }, 120_000)

  it('DBE-L3 状态条上的断开：两条都断、状态条熄、再断一次说没有；下一次查询重新连上', async () => {
    const [roOpen, rwOpen] = [ro.open(), rw.open()]
    const since = await events.mark()
    expect(await destroyDb(a)).toEqual({ success: true })
    await until(
      () => ro.open() === roOpen - 1 && rw.open() === rwOpen - 1,
      "A's two connections closed on the server side"
    )
    const last = await until(async () => {
      const evs = await dbEvents(since, a)
      return evs.length > 0 && evs.at(-1)!.status === null ? evs.at(-1) : null
    }, 'db banner cleared')
    expect(last.status).toBeNull()
    expect(await runtimeStatuses(a)).toEqual({})
    // 已经没有连接了：第二次断开什么也不做
    expect(await destroyDb(a)).toEqual({ success: false })
    expect(await listConnections(a, 'dbl3_list')).not.toContain('[connected]')

    // 断开的只是连接，不是 server：下一次查询照常用，重新连上
    const conns = ro.connections()
    const again = await runQuery(a, 'dbl3_again', 'e2e-ro', 'SELECT 3 AS l3_again')
    expect(again.isError).toBe(false)
    expect(ro.connections()).toBe(conns + 1)
    expect((await runtimeStatuses(a)).db).toEqual(banner(RO_DB))
  }, 120_000)

  it('DBE-L5 清空消息（运行时重建）不断连接：工具还在、不重连 server、不重连库', async () => {
    const conns = ro.connections()
    const connected = countInLog(CONNECTED_LINE)
    const mark = await events.mark()
    await app.main.eval(`window.api.message.clear(${JSON.stringify(a)})`)
    expect(dbToolsOf(await ensureRuntime(a))).toEqual(ALL_DB_TOOLS)

    const end = await runQuery(a, 'dbl5_after_clear', 'e2e-ro', 'SELECT 5 AS l5_after_clear')
    expect(end.isError).toBe(false)
    expect(ro.connections()).toBe(conns)
    expect(countInLog(CONNECTED_LINE)).toBe(connected)
    const connecting = (await events.allSince<RecordedEvent>(mark)).filter(
      (e) => e.type === 'mcp_connecting'
    )
    expect(connecting).toEqual([])
    expect((await runtimeStatuses(a)).db).toEqual(banner(RO_DB))
  }, 120_000)

  it('DBE-L2 两条会话各一条连接：删掉 Q 只断 Q 那一条，P 照常查询、不重连', async () => {
    const p = await tickedSession('DBE-L P')
    const qSid = await tickedSession('DBE-L Q')
    const conns = ro.connections()
    const open = ro.open()
    expect((await runQuery(p, 'dbl2_p', 'e2e-ro', 'SELECT 21 AS l2_p')).isError).toBe(false)
    expect((await runQuery(qSid, 'dbl2_q', 'e2e-ro', 'SELECT 22 AS l2_q')).isError).toBe(false)
    expect(ro.connections()).toBe(conns + 2)
    expect(ro.open()).toBe(open + 2)

    await deleteSession(qSid)
    await until(() => ro.open() === open + 1, "Q's connection closed on the server side")
    await until(
      () => app.mainLog().includes(`database server closed session=${qSid} (1 connection(s))`),
      "Q's database server closed with its one connection"
    )

    const after = await runQuery(p, 'dbl2_p_again', 'e2e-ro', 'SELECT 23 AS l2_p_again')
    expect(after.isError).toBe(false)
    expect(ro.connections()).toBe(conns + 2)
    await deleteSession(p)
  }, 120_000)

  it('DBE-L6 子会话继承勾选、自己一条连接；删掉子会话只断它那一条', async () => {
    const parent = await tickedSession('DBE-L6 parent')
    expect(
      (await runQuery(parent, 'dbl6_parent', 'e2e-ro', 'SELECT 61 AS l6_parent')).isError
    ).toBe(false)
    const child = await createSession({ title: 'DBE-L6 child', parentId: parent })
    expect(await storedTools(child)).toEqual(['mcp:database'])
    expect(dbToolsOf(await ensureRuntime(child))).toEqual(ALL_DB_TOOLS)

    const conns = ro.connections()
    const open = ro.open()
    expect((await runQuery(child, 'dbl6_child', 'e2e-ro', 'SELECT 62 AS l6_child')).isError).toBe(
      false
    )
    expect(ro.connections()).toBe(conns + 1)
    expect(ro.open()).toBe(open + 1)

    await deleteSession(child)
    await until(() => ro.open() === open, "the child's connection closed on the server side")
    await until(
      () => app.mainLog().includes(`database server closed session=${child} (1 connection(s))`),
      "the child's database server closed"
    )
    // 父会话那一条还在
    expect(
      (await runQuery(parent, 'dbl6_parent_again', 'e2e-ro', 'SELECT 63 AS l6_parent_again'))
        .isError
    ).toBe(false)
    expect(ro.connections()).toBe(conns + 1)
    await deleteSession(parent)
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 设置里改了连接
// ═══════════════════════════════════════════════════════════════════════

describe('设置里把正开着的可写连接改成只读（DBE-B2）', () => {
  const COUNT = 'SELECT count(*)::int AS n FROM items'
  let f = ''
  let flipId = ''

  it('DBE-B2 设置页那条路：改动当场断开旧连接；agent 的下一条写不问、重连成只读、写不进去', async () => {
    f = await tickedSession('DBE-B2 flip')
    flipId = await addDbCredential(app.main, {
      name: 'e2e-flip',
      dbType: 'postgresql',
      host: '127.0.0.1',
      port: flip.port,
      username: 'e2e_flip_user',
      password: 'e2e-flip-pw',
      database: 'e2e_flip_db',
      readonly: false
    })
    // 可写：连读都要问
    const counted = await allowQuery(f, 'dbb2_count', 'e2e-flip', COUNT, 'Count items')
    expect(counted.isError).toBe(false)
    expect(counted.result).toContain('| 0 |')
    expect(flip.open()).toBe(1)
    // 可写连接：没有只读标志、没有只读事务
    expect(flip.statementsOf(1)).toEqual([COUNT])

    // 用户在设置里把它改成只读 —— 这条连接是按旧配置（可写）建的，当场断开
    const since = await events.mark()
    await app.main.eval(
      `window.api.dbCredential.update(${JSON.stringify({ id: flipId, readonly: true })})`
    )
    await until(() => flip.open() === 0, 'the settings change closed the writable connection')
    await until(
      async () => (await dbEvents(since, f)).some((e) => e.status === null),
      'db banner cleared for the flipped session'
    )

    // agent 的下一条写：它现在是只读连接，不问；重新连上的是一条只读连接，写被挡在门外
    const INSERT = "INSERT INTO items (label) VALUES ('b2_sneaky')"
    const write = await runQuery(f, 'dbb2_insert', 'e2e-flip', INSERT, 'Add one')
    expect(write.isError).toBe(true)
    expect(write.result).toBe(`[MCP Error] Database error: ${READONLY_PRECHECK}`)
    expect(flip.connections()).toBe(2)
    expect(flip.statementsOf(2)).toEqual(['SET default_transaction_read_only = on'])
    expect(flip.saw('b2_sneaky')).toBe(false)
    expect(await decisionOf('dbb2_insert')).toMatchObject({
      objectKind: 'database',
      effect: 'allow',
      winning: 'default:database'
    })

    // 预检认不出的写法：到了服务器，被只读事务拒绝
    const cte = await runQuery(
      f,
      'dbb2_cte',
      'e2e-flip',
      "WITH x AS (INSERT INTO items (label) VALUES ('b2_cte') RETURNING id) SELECT id FROM x",
      'Add one through a CTE'
    )
    expect(cte.isError).toBe(true)
    expect(cte.result).toContain('read-only transaction')
    expect(await flip.count('items')).toBe(0)
  }, 120_000)

  it('DBE-B2b 绕过设置页改了库（第二道防线）：下一条语句发现模式对不上，旧的可写连接不用、重连成只读', async () => {
    // 先经设置页改回可写（又断开一次），再把只读连接留在 PGlite 会话里的标志抹掉 ——
    // 这台 bridge 的会话只有一个，那条只读连接下的 SET 还挂在上面
    await app.main.eval(
      `window.api.dbCredential.update(${JSON.stringify({ id: flipId, readonly: false })})`
    )
    await until(() => flip.open() === 0, 'writable again: the read-only connection closed')
    await flip.query('SET default_transaction_read_only = off')

    const counted = await allowQuery(f, 'dbb2b_count', 'e2e-flip', COUNT, 'Count items')
    expect(counted.isError).toBe(false)
    const held = flip.connections()
    expect(flip.open()).toBe(1)

    // 库里的只读位变了，但不是经设置页（另一个窗口、导入、手改库）—— 没有谁去断开那条连接
    sqlite(app.home, `UPDATE db_credentials SET readonly = 1 WHERE id = ${sqlLit(flipId)}`)
    expect(flip.open()).toBe(1)

    const INSERT = "INSERT INTO items (label) VALUES ('b2b_sneaky')"
    const write = await runQuery(f, 'dbb2b_insert', 'e2e-flip', INSERT, 'Add one')
    expect(write.isError).toBe(true)
    expect(write.result).toBe(`[MCP Error] Database error: ${READONLY_PRECHECK}`)
    // 旧的可写连接关了，新连的是只读
    expect(flip.connections()).toBe(held + 1)
    expect(flip.statementsOf(held + 1)).toEqual(['SET default_transaction_read_only = on'])
    await until(() => flip.open() === 1, 'only the new read-only connection is open')
    expect(flip.saw('b2b_sneaky')).toBe(false)
    expect(
      app.mainLog().includes('Credential "e2e-flip" changed read-only mode, reconnecting')
    ).toBe(true)
    expect(await flip.count('items')).toBe(0)
    await deleteSession(f)
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 用户自己的策略
// ═══════════════════════════════════════════════════════════════════════

describe('用户自己的策略（DBE-P）', () => {
  const ASK_RO = 'db-e2e-ask-ro'
  const DENY_RW = 'db-e2e-deny-rw'
  const ANNOTATIONS = 'db-e2e-annotations'
  let s = ''

  const policy = (name: string, type: string, effect: string, match: string): string =>
    [
      '---',
      'shuvix: policy v1',
      `name: ${name}`,
      `description: e2e ${effect} policy`,
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      `  object.type: [${type}]`,
      'shuvix-policy-rules:',
      `  - effect: ${effect}`,
      `    match: ${match}`,
      '---',
      'e2e policy body'
    ].join('\n')

  beforeAll(async () => {
    s = await tickedSession('DBE-P policies')
  })

  afterAll(async () => {
    for (const name of [ASK_RO, DENY_RW, ANNOTATIONS]) await deletePolicy(name)
  })

  it('DBE-P1 用户按连接名写的 ask：只读连接也问，卡片写明连接；拒了语句没到库', async () => {
    const created = await createPolicy(
      policy(
        ASK_RO,
        'database',
        'ask',
        "object.type == 'database' && object.credential == 'e2e-ro'"
      )
    )
    expect(created.success, created.error).toBe(true)
    try {
      const SQL = 'SELECT name AS p1_probe FROM users WHERE id = 1'
      provider.reset()
      const since = await driver.start(s, [
        {
          id: 'dbp1_select',
          tool: QUERY,
          args: { connection: 'e2e-ro', sql: SQL, description: 'Read ada' }
        }
      ])
      const ask = await driver.waitAsk(s, since)
      expect(ask).toMatchObject({
        id: 'dbp1_select',
        toolName: QUERY,
        command: `-- e2e-ro\n${SQL}`
      })
      await driver.answer(s, ask.id, false)
      const { ends } = await driver.finish(s, since)
      expect(ends.dbp1_select.result).toBe(`[MCP Error] User denied ${SQL}`)
      expect(ro.saw('p1_probe')).toBe(false)
      expect(await decisionOf('dbp1_select')).toMatchObject({
        objectKind: 'database',
        effect: 'ask',
        winning: `${ASK_RO}#0`,
        userResponse: 'denied'
      })
    } finally {
      await deletePolicy(ASK_RO)
    }
  }, 120_000)

  it('DBE-P2 用户按连接名写的 deny：不问就拒，免询问开着也拒；语句没到库', async () => {
    const created = await createPolicy(
      policy(DENY_RW, 'database', 'deny', "object.credential == 'e2e-rw'")
    )
    expect(created.success, created.error).toBe(true)
    await setAutoAllow(s, true)
    try {
      const end = await runQuery(
        s,
        'dbp2_insert',
        'e2e-rw',
        "INSERT INTO items (label) VALUES ('p2_probe')"
      )
      expect(end.isError).toBe(true)
      expect(end.result).toBe(`[MCP Error] Denied by security policy rule '${DENY_RW}#0'`)
      expect(rw.saw('p2_probe')).toBe(false)
      expect(await decisionOf('dbp2_insert')).toMatchObject({
        objectKind: 'database',
        effect: 'deny',
        winning: `${DENY_RW}#0`
      })
    } finally {
      await setAutoAllow(s, false)
      await deletePolicy(DENY_RW)
    }
  }, 120_000)

  it('DBE-P3 按工具 annotations 写的策略：列连接（可信且只读）不问；query 在全工具门那一层就问，拒了连 server 都没到', async () => {
    const created = await createPolicy(
      policy(
        ANNOTATIONS,
        'invocation',
        'ask',
        "has(object.mcpServer) && object.mcpServer == 'database' && !(object.mcpTrusted && object.readOnly)"
      )
    )
    expect(created.success, created.error).toBe(true)
    try {
      provider.reset()
      const listed = await driver.run(s, [{ id: 'dbp3_list', tool: LIST, args: {} }])
      expect(listed.ends.dbp3_list.isError).toBe(false)
      expect(await driver.eventsSince(listed.since, 'input_request', s)).toEqual([])

      const SQL = 'SELECT 3 AS p3_probe'
      provider.reset()
      const since = await driver.start(s, [
        {
          id: 'dbp3_query',
          tool: QUERY,
          args: { connection: 'e2e-ro', sql: SQL, description: 'Probe' }
        }
      ])
      const ask = await driver.waitAsk(s, since)
      expect(ask).toMatchObject({ id: 'dbp3_query', toolName: QUERY, command: QUERY })
      await driver.answer(s, ask.id, false)
      const { ends } = await driver.finish(s, since)
      // 宿主的包装层在 server 之前就挡下了：真正的工具错误，不带 [MCP Error] 前缀
      expect(ends.dbp3_query.isError).toBe(true)
      expect(ends.dbp3_query.result).toBe(`User denied ${QUERY}`)
      expect(ro.saw('p3_probe')).toBe(false)
      expect(decisionsOf('dbp3_query')).toEqual([
        expect.objectContaining({ objectKind: 'invocation', effect: 'ask', userResponse: 'denied' })
      ])
    } finally {
      await deletePolicy(ANNOTATIONS)
    }
  }, 120_000)
})

// ═══════════════════════════════════════════════════════════════════════
// 启用开关（放在最后：停用会断开所有会话的实例）
// ═══════════════════════════════════════════════════════════════════════

describe('启用开关（DBE-L4）', () => {
  it('DBE-L4 停用：断开活着的实例与它们的连接、状态条熄；新会话勾了也没有工具、不报错、不转圈；重新启用之后又有了', async () => {
    const live = await tickedSession('DBE-L4 live')
    expect((await runQuery(live, 'dbl4_live', 'e2e-ro', 'SELECT 4 AS l4_live')).isError).toBe(false)
    expect(ro.open()).toBeGreaterThan(0)

    try {
      const since = await events.mark()
      await mcpUpdate({ id: DATABASE_SERVER_ID, isEnabled: false })
      await until(
        () => app.mainLog().includes(`disconnected: ${DATABASE_SERVER_ID}#${live}`),
        'live session instance disconnected'
      )
      // 这台 server 的每一个会话实例都关了，它们名下的库连接跟着全断
      await until(() => ro.open() === 0 && rw.open() === 0, 'every database socket closed')
      await until(
        async () => (await dbEvents(since, live)).some((e) => e.status === null),
        'db banner cleared for the live session'
      )

      const mark = await events.mark()
      const off = await createSession({ title: 'DBE-L4 off' })
      expect((await writeTools(off, ['mcp:database'])).success).toBe(true)
      expect(dbToolsOf(await ensureRuntime(off))).toEqual([])
      const noise = (await events.allSince<RecordedEvent>(mark)).filter(
        (e) => e.sessionId === off && (e.type === 'error' || e.type === 'mcp_connecting')
      )
      expect(noise).toEqual([])
    } finally {
      await mcpUpdate({ id: DATABASE_SERVER_ID, isEnabled: true })
    }
    const on = await tickedSession('DBE-L4 on')
    expect(dbToolsOf(await ensureRuntime(on))).toEqual(ALL_DB_TOOLS)
  }, 120_000)
})
