/** MCP Server 对外服务日志数据结构（对应 DB 表 mcp_server_logs） */
export interface McpServerLog {
  id: string
  sessionId: string
  clientName: string
  clientVersion: string
  toolName: string
  arguments: string
  result: string
  isError: number
  durationMs: number
  createdAt: number
}
