/**
 * 数据库连接管理器 —— 内置能力服务器 `database` 的连接池（与 ssh 的 sshControl.ts 同位）。
 * 管理 per-session 的 MySQL/PostgreSQL 连接生命周期
 * 支持同一 session 同时持有多个不同凭据的连接
 * 空闲超时后自动断开；会话结束时由 server 的 transport.onclose 整批断开
 *
 * 设置页的「测试连接」、凭据改动后的断开，与会话状态条（runtime 'db'）也用它。
 *
 * **只读连接靠的是每条语句的包装，而不是建连时下发一次的会话标志**：会话级的只读标志任何一条
 * 语句都能改回去（`SET default_transaction_read_only = off`、`SET transaction_read_only = OFF`），
 * 而 ask-on-database 对只读连接从不询问 —— 那样「只读」就只剩一句承诺。所以只读连接上的每一次
 * 查询都是：重申只读 → 显式开一个只读事务 → 执行**恰好一条**语句 → 回滚。事务里改不回读写
 * （PostgreSQL 直接报错），一条语句也没法先 COMMIT 再写（显式事务块里 DO 块不能提交；多语句
 * 不经扩展协议 / 预处理协议）；下一次查询又从重申只读开始。连接级的只读标志留作纵深防御。
 *
 * **一次恰好一条语句**（两种连接都是）：PostgreSQL 走扩展协议、MySQL 走预处理协议，多条语句
 * 在协议层就被拒绝 —— 否则 `SELECT 1; SELECT 2` 只回得来最后一份结果，写连接上的询问卡片
 * 也会一口气放行好几条。
 */

import type { QueryConfig } from 'pg'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import { createLogger } from '../../logger'
import { dbCredentialDao } from '../../dao/dbCredentialDao'
import type { DbCredential, DbType } from '../../dao/types'
import { truncateMiddle, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from '../../../shared/node/truncate'

const log = createLogger('DbManager')

/** 空闲超时时间（10 分钟） */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 写操作关键词正则（只读连接的第一层：给一句友好的报错）。真正的保护是下面的只读事务包装，
 * 所以这里只需在跳过开头的注释与空白之后认出常见写语句，不必滴水不漏。
 */
const WRITE_KEYWORDS =
  /^(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE|CALL|EXEC|SET\s+(GLOBAL|SESSION)|FLUSH|GRANT|REVOKE|LOCK|UNLOCK)\b/i

/** 去掉 SQL 开头的空白与注释（`-- …` 行注释、`/* … *\/` 块注释），供关键词判断 */
function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const next = s
      .replace(/^\s+/, '')
      .replace(/^--[^\n]*(\n|$)/, '')
      .replace(/^\/\*[\s\S]*?\*\//, '')
    if (next === s) return s
    s = next
  }
}

// 使用动态 import 以支持纯 JS 驱动（无 native binding）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mysql = require('mysql2/promise') as typeof import('mysql2/promise')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client: PgClient } = require('pg') as typeof import('pg')

type MysqlConnection = Awaited<ReturnType<(typeof mysql)['createConnection']>>
type PgClientInstance = InstanceType<typeof PgClient>

interface ConnectionEntry {
  client: MysqlConnection | PgClientInstance
  credentialName: string
  dbType: DbType
  readonly: boolean
  host: string
  database: string
  username: string
  destroyTimer?: ReturnType<typeof setTimeout>
}

/** 生成复合 key：sessionId:credentialName */
function connKey(sessionId: string, credentialName: string): string {
  return `${sessionId}:${credentialName}`
}

/** 判断 key 是否属于某 session */
function isSessionKey(key: string, sessionId: string): boolean {
  return key === sessionId || key.startsWith(`${sessionId}:`)
}

/** key 的 sessionId 部分（凭据名可能含冒号，session id 不会） */
function sessionOfKey(key: string): string {
  const i = key.indexOf(':')
  return i < 0 ? key : key.slice(0, i)
}

/**
 * 从驱动报错里抹掉凭据内容：设置页对用户的承诺是「AI 能发起连接，但看不到凭据的内容」，而驱动的
 * 报错会原样带出主机、用户名与库名（`connect ECONNREFUSED 10.0.0.7:5432`、
 * `password authentication failed for user "alice"`、`database "hr" does not exist`）。
 */
