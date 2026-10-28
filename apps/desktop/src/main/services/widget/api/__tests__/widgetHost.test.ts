/**
 * 组件宿主（widgetHost.ts + widgetHostCore.ts）—— 真的子进程：Electron 的 node 模式（`ELECTRON_RUN_AS_NODE=1`）跑打好的
 * widgetHost.js，真的 QuickJS + 真的 better-sqlite3，按 hostProtocol 收发原始消息（请求自带 cpuMs 与 mode）。
 * 整个文件只拉起一个宿主（beforeAll），每条用例用自己的组件 id 与库文件，互不干扰；API 包用本机 esbuild 现打（widgetApiKit）。
 * 主进程侧的 Node 打不开这里的 better-sqlite3（它是为 Electron 编的），所以库里有什么一律经宿主自己看：读操作或 `query` 请求。
 * Electron 加载不了 better-sqlite3（CI=1 跳过了 electron-rebuild）时整个文件跳过。
 *
 *   H-1  query 建 books（title UNIQUE）；写操作 addBook 返回 RETURNING 的行、wrote:true；读操作 listBooks 看得到；
 *        ctx.uuid 是 v4；日志随结果回来；同名再加一次（ON CONFLICT）更新的是同一个 id
 *   H-2  读操作写不了：run 的 INSERT、sql 的 INSERT…RETURNING、WITH…INSERT、UPDATE、DELETE、REPLACE → ok:false
 *        「A read operation cannot change data」、wrote:false、行数不变
 *   H-3  模式来自请求：op.write 以 mode:'read' 发来 → INSERT 被拒；读操作调 ctx.db.tx → 「Transactions are only for write operations.」
 *   H-4  写操作 `ctx.db.query(args.sql)`：ATTACH 别的组件的库 / 新文件、VACUUM INTO、PRAGMA writable_schema / journal_mode、
 *        load_extension（裸的被守卫挡、加引号的由 SQLite 「not authorized」挡）、pragma_database_list、CREATE、DROP、BEGIN、SAVEPOINT
 *        → 都 ok:false；目标位置一个文件都没有；别的组件的行从不出现；books 还在；日志模式还是 wal
 *   H-5  读操作把 args.name 拼进 SQL：`x'; ATTACH …; --` 被拒、不出文件；`x'; DELETE FROM books; --` 被拒；
 *        `x' UNION SELECT name FROM sqlite_master --` 能跑，但只看得到自己的库（钉住）
 *   H-7  写操作 `SELECT 1; DELETE FROM books` → ok:false，行都在
 *   H-8  事务：两条插入一起提交；回调抛错 → 两条都没有、结果是错误；里层抛错外层接住 → 里层的行没了、外层的留着
 *   H-9  一个 handler 里并发两个 tx：A 落库，B 以「Another ctx.db.tx is still running here…」拒绝
 *   H-10 `tx(async()=>{ 插 X; for(;;){} })`、cpuMs 300 → timeout；之后正常写的 Y 读得到；装结构照常；forget 之后
 *        Y 在、X 不在。tx 里 `await new Promise(()=>{})` 的变体同样
 *   H-11 api.ts 顶层抓住 `globalThis.__host`；操作里 `h.tx('begin')`、插入、返回 → 「left a transaction open; it was rolled back」，
 *        行不在，下一次写照常提交
 *   H-12 dry run：写操作返回 RETURNING 的行、wrote:false、行不在；里面用 ctx.db.tx → 不在；handler 失败或超时 → 不在，
 *        之后真的写照常提交；读操作的 dry run → 正常结果
 *   H-13 写操作插入后 ctx.fail → 行留着、wrote:true；读操作永远 wrote:false
 *   H-14 BLOB → base64；布尔 → 0/1；对象 → JSON 文本
 *   H-15 外键冲突被拒；写过之后有 `-wal` 文件；dbPath 的上级目录第一次用时建出来
 *   H-16 多条语句的脚本（经 query，`sql` 动作装结构就是它）：含 FTS5 trigram 的 DDL 生效；第二条失败 → 第一条也没生效
 *        （整段一个事务）；禁用词 → sql_refused；重跑 CREATE IF NOT EXISTS 无害；脚本自带 BEGIN/COMMIT → query_failed（钉住）
 *   H-17 query：SELECT → psql 表格、以「(n rows)」结尾，没有行 →「(0 rows)」；UPDATE →「OK (2 rows changed)」；多条语句 →「OK」、都生效；
 *        ATTACH / VACUUM / PRAGMA → sql_refused、不出文件；`SELECT * FROM pragma_table_info('books')` 能用；语法错 → query_failed
 *   H-18 两个组件互相隔离（同名表、各自的文件）；对一个组件连发两次调用，按顺序落定
 *   WC-S1 迁移脚本（建新表、INSERT … SELECT 搬行、DROP 旧表、改名）→ OK，行带过去
 *   WC-S2 INSERT + ALTER + 失败的一句 → query_failed（SQLite 的原话），行数与列都没变
 *   WC-S3 / S4 失败或成功的脚本之后：写操作提交、读操作（只读连接）看得到、下一段脚本开得了事务
 *   WC-S5 单条语句（带结尾的 `;` 或注释）照旧是「OK (1 row changed)」
 *   WC-S6 脚本自己中途 COMMIT / END / ROLLBACK → query_failed「ended its own transaction partway」（之前 / 之后的
 *         哪些生效了钉住）；自己 COMMIT 之后再失败 → SQLite 的原话（钉住）；结束后又 BEGIN 留着 → 照样提交；
 *         触发器的 BEGIN … END 不算；之后连接干净
 *   WC-S7 单独一条 BEGIN / COMMIT / END / ROLLBACK / SAVEPOINT / RELEASE（含小写、前面有注释）→ query_failed
 *         「Do not write transaction statements in sql」；之后写操作提交、读得到，脚本照常
 *   H-19 第一条消息是 `{ready:true}`；没有数字 id 的消息被忽略、下一条照常；disconnect() → 宿主以 0 退出（最后一条，关掉共用的宿主）
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  CallResult,
  HostRequestBody,
  HostResponse,
  OpMode,
  WidgetCaller,
  WidgetHostTarget
} from '../hostProtocol'
import {
  buildHostBundle,
  bundleApi,
  electronCanLoadSqlite,
  startRawHost,
  type RawHost
} from './widgetApiKit'

const USER: WidgetCaller = { kind: 'user', label: 'user' }
const BOOKS_DDL = 'CREATE TABLE books(id TEXT PRIMARY KEY, title TEXT NOT NULL UNIQUE)'
const READ_ONLY_MSG = 'A read operation cannot change data'

/**
 * 大多数用例共用的 API：书架。只用 `ctx.db.query(text, params)`（不用带反引号的模板标签，免得在这里层层转义），
 * 唯一的例外是 readInsertRun（要测 `run`）
 */
