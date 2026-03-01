export type { McpTransportType, McpServer } from '../dao/types'
import type { McpTransportType, McpServer } from '../dao/types'

/** MCP Server 连接状态 */
export type McpServerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** IPC: 添加 MCP Server 参数 */
export interface McpServerAddParams {
  name: string
  type: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/** IPC: 更新 MCP Server 参数 */
export interface McpServerUpdateParams {
  id: string
  name?: string
  type?: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  isEnabled?: boolean
}

/** MCP Server 列表项（含运行时状态，用于 IPC 返回给渲染进程） */
export interface McpServerInfo extends McpServer {
  /** 运行时连接状态 */
  status: McpServerStatus
  /** 错误信息（status === 'error' 时有值） */
  error?: string
  /** 该 server 发现的工具数量 */
  toolCount: number
}

/** MCP 工具信息（用于 IPC 返回给渲染进程） */
export interface McpToolInfo {
  /** 完整工具名：mcp__<serverName>__<toolName> */
  name: string
  /** 显示标签 */
  label: string
  /** 工具描述 */
  description: string
  /** 所属 server 名称（用于 UI 分组） */
  group: string
  /** 所属 server ID */
  serverId: string
  /** 所属 server 的连接状态 */
  serverStatus: McpServerStatus
}
