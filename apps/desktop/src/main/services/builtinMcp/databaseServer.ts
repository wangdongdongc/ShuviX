/**
 * 内置能力服务器 `database` —— 进程内 MCP server，按会话实例化，仅桌面（扩展没有 DB 驱动）。
 *
 * **凭据归 ShuviX 管**，与 ssh 正相反：数据库没有一份人人都有、各家驱动都认的用户级配置
 * （`~/.pgpass`、`~/.my.cnf` 各管各的，也表达不了「只读」这种 ShuviX 自己的语义），所以连接仍存在
 * `db_credentials` 表里、由设置页维护。模型只按**连接名**引用它们：密码 / token / 主机 / 用户名
 * 从不进工具参数、结果或描述 —— 设置页对用户的承诺是「AI 能发起连接，但看不到凭据内容」。
 *
 * 为什么值得内置（三项特权都用上了，外加凭据）：
 *  - **专属安全客体**：`query` 走 `enforceDatabase`，客体 `{type:'database', sql, credential, dbType,
 *    readonly}` —— 内置 ask-on-database 对可写连接逐条问、只读连接放行，用户也能按连接名 / 库类型
 *    写自己的策略。一台第三方 MCP server 只过得了 L1 那道「有人要调工具」的门。
 *  - **进程内询问**：ask 卡片与内置工具同一条路由（toolCallId 经 `_meta` 传进来）。
 *  - **专属渲染**：图标、标签与「连接名 · 说明」的折叠摘要（chat-protocol builtinMcpPresentations）。
 *  - 凭据在进程内直接读 DAO，秘密不出主进程。
 *
 * 刻意只有两个工具。不做 list-tables / describe：由 server 代生成的元数据查询，要么绕开
 * 「可写连接逐条问」，要么逐条问到烦人 —— 探 schema 就是模型自己写 SQL（information_schema 等），
 * 与旧 database 工具相同。也不做 disconnect：空闲 10 分钟自动断开，会话状态条上有断开按钮。
 *
 * 用**低层 `Server`**（纯 JSON Schema）而不是 `McpServer`（要 zod shape），理由同 ssh。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { BuiltinMcpFactory } from '@shuvix/agent-runtime'
import { dbCredentialDao } from '../../dao/dbCredentialDao'
import { getDesktopSecurityContext, TOOL_ABORTED } from '../toolContext'
import { dbManager } from './dbConnections'
import type { DesktopBuiltinMcpScope } from './types'
import { createLogger } from '../../logger'

const log = createLogger('mcp:database')

/** `mcp_servers.name` —— 也是工具名前缀（`mcp__database__query`） */
export const DATABASE_MCP_SERVER_NAME = 'database'

/** 设置里去哪加连接 —— 空列表与未知连接名的报错都指向这里 */
const WHERE_TO_ADD =
  "Ask the user to add one in ShuviX's settings: MCP → the built-in database server → saved connections."

const LIST_CONNECTIONS_TOOL = {
  name: 'list-connections',
  title: 'List saved database connections',
  description:
    "List the database connections the user has saved in ShuviX: each one's name, engine, whether it is read-only, and whether this session is already connected to it. Pass a name from this list as `connection` to query. Hosts, users and passwords are never shown and cannot be supplied here — connections are added by the user in settings.",
  // 无参工具的规范写法：显式只接受空对象
  inputSchema: { type: 'object' as const, additionalProperties: false },
  outputSchema: {
    type: 'object' as const,
    properties: {
      connections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            engine: { type: 'string', description: 'mysql or postgresql' },
            readonly: { type: 'boolean' },
            connected: {
              type: 'boolean',
              description: 'True when this session already holds an open connection to it'
            }
          },
          required: ['name', 'engine', 'readonly', 'connected']
        }
      }
    },
    required: ['connections']
  },
  annotations: {
    title: 'List saved database connections',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}

