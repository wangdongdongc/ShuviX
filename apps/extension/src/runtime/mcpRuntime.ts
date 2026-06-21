/**
 * 浏览器 MCP 运行时 —— 共享 McpManager 的扩展实例。
 *
 * 只注入两处宿主特定逻辑：store = chrome.storage 的 mcpStore；createTransport = 仅 http
 * （Streamable HTTP / SSE，基于 fetch，浏览器可用；stdio 本地进程浏览器不可能 → 抛错）。
 * 连接/发现/调用/AgentTool 转换等全部在共享 McpManager（与桌面同一套）。
 */
import { McpManager } from '@shuvix/agent-runtime'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { mcpStore } from '../storage/mcpStore'

function parseHeaders(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** 扩展 transport 工厂：仅 http（Streamable HTTP，失败回退 SSE）；stdio 不支持 */
function createTransport(server: McpServer): Transport {
  if (server.type !== 'http') {
    throw new Error('扩展仅支持 http 类型 MCP（浏览器无法运行本地进程）')
  }
  const headers = parseHeaders(server.headers)
  try {
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } })
  } catch {
    return new SSEClientTransport(new URL(server.url), { requestInit: { headers } })
  }
}

export const mcpManager = new McpManager({
  store: mcpStore,
  createTransport,
  // CSP 安全的 JSON Schema 校验器（无 new Function）——避免 MV3 'unsafe-eval' 报错
  // （SDK 默认 ajv 会编译 schema 触发 eval）
  clientOptions: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  logger: {
    info: (m) => console.info('[shuvix-mcp]', m),
    warn: (m) => console.warn('[shuvix-mcp]', m),
    error: (m) => console.error('[shuvix-mcp]', m)
  }
})
