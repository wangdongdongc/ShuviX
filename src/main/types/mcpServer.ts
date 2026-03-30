/** MCP Server 对外服务相关类型（ShuviX 作为 MCP Server） */

export type McpHostTransport = 'http'
export type McpHostFeature = 'database'

/** MCP Host 配置（从 settings 构建） */
export interface McpHostConfig {
  enabled: boolean
  transport: McpHostTransport
  port: number
  features: Record<McpHostFeature, boolean>
}

/** MCP Host 运行状态 */
export interface McpHostStatus {
  running: boolean
  transport: McpHostTransport
  port: number
  features: McpHostFeature[]
  error?: string
}

/** MCP Host 对外暴露的工具描述 */
export interface McpHostToolDesc {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** MCP Host 日志摘要（列表用，不含大字段） */
export interface McpHostLogSummary {
  id: string
  sessionId: string
  clientName: string
  clientVersion: string
  toolName: string
  isError: number
  durationMs: number
  createdAt: number
}