function redact(
  message: string,
  secrets: { host?: string; username?: string; database?: string; password?: string }
): string {
  let out = message
  const replaceAll = (value: string | undefined, label: string, wordOnly: boolean): void => {
    if (!value || value.length < 2) return
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(wordOnly ? `\\b${escaped}\\b` : escaped, 'g'), label)
  }
  replaceAll(secrets.password, '<password>', false)
  replaceAll(secrets.host, '<host>', false)
  replaceAll(secrets.username, '<user>', true)
  replaceAll(secrets.database, '<database>', true)
  return out
}

/** 结果格式化：查询出行 → 表格；写语句 → 影响的行数 */
function renderResult(fields: string[], rows: Record<string, unknown>[]): string {
  if (!rows || rows.length === 0) return '(0 rows)'
  const text = formatTable(fields, rows)
  const truncated = truncateMiddle(text, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)
  if (truncated.truncated) {
    return `[Output truncated: ${truncated.originalLines} lines]\n\n${truncated.text}`
  }
  return truncated.text
}

function affected(verb: string, count: number, extra = ''): string {
  return `OK: ${verb}, ${count} row${count === 1 ? '' : 's'} affected${extra}`
}

export class DbManager {
  private connections = new Map<string, ConnectionEntry>()
  /** 建连中的 key → 那一次建连（同一会话同时发出的两条首查询共用一次，不各开一条、漏掉一条） */
  private connecting = new Map<string, Promise<void>>()
  /** 会话的连接集合变了（连上 / 断开 / 空闲超时断开）→ 通知状态条 */
  private listeners = new Set<(sessionId: string) => void>()

