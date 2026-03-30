/**
 * 数据库连接管理器
 * 管理 per-session 的 MySQL/PostgreSQL 连接生命周期
 * 支持同一 session 同时持有多个不同凭据的连接
 * 空闲超时后自动断开
 */

import { createLogger } from '../logger'
import { dbCredentialDao } from '../dao/dbCredentialDao'
import type { DbCredential, DbType } from '../dao/types'
import { truncateMiddle, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from '../../shared/node/truncate'

const log = createLogger('DbManager')

/** 空闲超时时间（10 分钟） */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000

/** 写操作关键词正则（只读防护第一层） */
const WRITE_KEYWORDS =
  /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE|CALL|EXEC|SET\s+(GLOBAL|SESSION)|FLUSH|GRANT|REVOKE|LOCK|UNLOCK)\b/i

// 使用动态 import 以支持纯 JS 驱动（无 native binding）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mysql = require('mysql2/promise') as typeof import('mysql2/promise')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client: PgClient } = require('pg') as typeof import('pg')

type MysqlConnection = Awaited<ReturnType<(typeof mysql)['createConnection']>>

interface ConnectionEntry {
  client: MysqlConnection | InstanceType<typeof PgClient>
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

export class DbManager {
  private connections = new Map<string, ConnectionEntry>()

  /** 建立数据库连接（内部使用复合 key） */
  async connect(
    sessionId: string,
    credential: DbCredential
  ): Promise<{ success: boolean; error?: string }> {
    const key = connKey(sessionId, credential.name)
    // 如果已有同名连接，先断开
    await this.disconnectByKey(key)

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
        if (credential.readonly) {
          await conn.execute('SET SESSION TRANSACTION READ ONLY')
        }
        this.connections.set(key, {
          client: conn,
          credentialName: credential.name,
          dbType: 'mysql',
          readonly: credential.readonly,
          host: credential.host,
          database: credential.database,
          username: credential.username
        })
      } else {
        const client = new PgClient({
          host: credential.host,
          port: credential.port,
          user: credential.username,
          password: credential.password,
          database: credential.database,
          connectionTimeoutMillis: 15000
        })
        await client.connect()
        if (credential.readonly) {
          await client.query('SET default_transaction_read_only = on')
        }
        this.connections.set(key, {
          client,
          credentialName: credential.name,
          dbType: 'postgresql',
          readonly: credential.readonly,
          host: credential.host,
          database: credential.database,
          username: credential.username
        })
      }
      this.resetIdleTimeout(key)
      log.info(
        `Connected to ${credential.dbType} ${credential.host}/${credential.database} key=${key}`
      )
      return { success: true }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(`Connection failed: ${error}`)
      return { success: false, error }
    }
  }

  /**
   * 自动连接并执行查询（简化接口）
   * 如果对应凭据的连接不存在，自动建立连接后执行 SQL
   */
  async connectAndQuery(sessionId: string, credentialName: string, sql: string): Promise<string> {
    const key = connKey(sessionId, credentialName)

    // 如果没有活跃连接，自动建立
    if (!this.connections.has(key)) {
      const cred = dbCredentialDao.findByName(credentialName)
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

    return this.queryByKey(key, sql)
  }

  /** 执行 SQL 查询，返回格式化表格文本（通过复合 key） */
  private async queryByKey(key: string, sql: string): Promise<string> {
    const entry = this.connections.get(key)
    if (!entry) {
      throw new Error('Not connected to any database.')
    }

    if (entry.readonly && WRITE_KEYWORDS.test(sql)) {
      log.warn(`Blocked write operation in readonly mode: ${sql.substring(0, 100)}`)
      throw new Error(
        'Write operations are not allowed. This connection is in readonly mode. Only SELECT and read-only statements are permitted.'
      )
    }

    this.resetIdleTimeout(key)

    let rows: Record<string, unknown>[]
    let fields: string[]

    if (entry.dbType === 'mysql') {
      const conn = entry.client as MysqlConnection
      const [result, fieldDefs] = await conn.execute(sql)
      rows = result as Record<string, unknown>[]
      // Some commands (SET, FLUSH, etc.) don't return field definitions
      fields =
        fieldDefs && Array.isArray(fieldDefs)
          ? (fieldDefs as Array<{ name: string }>).map((f) => f.name)
          : []
    } else {
      const client = entry.client as InstanceType<typeof PgClient>
      const result = await client.query(sql)
      rows = (result.rows || []) as Record<string, unknown>[]
      // Some commands (SET, FLUSH, etc.) don't return field definitions
      fields = result.fields ? result.fields.map((f) => f.name) : []
    }

    if (!rows || rows.length === 0) {
      return '(0 rows)'
    }

    const text = formatTable(fields, rows)
    const truncated = truncateMiddle(text, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)

    if (truncated.truncated) {
      return `[Output truncated: ${truncated.originalLines} lines]\n\n${truncated.text}`
    }
    return truncated.text
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

  /** 断开指定复合 key 的单个连接 */
  private async disconnectByKey(key: string): Promise<void> {
    const entry = this.connections.get(key)
    if (!entry) return
    clearTimeout(entry.destroyTimer)
    this.connections.delete(key)
    try {
      if (entry.dbType === 'mysql') {
        await (entry.client as MysqlConnection).end()
      } else {
        await (entry.client as InstanceType<typeof PgClient>).end()
      }
    } catch {
      // 忽略断开时的错误
    }
    log.info(`Disconnected key=${key}`)
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
