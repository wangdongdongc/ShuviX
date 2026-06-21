/**
 * MCP 服务（桌面薄壳）—— 复用 @shuvix/agent-runtime 的共享 McpManager。
 *
 * 桌面只注入两处宿主特定逻辑：
 *  - store：mcpDao（SQLite mcp_servers 表）
 *  - createTransport：stdio（本地子进程，buildSpawnEnv 注入环境）+ http（Streamable HTTP/SSE）
 * 连接/发现/调用/AgentTool 转换/内置模板替换等全部在共享 McpManager 内（与扩展同一套）。
 */
import { McpManager } from '@shuvix/agent-runtime'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { mcpDao } from '../dao/mcpDao'
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

/** 桌面 transport 工厂：stdio（本地进程）+ http（Streamable HTTP，失败回退 SSE） */
function createTransport(server: McpServer): Transport {
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