const LIBRARY_API = `
import { defineApi, op, z } from 'shuvix/widget-api'
let counter = 0
const none = z.object({})
const sqlArg = z.object({ sql: z.string() })
const titleArg = z.object({ title: z.string() })
const insert = (db: any, title: string) =>
  db.query('INSERT INTO books(id, title) VALUES (?, ?) RETURNING id, title', ['id-' + title, title])
export default defineApi({
  addBook: op.write({
    description: 'Add a book; adding the same title again keeps its id.',
    input: titleArg,
    handler: async ({ title }, ctx) => {
      ctx.log('adding', title)
      const rows = await ctx.db.query(
        'INSERT INTO books(id, title) VALUES (?, ?) ON CONFLICT(title) DO UPDATE SET title = excluded.title RETURNING id, title',
        [ctx.uuid(), title]
      )
      return rows[0]
    }
  }),
  listBooks: op.read({
    description: 'List titles.',
    input: none,
    handler: async (_a, ctx) =>
      (await ctx.db.query('SELECT title FROM books ORDER BY title')).map((r: any) => r.title)
  }),
  readQuery: op.read({ description: 'Run SQL (read).', input: sqlArg, handler: (a, ctx) => ctx.db.query(a.sql) }),
  writeQuery: op.write({ description: 'Run SQL (write).', input: sqlArg, handler: (a, ctx) => ctx.db.query(a.sql) }),
  readInsertRun: op.read({
    description: 'Insert through run.',
    input: none,
    handler: (_a, ctx) => ctx.db.run\`INSERT INTO books(id, title) VALUES ('run-id', 'via run')\`
  }),
  readTx: op.read({ description: 'Open a tx.', input: none, handler: (_a, ctx) => ctx.db.tx(async () => 1) }),
  findByName: op.read({
    description: 'Find by name (concatenated on purpose).',
    input: z.object({ name: z.string() }),
    handler: (a, ctx) => ctx.db.query("SELECT title FROM books WHERE title = '" + a.name + "'")
  }),
  addTwo: op.write({
    description: 'Two inserts in one tx.',
    input: z.object({ a: z.string(), b: z.string(), fail: z.boolean().default(false) }),
    handler: (x, ctx) =>
      ctx.db.tx(async (tx) => {
        await insert(tx, x.a)
        await insert(tx, x.b)
        if (x.fail) throw new Error('boom after two inserts')
        return 'committed'
      })
  }),
  nested: op.write({
    description: 'Inner tx fails, outer catches.',
    input: z.object({ outer: z.string(), inner: z.string() }),
    handler: (x, ctx) =>
      ctx.db.tx(async (tx) => {
        await insert(tx, x.outer)
        let caught = ''
        try {
          await tx.tx(async (inner) => {
            await insert(inner, x.inner)
            throw new Error('inner boom')
          })
        } catch (e) {
          caught = (e as Error).message
        }
        return caught
      })
  }),
  concurrentTx: op.write({
    description: 'Two tx at the same level at once.',
    input: z.object({ a: z.string(), b: z.string() }),
    handler: async (x, ctx) => {
      const settled = await Promise.allSettled([
        ctx.db.tx(async (tx) => {
          await insert(tx, x.a)
          return 'a'
        }),
        ctx.db.tx(async (tx) => {
          await insert(tx, x.b)
          throw new Error('b failed')
        })
      ])
      return settled.map((s) =>
        s.status === 'fulfilled'
          ? { status: s.status, value: s.value }
          : { status: s.status, reason: (s.reason as Error).message }
      )
    }
  }),
  txSpin: op.write({
    description: 'Insert in a tx, then spin.',
    input: titleArg,
    handler: (a, ctx) =>
      ctx.db.tx(async (tx) => {
        await insert(tx, a.title)
        for (;;) {}
      })
  }),
  txHang: op.write({
    description: 'Insert in a tx, then wait forever.',
    input: titleArg,
    handler: (a, ctx) =>
      ctx.db.tx(async (tx) => {
        await insert(tx, a.title)
        await new Promise(() => {})
      })
  }),
  addInTx: op.write({
    description: 'Insert in a tx.',
    input: titleArg,
    handler: (a, ctx) => ctx.db.tx(async (tx) => (await insert(tx, a.title))[0])
  }),
  insertThenFail: op.write({
    description: 'Insert, then fail.',
    input: titleArg,
    handler: async (a, ctx) => {
      await insert(ctx.db, a.title)
      ctx.fail('refused', 'refused after the insert')
    }
  }),
  insertThenSpin: op.write({
    description: 'Insert, then spin.',
    input: titleArg,
    handler: async (a, ctx) => {
      await insert(ctx.db, a.title)
      for (;;) {}
    }
  }),
  values: op.read({
    description: 'Value conversions.',
    input: none,
    handler: (_a, ctx) =>
      ctx.db.query("SELECT X'48656C6C6F' AS b, ? AS t, ? AS f, ? AS o", [true, false, { a: 1 }])
  }),
  count: op.read({ description: 'Module-level counter.', input: none, handler: () => ++counter })
})
`