  /** 订阅「某会话的连接集合变了」；返回取消订阅 */
  onChange(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(sessionId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId)
      } catch (e: unknown) {
        log.warn(`change listener failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 建立数据库连接（内部使用复合 key） */
  async connect(
    sessionId: string,
    credential: DbCredential
  ): Promise<{ success: boolean; error?: string }> {
    const key = connKey(sessionId, credential.name)
    // 如果已有同名连接，先断开
    await this.disconnectByKey(key)

    let client: MysqlConnection | PgClientInstance | undefined
    /**
     * 服务端断开了一条空闲连接（重启、网络断、服务端的空闲超时）：驱动发 `error` / `end`。没人听的
     * `error` 事件在主进程里就是一个未捕获异常；而死掉的连接若还挂在表上，这个会话之后的每一次查询都会
     * 撞上「not queryable」，重试还会一直续上空闲计时。所以听着：还是它在表上，就摘掉 —— 下次查询重连。
     */
    const onLost = (lostClient: MysqlConnection | PgClientInstance, err?: unknown): void => {
      const entry = this.connections.get(key)
      if (!entry || entry.client !== lostClient) return
      clearTimeout(entry.destroyTimer)
      this.connections.delete(key)
      const why = err instanceof Error ? `: ${err.message}` : ''
      log.warn(`Connection lost key=${key}${why}`)
      void this.endClient(entry.dbType, lostClient)
      this.notify(sessionId)
    }
    try {
      if (credential.dbType === 'mysql') {
        const conn: MysqlConnection = await mysql.createConnection({
          host: credential.host,
          port: credential.port,
          user: credential.username,
          password: credential.password,
          database: credential.database,
          connectTimeout: 15000
        })
        client = conn
        conn.on('error', (err: unknown) => onLost(conn, err))
        conn.on('end', () => onLost(conn))
        // 连接级只读标志：纵深防御（真正的保护是每条语句的只读事务包装，见文件头）
        if (credential.readonly) await conn.query('SET SESSION TRANSACTION READ ONLY')
      } else {
        const pg = new PgClient({
          host: credential.host,
          port: credential.port,
          user: credential.username,
          password: credential.password,
          database: credential.database,
          connectionTimeoutMillis: 15000
        })
        client = pg
        pg.on('error', (err) => onLost(pg, err))
        pg.on('end', () => onLost(pg))
        await pg.connect()
        if (credential.readonly) await pg.query('SET default_transaction_read_only = on')
      }
      this.connections.set(key, {
        client,
        credentialName: credential.name,
        dbType: credential.dbType === 'mysql' ? 'mysql' : 'postgresql',
        readonly: credential.readonly,
        host: credential.host,
        database: credential.database,
        username: credential.username
      })
      this.resetIdleTimeout(key)
      log.info(
        `Connected to ${credential.dbType} ${credential.host}/${credential.database} key=${key}`
      )
      this.notify(sessionId)
      return { success: true }
    } catch (err: unknown) {
      // 建到一半失败（比如只读标志下发失败）：已经打开的 socket 不能留着
      if (client) void this.endClient(credential.dbType, client)
      const error = err instanceof Error ? err.message : String(err)
      log.error(`Connection failed: ${error}`)
      return { success: false, error: redact(error, credential) }
    }
  }

  /**
   * 自动连接并执行查询（简化接口）
   * 如果对应凭据的连接不存在，自动建立连接后执行 SQL。
   *
   * `expect.readonly`：调用方刚读到的凭据只读位。与手里那条连接对不上（用户刚在设置里把它改成
   * 只读 / 可写）就断开重连 —— 否则安全门按「只读」放行，语句却跑在一条旧的可写连接上。
   */
  async connectAndQuery(
    sessionId: string,
    credentialName: string,
    sql: string,
    expect?: { readonly: boolean }
  ): Promise<string> {
    const key = connKey(sessionId, credentialName)

    const held = this.connections.get(key)
    if (held && expect && held.readonly !== expect.readonly) {
      log.info(`Credential "${credentialName}" changed read-only mode, reconnecting key=${key}`)
      await this.disconnectByKey(key)
    }

    // 如果没有活跃连接，自动建立（同一 key 的并发首查询共用一次建连）
    if (!this.connections.has(key)) {
      let pending = this.connecting.get(key)
      if (!pending) {
        pending = this.openFor(sessionId, credentialName, expect).finally(() => {
          this.connecting.delete(key)
        })
        this.connecting.set(key, pending)
      }
      await pending
    }

    return this.queryByKey(key, sql)
  }

  /**
   * 按凭据名建连；找不到凭据 / 连不上 → 抛出可行动的错误。
   * 调用方说它要只读、凭据却是可写（两次读之间用户改了设置）→ 取严的那一边，按只读连。
   */
  private async openFor(
    sessionId: string,
    credentialName: string,
    expect?: { readonly: boolean }
  ): Promise<void> {
    const found = dbCredentialDao.findByName(credentialName)
    const cred = found && expect?.readonly && !found.readonly ? { ...found, readonly: true } : found
    if (!cred) {
      const available = dbCredentialDao.findAllNamesWithType() || []
      const hint =
        available && available.length > 0
          ? ` Available credentials: [${available.map((c) => c.name).join(', ')}].`
          : ' No credentials configured.'
      throw new Error(`No saved database credential found with name "${credentialName}".${hint}`)
    }
    const result = await this.connect(sessionId, cred)
    if (!result.success) {
      throw new Error(`Failed to connect using credential "${credentialName}": ${result.error}`)
    }
  }

  /** 执行 SQL 查询，返回格式化文本（通过复合 key） */
  private async queryByKey(key: string, sql: string): Promise<string> {
    const entry = this.connections.get(key)
    if (!entry) {
      throw new Error('Not connected to any database.')
    }

    if (entry.readonly && WRITE_KEYWORDS.test(stripLeadingComments(sql))) {
      log.warn(`Blocked write operation in readonly mode: ${sql.substring(0, 100)}`)
      throw new Error(
        'Write operations are not allowed. This connection is in readonly mode. Only SELECT and read-only statements are permitted.'
      )
    }

    this.resetIdleTimeout(key)

    try {
      return entry.dbType === 'mysql'
        ? await this.runMysql(entry.client as MysqlConnection, sql, entry.readonly)
        : await this.runPg(entry.client as PgClientInstance, sql, entry.readonly)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(redact(message, entry))
    }
  }

  private async runPg(client: PgClientInstance, sql: string, readonly: boolean): Promise<string> {
    // 只读：显式只读事务（事务里改不回读写；DO 块在显式事务块里不能 COMMIT）
    if (readonly) await client.query('BEGIN TRANSACTION READ ONLY')
    try {
      // 扩展协议：多条语句在协议层就被拒绝（「cannot insert multiple commands into a prepared statement」）。
      // queryMode 是 pg 8.11+ 的选项，@types/pg 还没收
      const config: QueryConfig & { queryMode: 'extended' } = { text: sql, queryMode: 'extended' }
      const result = await client.query(config)
      const fields = result.fields ? result.fields.map((f) => f.name) : []
      if (fields.length === 0) {
        // 没有结果列的语句（INSERT / UPDATE / DELETE / DDL / SET …）：报影响的行数，而不是「0 行」
        return typeof result.rowCount === 'number' && result.command
          ? affected(result.command, result.rowCount)
          : `OK${result.command ? `: ${result.command}` : ''}`
      }
      return renderResult(fields, (result.rows || []) as Record<string, unknown>[])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (/multiple commands/i.test(message)) {
        throw new Error(
          'Run one statement per query — this SQL contains several. Split it into separate query calls.'
        )
      }
      throw err
    } finally {
      if (readonly) await client.query('ROLLBACK').catch(() => {})
    }
  }

  private async runMysql(conn: MysqlConnection, sql: string, readonly: boolean): Promise<string> {
    if (readonly) {
      // 每次都重申：上一条语句可能把会话默认值改成了读写（`SET SESSION transaction_read_only = OFF`）
      await conn.query('SET SESSION TRANSACTION READ ONLY')
      await conn.query('START TRANSACTION READ ONLY')
    }
    try {
      // 预处理协议：一次只有一条语句
      const [result, fieldDefs] = await conn.execute(sql)
      // 写语句回的是 ResultSetHeader（不是行数组）
      if (!Array.isArray(result)) {
        const header = result as { affectedRows?: number; insertId?: number }
        const count = typeof header.affectedRows === 'number' ? header.affectedRows : 0
        const insertId =
          typeof header.insertId === 'number' && header.insertId > 0
            ? `, insert id ${header.insertId}`
            : ''
        return affected('statement', count, insertId)
      }
      // CALL 回多份结果：取第一份结果集
      const rows = (Array.isArray(result[0]) ? result[0] : result) as unknown as Record<
        string,
        unknown
      >[]
      const defs = (
        Array.isArray(fieldDefs) && Array.isArray(fieldDefs[0]) ? fieldDefs[0] : fieldDefs
      ) as Array<{ name: string }> | undefined
      const fields = defs && Array.isArray(defs) ? defs.map((f) => f.name) : []
      return renderResult(fields, rows)
    } finally {
      if (readonly) await conn.query('ROLLBACK').catch(() => {})
    }
  }

  /** 测试连接（不保存到 session） */
  async testConnection(
    params: Pick<DbCredential, 'dbType' | 'host' | 'port' | 'username' | 'password' | 'database'>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (params.dbType === 'mysql') {
        const conn = await mysql.createConnection({
          host: params.host,
          port: params.port,
          user: params.username,
          password: params.password,
          database: params.database,
          connectTimeout: 10000
        })
        await conn.end()
      } else {
        const client = new PgClient({
          host: params.host,
          port: params.port,
          user: params.username,
          password: params.password,
          database: params.database,
          connectionTimeoutMillis: 10000
        })
        await client.connect()
        await client.end()
      }
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 断开指定 session 下的所有连接 */
  async disconnect(sessionId: string): Promise<void> {
    const keysToRemove: string[] = []
    for (const key of this.connections.keys()) {
      if (isSessionKey(key, sessionId)) {
        keysToRemove.push(key)
      }
    }
    await Promise.all(keysToRemove.map((key) => this.disconnectByKey(key)))
  }

  /**
   * 断开所有会话里用这个凭据名建的连接 —— 设置里改了 / 删了这个凭据：旧连接按旧配置建的
   * （旧主机、旧账号、旧的只读位），留着就错了；下次用到时按新配置重连。
   */
  async disconnectCredential(credentialName: string): Promise<void> {
    const keys = [...this.connections.entries()]
      .filter(([, entry]) => entry.credentialName === credentialName)
      .map(([key]) => key)
    await Promise.all(keys.map((key) => this.disconnectByKey(key)))
  }

  /** 断开指定复合 key 的单个连接 */
  private async disconnectByKey(key: string): Promise<void> {
    const entry = this.connections.get(key)
    if (!entry) return
    clearTimeout(entry.destroyTimer)
    this.connections.delete(key)
    await this.endClient(entry.dbType, entry.client)
    log.info(`Disconnected key=${key}`)
    this.notify(sessionOfKey(key))
  }

  private async endClient(
    dbType: DbType,
    client: MysqlConnection | PgClientInstance
  ): Promise<void> {
    try {
      if (dbType === 'mysql') {
        await (client as MysqlConnection).end()
      } else {
        await (client as PgClientInstance).end()
      }
    } catch {
      // 忽略断开时的错误
    }
  }

  /** 断开所有连接（应用退出时调用） */
  disconnectAll(): void {
    for (const key of this.connections.keys()) {
      this.disconnectByKey(key).catch(() => {})
    }
  }

  /** 是否有该 session 下的任何连接 */
  isConnected(sessionId: string): boolean {
    for (const key of this.connections.keys()) {
      if (isSessionKey(key, sessionId)) return true
    }
    return false
  }

  /** 该 session 下已连上的连接名（list-connections 标 [connected] 用） */
  connectedNames(sessionId: string): string[] {
    const names: string[] = []
    for (const [key, entry] of this.connections) {
      if (isSessionKey(key, sessionId)) names.push(entry.credentialName)
    }
    return names
  }

  /** 获取该 session 下第一个连接的状态（非敏感信息），用于运行时状态展示 */
  getConnectionInfo(
    sessionId: string
  ): { host: string; database: string; dbType: DbType; username: string } | undefined {
    for (const [key, entry] of this.connections) {
      if (isSessionKey(key, sessionId)) {
        return {
          host: entry.host,
          database: entry.database,
          dbType: entry.dbType,
          username: entry.username
        }
      }
    }
    return undefined
  }

  /**
   * 会话状态条上的 `db` 一条：第一条连接的「库类型 库名」，同时连着几条时标上还有几条；没有连接 →
   * undefined。状态条是给用户看的（主机名在这里可以出现），模型看不到它。
   */
  runtimeStatus(sessionId: string): RuntimeStatus | undefined {
    const info = this.getConnectionInfo(sessionId)
    if (!info) return undefined
    const more = this.connectedNames(sessionId).length - 1
    return {
      label: `${info.dbType} ${info.database}${more > 0 ? ` +${more}` : ''}`,
      icon: 'Database',
      color: '#f59e0b',
      description: info.host
    }
  }

  private resetIdleTimeout(key: string): void {
    const entry = this.connections.get(key)
    if (!entry) return
    clearTimeout(entry.destroyTimer)
    entry.destroyTimer = setTimeout(() => {
      log.info(`Idle timeout, disconnecting key=${key}`)
      this.disconnectByKey(key).catch(() => {})
    }, IDLE_TIMEOUT_MS)
  }
}

export const dbManager = new DbManager()

// ────────────────────────────────────────────────────────────────
// 表格格式化工具
// ────────────────────────────────────────────────────────────────

function formatTable(fields: string[], rows: Record<string, unknown>[]): string {
  // 计算每列最大宽度
  const widths = fields.map((f) => f.length)
  for (const row of rows) {
    for (let i = 0; i < fields.length; i++) {
      const val = String(row[fields[i]] ?? 'NULL')
      if (val.length > widths[i]) widths[i] = val.length
    }
  }

  const sep = widths.map((w) => '-'.repeat(w + 2)).join('+')
  const header = fields.map((f, i) => ` ${f.padEnd(widths[i])} `).join('|')
  const dataRows = rows.map((row) =>
    fields.map((f, i) => ` ${String(row[f] ?? 'NULL').padEnd(widths[i])} `).join('|')
  )

  return [
    `+${sep}+`,
    `|${header}|`,
    `+${sep}+`,
    ...dataRows.map((r) => `|${r}|`),
    `+${sep}+`,
    `(${rows.length} row${rows.length === 1 ? '' : 's'})`
  ].join('\n')
}
