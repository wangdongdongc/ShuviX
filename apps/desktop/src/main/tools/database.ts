/**
 * Database 工具 — 连接远程 MySQL/PostgreSQL 数据库并执行查询
 * 单一 query 接口，连接由 dbManager 自动管理（自动建立、空闲超时自动断开）
 */

import { Type } from 'typebox'
import { dbManager } from '../services/dbManager'
import { dbCredentialDao } from '../dao/dbCredentialDao'
import { BaseTool } from '@shuvix/agent-runtime'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { DatabaseToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { t } from '../i18n'
import { createLogger } from '../logger'

const log = createLogger('Tool:database')

const DatabaseParamsSchema = Type.Object({
  credentialName: Type.String({
    description: 'Name of a saved database credential to query against.'
  }),
  sql: Type.String({
    description:
      'SQL statement to execute. Only SELECT and read-only statements are allowed on readonly connections.'
  }),
  description: Type.Optional(
    Type.String({
      description: 'Brief description of what this query does and why.'
    })
  )
})

function getDatabaseDescription(): string {
  const creds = dbCredentialDao.findAllNamesWithType() || []
  let desc =
    'Query remote MySQL/PostgreSQL databases. Generate SQL directly to explore schemas, inspect tables, and query data. Connection is managed automatically — just provide a credential name and SQL.'
  if (creds && creds.length > 0) {
    const credList = creds
      .map((c) => `"${c.name}" (${c.dbType}${c.readonly ? ', readonly' : ''})`)
      .join(', ')
    desc += ` Available connections: [${credList}].`
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
      credentialName: string
      sql: string
      description?: string
    },
    signal?: AbortSignal
  ): Promise<AgentToolResult<DatabaseToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const { credentialName, sql } = params

    try {
      const text = await dbManager.connectAndQuery(this.ctx.sessionId, credentialName, sql)

      // 更新运行时状态指示器
      const info = dbManager.getConnectionInfo(this.ctx.sessionId)
      if (info) {
        this.ctx.emitChatEvent?.({
          type: 'runtime_event',
          runtimeId: 'db',
          status: {
            label: `${info.dbType} ${info.database}`,
            icon: 'Database',
            color: '#f59e0b',
            description: info.host
          }
        })
      }

      return {
        content: [{ type: 'text', text }],
        details: { type: 'database', action: 'query', success: true, credentialName }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(`Database query failed: ${error}`)
      return {
        content: [{ type: 'text', text: `Database error: ${error}` }],
        details: { type: 'database', action: 'query', success: false, credentialName, error }
      }
    }
  }
}

import { registerBuiltinTool } from '../services/toolRegistry'
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
