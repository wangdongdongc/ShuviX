/**
 * 内置能力服务器 `database` 的连接池（`dbConnections.ts`）—— 对着**真的 PostgreSQL** 看它。
 *
 * PostgreSQL 一侧是 PGlite 经 TCP 桥（`pgliteBridge.ts`）接出来的真服务端，驱动是应用自己的 `pg`：
 * 只读到底靠不靠得住、一次是不是恰好一条语句、结果文本长什么样，这些都是**服务端**答的问题，
 * 换成假驱动就只剩在测假驱动。「SQL 到没到服务端」一律看桥的日志（`Q` 与扩展协议的 `P` 都记），
 * 不看连接池自己的回报。
 *
 * MySQL 没有能进测试进程的真服务端，于是走 spy：`dbConnections.ts` 用 `require` 取驱动，
 * `vi.mock('mysql2/promise')` 碰不到它；同一份 CommonJS 实例经 `createRequire` 取到，再
 * `vi.spyOn` 它的 `createConnection`。空闲超时与「只读标志下发失败」这类要精确控制驱动行为的
 * 用例，对 `pg.Client.prototype` 也这么做（配假时钟）。
 *
 * 钉的是：
 *   DBC-1…3    懒连接、同会话复用、会话之间互不相干；
 *   DBC-4      只读 PostgreSQL：建连下发的会话标志 + 每条语句一个只读事务；友好的前置拦截
 *              （跳过开头的注释）；拦不住的写语句由服务端拒绝；各种「改回可写」的手法都无效；
 *   DBC-5      只读 MySQL：同样的包装由驱动调用序列看；
 *   DBC-6…7    结果文本：表格、行数、写语句的影响行数、一次一条、截断；
 *   DBC-8      空闲超时；DBC-9…10 建连失败；DBC-11 状态条；DBC-12 测试连接；
 *   DBC-13…16  并发首查询只建一次连接、凭据改了只读位要重连、设置里改删凭据断开、报错抹掉凭据内容。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type { DbCredential } from '../../../dao/types'
import { startPgliteBridge, type PgliteBridge } from './pgliteBridge'

const logged = vi.hoisted(() => ({ lines: [] as string[] }))
/** 设置里保存的连接（DAO 的真形状：findByName 回解密后的整行，findAllNamesWithType 只回三列） */
const store = vi.hoisted(() => ({ creds: [] as DbCredential[] }))

vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: (m: string) => void logged.lines.push(`info ${m}`),
    warn: (m: string) => void logged.lines.push(`warn ${m}`),
    error: (m: string) => void logged.lines.push(`error ${m}`)
  })
}))
// better-sqlite3 是为 Electron 编译的，vitest 的 Node 进程加载不了 —— DAO 一律换成读 store 的假件
vi.mock('../../../dao/dbCredentialDao', () => ({
  dbCredentialDao: {
    findByName: (name: string) => store.creds.find((c) => c.name === name),
    findAllNamesWithType: () =>
      store.creds.map(({ name, dbType, readonly }) => ({ name, dbType, readonly }))
  }
}))

import { DbManager } from '../dbConnections'

// 与 dbConnections.ts 里 `require('pg')` / `require('mysql2/promise')` 是同一份 CommonJS 实例
const requireDriver = createRequire(import.meta.url)
const pg = requireDriver('pg') as typeof import('pg')
const mysql = requireDriver('mysql2/promise') as typeof import('mysql2/promise')

const READ_ONLY_REFUSAL =
  'Write operations are not allowed. This connection is in readonly mode. Only SELECT and read-only statements are permitted.'
const ONE_STATEMENT =
  'Run one statement per query — this SQL contains several. Split it into separate query calls.'

// ─── 素材 ────────────────────────────────────────────────────────────────

