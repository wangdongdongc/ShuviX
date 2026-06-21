/**
 * MCP（Model Context Protocol）客户端共享类型 —— 桌面/扩展/共享 McpManager 单一来源。
 *
 * McpServer 是「配置数据形状」（与桌面 DB 行平行；扩展存 chrome.storage）。
 * 连接/发现/调用等运行时行为由 @shuvix/agent-runtime 的 McpManager 承载（宿主无关）。
 */

/** 传输类型：stdio = 本地子进程（仅桌面）；http = 远程（Streamable HTTP / SSE，桌面+浏览器） */
export type McpTransportType = 'stdio' | 'http'

/** MCP Server 配置（桌面对应 mcp_servers 表行；扩展存 chrome.storage） */
export interface McpServer {
  id: string
  /** 显示名称（也用于工具名前缀），如 "filesystem" */
  name: string
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
  /** 扩展元数据 JSON */
  metadata: string
  /** 是否启用 */
  isEnabled: number
  /** 是否为内置 server（随产品发布，不可删除；除 env/isEnabled 外只读） */
  isBuiltin: number
  /** 上次连接发现的工具列表 JSON（持久化缓存，作为离线工具数据源） */
  cachedTools: string
  createdAt: number
  updatedAt: number
}

/** MCP Server 连接状态 */
export type McpServerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** 添加 MCP Server 参数 */
export interface McpServerAddParams {
  name: string
  type: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/** 更新 MCP Server 参数 */
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

/** MCP Server 列表项（含运行时状态，返回给前端） */
export interface McpServerInfo extends McpServer {
  status: McpServerStatus
  error?: string
  toolCount: number
}

/** MCP 工具/服务器信息（返回给前端，服务器级一条或工具级一条） */
export interface McpToolInfo {
  /** 工具级：mcp__<server>__<tool>；服务器级：mcp:<server> */
  name: string
  label: string
  description: string
  group: string
  serverId: string
  serverStatus: McpServerStatus
  isBuiltin?: boolean
}

// McpToolDetails（AgentToolResult.details）复用 types/chatMessage 中的定义，避免重复。
