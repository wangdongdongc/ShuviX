/**
 * tool_search 工具 —— 模型查找这条会话没开启的 MCP 服务器（组件也是，一个组件一台），经用户确认后整台开启。
 *
 * 没勾选的服务器不占上下文，模型需要时自己找。探针（e2e/live/toolDiscovery.probe.ts）量到的差别是这个工具存在的理由：
 * 用户中途勾选时上下文末尾什么也看不到，模型照走老路；模型自己搜到的工具，下一步就会用。
 *
 * 不用 pi 的 `deferred` / `control.addTools`：服务器按整台开关，开启走的是用户勾选同一条路（勾选 → 重配），
 * 选择器、锁、子会话与分支的继承都不必另外处理。
 *
 * 确认之后的每个等待都要和 `signal` 竞争（untilAborted）。回退会先立起闸门，再等这次工具调用结束；不竞争的话，
 * 停在闸门上的重配和等它的回退就互相等死了。
 *
 * 不重跑（BaseTool 缺省 `replay: 'unsafe'`）：进程中断之后模型拿到中断结果，自己再调一次时已经开启的那台
 * 走「已经开着」的回答，不会再问一次。
 */
import { Type } from 'typebox'
import type { TObject, TString } from 'typebox'
import {
  BaseTool,
  callOwnerOf,
  type McpToolDeclaration,
  type ToolCallScope,
  type ToolResult
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import {
  safeExtensionName,
  TOOL_SEARCH_TOOL_NAME,
  withToolsSelected
} from '@shuvix/chat-protocol/toolSelection'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { widgetIdOfServer } from '@shuvix/chat-protocol/widgetServers'
import {
  extensionChoiceLine,
  extensionSourceOf,
  findExtensions,
  isExtensionOff,
  offeredServers
} from '../services/extensionDiscovery'
import { mcpService } from '../services/mcpService'
import { sessionService } from '../services/sessionService'
import { withCallAgent } from '../services/toolAgent'
import { assertExtensionAccess, type ToolContext } from '../services/toolContext'
import { registerBuiltinTool } from '../services/toolRegistry'
import { untilAborted } from '../utils/untilAborted'
import { t } from '../i18n'

/** 确认之后连接的上限：用户就在旁边等，第一次 `npx` 启动可以慢一些（创建 agent 时的惰性连接只等 5 秒） */
const CONNECT_TIMEOUT_MS = 30_000

/** 描述固定不变：它变了就是一次工具重新声明，会打穿不支持中途改工具的模型的缓存 */
export const TOOL_SEARCH_DESCRIPTION =
  'Find and turn on extensions (MCP servers) that are off in this session. ' +
  'Some capabilities, such as a browser, SSH or databases, may not be available to you yet; search before working around a missing one. ' +
  "The user's widgets are extensions too: small apps with their own records, such as a reading list or an expense log.\n\n" +
  '`query` is a few keywords for what you need, or the exact name of an extension. ' +
  'With one match the user is asked to approve it, and if they do its tools are available from your next call. ' +
  'With several you get their names: call again with the exact name of the one you need. ' +
  'Searching itself starts nothing.'

export const ToolSearchParamsSchema: TObject<{ query: TString }> = Type.Object({
  query: Type.String({
    description: 'Keywords for what you need, or the exact name of an extension.'
  })
})

const NO_MATCH = 'No matching tools found.'

const textResult = (text: string): ToolResult => ({
  content: [{ type: 'text' as const, text }],
  details: undefined
})

/** 开启之后给模型的回答：工具全名和描述首行（用户批准之后，这些声明本来就会发给模型） */
function loadedText(server: string, tools: readonly McpToolDeclaration[]): string {
  const lines = tools.map((tool) => {
    const first = (tool.description ?? '').trim().split(/\r?\n/)[0].slice(0, 200)
    return `- mcp__${server}__${tool.name}${first ? `: ${first}` : ''}`
  })
  return `Loaded ${tools.length} tool${tools.length === 1 ? '' : 's'}. They are available from your next call:\n${lines.join('\n')}`
}

interface ToolSearchParams {
  query?: unknown
}

export class ToolSearchTool extends BaseTool<typeof ToolSearchParamsSchema> {
  readonly name = TOOL_SEARCH_TOOL_NAME
  readonly label = t(BUILTIN_TOOL_PRESENTATIONS.tool_search.labelKey)
  readonly description = TOOL_SEARCH_DESCRIPTION
  readonly parameters = ToolSearchParamsSchema

  constructor(private readonly ctx: ToolContext) {
    super()
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }

  /** 门在 executeInternal 里：搜到哪一台之前，不知道该问什么 */
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }

  protected async executeInternal(
    toolCallId: string,
    params: ToolSearchParams,
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<ToolResult> {
    const query = typeof params.query === 'string' ? params.query.trim() : ''
    if (query === '') throw new Error('query must not be empty')

    const hits = findExtensions(query, offeredServers())
    if (hits.length === 0) return textResult(NO_MATCH)

    const { sessionId } = this.ctx
    const state = sessionService.rootToolState(sessionId)
    if (hits.length > 1) {
      const lines = hits.map((hit) => {
        const entry = `mcp:${hit.name}`
        const note = state.optedOut.has(entry)
          ? ' (the user turned it off in this session)'
          : state.names.includes(entry)
            ? ' (already on)'
            : ''
        return `${extensionChoiceLine(hit)}${note}`
      })
      return textResult(
        `Several extensions match. Call ${TOOL_SEARCH_TOOL_NAME} again with the exact name of the one you need:\n${lines.join('\n')}`
      )
    }
    const server = hits[0]
    if (!isExtensionOff(server, state)) return textResult(this.statusOf(server))

    const until = <T>(work: Promise<T>): Promise<T> => (signal ? untilAborted(work, signal) : work)
    const change = await until(
      sessionService.previewAgentChange(sessionId, {
        enabledTools: withToolsSelected(state.selection, [`mcp:${server.name}`])
      })
    )
    await assertExtensionAccess(
      withCallAgent(this.ctx, call),
      {
        server: server.name,
        builtin: server.type === 'inproc' && widgetIdOfServer(server.name) === undefined
      },
      {
        toolCallId,
        toolName: TOOL_SEARCH_TOOL_NAME,
        description: t('tool.toolSearchAskQuery', { query }),
        preview: {
          kind: 'extension',
          server: server.name,
          source: extensionSourceOf(server),
          ...(change.cache === 'lost' ? { cacheLoss: { promptTokens: change.promptTokens } } : {})
        },
        owner: callOwnerOf(call),
        ...(signal ? { signal } : {})
      }
    )

    // 先连上再写勾选：写下之后才连不上的话，这台留在勾选里却不在锁里，重配也不会再试（AgentLock.planReconfigure），
    // 候选又把它排除了，模型和用户都没路可走
    const connected = await until(
      mcpService.ensureServerByName(server.name, { sessionId, timeoutMs: CONNECT_TIMEOUT_MS })
    )
    if (!connected.ok) {
      throw new Error(
        `Could not connect to ${safeExtensionName(server.name)}: ${connected.error ?? 'unknown error'}. Nothing was changed.`
      )
    }
    // enableServer 一调用就写勾选，until 拦不住：写之前自己看一眼
    if (signal?.aborted) throw signal.reason
    const tools = await until(sessionService.enableServer(sessionId, server.name))
    if (!tools) {
      throw new Error(
        `${safeExtensionName(server.name)} was selected for this session but did not reach the agent. It will be used from the next new agent.`
      )
    }
    return textResult(loadedText(server.name, tools))
  }

  /** 搜到的那台已经开着或被用户取消了：说清楚，不是「没找到」 */
  private statusOf(server: McpServer): string {
    const { sessionId } = this.ctx
    const name = safeExtensionName(server.name)
    const tools = sessionService.lockedServerTools(sessionId, server.name)
    if (tools) return `${name} is already on. ${loadedText(server.name, tools)}`
    if (sessionService.rootToolState(sessionId).optedOut.has(`mcp:${server.name}`)) {
      return `The user turned ${name} off in this session, so it cannot be enabled from here.`
    }
    const error = mcpService.getError(server.id, sessionId)
    return `${name} is on in this session but is not connected${error ? `: ${error}` : ''}. The user can retry it from the extensions picker.`
  }
}

registerBuiltinTool({
  name: TOOL_SEARCH_TOOL_NAME,
  group: 'general',
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.tool_search.labelKey),
  getHint: () => t('tool.toolSearchHint'),
  factory: (ctx) => new ToolSearchTool(ctx),
  presentation: BUILTIN_TOOL_PRESENTATIONS.tool_search.presentation,
  describe: () => ({ description: TOOL_SEARCH_DESCRIPTION, parameters: ToolSearchParamsSchema })
})
