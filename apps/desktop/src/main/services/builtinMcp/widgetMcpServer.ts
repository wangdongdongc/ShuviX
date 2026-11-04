/**
 * 组件的 MCP 服务器（2026-11-04）—— 每个有 API 的组件是一台 `widget-<id>`，它的操作是工具 `mcp__widget-<id>__<op>`。
 * agent 经 `tool_search` 或选择器开启它；`widget` 工具只管造。门后和界面是同一个分发器（callWidgetOp），效果一致。
 *
 * **没有数据库行**：组件的真相在文件系统里（widget.json + 构建产物 api.json），main 启动时把这里算出的行注册给
 * `mcpService`（setComputedMcpServers），并进 McpManager 的 store。`mcp:list` 和配置分享直接读 mcpDao，所以设置页和导出都看不到它们。
 *
 * **授权**：操作照旧过 `ask-on-widget-access`。对象上的 `selected` 说这条会话的勾选里有它：勾选是用户的同意
 * （选择器、批准过的 `tool_search` 卡片、项目保存的默认），所以读操作不再问，写操作第一次仍单独问。`selected` 只有这里
 * 会填，`widget` 工具的 `preview` / `export` 和预览页面都没有它，勾选放开的只是这里的读操作。
 *
 * **声明的变化**：连接在建立时列一次工具，agent 的锁里存着当时的声明。绿色构建改了 API、组件归档或删除时，
 * `widgetService.onServerChanged` 让这台的连接退役，下一次连接重新列；已经开着它的 agent 不跟着变（见 AgentLock.planReconfigure），
 * 别的会话的一次构建不该悄悄打穿这里的缓存。调用永远按此刻的快照判：操作没了就报错并列出现有的。
 *
 * 用**低层 `Server`**（纯 JSON Schema），理由同 ssh / database。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import { builtinCallOwnerOf, type BuiltinMcpFactory } from '@shuvix/agent-runtime'
import { isToolSelected } from '@shuvix/chat-protocol/toolSelection'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import {
  widgetSelectionEntry,
  widgetServerId,
  widgetServerName,
  widgetToolName
} from '@shuvix/chat-protocol/widgetServers'
import { sessionRecords } from '../sessionRecords'
import { assertWidgetAccess, TOOL_ABORTED } from '../toolContext'
import { agentActorOf, withCallAgent } from '../toolAgent'
import {
  agentOpProblem,
  readApiSnapshot,
  resolveAgentOp,
  runWidgetOpForAgent,
  widgetService,
  widgetStorageOf,
  type OpManifest
} from '../widget'
import { noteWidgetUse } from '../widget/noteUse'
import type { DesktopBuiltinMcpScope } from './types'
import { createLogger } from '../../logger'

const log = createLogger('mcp:widget')

const err = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true
})

/** 能声明给模型的操作（纯界面的不算；声明不合格的老操作也不算，见 agentOpProblem） */
function declarableOps(widgetId: string): OpManifest[] {
  const snapshot = widgetStorageOf(widgetId) === 'sqlite' ? readApiSnapshot(widgetId) : null
  if (!snapshot) return []
  return snapshot.ops.filter((op) => op.agent !== false && !agentOpProblem(widgetId, op))
}

/** 操作 → MCP 工具声明。没有 outputSchema：带了它，SDK 客户端会要求每个结果都是结构化的 */
function toolOf(op: OpManifest): {
  name: string
  description: string
  inputSchema: { type: 'object'; [key: string]: unknown }
  annotations: Record<string, boolean>
} {
  const { $schema: _schema, ...inputSchema } = op.input as Record<string, unknown>
  return {
    name: op.name,
    description: op.description,
    inputSchema: { ...inputSchema, type: 'object' },
    annotations: {
      // 读操作跑在只读连接上，这个提示由宿主保证；handler 没有网络也没有文件（WidgetCtx）
      readOnlyHint: op.mode === 'read',
      destructiveHint: op.mode === 'write',
      idempotentHint: false,
      openWorldHint: false
    }
  }
}

/** 行每次 MCP 调用都要读（McpManager 按名找连接时走 findAll），组件变化时失效，再加一个短 TTL 兜住目录被外部改动 */
const ROWS_TTL_MS = 5000
let cachedRows: { at: number; rows: McpServer[] } | null = null