/** 每个操作的读写模式（请求里要带上 —— 宿主不看沙箱，只看请求） */
const LIBRARY_MODES: Record<string, OpMode> = {
  addBook: 'write',
  listBooks: 'read',
  readQuery: 'read',
  writeQuery: 'write',
  readInsertRun: 'read',
  readTx: 'read',
  findByName: 'read',
  addTwo: 'write',
  nested: 'write',
  concurrentTx: 'write',
  txSpin: 'write',
  txHang: 'write',
  addInTx: 'write',
  insertThenFail: 'write',
  insertThenSpin: 'write',
  values: 'read',
  count: 'read'
}

interface Bundle {
  path: string
  hash: string
}

let tmp = ''
let host: RawHost
let library: Bundle
let bundleSeq = 0

/** 打一份 API 包，写成临时文件（bundlePath），hash 每份不同 */
async function writeBundle(source: string): Promise<Bundle> {
  const n = ++bundleSeq
  const path = join(tmp, 'bundles', `api-${n}.js`)
  mkdirSync(join(tmp, 'bundles'), { recursive: true })
  writeFileSync(path, await bundleApi(source))
  return { path, hash: `bundle-${n}` }
}

/** 一个组件的位置：`<tmp>/data/<id>/data.sqlite` */
function targetOf(widgetId: string): WidgetHostTarget {
  return { widgetId, dbPath: join(tmp, 'data', widgetId, 'data.sqlite') }
}

interface CallOptions {
  mode?: OpMode
  dryRun?: boolean
  cpuMs?: number
  bundle?: Bundle
  caller?: WidgetCaller
}

function callRequest(
  target: WidgetHostTarget,
  op: string,
  args: unknown = {},
  options: CallOptions = {}
): HostRequestBody {
  const bundle = options.bundle ?? library
  return {
    type: 'call',
    target,
    bundlePath: bundle.path,
    bundleHash: bundle.hash,
    op,
    mode: options.mode ?? LIBRARY_MODES[op] ?? 'write',
    args,
    caller: options.caller ?? USER,
    ...(options.dryRun ? { dryRun: true } : {}),
    cpuMs: options.cpuMs ?? 5000
  }
}

/** 一次调用；宿主层面成功（ok:true）才返回 CallResult，否则让用例失败 */
async function call(
  target: WidgetHostTarget,
  op: string,
  args: unknown = {},
  options: CallOptions = {}
): Promise<CallResult> {
  const res = await host.request(callRequest(target, op, args, options))
  if (!res.ok) throw new Error(`host error ${res.error.code}: ${res.error.message}`)
  return res.result as CallResult
}

/** 一次调用的值（outcome 必须 ok） */
async function value(
  target: WidgetHostTarget,
  op: string,
  args: unknown = {},
  options: CallOptions = {}
): Promise<unknown> {
  const r = await call(target, op, args, options)
  if (!r.outcome.ok) throw new Error(`${op} failed: ${JSON.stringify(r.outcome.error)}`)
  return r.outcome.value
}

async function titles(target: WidgetHostTarget): Promise<string[]> {
  return (await value(target, 'listBooks')) as string[]
}

/** 装结构：经 `query`（`widget` 工具的 `sql`；多条语句整段在一个事务里） */
async function applySchema(target: WidgetHostTarget, ddl: string): Promise<HostResponse> {
  return host.request({ type: 'query', target, sql: ddl })
}

async function query(target: WidgetHostTarget, sql: string): Promise<HostResponse> {
  return host.request({ type: 'query', target, sql })
}

/** `query` 的文本输出（必须成功） */
async function queryText(target: WidgetHostTarget, sql: string): Promise<string> {
  const res = await query(target, sql)
  if (!res.ok) throw new Error(`query failed ${res.error.code}: ${res.error.message}`)
  return (res.result as { output: string }).output
}

/** 一个装好 books 表的新书架组件 */
async function freshLibrary(widgetId: string): Promise<WidgetHostTarget> {
  const target = targetOf(widgetId)
  const res = await applySchema(target, BOOKS_DDL)
  expect(res).toMatchObject({ ok: true })
  return target
}

function errorOf(r: CallResult): { code: string; message: string } {
  expect(r.outcome.ok).toBe(false)
  return (r.outcome as { ok: false; error: { code: string; message: string } }).error
}

