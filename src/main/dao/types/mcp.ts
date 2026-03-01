/** MCP Server 传输类型 */
export type McpTransportType = 'stdio' | 'http'

/** MCP Server 数据结构（对应 DB 表 mcp_servers） */
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
  /** 上次连接时发现的工具列表 JSON（持久化缓存） */
  cachedTools: string
  createdAt: number
  updatedAt: number
}
