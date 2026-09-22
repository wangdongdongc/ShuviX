/**
 * 内置数据库（`mcp:database` 能力服务器）e2e 的共用夹具 —— 一台真的 PostgreSQL 与几个小助手。
 *
 * **真的 PostgreSQL**：PGlite（WASM 版 Postgres，桌面已经依赖它）说完整的线协议 ——
 * `execProtocolRaw` 吃一条前端消息、吐后端的回应。这里在 spec 进程里起一台 `127.0.0.1:0` 的
 * TCP 服务把两头接起来，应用自己的 `pg` 驱动就像连一台普通服务器那样连上来。握手只在 PGlite
 * 里做一次（MD5 口令，任何密码都过），之后每条 TCP 连接的 StartupMessage 都回放那一次的结果。
 *
 * 用法上的三条硬约束（踩过的坑，别改）：
 *   - **一台 bridge 只给一个已保存连接用**：PGlite 只有一个后端会话，`SET`、事务状态会串到这台
 *     bridge 的每一条 TCP 连接上 —— 只读连接下发的 `SET default_transaction_read_only = on`
 *     会一直留在会话里，于是同一台 bridge 再也当不了可写库。
 *   - **消息严格串行**：一条接一条喂给 PGlite（`serial`），直接查询（`query` / `count`）也排进
 *     同一条队列，不会插进某个客户端的扩展协议序列中间。
 *   - **日志要记 `P`（Parse）不只记 `Q`**：用户的语句走扩展协议（`queryMode: 'extended'`，
 *     见 dbConnections.ts），到这边是 `P` 消息；`BEGIN TRANSACTION READ ONLY` / `ROLLBACK` /
 *     建连时的 `SET` 才是简单查询 `Q`。只记 `Q` 的话「这条 SQL 从没到过服务器」会因为错的原因成立。
 *
 * 「SQL 到没到服务器」一律按这份日志断，不信工具自己的回报。库里的行数用 `count`（直接问 PGlite，
 * 不经 bridge、不进日志）。
 */
import { createHash } from 'node:crypto'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import type { CdpClient } from './cdp'

/** 内置数据库 server 的全部工具 */
export const DATABASE_TOOL_NAMES = ['list-connections', 'query'] as const

/** `mcp__database__<tool>` —— 客户端给内置 server 的工具加的前缀 */
export const dbTool = (tool: string): string => `mcp__database__${tool}`

/** v28 种下的内置行 */
export const DATABASE_SERVER_ID = 'builtin-mcp-database'

/** 工具显示名（`tool.remoteDbLabel`）的三语候选 */
export const DB_LABELS = ['Remote Database', '远程数据库', 'リモートデータベース']

/** 只读连接上的写语句被第一层（关键词预检）挡下时的原话 —— 这条语句根本没发到服务器 */
export const READONLY_PRECHECK =
  'Write operations are not allowed. This connection is in readonly mode. Only SELECT and read-only statements are permitted.'

/** 一次调用里塞了几条语句时的原话（扩展协议在服务器那一侧拒绝，一条都没执行） */
export const ONE_STATEMENT =
  'Run one statement per query — this SQL contains several. Split it into separate query calls.'

// ─── PGlite bridge ──────────────────────────────────────────────────────

/** bridge 收到的一条语句 */
export interface BridgeStatement {
  /** 这条 TCP 连接是第几个被接受的（从 1 起） */
  conn: number
  /** `Q` = 简单查询；`P` = 扩展协议的 Parse（用户语句走这条） */
  kind: 'Q' | 'P'
  sql: string
}

export interface PgBridge {
  port: number
  /** 至今接受过的 TCP 连接数 */
  connections(): number
  /** 此刻还开着的连接数 */
  open(): number
  /** 收到的全部语句（到达顺序） */
  statements(): BridgeStatement[]
  /** 某一条连接收到的语句原文（到达顺序） */
  statementsOf(conn: number): string[]
  /** 有没有哪条语句（任一连接）包含 needle */
  saw(needle: string): boolean
  /** 直接问 PGlite（不经 bridge、不进日志）—— 种数据与核对用 */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>
  /** 某张表此刻的行数 */
  count(table: string): Promise<number>
  close(): Promise<void>
}

const u8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
const md5 = (s: string | Buffer): string => createHash('md5').update(s).digest('hex')

/** 一条前端消息：类型字节 + int32 长度（含自身）+ 正文 */
function frame(type: string, body: Buffer): Buffer {
  const b = Buffer.alloc(5 + body.length)
  b.write(type, 0, 'latin1')
  b.writeInt32BE(4 + body.length, 1)
  body.copy(b, 5)
  return b
}

/** 从 start 起读一个 C 字符串 */
function cstr(buf: Buffer, start: number): string {
  const end = buf.indexOf(0, start)
  return buf.subarray(start, end < 0 ? buf.length : end).toString('utf8')
}

export interface PgBridgeOptions {
  /**
   * 拒绝每一次登录：收到 StartupMessage 就回一条 FATAL 的 ErrorResponse（文字由它给）然后断开 ——
   * 与真的 PostgreSQL 按 pg_hba.conf 拒绝登录时一样，报错里带着客户端地址、用户名与库名。
   * 参数是 StartupMessage 里的键值（`user` / `database` …）与客户端地址。
   */
  refuse?: (startup: Record<string, string>, clientHost: string) => string
}

/** StartupMessage 的键值对（int32 长度 + int32 协议号之后，C 字符串成对，空串收尾） */
function startupParams(msg: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let at = 8
  while (at < msg.length && msg[at] !== 0) {
    const key = cstr(msg, at)
    at += Buffer.byteLength(key) + 1
    const value = cstr(msg, at)
    at += Buffer.byteLength(value) + 1
    out[key] = value
  }
  return out
}

