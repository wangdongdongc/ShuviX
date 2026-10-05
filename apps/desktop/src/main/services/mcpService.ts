/**
 * MCP 服务（桌面薄壳）—— 复用 @shuvix/agent-runtime 的共享 McpManager。
 *
 * 桌面只注入两处宿主特定逻辑：
 *  - store：mcpDao（SQLite mcp_servers 表）
 *  - createTransport：stdio（本地子进程，buildSpawnEnv 注入环境，见 McpStdioTransport）
 *    + http（Streamable HTTP）
 *    + inproc（内置能力服务器，进程内、按会话实例化，见 builtinMcpServers）
 * 连接/发现/调用/AgentTool 转换/内置模板替换等全部在共享 McpManager 内（与扩展同一套）。
 */
import { McpManager, BuiltinMcpRegistry, type BuiltinMcpScope } from '@shuvix/agent-runtime'
import { requestUserInputFor } from './userInputBroker'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import type { DesktopBuiltinMcpScope } from './builtinMcp/types'
import type { ToolAgentIdentity } from './toolAgent'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { mcpDao } from '../dao/mcpDao'
import { BUILTIN_MCP_FACTORIES } from './builtinMcp'
import { buildSpawnEnv } from '../utils/paths'
import { McpStdioTransport } from '../utils/mcpStdioTransport'
import { createLogger } from '../logger'

const log = createLogger('MCP')

function parseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 内置能力服务器注册表（ssh / browser / database）。
 * 在 `registerBuiltinMcpServers()` 里填充 —— 放在独立模块，避免本文件反向依赖上层服务。
 */
export const builtinMcpRegistry = new BuiltinMcpRegistry<DesktopBuiltinMcpScope>()
for (const [name, factory] of Object.entries(BUILTIN_MCP_FACTORIES)) {
  builtinMcpRegistry.register(name, factory)
}

/**
 * 内置服务器认调用方用的解析器：(会话, durable 对话) → 发起调用的 agent。由 main 启动时注册
 * （`(sid, c) => host.get(sid)?.agentIdentity(c)`，见 sessionHost 的 sessionAgentResolver）——
 * 直接 import 会话宿主会经 agentHost 绕回本文件。没注册 = 认不出（主体按 root）。
 */
export type BuiltinMcpAgentResolver = (
  sessionId: string,
  conversationId: number
) => ToolAgentIdentity | undefined
let agentResolver: BuiltinMcpAgentResolver | null = null

export function setBuiltinMcpAgentResolver(resolver: BuiltinMcpAgentResolver | null): void {
  agentResolver = resolver
}

/** 桌面 transport 工厂：stdio（本地进程）+ http（Streamable HTTP）+ inproc（内置） */
function createTransport(
  server: McpServer,
  scope?: BuiltinMcpScope
): Transport | Promise<Transport> {
  if (server.type === 'inproc') {
    if (!scope) throw new Error(`内置能力服务器 ${server.name} 需要会话上下文`)
    const { sessionId } = scope
    // 两条通道都是**按 sessionId 找归属**的，所以补齐它们只需要会话 id；
    // 之所以在这一层补而不是让内置模块自己取，是边界规则（见 builtinMcp/types.ts）
    return builtinMcpRegistry.createClientTransport(server.name, {
      sessionId,
      requestUserInput: (request) => requestUserInputFor(sessionId, request),
      emitChatEvent: (event) => chatFrontendRegistry.broadcast({ ...event, sessionId }),
      // 每次调用现问注册着的解析器 —— 连接活得比任何一次调用都久（重连也在调用途中懒发生），
      // 建连时快照下来的身份会过时
      agentOf: (conversationId) => agentResolver?.(sessionId, conversationId)
    })
  }
  if (server.type === 'stdio') {
    return new McpStdioTransport({
      command: server.command,
      args: parseJsonArray(server.args),
      env: buildSpawnEnv(parseJsonObject(server.env)) as Record<string, string>
    })
  } else if (server.type === 'http') {
    // 只有 Streamable HTTP。这里曾经 try/catch 回退到旧版 SSE transport，但构造函数从不因为网络
    // 失败而抛（连接在 start 时才发生），那条回退从来没走到过 —— 只认旧版 SSE 的 server 一直就连不上
    const headers = parseJsonObject(server.headers) as Record<string, string>
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } })
  }
  throw new Error(`不支持的 MCP transport 类型: ${server.type}`)
}

export const mcpService = new McpManager({
  store: mcpDao,
  createTransport,
  logger: {
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    error: (m) => log.error(m)
  }
})