const QUERY_TOOL = {
  name: 'query',
  title: 'Run SQL on a saved connection',
  description:
    'Run exactly one SQL statement on a saved MySQL or PostgreSQL connection — several statements separated by semicolons are refused, so split them into separate calls. Rows come back as a text table (long results are cut in the middle); a statement without a result set reports how many rows it affected. `connection` is a name from list-connections. Explore a schema with ordinary SQL — information_schema, SHOW TABLES on MySQL, pg_catalog on PostgreSQL. A read-only connection runs every statement inside a read-only transaction enforced by the database server itself, so writes fail there; on a connection with write access every statement is shown to the user, who must confirm it. The connection opens on first use, is reused, and closes after 10 minutes idle.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      connection: {
        type: 'string',
        description: 'Name of a saved connection (see list-connections).'
      },
      sql: { type: 'string', description: 'The SQL statement to run.' },
      description: {
        type: 'string',
        description: 'One short line on what this query does and why. Shown to the user.'
      }
    },
    required: ['connection', 'sql', 'description'],
    additionalProperties: false
  },
  annotations: {
    title: 'Run SQL on a saved connection',
    // 可写连接上一条 SQL 能做任何事 —— 这条提示是给策略用的，不因「多数查询只是读」调软。
    // 只读连接的真保护在数据库自己的会话标志上，不在这里
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true
  }
}

/** 这台 server 的全部工具（守护用例拿它与 chat-protocol 的呈现清单对照） */
export const DATABASE_TOOLS = [LIST_CONNECTIONS_TOOL, QUERY_TOOL]

export function createDatabaseMcpServerFactory(): BuiltinMcpFactory<DesktopBuiltinMcpScope> {
  return (scope, transport) => createDatabaseMcpServer(scope, transport)
}