/** 活跃、有 API、至少一个操作能声明的组件各一行 */
export function widgetServerRows(): McpServer[] {
  const now = Date.now()
  if (cachedRows && now - cachedRows.at < ROWS_TTL_MS) return cachedRows.rows
  let rows: McpServer[] = []
  try {
    rows = widgetService.listActive().flatMap((widget) => {
      const ops = declarableOps(widget.id)
      if (ops.length === 0) return []
      return [
        {
          id: widgetServerId(widget.id),
          name: widgetServerName(widget.id),
          type: 'inproc' as const,
          command: '',
          args: '[]',
          env: '{}',
          url: '',
          headers: '{}',
          metadata: '{}',
          isEnabled: 1,
          // trusted 看这一位：调用归属（_meta）只带给可信的 server，操作的读写提示也由宿主保证
          isBuiltin: 1,
          cachedTools: JSON.stringify(ops.map(toolOf)),
          createdAt: widget.createdAt,
          updatedAt: widget.updatedAt
        }
      ]
    })
  } catch (e) {
    log.warn(`listing widgets failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  cachedRows = { at: now, rows }
  return rows
}

export function invalidateWidgetServerRows(): void {
  cachedRows = null
}

export function createWidgetMcpServerFactory(
  widgetId: string
): BuiltinMcpFactory<DesktopBuiltinMcpScope> {
  return async (scope, transport) => {
    const server = new Server(
      { name: widgetServerName(widgetId), version: '1.0.0' },
      { capabilities: { tools: {} } }
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const snapshot = widgetStorageOf(widgetId) === 'sqlite' ? readApiSnapshot(widgetId) : null
      for (const op of snapshot?.ops ?? []) {
        if (op.agent === false) continue
        const problem = agentOpProblem(widgetId, op)
        if (problem) log.warn(`widget ${widgetId}: not declared: ${problem}`)
      }
      return { tools: declarableOps(widgetId).map(toolOf) }
    })

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const opName = request.params.name
      const meta = request.params._meta as Record<string, unknown> | undefined
      const toolCallId =
        typeof meta?.['shuvix.dev/toolCallId'] === 'string'
          ? (meta['shuvix.dev/toolCallId'] as string)
          : `widget-${String(extra.requestId)}`
      const owner = builtinCallOwnerOf(meta)
      try {
        // 分发器不看归档，这里看：归档了的组件不该再被改动
        const widget = widgetService.getById(widgetId)
        if (!widget || widget.archivedAt) {
          return err(`The widget "${widgetId}" was archived or deleted.`)
        }
        const entry = resolveAgentOp(widgetId, opName)
        const ctx: Parameters<typeof assertWidgetAccess>[0] = {
          sessionId: scope.sessionId,
          requestUserInput: scope.requestUserInput,
          agentOf: scope.agentOf
        }
        const selection =
          sessionRecords.pickSettings(scope.sessionId, ['enabledTools'])?.enabledTools ?? []
        await assertWidgetAccess(
          ctx,
          entry.mode,
          {
            widgetId,
            name: widget.name,
            operation: opName,
            selected: isToolSelected(selection, widgetSelectionEntry(widgetId), false)
          },
          {
            toolCallId,
            toolName: widgetToolName(widgetId, opName),
            operation: 'call',
            owner,
            signal: extra.signal
          }
        )
        // 询问可能等了很久，这期间调用方可能已经放弃
        if (extra.signal.aborted) throw new Error(TOOL_ABORTED)
        noteWidgetUse(widgetId, scope.sessionId)
        const actor = agentActorOf(withCallAgent(ctx, owner))
        const { text, isError } = await runWidgetOpForAgent(
          widgetId,
          entry,
          request.params.arguments ?? {},
          { kind: 'agent', sessionId: scope.sessionId, actor, label: actor }
        )
        return isError ? err(text) : { content: [{ type: 'text', text }] }
      } catch (e: unknown) {
        // 客户端已经放弃了这次调用，SDK 不会再回任何东西 —— 抛出即可
        if (extra.signal.aborted) throw e
        // 门的拒绝和找不到操作：作为这次调用的失败回给模型
        return err(e instanceof Error ? e.message : String(e))
      }
    })

    await server.connect(transport)
  }
}