describe.skipIf(!electronCanLoadSqlite())('组件宿主（真子进程，原始协议）', () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-host-'))
    const hostPath = await buildHostBundle(tmp)
    host = await startRawHost(hostPath)
    library = await writeBundle(LIBRARY_API)
  }, 60_000)

  afterAll(async () => {
    if (host) await host.stop()
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }, 30_000)

  it('H-1 建表、写、读、uuid、日志、ON CONFLICT 更新同一个 id', async () => {
    const t = await freshLibrary('h1-shelf')

    const first = await call(t, 'addBook', { title: 'Dune' })
    expect(first.wrote).toBe(true)
    expect(first.outcome.ok).toBe(true)
    const row = (first.outcome as { value: { id: string; title: string } }).value
    expect(row.title).toBe('Dune')
    // ctx.uuid → crypto.randomUUID：v4
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first.logs).toEqual(['adding Dune'])

    const list = await call(t, 'listBooks')
    expect(list).toMatchObject({ outcome: { ok: true, value: ['Dune'] }, wrote: false })

    const again = await call(t, 'addBook', { title: 'Dune' })
    expect(again.outcome).toEqual({ ok: true, value: { id: row.id, title: 'Dune' } })
    expect(await titles(t)).toEqual(['Dune'])
  }, 30_000)

  it('H-2 读操作写不了：run / RETURNING / WITH / UPDATE / DELETE / REPLACE', async () => {
    const t = await freshLibrary('h2-shelf')
    await value(t, 'addBook', { title: 'keep' })

    const viaRun = await call(t, 'readInsertRun')
    expect(errorOf(viaRun).message).toContain(READ_ONLY_MSG)
    expect(viaRun.wrote).toBe(false)

    for (const sql of [
      "INSERT INTO books(id, title) VALUES ('r', 'returning') RETURNING *",
      "WITH x AS (SELECT 1) INSERT INTO books(id, title) VALUES ('w', 'with')",
      "UPDATE books SET title = 'changed'",
      'DELETE FROM books',
      "REPLACE INTO books(id, title) VALUES ('p', 'replace')"
    ]) {
      const r = await call(t, 'readQuery', { sql })
      expect(errorOf(r).message, sql).toContain(READ_ONLY_MSG)
      expect(r.wrote, sql).toBe(false)
    }
    expect(await titles(t)).toEqual(['keep'])
  }, 30_000)

  it('H-3 模式来自请求：op.write 以 read 发来 → INSERT 被拒；读操作开事务被拒', async () => {
    const t = await freshLibrary('h3-shelf')

    const asRead = await call(t, 'addBook', { title: 'sneaky' }, { mode: 'read' })
    expect(errorOf(asRead).message).toContain(READ_ONLY_MSG)
    expect(asRead.wrote).toBe(false)
    expect(await titles(t)).toEqual([])

    const tx = await call(t, 'readTx')
    expect(errorOf(tx).message).toContain('Transactions are only for write operations.')
  }, 30_000)

  it('H-4 写操作碰不到别的文件、改不了连接设置、改不了结构', async () => {
    const other = await freshLibrary('h4-other')
    await applySchema(
      other,
      "CREATE TABLE secrets(v TEXT); INSERT INTO secrets VALUES ('TOP-SECRET')"
    )
    const t = await freshLibrary('h4-shelf')
    await value(t, 'addBook', { title: 'mine' })

    const newFile = join(tmp, 'h4-new.sqlite')
    const copy = join(tmp, 'h4-copy.sqlite')
    const statements = [
      `ATTACH DATABASE '${other.dbPath}' AS o`,
      `ATTACH '${newFile}' AS n`,
      `VACUUM INTO '${copy}'`,
      'PRAGMA writable_schema=ON',
      'PRAGMA journal_mode=DELETE',
      "SELECT load_extension('/x')",
      'SELECT "load_extension"(\'/x\')',
      'SELECT * FROM pragma_database_list',
      'CREATE TABLE extra(x)',
      'DROP TABLE books',
      'BEGIN',
      'SAVEPOINT s1'
    ]
    for (const sql of statements) {
      const r = await call(t, 'writeQuery', { sql })
      const err = errorOf(r)
      expect(err.message, sql).not.toContain('TOP-SECRET')
      expect(JSON.stringify(r), sql).not.toContain('TOP-SECRET')
    }
    // 守卫挡下的给了说法；加引号的 load_extension 过了守卫，由 SQLite 自己拒绝（扩展加载是关着的）
    const quoted = await call(t, 'writeQuery', { sql: 'SELECT "load_extension"(\'/x\')' })
    expect(errorOf(quoted).message).toMatch(/not authorized/i)
    const attach = await call(t, 'writeQuery', { sql: `ATTACH '${newFile}' AS n` })
    expect(errorOf(attach).message).toContain('(got ATTACH)')

    expect(existsSync(newFile)).toBe(false)
    expect(existsSync(copy)).toBe(false)
    expect(await titles(t)).toEqual(['mine'])
    expect(await queryText(t, "SELECT name FROM sqlite_master WHERE name = 'extra'")).toBe(
      '(0 rows)'
    )
    expect(await queryText(t, 'SELECT * FROM pragma_journal_mode')).toContain(' wal ')
    // 别的组件的库没被动过
    expect(await queryText(other, 'SELECT v FROM secrets')).toContain('TOP-SECRET')
  }, 30_000)

  it('H-5 读操作把参数拼进 SQL：ATTACH / 第二条语句被拒，UNION 只看得到自己的库', async () => {
    const other = await freshLibrary('h5-other')
    await applySchema(other, 'CREATE TABLE secrets(v TEXT)')
    const t = await freshLibrary('h5-shelf')
    await value(t, 'addBook', { title: 'one' })
    await value(t, 'addBook', { title: 'two' })

    const pfile = join(tmp, 'h5-p.sqlite')
    const attach = await call(t, 'findByName', {
      name: `x'; ATTACH DATABASE '${pfile}' AS p; --`
    })
    expect(errorOf(attach).message).toContain('cannot use ATTACH')
    expect(existsSync(pfile)).toBe(false)

    const del = await call(t, 'findByName', { name: "x'; DELETE FROM books; --" })
    expect(errorOf(del).message).toMatch(/more than one statement/i)
    expect(await titles(t)).toEqual(['one', 'two'])

    // 钉住：UNION 注入能跑 —— 但 sqlite_master 只是自己这个文件的
    const union = await call(t, 'findByName', {
      name: "x' UNION SELECT name FROM sqlite_master --"
    })
    expect(union.outcome.ok).toBe(true)
    const names = ((union.outcome as { value: { title: string }[] }).value ?? []).map(
      (r) => r.title
    )
    expect(names).toContain('books')
    expect(names).not.toContain('secrets')
    expect(union.wrote).toBe(false)
  }, 30_000)

  it('H-7 写操作 `SELECT 1; DELETE FROM books` → 拒绝，行都在', async () => {
    const t = await freshLibrary('h7-shelf')
    await value(t, 'addBook', { title: 'stay' })

    const r = await call(t, 'writeQuery', { sql: 'SELECT 1; DELETE FROM books' })
    expect(errorOf(r).message).toMatch(/more than one statement/i)
    expect(await titles(t)).toEqual(['stay'])
  }, 30_000)

  it('H-8 事务：一起提交；回调抛错全回滚；里层抛错外层接住', async () => {
    const t = await freshLibrary('h8-shelf')

    const committed = await call(t, 'addTwo', { a: 'a1', b: 'b1' })
    expect(committed.outcome).toEqual({ ok: true, value: 'committed' })
    // 事务提交了：算写过（推 data 事件）
    expect(committed.wrote).toBe(true)
    expect(await titles(t)).toEqual(['a1', 'b1'])

    const failed = await call(t, 'addTwo', { a: 'a2', b: 'b2', fail: true })
    expect(errorOf(failed)).toEqual({ code: 'internal', message: 'boom after two inserts' })
    // 事务里的写全回滚了：不算写过
    expect(failed.wrote).toBe(false)
    expect(await titles(t)).toEqual(['a1', 'b1'])

    expect(await value(t, 'nested', { outer: 'outer', inner: 'inner' })).toBe('inner boom')
    expect(await titles(t)).toEqual(['a1', 'b1', 'outer'])
  }, 30_000)

  it('H-9 一个 handler 里并发两个 tx：A 落库，B 立刻被拒', async () => {
    const t = await freshLibrary('h9-shelf')

    const settled = await value(t, 'concurrentTx', { a: 'A', b: 'B' })
    expect(settled).toEqual([
      { status: 'fulfilled', value: 'a' },
      {
        status: 'rejected',
        reason: expect.stringContaining('Another ctx.db.tx is still running here')
      }
    ])
    expect(await titles(t)).toEqual(['A'])
  }, 30_000)

  it.each([
    ['txSpin', 'timeout'],
    ['txHang', 'internal']
  ])(
    'H-10 %s：tx 里的 VM 失败（%s）之后保存点回滚，之后的写照常提交',
    async (op, code) => {
      const t = await freshLibrary(`h10-${op.toLowerCase()}`)

      const stuck = await host.request(callRequest(t, op, { title: 'X' }, { cpuMs: 300 }))
      expect(stuck.ok).toBe(false)
      expect((stuck as { error: { code: string } }).error.code).toBe(code)
      if (code === 'internal') {
        expect((stuck as { error: { message: string } }).error.message).toContain('never finished')
      }

      // 之后的写提交得了，读操作看得到
      expect(await value(t, 'addBook', { title: 'Y' })).toMatchObject({ title: 'Y' })
      expect(await titles(t)).toEqual(['Y'])
      // 读写连接上没有残留的保存点：装结构照常
      expect(await applySchema(t, 'CREATE TABLE IF NOT EXISTS later(x)')).toMatchObject({
        ok: true
      })

      // 关掉连接再重开：Y 在磁盘上，X 不在
      expect(await host.request({ type: 'forget', widgetId: t.widgetId })).toMatchObject({
        ok: true,
        result: null
      })
      expect(await titles(t)).toEqual(['Y'])
    },
    30_000
  )

  it('H-11 绕过 ctx.db.tx 直接开的事务：调用结束时回滚并报错，之后照常提交', async () => {
    const bundle = await writeBundle(`
import { defineApi, op, z } from 'shuvix/widget-api'
const h = (globalThis as any).__host
export default defineApi({
  sneak: op.write({
    description: 'Open a transaction behind ctx.db.tx.',
    input: z.object({}),
    handler: async (_a, ctx) => {
      h.tx('begin')
      await ctx.db.query("INSERT INTO books(id, title) VALUES ('s', 'sneaky')")
      return 'done'
    }
  }),
  add: op.write({
    description: 'Plain insert.',
    input: z.object({ title: z.string() }),
    handler: (a, ctx) => ctx.db.query('INSERT INTO books(id, title) VALUES (?, ?)', [a.title, a.title])
  })
})
`)
    const t = await freshLibrary('h11-shelf')

    const r = await call(t, 'sneak', {}, { bundle, mode: 'write' })
    expect(errorOf(r)).toEqual({
      code: 'internal',
      message: 'The operation left a transaction open; it was rolled back.'
    })
    // 写在被回滚的保存点里：不算写过，界面不该收到 data 事件
    expect(r.wrote).toBe(false)
    expect(await titles(t)).toEqual([])

    expect((await call(t, 'add', { title: 'after' }, { bundle, mode: 'write' })).outcome.ok).toBe(
      true
    )
    expect(await titles(t)).toEqual(['after'])
  }, 30_000)

  it('H-12 dry run：写了又回滚；事务、失败、超时都不留东西；读操作照常', async () => {
    const t = await freshLibrary('h12-shelf')

    const dry = await call(t, 'addBook', { title: 'ghost' }, { dryRun: true })
    expect(dry.outcome).toMatchObject({ ok: true, value: { title: 'ghost' } })
    expect(dry.wrote).toBe(false)
    expect(await titles(t)).toEqual([])

    const dryTx = await call(t, 'addInTx', { title: 'ghost-tx' }, { dryRun: true })
    expect(dryTx.outcome).toMatchObject({ ok: true, value: { title: 'ghost-tx' } })
    expect(dryTx.wrote).toBe(false)
    expect(await titles(t)).toEqual([])

    const dryFail = await call(t, 'insertThenFail', { title: 'ghost-fail' }, { dryRun: true })
    expect(errorOf(dryFail).code).toBe('refused')
    expect(dryFail.wrote).toBe(false)
    expect(await titles(t)).toEqual([])

    const dryTimeout = await host.request(
      callRequest(t, 'insertThenSpin', { title: 'ghost-spin' }, { dryRun: true, cpuMs: 300 })
    )
    expect(dryTimeout).toMatchObject({ ok: false, error: { code: 'timeout' } })
    expect(await titles(t)).toEqual([])

    // 之后真的写照常提交
    expect(await value(t, 'addBook', { title: 'real' })).toMatchObject({ title: 'real' })
    expect(await titles(t)).toEqual(['real'])

    // 读操作的 dry run：正常结果
    const dryRead = await call(t, 'listBooks', {}, { dryRun: true })
    expect(dryRead).toMatchObject({ outcome: { ok: true, value: ['real'] }, wrote: false })
  }, 30_000)

  it('H-13 写操作插入后 ctx.fail：行留着（逐条自动提交）、wrote:true；读操作 wrote:false', async () => {
    const t = await freshLibrary('h13-shelf')

    const r = await call(t, 'insertThenFail', { title: 'persisted' })
    expect(errorOf(r)).toEqual({ code: 'refused', message: 'refused after the insert' })
    expect(r.wrote).toBe(true)
    expect(await titles(t)).toEqual(['persisted'])

    const read = await call(t, 'listBooks')
    expect(read.wrote).toBe(false)
    const failedRead = await call(t, 'readQuery', { sql: 'SELECT nope FROM books' })
    expect(failedRead.outcome.ok).toBe(false)
    expect(failedRead.wrote).toBe(false)
  }, 30_000)

  it('H-14 值的转换：BLOB → base64，布尔 → 0/1，对象 → JSON 文本', async () => {
    const t = await freshLibrary('h14-shelf')
    expect(await value(t, 'values')).toEqual([
      { b: Buffer.from('Hello').toString('base64'), t: 1, f: 0, o: '{"a":1}' }
    ])
  }, 30_000)

  it('H-15 外键冲突被拒；写过之后有 -wal；dbPath 的上级目录第一次用时建出来', async () => {
    const t = targetOf('h15-shelf')
    expect(existsSync(join(tmp, 'data', 'h15-shelf'))).toBe(false)
    expect(
      await applySchema(
        t,
        BOOKS_DDL +
          '; CREATE TABLE loans(id INTEGER PRIMARY KEY, book TEXT NOT NULL REFERENCES books(id))'
      )
    ).toMatchObject({ ok: true })
    expect(existsSync(join(tmp, 'data', 'h15-shelf'))).toBe(true)

    const fk = await call(t, 'writeQuery', { sql: "INSERT INTO loans(book) VALUES ('missing')" })
    expect(errorOf(fk).message).toMatch(/FOREIGN KEY constraint failed/)
    expect(await queryText(t, 'SELECT count(*) AS n FROM loans')).toContain(' 0 ')

    await value(t, 'addBook', { title: 'wal' })
    expect(existsSync(t.dbPath + '-wal')).toBe(true)
  }, 30_000)

  it('H-16 多条语句的脚本（装结构）：FTS5 trigram、原子性、禁用词、重跑无害、自带 BEGIN/COMMIT（钉住）', async () => {
    const t = targetOf('h16-shelf')
    const ddl = [
      BOOKS_DDL.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'),
      'CREATE INDEX IF NOT EXISTS books_title ON books(title)',
      "CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(body, tokenize='trigram')"
    ].join(';\n')
    expect(await applySchema(t, ddl)).toMatchObject({ ok: true, result: { output: 'OK' } })
    await queryText(t, "INSERT INTO notes(body) VALUES ('the quick brown fox')")
    expect(await queryText(t, "SELECT body FROM notes WHERE notes MATCH 'uic'")).toContain(
      'the quick brown fox'
    )

    // 第二条失败 → 第一条也没生效
    const broken = await applySchema(t, 'CREATE TABLE a1(x); CREATE TABLE a1(y)')
    expect(broken).toMatchObject({ ok: false, error: { code: 'query_failed' } })
    expect(await queryText(t, "SELECT name FROM sqlite_master WHERE name = 'a1'")).toBe('(0 rows)')

    const refused = await applySchema(
      t,
      `CREATE TABLE b1(x); ATTACH '${join(tmp, 'h16.sqlite')}' AS q`
    )
    expect(refused).toMatchObject({ ok: false, error: { code: 'sql_refused' } })
    expect(existsSync(join(tmp, 'h16.sqlite'))).toBe(false)
    expect(await queryText(t, "SELECT name FROM sqlite_master WHERE name = 'b1'")).toBe('(0 rows)')

    // 重跑同一份（IF NOT EXISTS）无害，数据还在
    expect(await applySchema(t, ddl)).toMatchObject({ ok: true })
    expect(await queryText(t, 'SELECT count(*) AS n FROM notes')).toContain(' 1 ')

    // 钉住：脚本自带事务 → 套在宿主的 BEGIN IMMEDIATE 里会失败
    const ownTx = await applySchema(t, 'BEGIN; CREATE TABLE c1(x); COMMIT;')
    expect(ownTx).toMatchObject({ ok: false, error: { code: 'query_failed' } })
    expect(await queryText(t, "SELECT name FROM sqlite_master WHERE name = 'c1'")).toBe('(0 rows)')
  }, 30_000)

  it('H-17 query：表格、改了几行、多条语句、禁用词、pragma_table_info、语法错', async () => {
    const t = await freshLibrary('h17-shelf')
    await value(t, 'addBook', { title: 'a' })
    await value(t, 'addBook', { title: 'b' })

    const table = await queryText(t, 'SELECT title FROM books ORDER BY title')
    expect(table.split('\n')).toEqual([' title ', '-------', ' a     ', ' b     ', '(2 rows)'])
    expect(await queryText(t, "SELECT title FROM books WHERE title = 'a'")).toMatch(/\(1 row\)$/)
    expect(await queryText(t, "SELECT title FROM books WHERE title = 'zzz'")).toBe('(0 rows)')

    expect(await queryText(t, "UPDATE books SET title = title || '!'")).toBe('OK (2 rows changed)')
    expect(
      await queryText(
        t,
        "INSERT INTO books(id, title) VALUES ('m1', 'm1'); INSERT INTO books(id, title) VALUES ('m2', 'm2')"
      )
    ).toBe('OK')
    expect(await titles(t)).toEqual(['a!', 'b!', 'm1', 'm2'])

    for (const sql of [
      `ATTACH '${join(tmp, 'h17-a.sqlite')}' AS a`,
      `VACUUM INTO '${join(tmp, 'h17-v.sqlite')}'`,
      'PRAGMA journal_mode=DELETE'
    ]) {
      expect(await query(t, sql), sql).toMatchObject({ ok: false, error: { code: 'sql_refused' } })
    }
    expect(existsSync(join(tmp, 'h17-a.sqlite'))).toBe(false)
    expect(existsSync(join(tmp, 'h17-v.sqlite'))).toBe(false)

    const info = await queryText(t, "SELECT name FROM pragma_table_info('books')")
    expect(info).toContain(' id ')
    expect(info).toContain(' title ')

    expect(await query(t, 'SELEKT nonsense')).toMatchObject({
      ok: false,
      error: { code: 'query_failed' }
    })
  }, 30_000)

  it('H-18 两个组件互相隔离；连发两次调用按顺序落定', async () => {
    const a = await freshLibrary('h18-alpha')
    const b = await freshLibrary('h18-beta')
    expect(a.dbPath).not.toBe(b.dbPath)
    await value(a, 'addBook', { title: 'only in alpha' })
    await value(b, 'addBook', { title: 'only in beta' })
    expect(await titles(a)).toEqual(['only in alpha'])
    expect(await titles(b)).toEqual(['only in beta'])

    const order: number[] = []
    const first = call(a, 'count').then((r) => {
      order.push(1)
      return r
    })
    const second = call(a, 'count').then((r) => {
      order.push(2)
      return r
    })
    const [r1, r2] = await Promise.all([first, second])
    expect(order).toEqual([1, 2])
    const v1 = (r1.outcome as { value: number }).value
    expect((r2.outcome as { value: number }).value).toBe(v1 + 1)
  }, 30_000)

  // ─── sql 的脚本与事务（WC-S1..S7） ───

  /** 一个失败的 query 的错误（必须失败） */
  const queryError = (res: HostResponse): { code: string; message: string } => {
    expect(res.ok).toBe(false)
    return (res as { ok: false; error: { code: string; message: string } }).error
  }

  /** 表在不在 */
  const hasTable = async (t: WidgetHostTarget, name: string): Promise<boolean> =>
    !(
      (await queryText(
        t,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${name}'`
      )) === '(0 rows)'
    )

  /** 读写连接没有停在事务里：写操作提交了（读连接看得到），下一段脚本照常开得了事务 */
  async function expectConnectionClean(t: WidgetHostTarget, title: string): Promise<void> {
    const w = await call(t, 'addBook', { title })
    expect(w.wrote).toBe(true)
    expect(await titles(t)).toContain(title)
    expect(
      await query(
        t,
        `CREATE TABLE IF NOT EXISTS probe_${title}(x); CREATE INDEX IF NOT EXISTS probe_${title}_x ON probe_${title}(x)`
      )
    ).toMatchObject({ ok: true, result: { output: 'OK' } })
  }

  it('WC-S1 迁移脚本（建新表、搬行、删旧表、改名）→ OK；行带过去，操作照常', async () => {
    const t = await freshLibrary('wcs1-shelf')
    await value(t, 'addBook', { title: 'Dune' })
    await value(t, 'addBook', { title: 'Emma' })

    const script = [
      'CREATE TABLE books2(id TEXT PRIMARY KEY, title TEXT NOT NULL UNIQUE, note TEXT)',
      "INSERT INTO books2(id, title, note) SELECT id, title, 'moved' FROM books",
      'DROP TABLE books',
      'ALTER TABLE books2 RENAME TO books'
    ].join(';\n')
    expect(await query(t, script)).toMatchObject({ ok: true, result: { output: 'OK' } })

    expect(await titles(t)).toEqual(['Dune', 'Emma'])
    expect(await queryText(t, "SELECT count(*) AS n FROM books WHERE note = 'moved'")).toContain(
      ' 2 '
    )
    expect(await hasTable(t, 'books2')).toBe(false)
  }, 30_000)

  it('WC-S2 / WC-S3 DML + DDL + 失败的一句 → 全部回滚、报 SQLite 的错；之后写、读、下一段脚本都照常', async () => {
    const t = await freshLibrary('wcs2-shelf')
    await value(t, 'addBook', { title: 'keep' })

    const res = await query(
      t,
      "INSERT INTO books(id, title) VALUES ('s2', 'inserted'); ALTER TABLE books ADD COLUMN x TEXT; INSERT INTO nope VALUES (1)"
    )
    const err = queryError(res)
    expect(err.code).toBe('query_failed')
    expect(err.message).toMatch(/no such table: nope/)
    expect(await titles(t)).toEqual(['keep'])
    const cols = await queryText(t, "SELECT name FROM pragma_table_info('books')")
    expect(cols).toContain(' title ')
    expect(cols).not.toMatch(/^ x\s*$/m)

    // WC-S3：失败之后连接干净
    await expectConnectionClean(t, 'after')
    expect(await titles(t)).toEqual(['after', 'keep'])
  }, 30_000)

  it('WC-S4 成功的脚本之后：写操作提交、读操作看得到（连接回到自动提交）', async () => {
    const t = await freshLibrary('wcs4-shelf')
    expect(await query(t, 'CREATE TABLE s4a(x); CREATE TABLE s4b(y)')).toMatchObject({
      ok: true,
      result: { output: 'OK' }
    })
    await expectConnectionClean(t, 'seen')
  }, 30_000)

  it('WC-S5 单条语句照旧：`INSERT …`、`INSERT …;`、`INSERT …; -- done` 都是「OK (1 row changed)」', async () => {
    const t = await freshLibrary('wcs5-shelf')
    for (const [i, tail] of ['', ';', '; -- done', '; /* done */'].entries()) {
      expect(
        await queryText(t, `INSERT INTO books(id, title) VALUES ('s5-${i}', 's5-${i}')${tail}`),
        tail
      ).toBe('OK (1 row changed)')
    }
    expect(await titles(t)).toEqual(['s5-0', 's5-1', 's5-2', 's5-3'])
  }, 30_000)

  it('WC-S6 脚本自己中途结束事务（COMMIT / END / ROLLBACK）→ query_failed 说清楚；连接不留在事务里', async () => {
    const t = await freshLibrary('wcs6-shelf')
    const partway = 'The script ended its own transaction partway'
    const refusal = 'Do not write transaction statements in sql'

    // COMMIT：之前的已经提交，之后的在自动提交里跑了（钉住：报错说「可能已经生效」）
    const commit = queryError(await query(t, 'CREATE TABLE m1(x); COMMIT; CREATE TABLE m2(y)'))
    expect(commit.code).toBe('query_failed')
    expect(commit.message).toContain(partway)
    expect(commit.message).toContain(refusal)
    expect(await hasTable(t, 'm1')).toBe(true)
    expect(await hasTable(t, 'm2')).toBe(true)

    // END 与 COMMIT 同义
    const end = queryError(await query(t, 'CREATE TABLE e1(x); END'))
    expect(end.message).toContain(partway)
    expect(await hasTable(t, 'e1')).toBe(true)

    // ROLLBACK：之前的回滚了，之后的生效了
    const rollback = queryError(await query(t, 'CREATE TABLE r1(x); ROLLBACK; CREATE TABLE r2(y)'))
    expect(rollback.message).toContain(partway)
    expect(await hasTable(t, 'r1')).toBe(false)
    expect(await hasTable(t, 'r2')).toBe(true)

    // 自己 COMMIT 之后再失败 → SQLite 的错，再加一句「中途结束、之前的可能已经生效」；COMMIT 之前的留着
    const late = queryError(await query(t, 'CREATE TABLE m3(x); COMMIT; CREATE TABLE m3(y)'))
    expect(late.code).toBe('query_failed')
    expect(late.message).toMatch(/table m3 already exists/)
    expect(late.message).toContain(partway)
    expect(await hasTable(t, 'm3')).toBe(true)

    // 结束之后又自己 BEGIN、留着开着的事务 → 宿主照样提交
    expect(await query(t, 'CREATE TABLE z1(x); COMMIT; BEGIN; CREATE TABLE z2(x)')).toMatchObject({
      ok: true,
      result: { output: 'OK' }
    })
    expect(await hasTable(t, 'z1')).toBe(true)
    expect(await hasTable(t, 'z2')).toBe(true)

    // 触发器的 BEGIN … END 不算事务语句
    expect(
      await query(
        t,
        "CREATE TABLE t1(a TEXT); CREATE TRIGGER t1_ai AFTER INSERT ON t1 BEGIN INSERT INTO books(id, title) VALUES ('trig-' || NEW.a, 'trig-' || NEW.a); END; INSERT INTO t1 VALUES ('x')"
      )
    ).toMatchObject({ ok: true, result: { output: 'OK' } })
    expect(await titles(t)).toEqual(['trig-x'])

    await expectConnectionClean(t, 'clean')
  }, 30_000)

  it.each([
    'BEGIN',
    'BEGIN IMMEDIATE',
    'begin transaction;',
    'COMMIT',
    'END',
    'ROLLBACK',
    'SAVEPOINT sp',
    'RELEASE sp',
    '-- open one\nBEGIN',
    '  /* c */ BEGIN;'
  ])(
    'WC-S7 单独一条事务语句 %j → query_failed、不进事务；之后写、读、脚本照常',
    async (sql) => {
      const id = `wcs7-${sql
        .replace(/[^a-z]+/gi, '-')
        .toLowerCase()
        .replace(/^-|-$/g, '')}`
      const t = await freshLibrary(id)

      const err = queryError(await query(t, sql))
      expect(err.code).toBe('query_failed')
      expect(err.message.startsWith('Do not write transaction statements in sql')).toBe(true)

      await expectConnectionClean(t, 'committed')
      expect(await titles(t)).toEqual(['committed'])
    },
    30_000
  )

  // 最后一条：会关掉共用的宿主
  it('H-19 ready 在先；没有数字 id 的消息被忽略；disconnect → 以 0 退出', async () => {
    expect(host.messages[0]).toEqual({ ready: true })
    const t = await freshLibrary('h19-shelf')

    const before = host.messages.length
    host.sendRaw({ type: 'forget', widgetId: t.widgetId })
    host.sendRaw({ id: 'x', type: 'query', target: t, sql: 'SELECT 1' })
    host.sendRaw('hello')
    expect(await queryText(t, 'SELECT 1 AS one')).toContain(' 1 ')
    // 只多了这一条 query 的应答
    expect(host.messages.length).toBe(before + 1)

    await host.stop()
    expect(await host.exited).toEqual([0, null])
  }, 30_000)
})
