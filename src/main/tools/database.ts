/**
 * Database 工具 — 连接远程 MySQL/PostgreSQL 数据库并执行查询
 * 支持 connect / query / disconnect 三个动作，所有 SQL 由 AI 生成
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
  action: Type.Union([Type.Literal('connect'), Type.Literal('query'), Type.Literal('disconnect')], {
    description:
      'Action to perform: "connect" to establish a database connection, "query" to execute SQL, "disconnect" to close the connection.'
  }),
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
  )
})

function getDatabaseDescription(): string {
  const creds = dbCredentialDao.findAllNamesWithType()
  let desc =
    'Connect and query remote MySQL/PostgreSQL databases. Generate SQL directly to explore schemas, inspect tables, and query data.'
  if (creds.length > 0) {
    const credList = creds
      .map((c) => `"${c.name}" (${c.dbType}${c.readonly ? ', readonly' : ''})`)
      .join(', ')
    desc += ` Available connections: [${credList}]. Use connect with credentialName to connect, e.g. database({ action: "connect", credentialName: "${creds[0].name}" }).`
  } else {
    desc +=
      ' No credentials configured yet — ask the user to add database credentials in Settings > Tools > Database.'
  }
  return desc
}

export class DatabaseTool extends BaseTool<typeof DatabaseParamsSchema> {
  readonly name = 'database'
  readonly parameters = DatabaseParamsSchema

  get label(): string {
    return t('tool.remoteDbLabel')
  }

  get description(): string {
    return getDatabaseDescription()
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
      action: 'connect' | 'query' | 'disconnect'
      credentialName?: string
      sql?: string
      description?: string
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
      details: { type: 'database', action: 'connect', success: true, credentialName }
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
      details: { type: 'database', action: 'connect', success: false, credentialName }
    }
  }

  if (signal?.aborted) throw new Error(TOOL_ABORTED)

  log.info(`Connecting to ${cred.dbType} ${cred.host}/${cred.database} session=${ctx.sessionId}`)
  const result = await dbManager.connect(ctx.sessionId, cred)

  if (result.success) {
    ctx.emitChatEvent?.({
      type: 'runtime_event',
      runtimeId: 'db',
      status: {
        label: `${cred.dbType} ${cred.database}`,
        icon: 'Database',
        color: '#f59e0b',
        description: cred.host
      }
    })
    return {
      content: [
        {
          type: 'text',
          text: `Connected to ${cred.dbType} database "${cred.database}" on ${cred.host} as ${cred.username}${cred.readonly ? ' (readonly)' : ''}. You can now run SQL queries.`
        }
      ],
      details: { type: 'database', action: 'connect', success: true, credentialName }
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
        type: 'database',
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
    details: { type: 'database', action: 'query', success: true }
  }
}

async function handleDisconnect(ctx: ToolContext): Promise<AgentToolResult<DatabaseToolDetails>> {
  if (!dbManager.isConnected(ctx.sessionId)) {
    return {
      content: [{ type: 'text', text: 'No active database connection to disconnect.' }],
      details: { type: 'database', action: 'disconnect', success: false }
    }
  }
  await dbManager.disconnect(ctx.sessionId)
  ctx.emitChatEvent?.({
    type: 'runtime_event',
    runtimeId: 'db',
    status: null
  })
  return {
    content: [{ type: 'text', text: 'Database connection closed.' }],
    details: { type: 'database', action: 'disconnect', success: true }
  }
}
import { registerBuiltinTool } from './registry'
registerBuiltinTool({
  name: 'database',
  group: 'remote',
  defaultEnabled: false,
  getLabel: () => t('tool.remoteDbLabel'),
  getHint: () => t('tool.remoteDbHint'),
  factory: (ctx) => new DatabaseTool(ctx),
  presentation: {
    icon: 'Database',
    iconColor: '#f59e0b',
    summaryField: 'description'
  }
})
