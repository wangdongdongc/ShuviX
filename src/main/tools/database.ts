/**
 * Database 工具 — 连接远程 MySQL/PostgreSQL 数据库并执行查询
 * 支持 connect / query / disconnect / list_tables / describe_table 五个动作
 */

import { Type } from '@sinclair/typebox'
import { dbManager } from '../services/dbManager'
import { dbCredentialDao } from '../dao/dbCredentialDao'
import { BaseTool, TOOL_ABORTED, type ToolContext } from './types'
import type { AgentToolResult } from '@mariozechner/pi-agent-core'
import type { DatabaseToolDetails } from '../../shared/types/chatMessage'
import { t } from '../i18n'
import { createLogger } from '../logger'

const log = createLogger('Tool:database')

const DatabaseParamsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('connect'),
      Type.Literal('query'),
      Type.Literal('disconnect'),
      Type.Literal('list_tables'),
      Type.Literal('describe_table')
    ],
    {
      description:
        'Action to perform: "connect" to establish a database connection, "query" to execute SQL, "list_tables" to list all tables, "describe_table" to show table structure, "disconnect" to close the connection.'
    }
  ),
  credentialName: Type.Optional(
    Type.String({
      description: 'Name of a saved database credential (required for connect action).'
    })
  ),
  sql: Type.Optional(
    Type.String({
      description:
        'SQL statement to execute (required for query action). Only SELECT and read-only statements are allowed.'
    })
  ),
  description: Type.Optional(
    Type.String({
      description: 'Brief description of what this query does and why.'
    })
  ),
  tableName: Type.Optional(
    Type.String({
      description: 'Table name to describe (required for describe_table action).'
    })
  )
})

export class DatabaseTool extends BaseTool<typeof DatabaseParamsSchema> {
  readonly name = 'remote_db'
  readonly parameters = DatabaseParamsSchema

  get label(): string {
    return t('tool.remoteDbLabel')
  }

  get description(): string {
    const creds = dbCredentialDao.findAllNamesWithType()
    let desc =
      'Connect and query remote MySQL/PostgreSQL databases. Supports SELECT queries and schema inspection.'
    if (creds.length > 0) {
      const credList = creds
        .map((c) => `"${c.name}" (${c.dbType}${c.readonly ? ', readonly' : ''})`)
        .join(', ')
      desc += ` Available connections: [${credList}]. Use connect with credentialName to connect, e.g. database({ action: "connect", credentialName: "${creds[0].name}" }).`
    } else {
      desc +=
        ' No credentials configured yet — ask the user to add database credentials in Settings > Tools > Database.'
    }
    desc +=
      ' After connecting, use list_tables to explore the schema, describe_table to inspect columns, and query to run SELECT statements.'
    return desc
  }

