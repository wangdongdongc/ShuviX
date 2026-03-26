/**
 * 数据库连接管理器
 * 管理 per-session 的 MySQL/PostgreSQL 连接生命周期
 * 空闲超时后自动断开
 */

import { createLogger } from '../logger'
import type { DbCredential, DbType } from '../dao/types'
import { truncateMiddle, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from '../../shared/node/truncate'

const log = createLogger('DbManager')

/** 空闲超时时间（10 分钟） */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000

/** 写操作关键词正则（只读防护第一层） */
const WRITE_KEYWORDS =
  /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE|CALL|EXEC)\b/i

// 使用动态 import 以支持纯 JS 驱动（无 native binding）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mysql = require('mysql2/promise') as typeof import('mysql2/promise')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client: PgClient } = require('pg') as typeof import('pg')

type MysqlConnection = Awaited<ReturnType<(typeof mysql)['createConnection']>>

interface ConnectionEntry {
  client: MysqlConnection | InstanceType<typeof PgClient>
  dbType: DbType
  host: string
  database: string
  username: string
  destroyTimer?: ReturnType<typeof setTimeout>
}

export class DbManager {
  private connections = new Map<string, ConnectionEntry>()

  /** 建立数据库连接 */
  async connect(
    sessionId: string,
    credential: DbCredential
  ): Promise<{ success: boolean; error?: string }> {
    await this.disconnect(sessionId)

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
        this.connections.set(sessionId, {
          client: conn,
          dbType: 'mysql',
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
        this.connections.set(sessionId, {
          client,
          dbType: 'postgresql',
          host: credential.host,
          database: credential.database,
          username: credential.username
        })
      }
      this.resetIdleTimeout(sessionId)
      log.info(
        `Connected to ${credential.dbType} ${credential.host}/${credential.database} session=${sessionId}`
      )
      return { success: true }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(`Connection failed: ${error}`)
      return { success: false, error }
    }
  }

  /** 执行 SQL 查询，返回格式化表格文本 */
  async query(sessionId: string, sql: string): Promise<string> {
    if (WRITE_KEYWORDS.test(sql)) {
      throw new Error(
        'Write operations are not allowed. This connection is in readonly mode. Only SELECT and read-only statements are permitted.'
      )
    }

    const entry = this.connections.get(sessionId)
    if (!entry) {
      throw new Error(
        'Not connected to any database. Use database({ action: "connect", credentialName: "..." }) first.'
      )
    }

    this.resetIdleTimeout(sessionId)

    let rows: Record<string, unknown>[]
    let fields: string[]

    if (entry.dbType === 'mysql') {
      const conn = entry.client as MysqlConnection
      const [result, fieldDefs] = await conn.execute(sql)
      rows = result as Record<string, unknown>[]
      fields = (fieldDefs as Array<{ name: string }>).map((f) => f.name)
    } else {
      const client = entry.client as InstanceType<typeof PgClient>
      const result = await client.query(sql)
      rows = result.rows as Record<string, unknown>[]
      fields = result.fields.map((f) => f.name)
    }

    if (rows.length === 0) {
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

  /** 断开指定 session 的连接 */
  async disconnect(sessionId: string): Promise<void> {
    const entry = this.connections.get(sessionId)
    if (!entry) return
    clearTimeout(entry.destroyTimer)
    this.connections.delete(sessionId)
    try {
      if (entry.dbType === 'mysql') {
        await (entry.client as MysqlConnection).end()
      } else {
        await (entry.client as InstanceType<typeof PgClient>).end()
      }
    } catch {
      // 忽略断开时的错误
    }
    log.info(`Disconnected session=${sessionId}`)
  }

  /** 断开所有连接（应用退出时调用） */
  disconnectAll(): void {
    for (const sessionId of this.connections.keys()) {
      this.disconnect(sessionId).catch(() => {})
    }
  }

  /** 是否已连接 */
  isConnected(sessionId: string): boolean {
    return this.connections.has(sessionId)
  }

  /** 获取连接状态（非敏感信息） */
  getConnectionInfo(
    sessionId: string
  ): { host: string; database: string; dbType: DbType; username: string } | undefined {
    const entry = this.connections.get(sessionId)
    if (!entry) return undefined
    return {
      host: entry.host,
      database: entry.database,
      dbType: entry.dbType,
      username: entry.username
    }
  }

  private resetIdleTimeout(sessionId: string): void {
    const entry = this.connections.get(sessionId)
    if (!entry) return
    clearTimeout(entry.destroyTimer)
    entry.destroyTimer = setTimeout(() => {
      log.info(`Idle timeout, disconnecting session=${sessionId}`)
      this.disconnect(sessionId).catch(() => {})
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
