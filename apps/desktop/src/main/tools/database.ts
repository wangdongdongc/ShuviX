/**
 * Database 工具 — 连接远程 MySQL/PostgreSQL 数据库并执行查询
 * 单一 query 接口，连接由 dbManager 自动管理（自动建立、空闲超时自动断开）
 *
 * 询问：每次查询都过安全模块（客体 `{type:'database', sql, credential, dbType, readonly}`）。
 * 内置 ask-on-database 策略对**可写连接**逐条 ask、只读连接放行 —— 刻意不按 SQL
 * 文本分辨读写（`WITH x AS (...) INSERT`、注释前缀、分号多语句都能骗过这类判定），
 * 与命令询问同一理由。只读连接的实际保护来自 DB 服务端的 read-only 会话标志
 * （dbManager 建连时下发），不依赖模式匹配。
 */

import { Type } from 'typebox'
import { dbManager } from '../services/dbManager'
import { dbCredentialDao } from '../dao/dbCredentialDao'
import { BaseTool } from '@shuvix/agent-runtime'
import { getDesktopSecurityContext, TOOL_ABORTED, type ToolContext } from '../services/toolContext'
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
      'SQL statement to execute. Read-only connections reject writes; on writable connections each statement is shown to the user, who must confirm it.'
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
    toolCallId: string,
    params: {
      credentialName: string
      sql: string
      description?: string
    },
    signal?: AbortSignal
  ): Promise<AgentToolResult<DatabaseToolDetails>> {
    if (signal?.aborted) throw new Error(TOOL_ABORTED)

    const { credentialName, sql } = params

    // 凭据不存在时不评估：查询根本跑不起来，connectAndQuery 会给出「无此凭据」的可行动错误
    const credential = dbCredentialDao.findByName(credentialName)
    if (credential) {
      const outcome = await getDesktopSecurityContext(this.ctx).enforceDatabase(
        {
          sql,
          credential: credentialName,
          dbType: credential.dbType,
          readonly: credential.readonly
        },
        {
          toolCallId,
          toolName: 'database',
          description: params.description,
          abortError: TOOL_ABORTED,
          // 用户选「其它」：不执行 SQL，把反馈文本作为正常 tool result 返回（同 bash/ssh）
          onOther: 'return',
          // fail-closed：ask 且无询问通道 → 拒绝
          missingChannel: 'deny'
        }
      )
      if (outcome.status === 'feedback') {
        return {
          content: [
            {
              type: 'text',
              text: `Query was not executed. User responded with feedback instead:\n${outcome.text}`
            }
          ],
          details: { type: 'database', action: 'query', success: false, credentialName }
        }
      }
    }

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
  getLabel: () => t('tool.remoteDbLabel'),
  getHint: () => t('tool.remoteDbHint'),
  factory: (ctx) => new DatabaseTool(ctx),
  presentation: {
    icon: 'Database',
    iconColor: '#f59e0b'
  },
  describe: () => ({ description: getDatabaseDescription(), parameters: DatabaseParamsSchema })
})