/** 一条已保存的连接（凭据内容刻意取可辨认的值：报错里有没有漏出来一眼看得见） */
function cred(name: string, over: Partial<DbCredential> = {}): DbCredential {
  return {
    id: `id-${name}`,
    name,
    dbType: 'postgresql',
    host: '127.0.0.1',
    port: 5432,
    username: 'alice',
    password: 'hunter2-secret',
    database: 'hrdb',
    authType: 'password',
    token: '',
    connStr: '',
    readonly: true,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function save(...creds: DbCredential[]): void {
  store.creds.push(...creds)
}

/** 轮询直到条件成立（socket 的关闭在对端是异步落定的） */
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** 这条用例建的连接池，以及它碰过的会话 —— afterEach 据此把连接全部关掉（关桥之前必须先关） */
let mgr: DbManager
const sessions = new Set<string>()

/** connectAndQuery，失败时回 `THREW: <message>`（用例多半要逐字比对那句话） */
async function q(
  sid: string,
  name: string,
  sql: string,
  expectMode?: { readonly: boolean }
): Promise<string> {
  sessions.add(sid)
  try {
    return await mgr.connectAndQuery(sid, name, sql, expectMode)
  } catch (e) {
    return `THREW: ${e instanceof Error ? e.message : String(e)}`
  }
}

beforeEach(() => {
  mgr = new DbManager()
  sessions.clear()
  store.creds.length = 0
  logged.lines.length = 0
})

afterEach(async () => {
  vi.useRealTimers()
  // 先关连接、再还原 spy：spy 用例里的连接是被 spy 过的 pg.Client，关它要走假的 end()
  await Promise.all([...sessions].map((s) => mgr.disconnect(s)))
  vi.restoreAllMocks()
  // 下一条用例从「桥上一条连接都没有」开始 —— 数 open 的断言才不会被上一条的收尾打扰
  await until(() => [ro, rw, flip].every((b) => !b || b.log.open === 0), 'bridge sockets to close')
})

// ─── 真 PostgreSQL（PGlite 桥）─────────────────────────────────────────────
//
// PGlite 是单会话：同一座桥上所有连接共用一个后端会话，只读连接建连时下发的
// `default_transaction_read_only = on` 在它断开之后仍留在那个会话里。所以只读与可写各用一座桥，
// 而「可写连接中途改成只读」那一组单独一座（它会把桥的会话变成只读）。

let ro: PgliteBridge
let rw: PgliteBridge
let flip: PgliteBridge

beforeAll(async () => {
  ;[ro, rw, flip] = await Promise.all([
    startPgliteBridge(),
    startPgliteBridge(),
    startPgliteBridge()
  ])
  // 播种必须在任何只读连接连上之前（之后这个会话就是只读的了）
  await ro.db.exec(
    `CREATE TABLE users (id int, name text); INSERT INTO users VALUES (1, 'a'), (2, NULL);`
  )
  await flip.db.exec('CREATE TABLE items (x int);')
}, 60_000)

afterAll(async () => {
  await Promise.all([ro?.close(), rw?.close(), flip?.close()])
})

const roCred = (over: Partial<DbCredential> = {}): DbCredential =>
  cred('ro', { port: ro.port, readonly: true, ...over })
const rwCred = (over: Partial<DbCredential> = {}): DbCredential =>
  cred('rw', { port: rw.port, readonly: false, ...over })

/** 桥日志里从 mark 起新收到的语句 */
const since = (bridge: PgliteBridge, mark: number): string[] => bridge.log.queries.slice(mark)

/** 直接问 PGlite（与桥同一个会话；只做读） */
async function scalar(bridge: PgliteBridge, sql: string): Promise<unknown> {
  const r = await bridge.db.query<Record<string, unknown>>(sql)
  return Object.values(r.rows[0] ?? {})[0]
}

describe('连接的寿命：懒连接、复用、按会话隔离', () => {
  it('DBC-1 第一次查询之前一条 TCP 连接都不开，connectedNames 为空', async () => {
    save(roCred())
    const before = ro.log.connections

    expect(mgr.connectedNames('s1')).toEqual([])
    expect(mgr.isConnected('s1')).toBe(false)
    expect(mgr.runtimeStatus('s1')).toBeUndefined()
    // 构造连接池、甚至查询别的会话的状态都不该碰网络
    expect(ro.log.connections).toBe(before)

    await q('s1', 'ro', 'SELECT 1 AS a')
    expect(ro.log.connections).toBe(before + 1)
  })

  it('DBC-2 同一会话连续两次查询只开一条连接', async () => {
    save(rwCred())
    const before = rw.log.connections

    expect(await q('s1', 'rw', 'SELECT 1 AS a')).toContain('(1 row)')
    expect(await q('s1', 'rw', 'SELECT 2 AS b')).toContain('(1 row)')

    expect(rw.log.connections).toBe(before + 1)
    expect(mgr.connectedNames('s1')).toEqual(['rw'])
  })

  it('DBC-3 另一个会话有自己的连接；断开 s1 只关 s1 的那条，s2 照查、不重连', async () => {
    save(rwCred())
    const before = rw.log.connections
    await q('s1', 'rw', 'SELECT 1 AS a')
    await q('s2', 'rw', 'SELECT 1 AS a')
    expect(rw.log.connections).toBe(before + 2)
    const open = rw.log.open

    await mgr.disconnect('s1')
    await until(() => rw.log.open === open - 1, 's1 的 socket 关闭')
    expect(mgr.connectedNames('s1')).toEqual([])
    expect(mgr.connectedNames('s2')).toEqual(['rw'])

    expect(await q('s2', 'rw', 'SELECT 3 AS c')).toContain('| 3 |')
    expect(rw.log.connections).toBe(before + 2)
  })
})

describe('只读 PostgreSQL：会话标志 + 每条语句一个只读事务', () => {
  it('DBC-4a 连上后第一条是会话级只读标志；之后每条语句都包在 BEGIN READ ONLY … ROLLBACK 里（语句走扩展协议）', async () => {
    save(roCred())
    const mark = ro.log.queries.length
    const connectionsBefore = ro.log.connections

    const out = await q('s1', 'ro', 'SELECT count(*)::int AS n FROM users')
    expect(out).toContain('| 2 |')
    expect(ro.log.connections).toBe(connectionsBefore + 1)
    expect(since(ro, mark)).toEqual([
      'SET default_transaction_read_only = on',
      'BEGIN TRANSACTION READ ONLY',
      'SELECT count(*)::int AS n FROM users',
      'ROLLBACK'
    ])

    // 第二条不再下发会话标志，但照样包一层 —— 包装是每条语句的事，不是建连时的事
    const mark2 = ro.log.queries.length
    await q('s1', 'ro', 'SELECT 1 AS a')
    expect(since(ro, mark2)).toEqual(['BEGIN TRANSACTION READ ONLY', 'SELECT 1 AS a', 'ROLLBACK'])
  })

  it.each([
    'CREATE TABLE pwned (a int)',
    // 开头的注释与空白跳过之后再认关键词：注释不能把一条写语句伪装成「不认识」
    '/**/ CREATE TABLE pwned (a int)',
    '-- just a note\n  INSERT INTO users VALUES (9)',
    '  /* a */ /* b */ delete from users',
    'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
    'set global read_only = 0'
  ])('DBC-4b 前置拦截 %j：逐字那句友好的话，且语句根本没到服务端', async (sql) => {
    save(roCred())
    const mark = ro.log.queries.length

    expect(await q('s1', 'ro', sql)).toBe(`THREW: ${READ_ONLY_REFUSAL}`)
    expect(since(ro, mark)).not.toContain(sql)
    expect(await scalar(ro, 'SELECT count(*)::int FROM users')).toBe(2)
  })

  it('DBC-4c 前置正则认不出的写语句到了服务端，由只读事务拒绝 —— 用的是服务端自己的报错', async () => {
    save(roCred())
    const cte = 'WITH x AS (INSERT INTO users VALUES (9) RETURNING id) SELECT * FROM x'
    const doBlock = 'DO $$ BEGIN INSERT INTO users VALUES (10); END $$'
    const mark = ro.log.queries.length

    expect(await q('s1', 'ro', cte)).toBe('THREW: cannot execute SELECT in a read-only transaction')
    expect(await q('s1', 'ro', doBlock)).toBe(
      'THREW: cannot execute INSERT in a read-only transaction'
    )
    // 这回确实到了服务端 —— 拒绝它的是数据库，不是那条正则
    expect(since(ro, mark)).toEqual(expect.arrayContaining([cte, doBlock]))
    expect(await scalar(ro, 'SELECT count(*)::int FROM users')).toBe(2)
    // 查询失败之后连接照旧可用（ROLLBACK 把失败的事务收掉了）
    expect(await q('s1', 'ro', 'SELECT 1 AS a')).toContain('(1 row)')
  })

  it('DBC-4d 「改回可写」的手法一个都不管用：之后的写照样被服务端拒绝', async () => {
    save(roCred())

    // 每一条都在只读事务里跑、随后回滚 —— 能执行的也只改得了这一个事务
    expect(await q('s1', 'ro', 'SET default_transaction_read_only = off')).toBe('OK: SET')
    // 事务里第一条语句之前 PostgreSQL 允许把它改成读写 —— 可它就是这一条语句本身，随后即回滚
    expect(await q('s1', 'ro', 'SET transaction_read_only = off')).toBe('OK: SET')
    expect(
      await q('s1', 'ro', "SELECT set_config('default_transaction_read_only','off',false)")
    ).toContain('| off')
    expect(await q('s1', 'ro', 'COMMIT')).toBe('OK: COMMIT')
    expect(await q('s1', 'ro', 'BEGIN READ WRITE')).toBe('OK: BEGIN')
    // DO 块在显式事务块里不能 COMMIT —— 一条语句里「先提交、再写」走不通
    expect(
      await q(
        's1',
        'ro',
        "DO $$ BEGIN PERFORM set_config('default_transaction_read_only','off',false); COMMIT; INSERT INTO users VALUES (11); END $$"
      )
    ).toBe('THREW: invalid transaction termination')

    // 以上随便哪一条若真把会话改成了可写，下面这两条就会成功
    expect(
      await q('s1', 'ro', 'WITH x AS (INSERT INTO users VALUES (12) RETURNING id) SELECT * FROM x')
    ).toBe('THREW: cannot execute SELECT in a read-only transaction')
    expect(await q('s1', 'ro', 'DO $$ BEGIN CREATE TABLE pwned (a int); END $$')).toBe(
      'THREW: cannot execute CREATE TABLE in a read-only transaction'
    )
    expect(await scalar(ro, 'SELECT count(*)::int FROM users')).toBe(2)
    expect(await scalar(ro, "SELECT to_regclass('pwned')::text")).toBeNull()
    // 自始至终一条连接：没有「报错后重连成一条新的可写连接」这回事
    expect(mgr.connectedNames('s1')).toEqual(['ro'])
  })

  it('DBC-4e 只读连接上的 SELECT 照常出结果', async () => {
    save(roCred())
    expect(await q('s1', 'ro', 'SELECT name FROM users WHERE id = 1')).toBe(
      '+------+\n| name |\n+------+\n| a    |\n+------+\n(1 row)'
    )
  })
})

describe('结果文本（真 PostgreSQL）', () => {
  it('DBC-6a 表格逐字：列宽按最宽的值、NULL 印成 NULL、末行是行数', async () => {
    save(roCred())
    expect(await q('s1', 'ro', 'SELECT id, name FROM users ORDER BY id')).toBe(
      '+----+------+\n| id | name |\n+----+------+\n| 1  | a    |\n| 2  | NULL |\n+----+------+\n(2 rows)'
    )
  })

  it('DBC-6b 一行说 (1 row)，零行只说 (0 rows)（不印表头）', async () => {
    save(roCred())
    expect(await q('s1', 'ro', 'SELECT id FROM users WHERE id = 2')).toMatch(/\n\(1 row\)$/)
    expect(await q('s1', 'ro', 'SELECT id, name FROM users WHERE false')).toBe('(0 rows)')
  })

  it('DBC-6c 没有结果列的语句报「OK: <命令>, n row(s) affected」；没有行数的只报命令', async () => {
    save(rwCred())
    await rw.db.exec('CREATE TABLE r6c (x int)')

    expect(await q('s1', 'rw', 'INSERT INTO r6c VALUES (1), (2)')).toBe(
      'OK: INSERT, 2 rows affected'
    )
    expect(await q('s1', 'rw', 'UPDATE r6c SET x = x + 10 WHERE x = 1')).toBe(
      'OK: UPDATE, 1 row affected'
    )
    expect(await q('s1', 'rw', 'DELETE FROM r6c WHERE x < 0')).toBe('OK: DELETE, 0 rows affected')
    expect(await q('s1', 'rw', 'CREATE TABLE r6c_more (y int)')).toBe('OK: CREATE')
    expect(await q('s1', 'rw', 'SET search_path = public')).toBe('OK: SET')
    // 写语句带 RETURNING 就有结果列 —— 那是一张表，不是影响行数
    expect(await q('s1', 'rw', 'INSERT INTO r6c VALUES (7) RETURNING x')).toBe(
      '+---+\n| x |\n+---+\n| 7 |\n+---+\n(1 row)'
    )
    expect(await scalar(rw, 'SELECT count(*)::int FROM r6c')).toBe(3)
  })

  it('DBC-6d 一次恰好一条语句：多条语句被拒绝，一条都没执行（可写连接也一样）', async () => {
    save(rwCred())
    await rw.db.exec('CREATE TABLE r6d (x int); INSERT INTO r6d VALUES (1);')

    expect(await q('s1', 'rw', 'INSERT INTO r6d VALUES (5); DELETE FROM r6d')).toBe(
      `THREW: ${ONE_STATEMENT}`
    )
    expect(await q('s1', 'rw', 'SELECT 1; SELECT 2')).toBe(`THREW: ${ONE_STATEMENT}`)
    expect(await scalar(rw, 'SELECT count(*)::int FROM r6d')).toBe(1)
    // 被拒绝之后连接照常可用
    expect(await q('s1', 'rw', 'SELECT x FROM r6d')).toContain('(1 row)')
  })

  it('DBC-6e 只读连接上的多条语句同样被拒绝', async () => {
    save(roCred())
    expect(await q('s1', 'ro', 'SELECT 1; SELECT 2')).toBe(`THREW: ${ONE_STATEMENT}`)
  })

  it('DBC-7 3000 行：说出截断前的行数、保留表头、中间省略、结尾仍是行数', async () => {
    save(roCred())
    const out = await q('s1', 'ro', 'SELECT g AS n FROM generate_series(1, 3000) g')

    // 3 行表头 + 3000 行数据 + 下边框 + 行数 = 3005 行
    expect(out.startsWith('[Output truncated: 3005 lines]\n\n+------+\n| n    |\n+------+\n')).toBe(
      true
    )
    expect(out).toContain('lines omitted')
    expect(out.endsWith('| 3000 |\n+------+\n(3000 rows)')).toBe(true)
  })
})

describe('可写连接中途改成只读（真 PostgreSQL，独占一座桥）', () => {
  it('DBC-14a 手里是可写连接、调用方刚读到的却是只读 → 断开重连成只读，写被拒、行数不变', async () => {
    save(cred('rw', { port: flip.port, readonly: false }))
    expect(await q('s1', 'rw', 'INSERT INTO items VALUES (1)', { readonly: false })).toBe(
      'OK: INSERT, 1 row affected'
    )
    const connections = flip.log.connections

    // 用户在设置里把它改成了只读（服务端刚读到 readonly:true），而连接池手里还是旧的那条可写连接
    store.creds[0] = { ...store.creds[0], readonly: true }
    expect(await q('s1', 'rw', 'INSERT INTO items VALUES (2)', { readonly: true })).toBe(
      `THREW: ${READ_ONLY_REFUSAL}`
    )
    expect(flip.log.connections).toBe(connections + 1)
    // 旧的那条关掉了，不是两条并存
    await until(() => flip.log.open === 1, '旧连接关闭')
    expect(mgr.connectedNames('s1')).toEqual(['rw'])

    // 正则认不出的写，服务端也拒绝 —— 新连接确实是只读的
    expect(
      await q('s1', 'rw', 'WITH x AS (INSERT INTO items VALUES (3) RETURNING x) SELECT * FROM x', {
        readonly: true
      })
    ).toBe('THREW: cannot execute SELECT in a read-only transaction')
    expect(await scalar(flip, 'SELECT count(*)::int FROM items')).toBe(1)
  })
})

describe('并发首查询（真 PostgreSQL）', () => {
  it('DBC-13a 同一会话同时发出的两条首查询共用一次建连 —— 恰好一条连接，断开后一条不剩', async () => {
    save(roCred())
    const before = ro.log.connections
    const open = ro.log.open

    const [a, b] = await Promise.all([
      q('s3', 'ro', 'SELECT 1 AS a'),
      q('s3', 'ro', 'SELECT 2 AS b')
    ])
    expect(a).toContain('| a |')
    expect(b).toContain('| b |')
    expect(ro.log.connections).toBe(before + 1)
    expect(mgr.connectedNames('s3')).toEqual(['ro'])

    await mgr.disconnect('s3')
    await until(() => ro.log.open === open, '连接全部关闭')
  })
})

describe('服务端断开了一条空闲连接（真 PostgreSQL）', () => {
  // 重启、断网、服务端的空闲超时：驱动发 error / end。没人听的 error 在主进程里是未捕获异常 ——
  // vitest 会把它记成这次运行失败，所以「这条用例能绿」本身就是在断言「事件被接住了」
  it('DBC-15 连接从表上摘掉、状态条刷新；下一次查询重连并照常出结果', async () => {
    save(roCred())
    const seen: Array<string | null> = []
    const off = mgr.onChange((sid) => {
      if (sid === 's5') seen.push(mgr.runtimeStatus(sid)?.label ?? null)
    })
    expect(await q('s5', 'ro', 'SELECT 1 AS a')).toContain('(1 row)')
    expect(mgr.connectedNames('s5')).toEqual(['ro'])
    const before = ro.log.connections

    ro.dropClients()
    await until(() => mgr.connectedNames('s5').length === 0, '死掉的连接从表上摘掉')
    expect(logged.lines.some((l) => l.startsWith('warn Connection lost key=s5:ro'))).toBe(true)

    expect(await q('s5', 'ro', 'SELECT 2 AS b')).toContain('| b |')
    expect(ro.log.connections).toBe(before + 1)
    expect(mgr.connectedNames('s5')).toEqual(['ro'])
    // 连上 → 掉线 → 重连，状态条各刷新一次
    expect(seen).toEqual(['postgresql hrdb', null, 'postgresql hrdb'])
    off()
  })
})

describe('建连失败', () => {
  it('DBC-9a 连不上：逐字说用的是哪个连接，主机被抹掉；什么都没登记，下次照样重试', async () => {
    save(cred('down', { port: 9 }))
    const changes: string[] = []
    mgr.onChange((sid) => changes.push(sid))

    expect(await q('s1', 'down', 'SELECT 1')).toBe(
      'THREW: Failed to connect using credential "down": connect ECONNREFUSED <host>:9'
    )
    expect(mgr.connectedNames('s1')).toEqual([])
    expect(mgr.isConnected('s1')).toBe(false)
    expect(changes).toEqual([])
    // 失败的那次建连不会卡在「建连中」—— 第二次是一次新的尝试，失败得一模一样
    expect(await q('s1', 'down', 'SELECT 1')).toBe(
      'THREW: Failed to connect using credential "down": connect ECONNREFUSED <host>:9'
    )
  })

  it('DBC-9b 只读标志下发失败 → 建连失败（fail-closed），socket 关掉，什么都没登记（PostgreSQL）', async () => {
    save(cred('p', { readonly: true }))
    const calls: string[] = []
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(async () => {
      calls.push('connect')
    })
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation((async (sql: unknown) => {
      calls.push(`query ${String(sql)}`)
      throw new Error('permission denied to set parameter')
    }) as never)
    vi.spyOn(pg.Client.prototype, 'end').mockImplementation(async () => {
      calls.push('end')
    })

    expect(await q('s1', 'p', 'SELECT 1')).toBe(
      'THREW: Failed to connect using credential "p": permission denied to set parameter'
    )
    await until(() => calls.includes('end'), 'socket 关闭')
    expect(calls).toEqual(['connect', 'query SET default_transaction_read_only = on', 'end'])
    expect(mgr.connectedNames('s1')).toEqual([])
  })

  it('DBC-9c 只读标志下发失败 → 建连失败，连接关掉（MySQL）', async () => {
    save(cred('m', { dbType: 'mysql', readonly: true }))
    const conn = {
      query: vi.fn(async () => {
        throw new Error('nope')
      }),
      execute: vi.fn(),
      end: vi.fn(async () => {}),
      // 连接池会听 error / end（服务端断开空闲连接时摘掉它）
      on: vi.fn()
    }
    vi.spyOn(mysql, 'createConnection').mockResolvedValue(conn as never)

    expect(await q('s1', 'm', 'SELECT 1')).toBe(
      'THREW: Failed to connect using credential "m": nope'
    )
    expect(conn.execute).not.toHaveBeenCalled()
    await until(() => conn.end.mock.calls.length === 1, '连接关闭')
    expect(mgr.connectedNames('s1')).toEqual([])
  })

  it('DBC-10 查找与建连之间凭据被删了 → 说清楚还有哪些；一个都没有时换一句', async () => {
    save(cred('a'), cred('b'))
    expect(await q('s1', 'x', 'SELECT 1')).toBe(
      'THREW: No saved database credential found with name "x". Available credentials: [a, b].'
    )
    store.creds.length = 0
    expect(await q('s1', 'x', 'SELECT 1')).toBe(
      'THREW: No saved database credential found with name "x". No credentials configured.'
    )
  })

  it('DBC-13b 并发首查询共用的那次建连失败 → 两条都拿到同一句错误，之后能重试', async () => {
    save(cred('p', { readonly: false }))
    let attempts = 0
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(async () => {
      attempts++
      await new Promise((r) => setTimeout(r, 10))
      throw new Error('server is starting up')
    })
    vi.spyOn(pg.Client.prototype, 'end').mockImplementation(async () => {})

    const [a, b] = await Promise.all([q('s1', 'p', 'SELECT 1'), q('s1', 'p', 'SELECT 2')])
    expect(attempts).toBe(1)
    expect(a).toBe('THREW: Failed to connect using credential "p": server is starting up')
    expect(b).toBe(a)

    await q('s1', 'p', 'SELECT 3')
    expect(attempts).toBe(2)
  })
})

// ─── spy 驱动：MySQL、空闲超时、重连与报错 ──────────────────────────────────

interface FakeMysqlConnection {
  query: ReturnType<typeof vi.fn>
  execute: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

/** 一条假的 mysql2 连接：按顺序记下每一次 query / execute（execute 的应答由用例给；Error = 抛出） */
function fakeMysql(executeResult: (sql: string) => unknown = () => [[{ a: 1 }], [{ name: 'a' }]]): {
  conn: FakeMysqlConnection
  calls: string[]
} {
  const calls: string[] = []
  const conn = {
    query: vi.fn(async (sql: string) => {
      calls.push(`query ${sql}`)
      return [[], []]
    }),
    execute: vi.fn(async (sql: string) => {
      calls.push(`execute ${sql}`)
      const r = executeResult(sql)
      if (r instanceof Error) throw r
      return r
    }),
    end: vi.fn(async () => {
      calls.push('end')
    }),
    // 连接池会听 error / end（服务端断开空闲连接时摘掉它）
    on: vi.fn()
  }
  return { conn, calls }
}

describe('只读 MySQL：同样的包装，看驱动调用序列', () => {
  it('DBC-5a 建连把凭据原样交给驱动，第一件事是会话级只读；每条语句：重申只读 → 只读事务 → execute → ROLLBACK', async () => {
    save(
      cred('m', {
        dbType: 'mysql',
        host: 'db.internal',
        port: 3307,
        username: 'bob',
        password: 'pw-1',
        database: 'shop',
        readonly: true
      })
    )
    const { conn, calls } = fakeMysql()
    const create = vi.spyOn(mysql, 'createConnection').mockResolvedValue(conn as never)

    expect(await q('s1', 'm', 'SELECT 1 AS a')).toBe('+---+\n| a |\n+---+\n| 1 |\n+---+\n(1 row)')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toEqual({
      host: 'db.internal',
      port: 3307,
      user: 'bob',
      password: 'pw-1',
      database: 'shop',
      connectTimeout: 15000
    })
    expect(calls).toEqual([
      'query SET SESSION TRANSACTION READ ONLY',
      'query SET SESSION TRANSACTION READ ONLY',
      'query START TRANSACTION READ ONLY',
      'execute SELECT 1 AS a',
      'query ROLLBACK'
    ])

    // 每条都重申：上一条可能把会话默认值改成了读写（`SET SESSION transaction_read_only = OFF`）
    calls.length = 0
    await q('s1', 'm', 'SET @@session.transaction_read_only = 0')
    await q('s1', 'm', 'SELECT 2 AS a')
    expect(calls).toEqual([
      'query SET SESSION TRANSACTION READ ONLY',
      'query START TRANSACTION READ ONLY',
      'execute SET @@session.transaction_read_only = 0',
      'query ROLLBACK',
      'query SET SESSION TRANSACTION READ ONLY',
      'query START TRANSACTION READ ONLY',
      'execute SELECT 2 AS a',
      'query ROLLBACK'
    ])
  })

  it('DBC-5b 语句报错也照样 ROLLBACK；报错原样（抹掉凭据内容后）回给调用方', async () => {
    save(cred('m', { dbType: 'mysql', readonly: true }))
    const { conn, calls } = fakeMysql(() => new Error("Table 'shop.nope' doesn't exist"))
    vi.spyOn(mysql, 'createConnection').mockResolvedValue(conn as never)

    expect(await q('s1', 'm', 'SELECT * FROM nope')).toBe("THREW: Table 'shop.nope' doesn't exist")
    expect(calls.slice(-2)).toEqual(['execute SELECT * FROM nope', 'query ROLLBACK'])
  })

  it('DBC-5c 前置拦截对 MySQL 同样有效：写语句一条驱动调用都不发', async () => {
    save(cred('m', { dbType: 'mysql', readonly: true }))
    const { conn, calls } = fakeMysql()
    vi.spyOn(mysql, 'createConnection').mockResolvedValue(conn as never)

    expect(await q('s1', 'm', '/* x */ UPDATE t SET a = 1')).toBe(`THREW: ${READ_ONLY_REFUSAL}`)
    // 只有建连时那一条会话级只读
    expect(calls).toEqual(['query SET SESSION TRANSACTION READ ONLY'])
  })

  it('DBC-5d 可写 MySQL：一条只读相关的语句都不发，只有 execute', async () => {
    save(cred('m', { dbType: 'mysql', readonly: false }))
    const { conn, calls } = fakeMysql()
    vi.spyOn(mysql, 'createConnection').mockResolvedValue(conn as never)

    await q('s1', 'm', 'SELECT 1 AS a')
    await q('s1', 'm', 'SELECT 2 AS a')
    expect(calls).toEqual(['execute SELECT 1 AS a', 'execute SELECT 2 AS a'])
  })

  it('DBC-5e 写语句（ResultSetHeader）报影响行数，有自增 id 时一并报出 —— 不再是「rows is not iterable」', async () => {
    save(cred('m', { dbType: 'mysql', readonly: false }))
    const { conn } = fakeMysql((sql) => {
      if (sql.startsWith('UPDATE'))
        return [{ affectedRows: 3, insertId: 0, fieldCount: 0 }, undefined]
      if (sql.startsWith('INSERT'))
        return [{ affectedRows: 1, insertId: 42, fieldCount: 0 }, undefined]
      return [{ affectedRows: 0, insertId: 0, fieldCount: 0 }, undefined]
    })
    vi.spyOn(mysql, 'createConnection').mockResolvedValue(conn as never)

    expect(await q('s1', 'm', 'UPDATE t SET a = 1')).toBe('OK: statement, 3 rows affected')
    expect(await q('s1', 'm', "INSERT INTO t VALUES ('x')")).toBe(
      'OK: statement, 1 row affected, insert id 42'
    )
    expect(await q('s1', 'm', 'DELETE FROM t WHERE false')).toBe('OK: statement, 0 rows affected')
  })

  it('DBC-5f CALL 回好几份结果集 → 渲染第一份', async () => {
    save(cred('m', { dbType: 'mysql', readonly: false }))
    const { conn } = fakeMysql(() => [
      [[{ id: 1 }, { id: 2 }], [{ other: 'x' }], { affectedRows: 0, insertId: 0 }],
      [[{ name: 'id' }], [{ name: 'other' }], undefined]
    ])
    vi.spyOn(mysql, 'createConnection').mockResolvedValue(conn as never)

    expect(await q('s1', 'm', 'CALL report()')).toBe(
      '+----+\n| id |\n+----+\n| 1  |\n| 2  |\n+----+\n(2 rows)'
    )
  })
})

/** pg.Client 的 spy 版本：连接、查询、断开都只记账 */
function fakePg(
  result: (sql: string) => unknown = () => ({
    rows: [{ a: 1 }],
    fields: [{ name: 'a' }],
    command: 'SELECT',
    rowCount: 1
  })
): { calls: string[]; ends: () => number } {
  const calls: string[] = []
  vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(async () => {
    calls.push('connect')
  })
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation((async (arg: unknown) => {
    const sql = typeof arg === 'string' ? arg : (arg as { text: string }).text
    calls.push(`query ${sql}`)
    const r = result(sql)
    if (r instanceof Error) throw r
    return r
  }) as never)
  vi.spyOn(pg.Client.prototype, 'end').mockImplementation(async () => {
    calls.push('end')
  })
  return { calls, ends: () => calls.filter((c) => c === 'end').length }
}

describe('空闲超时（假时钟）', () => {
  const TEN_MINUTES = 10 * 60 * 1000

  it('DBC-8a 空闲满 10 分钟断开：驱动 end、连接集合清空、状态变化通知出去', async () => {
    vi.useFakeTimers()
    save(cred('p'))
    const { ends } = fakePg()
    const changes: string[] = []
    mgr.onChange((sid) => changes.push(sid))

    await q('s1', 'p', 'SELECT 1')
    expect(changes).toEqual(['s1'])

    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1)
    expect(mgr.connectedNames('s1')).toEqual(['p'])
    expect(ends()).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(mgr.connectedNames('s1')).toEqual([])
    expect(mgr.runtimeStatus('s1')).toBeUndefined()
    expect(ends()).toBe(1)
    // 空闲断开也通知 —— 状态条靠它清掉，不会一直挂着一条早就没了的连接
    expect(changes).toEqual(['s1', 's1'])
  })

  it('DBC-8b 第 9 分钟的一次查询把计时重新拉满', async () => {
    vi.useFakeTimers()
    save(cred('p'))
    const { ends } = fakePg()

    await q('s1', 'p', 'SELECT 1')
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
    await q('s1', 'p', 'SELECT 2')
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
    expect(ends()).toBe(0)
    expect(mgr.connectedNames('s1')).toEqual(['p'])

    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(ends()).toBe(1)
  })

  it('DBC-8c 超时断开之后的下一次查询重新建连', async () => {
    vi.useFakeTimers()
    save(cred('p'))
    const { calls } = fakePg()

    await q('s1', 'p', 'SELECT 1')
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    await q('s1', 'p', 'SELECT 2')

    expect(calls.filter((c) => c === 'connect')).toHaveLength(2)
    expect(mgr.connectedNames('s1')).toEqual(['p'])
  })
})

describe('凭据的只读位变了：重连，取严的那一边', () => {
  it('DBC-14b 连接池还没连着：凭据库说可写、调用方说只读 → 按只读连', async () => {
    save(cred('p', { readonly: false }))
    const { calls } = fakePg()

    await q('s1', 'p', 'SELECT 1', { readonly: true })
    expect(calls).toEqual([
      'connect',
      'query SET default_transaction_read_only = on',
      'query BEGIN TRANSACTION READ ONLY',
      'query SELECT 1',
      'query ROLLBACK'
    ])
  })

  it('DBC-14c 凭据库说只读、调用方读到的是旧的可写 → 仍按只读连（严的一边赢）', async () => {
    save(cred('p', { readonly: true }))
    const { calls } = fakePg()

    await q('s1', 'p', 'SELECT 1', { readonly: false })
    expect(calls).toContain('query SET default_transaction_read_only = on')
    expect(await q('s1', 'p', 'INSERT INTO t VALUES (1)', { readonly: false })).toBe(
      `THREW: ${READ_ONLY_REFUSAL}`
    )
  })

  it('DBC-14d 手里是只读连接、用户把它改成了可写 → 断开重连，不再包只读事务', async () => {
    save(cred('p', { readonly: true }))
    const { calls, ends } = fakePg()
    await q('s1', 'p', 'SELECT 1', { readonly: true })

    store.creds[0] = { ...store.creds[0], readonly: false }
    calls.length = 0
    await q('s1', 'p', 'SELECT 2', { readonly: false })

    expect(ends()).toBe(1)
    expect(calls).toEqual(['end', 'connect', 'query SELECT 2'])
  })

  it('DBC-14e 只读位没变 → 复用手里的连接', async () => {
    save(cred('p', { readonly: false }))
    const { calls } = fakePg()

    await q('s1', 'p', 'SELECT 1', { readonly: false })
    await q('s1', 'p', 'SELECT 2', { readonly: false })
    expect(calls.filter((c) => c === 'connect')).toHaveLength(1)
  })
})

describe('设置里改 / 删了凭据：disconnectCredential', () => {
  it('DBC-15 关掉这个凭据在所有会话里的连接，别的凭据不动；受影响的每个会话各通知一次', async () => {
    save(cred('a'), cred('b'))
    const { ends } = fakePg()
    await q('s1', 'a', 'SELECT 1')
    await q('s2', 'a', 'SELECT 1')
    await q('s2', 'b', 'SELECT 1')
    const changes: string[] = []
    mgr.onChange((sid) => changes.push(sid))

    await mgr.disconnectCredential('a')

    expect(ends()).toBe(2)
    expect(mgr.connectedNames('s1')).toEqual([])
    expect(mgr.connectedNames('s2')).toEqual(['b'])
    expect([...changes].sort()).toEqual(['s1', 's2'])

    // 没人用的名字：什么都不发生
    changes.length = 0
    await mgr.disconnectCredential('nobody')
    expect(ends()).toBe(2)
    expect(changes).toEqual([])
  })
})

describe('状态条：runtimeStatus / getConnectionInfo / onChange', () => {
  it('DBC-11a 只答这个会话自己的连接；断开之后没有了', async () => {
    save(cred('p', { host: 'db.example', database: 'sales', username: 'carol' }))
    fakePg()
    await q('s1', 'p', 'SELECT 1')

    expect(mgr.getConnectionInfo('s1')).toEqual({
      host: 'db.example',
      database: 'sales',
      dbType: 'postgresql',
      username: 'carol'
    })
    expect(mgr.runtimeStatus('s1')).toEqual({
      label: 'postgresql sales',
      icon: 'Database',
      color: '#f59e0b',
      description: 'db.example'
    })
    expect(mgr.isConnected('s1')).toBe(true)
    // 另一个会话什么都没有；前缀相同的会话 id 也不算
    expect(mgr.getConnectionInfo('s2')).toBeUndefined()
    expect(mgr.getConnectionInfo('s')).toBeUndefined()
    expect(mgr.isConnected('s')).toBe(false)
    expect(mgr.runtimeStatus('s2')).toBeUndefined()

    await mgr.disconnect('s1')
    expect(mgr.getConnectionInfo('s1')).toBeUndefined()
    expect(mgr.runtimeStatus('s1')).toBeUndefined()
    expect(mgr.isConnected('s1')).toBe(false)
  })

  it('DBC-11b 同时连着几条：标签写第一条，并标出还有几条', async () => {
    save(
      cred('p', { database: 'sales' }),
      cred('m', { dbType: 'mysql', database: 'shop', readonly: false })
    )
    fakePg()
    vi.spyOn(mysql, 'createConnection').mockResolvedValue(fakeMysql().conn as never)

    await q('s1', 'p', 'SELECT 1')
    await q('s1', 'm', 'SELECT 1')
    expect(mgr.runtimeStatus('s1')?.label).toBe('postgresql sales +1')

    await mgr.disconnectCredential('p')
    expect(mgr.runtimeStatus('s1')).toMatchObject({ label: 'mysql shop' })
  })

  it('DBC-11c onChange：连上与断开各通知一次，带的是会话 id；取消订阅后不再收到', async () => {
    save(cred('p'))
    fakePg()
    const seen: string[] = []
    const off = mgr.onChange((sid) =>
      seen.push(`${sid}:${mgr.runtimeStatus(sid)?.label ?? 'none'}`)
    )

    await q('s1', 'p', 'SELECT 1')
    await mgr.disconnect('s1')
    expect(seen).toEqual(['s1:postgresql hrdb', 's1:none'])

    off()
    await q('s1', 'p', 'SELECT 1')
    expect(seen).toHaveLength(2)
  })

  it('DBC-11d 一个监听者抛错不影响别的监听者，也不影响建连（记一条 warn）', async () => {
    save(cred('p'))
    fakePg()
    const seen: string[] = []
    mgr.onChange(() => {
      throw new Error('listener boom')
    })
    mgr.onChange((sid) => seen.push(sid))

    expect(await q('s1', 'p', 'SELECT 1')).toContain('(1 row)')
    expect(seen).toEqual(['s1'])
    expect(logged.lines).toContain('warn change listener failed: listener boom')
  })
})

describe('报错里抹掉凭据内容', () => {
  const secrets = {
    host: '10.0.0.7',
    username: 'alice',
    database: 'hrdb',
    password: 'hunter2-secret'
  }

  it.each<[string, string]>([
    ['connect ECONNREFUSED 10.0.0.7:5432', 'connect ECONNREFUSED <host>:5432'],
    [
      'password authentication failed for user "alice"',
      'password authentication failed for user "<user>"'
    ],
    ['database "hrdb" does not exist', 'database "<database>" does not exist'],
    ['bad password hunter2-secret for alice@10.0.0.7', 'bad password <password> for <user>@<host>']
  ])('DBC-16a 建连报错 %j → %j', async (raw, redacted) => {
    save(cred('p', { ...secrets, readonly: false }))
    vi.spyOn(pg.Client.prototype, 'connect').mockRejectedValue(new Error(raw))
    vi.spyOn(pg.Client.prototype, 'end').mockResolvedValue(undefined as never)

    expect(await q('s1', 'p', 'SELECT 1')).toBe(
      `THREW: Failed to connect using credential "p": ${redacted}`
    )
  })

  it('DBC-16b 查询报错同样抹掉（库名只按整词替换，不误伤包含它的更长的词）', async () => {
    save(cred('p', { ...secrets, readonly: false }))
    fakePg((sql) =>
      sql.startsWith('SELECT')
        ? new Error('permission denied for database hrdb; hint: ask alice about hrdb_archive')
        : { rows: [], fields: [], command: 'SET', rowCount: null }
    )

    expect(await q('s1', 'p', 'SELECT 1')).toBe(
      'THREW: permission denied for database <database>; hint: ask <user> about hrdb_archive'
    )
  })

  it('DBC-16c 不到两个字符的值不替换（否则一个字母的用户名会把整句话打成筛子）', async () => {
    save(cred('p', { host: 'h', username: 'a', database: 'd', password: 'x', readonly: false }))
    vi.spyOn(pg.Client.prototype, 'connect').mockRejectedValue(
      new Error('authentication failed: a d h x')
    )
    vi.spyOn(pg.Client.prototype, 'end').mockResolvedValue(undefined as never)

    expect(await q('s1', 'p', 'SELECT 1')).toBe(
      'THREW: Failed to connect using credential "p": authentication failed: a d h x'
    )
  })
})

describe('测试连接（设置页）', () => {
  it('DBC-12 对着桥成功、对着 9 号端口失败；试完就关，不给任何会话留下连接', async () => {
    const changes: string[] = []
    mgr.onChange((sid) => changes.push(sid))
    const before = rw.log.connections
    const ok = await mgr.testConnection({
      dbType: 'postgresql',
      host: '127.0.0.1',
      port: rw.port,
      username: 'u',
      password: 'p',
      database: 'd'
    })
    expect(ok).toEqual({ success: true })

    const bad = await mgr.testConnection({
      dbType: 'postgresql',
      host: '127.0.0.1',
      port: 9,
      username: 'u',
      password: 'p',
      database: 'd'
    })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('ECONNREFUSED')

    // 真的连过一次，而且那条连接随即关掉了（不是留在池子里）
    expect(rw.log.connections).toBe(before + 1)
    await until(() => rw.log.open === 0, '测试连接关闭')
    // 连接集合没动过 —— 状态条不会因为设置页点了一下「测试」而亮起来
    expect(changes).toEqual([])
  })
})
