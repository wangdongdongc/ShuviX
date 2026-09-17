/**
 * MCP 服务（桌面薄壳）—— 复用 @shuvix/agent-runtime 的共享 McpManager。
 *
 * 桌面只注入两处宿主特定逻辑：
 *  - store：mcpDao（SQLite mcp_servers 表）
 *  - createTransport：stdio（本地子进程，buildSpawnEnv 注入环境）+ http（Streamable HTTP/SSE）
 *    + inproc（内置能力服务器，进程内、按会话实例化，见 builtinMcpServers）
 * 连接/发现/调用/AgentTool 转换/内置模板替换等全部在共享 McpManager 内（与扩展同一套）。
 */
import { McpManager, BuiltinMcpRegistry, type BuiltinMcpScope } from '@shuvix/agent-runtime'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { mcpDao } from '../dao/mcpDao'
import { BUILTIN_MCP_FACTORIES } from './builtinMcp'
import { buildSpawnEnv } from '../utils/paths'
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
 * 内置能力服务器注册表（ssh / 后续 database、browser）。
 * 在 `registerBuiltinMcpServers()` 里填充 —— 放在独立模块，避免本文件反向依赖上层服务。
 */
export const builtinMcpRegistry = new BuiltinMcpRegistry()
for (const [name, factory] of Object.entries(BUILTIN_MCP_FACTORIES)) {
  builtinMcpRegistry.register(name, factory)
}

/** 桌面 transport 工厂：stdio（本地进程）+ http（Streamable HTTP，失败回退 SSE）+ inproc（内置） */
function createTransport(
  server: McpServer,
  scope?: BuiltinMcpScope
): Transport | Promise<Transport> {
  if (server.type === 'inproc') {
    if (!scope) throw new Error(`内置能力服务器 ${server.name} 需要会话上下文`)
    return builtinMcpRegistry.createClientTransport(server.name, scope)
  }
  if (server.type === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: parseJsonArray(server.args),
      env: buildSpawnEnv(parseJsonObject(server.env)) as Record<string, string>
    })
  } else if (server.type === 'http') {
    const headers = parseJsonObject(server.headers) as Record<string, string>
    try {
      return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } })
    } catch {
      return new SSEClientTransport(new URL(server.url), { requestInit: { headers } })
    }
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