export async function createDatabaseMcpServer(
  scope: DesktopBuiltinMcpScope,
  transport: Transport
): Promise<void> {
  const server = new Server(
    { name: 'shuvix-database', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DATABASE_TOOLS }))

  const err = (text: string): CallToolResult => ({
    content: [{ type: 'text' as const, text }],
    isError: true
  })

  /** 已保存的连接（只取名字 / 类型 / 只读 —— 不解密任何东西）；每次现读，用户可能刚在设置里改过 */
  const savedConnections = (): Array<{ name: string; dbType: string; readonly: boolean }> =>
    dbCredentialDao.findAllNamesWithType() ?? []

  /** 连接状态条：有连接时显示「库类型 库名」与主机，一条都没了就清掉 */
  const announce = (): void => {
    scope.emitChatEvent?.({
      type: 'runtime_event',
      runtimeId: 'db',
      status: dbManager.runtimeStatus(scope.sessionId) ?? null
    })
  }
  // 连接集合一变就刷新状态条 —— 连上、断开、空闲超时断开、设置里改了凭据被断开，都走这一条；
  // 「查询成功之后再报」会漏掉连上了却查失败、以及空闲断开这两种
  const stopWatching = dbManager.onChange((sessionId) => {
    if (sessionId === scope.sessionId) announce()
  })

  const handleListConnections = (): CallToolResult => {
    const saved = savedConnections()
    const connected = new Set(dbManager.connectedNames(scope.sessionId))
    const connections = saved.map((c) => ({
      name: c.name,
      engine: c.dbType,
      readonly: c.readonly,
      connected: connected.has(c.name)
    }))
    const text =
      connections.length === 0
        ? `No database connections are saved yet. ${WHERE_TO_ADD}`
        : [
            `${connections.length} saved connection(s):`,
            ...connections.map(
              (c) =>
                `  ${c.name}  (${c.engine}${c.readonly ? ', read-only' : ''})${c.connected ? '  [connected]' : ''}`
            )
          ].join('\n')
    return {
      // 规范要求带 outputSchema 的工具同时回一份序列化文本，供不读 structuredContent 的客户端
      content: [{ type: 'text' as const, text }],
      structuredContent: { connections }
    }
  }

  const handleQuery = async (
    args: Record<string, unknown>,
    toolCallId: string,
    signal: AbortSignal
  ): Promise<CallToolResult> => {
    const name = typeof args.connection === 'string' ? args.connection.trim() : ''
    const sql = typeof args.sql === 'string' ? args.sql : ''
    if (!name) return err('A `connection` name is required — see list-connections.')
    if (!sql.trim()) return err('An `sql` statement is required.')

    // 连接名必须**确实是已保存的那一个** —— 找不到就不评估、不连：查询根本跑不起来
    const saved = savedConnections()
    const credential = saved.find((c) => c.name === name)
    if (!credential) {
      return err(
        saved.length === 0
          ? `No database connections are saved yet, so "${name}" cannot be used. ${WHERE_TO_ADD}`
          : `No saved connection named "${name}". Saved connections: ${saved.map((c) => c.name).join(', ')}.`
      )
    }

    // 语句级安全门 —— 与旧 database 工具同一个客体、同一组选项
    const outcome = await getDesktopSecurityContext({
      sessionId: scope.sessionId,
      requestUserInput: scope.requestUserInput
    }).enforceDatabase(
      { sql, credential: name, dbType: credential.dbType, readonly: credential.readonly },
      {
        toolCallId,
        toolName: `mcp__${DATABASE_MCP_SERVER_NAME}__${QUERY_TOOL.name}`,
        description: typeof args.description === 'string' ? args.description : undefined,
        abortError: TOOL_ABORTED,
        // 用户选「其它」：不执行，把反馈作为正常结果带回（同 bash / ssh）
        onOther: 'return',
        // fail-closed：该问却没有询问通道 → 拒绝
        missingChannel: 'deny'
      }
    )
    if (outcome.status === 'feedback') {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Query was not executed. User responded with feedback instead:\n${outcome.text}`
          }
        ]
      }
    }
    // 询问可能挂了很久，这期间调用方可能早已放弃 —— 那时绝不能再去执行这条 SQL
    if (signal.aborted) return err('Aborted')

    try {
      // 把刚读到的只读位带过去：手里那条连接若是按旧配置建的（用户刚在设置里改了只读），重连
      const text = await dbManager.connectAndQuery(scope.sessionId, name, sql, {
        readonly: credential.readonly
      })
      return { content: [{ type: 'text' as const, text }] }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      log.warn(`query failed session=${scope.sessionId} connection=${name}: ${message}`)
      return err(`Database error: ${message}`)
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    // 客户端把 pi 那边的 toolCallId 放在 `_meta` 里（见 McpManager.callTool）——
    // 询问卡片用它做路由键，于是这台服务器的 ask 和内置工具的 ask 长得一样
    const meta = request.params._meta as Record<string, unknown> | undefined
    const toolCallId =
      typeof meta?.['shuvix.dev/toolCallId'] === 'string'
        ? (meta['shuvix.dev/toolCallId'] as string)
        : `database-${String(extra.requestId)}`

    try {
      switch (request.params.name) {
        case LIST_CONNECTIONS_TOOL.name:
          return handleListConnections()
        case QUERY_TOOL.name:
          return await handleQuery(args, toolCallId, extra.signal)
        default:
          return err(`Unknown tool: ${request.params.name}`)
      }
    } catch (e: unknown) {
      // 客户端已经放弃了这次调用（取消 / 超时），SDK 不会再回任何东西 —— 抛出即可
      if (extra.signal.aborted) throw e
      // 门的拒绝（策略拒绝 / 用户拒绝 / 没有询问通道）：原样作为这次调用的失败回给模型
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  // 会话没了（或用户在设置里停用了这台内置 server）→ McpManager 关掉这条连接 → 传播到这一侧 →
  // 断开该会话名下的全部数据库连接。旧 database 工具从不在会话删除时断开，只靠空闲超时。
  // InMemoryTransport 关一端会顺带关另一端、再回调到这里 —— 只收一次
  let closed = false
  transport.onclose = (): void => {
    if (closed) return
    closed = true
    stopWatching()
    const held = dbManager.connectedNames(scope.sessionId).length
    void dbManager
      .disconnect(scope.sessionId)
      .then(() => {
        if (held > 0) announce()
        log.info(`database server closed session=${scope.sessionId} (${held} connection(s))`)
      })
      .catch((e: unknown) =>
        log.warn(`database close failed: ${e instanceof Error ? e.message : String(e)}`)
      )
  }

  await server.connect(transport)
  log.info(`database server ready session=${scope.sessionId}`)
}