  constructor(private ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    _toolCallId: string,
    params: {
      action: 'connect' | 'query' | 'disconnect' | 'list_tables' | 'describe_table'
      credentialName?: string
      sql?: string
      description?: string
      tableName?: string
    },
    signal?: AbortSignal
  ): Promise<AgentToolResult<DatabaseToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    switch (params.action) {
      case 'connect':
        return handleConnect(this.ctx, params.credentialName, signal)
      case 'query':
        return handleQuery(this.ctx, params.sql, signal)
      case 'disconnect':
        return handleDisconnect(this.ctx)
      case 'list_tables':
        return handleListTables(this.ctx, signal)
      case 'describe_table':
        return handleDescribeTable(this.ctx, params.tableName, signal)
      default:
        throw new Error(`Unknown action: ${params.action}`)
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Action handlers
// ────────────────────────────────────────────────────────────────

async function handleConnect(
  ctx: ToolContext,
  credentialName: string | undefined,
  signal?: AbortSignal
): Promise<AgentToolResult<DatabaseToolDetails>> {
  if (!credentialName) {
    throw new Error('credentialName is required for connect action.')
  }

  if (dbManager.isConnected(ctx.sessionId)) {
    const info = dbManager.getConnectionInfo(ctx.sessionId)
    return {
      content: [
        {
          type: 'text',
          text: `Already connected to ${info?.dbType} database "${info?.database}" on ${info?.host}. Use disconnect first to switch connections.`
        }
      ],
      details: { type: 'remote_db', action: 'connect', success: true, credentialName }
    }
  }

  const cred = dbCredentialDao.findByName(credentialName)
  if (!cred) {
    const available = dbCredentialDao.findAllNamesWithType()
    const hint =
      available.length > 0
        ? ` Available credentials: [${available.map((c) => c.name).join(', ')}].`
        : ' No credentials configured.'
    return {
      content: [
        {
          type: 'text',
          text: `No saved database credential found with name "${credentialName}".${hint}`
        }
      ],
      details: { type: 'remote_db', action: 'connect', success: false, credentialName }
    }
  }

  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  log.info(`Connecting to ${cred.dbType} ${cred.host}/${cred.database} session=${ctx.sessionId}`)
  const result = await dbManager.connect(ctx.sessionId, cred)

  if (result.success) {
    return {
      content: [
        {
          type: 'text',
          text: `Connected to ${cred.dbType} database "${cred.database}" on ${cred.host} as ${cred.username}${cred.readonly ? ' (readonly)' : ''}. Use list_tables to explore the schema.`
        }
      ],
      details: { type: 'remote_db', action: 'connect', success: true, credentialName }
    }
  } else {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to connect using credential "${credentialName}": ${result.error}. Please ask the user to check their database credential configuration in Settings > Tools > Database.`
        }
      ],
      details: {
        type: 'remote_db',
        action: 'connect',
        success: false,
        credentialName,
        error: result.error
      }
    }
  }
}

async function handleQuery(
  ctx: ToolContext,
  sql: string | undefined,
  signal?: AbortSignal
): Promise<AgentToolResult<DatabaseToolDetails>> {
  if (!sql) {
    throw new Error('sql is required for query action.')
  }
  if (!dbManager.isConnected(ctx.sessionId)) {
    throw new Error(
      'Not connected to any database. Use database({ action: "connect", credentialName: "..." }) first.'
    )
  }
  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  const text = await dbManager.query(ctx.sessionId, sql)
  return {
    content: [{ type: 'text', text }],
    details: { type: 'remote_db', action: 'query', success: true }
  }
}

async function handleDisconnect(ctx: ToolContext): Promise<AgentToolResult<DatabaseToolDetails>> {
  if (!dbManager.isConnected(ctx.sessionId)) {
    return {
      content: [{ type: 'text', text: 'No active database connection to disconnect.' }],
      details: { type: 'remote_db', action: 'disconnect', success: false }
    }
  }
  await dbManager.disconnect(ctx.sessionId)
  return {
    content: [{ type: 'text', text: 'Database connection closed.' }],
    details: { type: 'remote_db', action: 'disconnect', success: true }
  }
}

async function handleListTables(
  ctx: ToolContext,
  signal?: AbortSignal
): Promise<AgentToolResult<DatabaseToolDetails>> {
  if (!dbManager.isConnected(ctx.sessionId)) {
    throw new Error(
      'Not connected to any database. Use database({ action: "connect", credentialName: "..." }) first.'
    )
  }
  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  const info = dbManager.getConnectionInfo(ctx.sessionId)!
  let sql: string
  if (info.dbType === 'mysql') {
    sql = 'SHOW TABLES'
  } else {
    sql = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  }

  const text = await dbManager.query(ctx.sessionId, sql)
  return {
    content: [{ type: 'text', text }],
    details: { type: 'remote_db', action: 'list_tables', success: true }
  }
}

async function handleDescribeTable(
  ctx: ToolContext,
  tableName: string | undefined,
  signal?: AbortSignal
): Promise<AgentToolResult<DatabaseToolDetails>> {
  if (!tableName) {
    throw new Error('tableName is required for describe_table action.')
  }
  if (!dbManager.isConnected(ctx.sessionId)) {
    throw new Error(
      'Not connected to any database. Use database({ action: "connect", credentialName: "..." }) first.'
    )
  }
  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  const info = dbManager.getConnectionInfo(ctx.sessionId)!
  let sql: string
  if (info.dbType === 'mysql') {
    // DESCRIBE は読み取り専用なので WRITE_KEYWORDS には引っかからない
    sql = `SELECT COLUMN_NAME as column_name, COLUMN_TYPE as data_type, IS_NULLABLE as is_nullable, COLUMN_DEFAULT as column_default, COLUMN_KEY as \`key\`, EXTRA as extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tableName.replace(/'/g, "''")}' ORDER BY ORDINAL_POSITION`
  } else {
    sql = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${tableName.replace(/'/g, "''")}' ORDER BY ordinal_position`
  }

  const text = await dbManager.query(ctx.sessionId, sql)
  return {
    content: [{ type: 'text', text }],
    details: { type: 'remote_db', action: 'describe_table', success: true }
  }
}

import { registerBuiltinTool } from './registry'
registerBuiltinTool({
  name: 'remote_db',
  group: 'remote',
  defaultEnabled: false,
  getLabel: () => t('tool.remoteDbLabel'),
  getHint: () => t('tool.remoteDbHint'),
  factory: (ctx) => new DatabaseTool(ctx)
})
