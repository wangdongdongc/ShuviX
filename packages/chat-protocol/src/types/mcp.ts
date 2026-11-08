/**
 * MCP（Model Context Protocol）客户端共享类型 —— 桌面/扩展/共享 McpManager 单一来源。
 *
 * McpServer 是「配置数据形状」（与桌面 DB 行平行；扩展存 chrome.storage）。
 * 连接/发现/调用等运行时行为由 @shuvix/agent-runtime 的 McpManager 承载（宿主无关）。
 */

/**
 * 传输类型：
 * - `stdio` 本地子进程（仅桌面）
 * - `http` 远程（Streamable HTTP，桌面+浏览器）。只说旧版 HTTP+SSE 的 server 不另设类型：先试
 *   Streamable HTTP，被回 404/405 才换旧版 SSE（规范的向后兼容做法，见 McpManager），走通了记进
 *   `metadata.transport`

 * - `inproc` **内置能力服务器**：随产品发布、跑在进程内、**按会话实例化**，不起进程也不走网络
 *   （见 agent-runtime 的 builtinMcpRegistry）。默认不启用，由用户在会话里逐条勾选。
 */
export type McpTransportType = 'stdio' | 'http' | 'inproc'

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
  /** 扩展元数据 JSON（形状见 McpServerMetadata；明文，不放 secret） */
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

/**
 * `McpServer.metadata` 里 ShuviX 认的键。这一列由几方各写各的键（设置页写 cwd、McpManager 写 transport……），
 * 所以写入一律**并进**已有的对象，不整列替换；不认识的键原样留着。
 */
export interface McpServerMetadata {
  /** stdio：子进程的工作目录（绝对路径）。缺省 = 继承 ShuviX 自己的 */
  cwd?: string
  /**
   * http：上次实际走通的是旧版 HTTP+SSE transport —— 下次直接用它，不必每次先挨一个 404/405。
   * 由 McpManager 记、也由它清（记着 SSE 却被回 404/405、改走 Streamable HTTP 走通了）。
   */
  transport?: 'sse'
  [key: string]: unknown
}

/** 读 metadata 列：坏 JSON、不是对象（数组、null、字符串）一律当空对象 —— 这一列谁都可能写坏，读它的不该因此失败 */
export function parseMcpServerMetadata(json: string | null | undefined): McpServerMetadata {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as McpServerMetadata)
      : {}
  } catch {
    return {}
  }
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
  /** stdio 的工作目录（绝对路径，存进 `metadata.cwd`）；空 / 不给 = 不设 */
  cwd?: string
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
  /** stdio 的工作目录（绝对路径）；`''` = 清掉，不给 = 不动 */
  cwd?: string
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

// McpToolDetails（MCP 工具结果的 details）复用 types/chatMessage 中的定义，避免重复。
