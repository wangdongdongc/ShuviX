/** MCP Server 传输类型 */
export type McpTransportType = 'stdio' | 'http'

/** MCP Server 连接状态 */
export type McpServerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** MCP Server 数据结构（对应 DB 表） */
export interface McpServer {
  id: string
  /** 显示名称（也用于工具名前缀），如 "filesystem" */
  name: string
  /** 传输类型 */
  type: McpTransportType
  /** stdio: 启动命令，如 "npx" */
  command: string
  /** stdio: 命令参数 JSON 数组 */
  args: string
  /** stdio: 环境变量 JSON 对象 */
  env: string
  /** http: 远程 URL */
  url: string
  /** http: 请求头 JSON 对象 */
  headers: string
  /** 是否启用 */
  isEnabled: number
  createdAt: number
  updatedAt: number
}

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
  /** 完整工具名：mcp:<serverName>:<toolName> */
  name: string
  /** 显示标签 */
  label: string
  /** 工具描述 */
  description: string
  /** 所属 server 名称（用于 UI 分组） */
  group: string
  /** 所属 server ID */
  serverId: string
}