/** 一条 FATAL 的 ErrorResponse（`S` / `V` 严重级、`C` SQLSTATE、`M` 文字） */
function fatal(code: string, message: string): Buffer {
  const fields = Buffer.concat(
    [
      ['S', 'FATAL'],
      ['V', 'FATAL'],
      ['C', code],
      ['M', message]
    ].map(([k, v]) => Buffer.from(`${k}${v}\0`))
  )
  return frame('E', Buffer.concat([fields, Buffer.from([0])]))
}

/**
 * 起一台 PGlite + TCP bridge。`seedSql` 在任何客户端连上来之前执行（建表、种行）。
 */
export async function startPgBridge(
  seedSql?: string,
  opts: PgBridgeOptions = {}
): Promise<PgBridge> {
  const db = new PGlite()
  await db.waitReady
  if (seedSql) await db.exec(seedSql)

  // PGlite 自己的握手只做一次：StartupMessage → MD5 质询 → 口令 → 认证成功 + 参数 + ReadyForQuery
  const params = Buffer.from('user\0postgres\0database\0postgres\0\0')
  const startup = Buffer.alloc(8 + params.length)
  startup.writeInt32BE(8 + params.length, 0)
  startup.writeInt32BE(196608, 4) // 协议 3.0
  params.copy(startup, 8)
  const challenge = Buffer.from(await db.execProtocolRaw(u8(startup)))
  const salt = challenge.subarray(9, 13) // 'R' + len + int32(5 = MD5) + 4 字节盐
  const password = 'md5' + md5(Buffer.concat([Buffer.from(md5('x' + 'postgres')), salt]))
  const hello = Buffer.from(await db.execProtocolRaw(u8(frame('p', Buffer.from(password + '\0')))))

  // 一条队列：bridge 转发的消息与直接查询都排在里面（PGlite 只有一个会话）
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  const log: BridgeStatement[] = []
  let accepted = 0
  let open = 0
  const sockets = new Set<Socket>()

  const server = createServer((sock) => {
    const conn = ++accepted
    open++
    sockets.add(sock)
    let buf = Buffer.alloc(0)
    let started = false
    sock.on('close', () => {
      open--
      sockets.delete(sock)
    })
    sock.on('error', () => undefined)
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (!started) {
          // 启动阶段的消息没有类型字节：int32 长度 + int32 代码
          if (buf.length < 8) return
          const len = buf.readInt32BE(0)
          if (buf.length < len) return
          const code = buf.readInt32BE(4)
          const startup = Buffer.from(buf.subarray(0, len))
          buf = buf.subarray(len)
          if (code === 80877103) {
            sock.write('N') // SSLRequest：不支持
            continue
          }
          if (opts.refuse) {
            // 28000 = invalid_authorization_specification（pg_hba.conf 拒绝登录时的 SQLSTATE）
            const host = (sock.remoteAddress ?? '').replace(/^::ffff:/, '')
            sock.end(fatal('28000', opts.refuse(startupParams(startup), host)))
            return
          }
          started = true
          sock.write(hello) // pg 不会再发口令：直接回放 PGlite 那一次握手的结果
          continue
        }
        if (buf.length < 5) return
        const len = buf.readInt32BE(1)
        if (buf.length < 1 + len) return
        const one = Buffer.from(buf.subarray(0, 1 + len))
        buf = buf.subarray(1 + len)
        const type = String.fromCharCode(one[0])
        if (type === 'X') {
          // Terminate：不转发（PGlite 的会话要留给下一条连接）
          sock.end()
          return
        }
        if (type === 'Q') log.push({ conn, kind: 'Q', sql: cstr(one, 5) })
        // Parse：语句名（C 字符串）之后才是语句原文
        if (type === 'P') log.push({ conn, kind: 'P', sql: cstr(one, one.indexOf(0, 5) + 1) })
        void serial(async () => {
          const out = await db.execProtocolRaw(u8(one))
          if (!sock.destroyed) sock.write(Buffer.from(out))
        }).catch(() => sock.destroy())
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const query = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
    (await serial(() => db.query<T>(sql))).rows

  return {
    port,
    connections: () => accepted,
    open: () => open,
    statements: () => [...log],
    statementsOf: (n) => log.filter((s) => s.conn === n).map((s) => s.sql),
    saw: (needle) => log.some((s) => s.sql.includes(needle)),
    query,
    count: async (table) =>
      (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await serial(() => db.close())
    }
  }
}

// ─── 已保存的连接 ───────────────────────────────────────────────────────

/** 一条已保存的连接（`dbCredential.add` 的参数） */
export interface DbCredentialSeed {
  name: string
  dbType: 'postgresql' | 'mysql'
  host: string
  port: number
  username: string
  password: string
  database: string
  readonly: boolean
}

/** 经设置页同一条 IPC 存一条连接，回它的 id */
export async function addDbCredential(main: CdpClient, seed: DbCredentialSeed): Promise<string> {
  const res = await main.eval<{ id: string }>(
    `window.api.dbCredential.add(${JSON.stringify(seed)})`
  )
  return res.id
}

/** 设置页给出的列表（不含密码） */
export interface DbCredentialListed {
  id: string
  name: string
  dbType: string
  host: string
  port: number
  username: string
  database: string
  readonly: boolean
}

export function listDbCredentials(main: CdpClient): Promise<DbCredentialListed[]> {
  return main.eval<DbCredentialListed[]>(`window.api.dbCredential.list()`)
}
