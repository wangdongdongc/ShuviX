/**
 * McpManager —— 宿主无关的 MCP 客户端核心（桌面/扩展单一来源）。
 *
 * 承载：连接/断开、工具发现、callTool、MCP 工具 → pi-agent-core AgentTool 转换、状态跟踪、
 * 内置 server 的 {{ENV}} 模板替换。两处只有「存储」和「transport 创建」不同，经构造参数注入：
 *  - store：server 配置读取 + cachedTools 持久化（桌面 mcpDao / 扩展 chrome.storage）
 *  - createTransport：按 server.type 造 transport（桌面 stdio+http / 扩展仅 http）
 *
 * 注意：stdio transport 依赖 Node child_process，故其 import 只留在桌面宿主的 createTransport 里，
 * 不进本模块——保证浏览器（扩展）也能打包本模块。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Type, type TSchema } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { McpServer, McpServerStatus, McpToolInfo } from '@shuvix/chat-protocol/types/mcp'
import type { McpToolDetails } from '@shuvix/chat-protocol/types/chatMessage'

/** MCP tools/list 返回的单个工具结构 */
export interface McpDiscoveredTool {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
    [key: string]: unknown
  }
}

/** server 配置存取（宿主注入：桌面 mcpDao / 扩展 chrome.storage） */
export interface McpStore {
  findById(id: string): McpServer | undefined
  findEnabled(): McpServer[]
  findAll(): McpServer[]
  updateCachedTools(id: string, toolsJson: string): void
}

export interface McpManagerOptions {
  store: McpStore
  /** 按 server 造 transport（桌面 stdio+http；扩展仅 http，遇 stdio 抛错） */
  createTransport: (server: McpServer) => Transport
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
  /**
   * 透传给 SDK Client 的构造选项（第二参）。
   * 浏览器（扩展）须注入 CSP 安全的 jsonSchemaValidator（CfWorkerJsonSchemaValidator），
   * 否则默认 ajv 会用 new Function 编译 schema → 触发 MV3 'unsafe-eval' CSP 报错。
   * 桌面（Node）省略即用默认 ajv。
   */
  clientOptions?: ConstructorParameters<typeof Client>[1]
}

interface McpConnection {
  client: Client
  transport: Transport
  tools: McpDiscoveredTool[]
  status: McpServerStatus
  error?: string
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} }

/** JSON Schema → TypeBox（Type.Unsafe 原样透传给 LLM） */
function jsonSchemaToTypebox(schema: McpDiscoveredTool['inputSchema']): TSchema {
  return Type.Unsafe<Record<string, unknown>>(schema as Record<string, unknown>)
}

interface McpContentBlock {
  type: string
  text?: string
  mimeType?: string
  resource?: unknown
}

function extractTextFromContent(content: unknown[]): string {
  return content
    .map((c) => {
      const block = c as McpContentBlock
      if (block.type === 'text') return block.text
      if (block.type === 'image') return `[image: ${block.mimeType}]`
      if (block.type === 'resource') return JSON.stringify(block.resource)
      return JSON.stringify(c)
    })
    .join('\n')
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
 * MCP 管理器 —— 管理所有 MCP Server 的连接、工具发现和调用。应用级单例，不绑定会话。
 */
export class McpManager {
  private connections = new Map<string, McpConnection>()
  private store: McpStore
  private createTransport: (server: McpServer) => Transport
  private log: NonNullable<McpManagerOptions['logger']>
  private clientOptions?: ConstructorParameters<typeof Client>[1]

  constructor(opts: McpManagerOptions) {
    this.store = opts.store
    this.createTransport = opts.createTransport
    this.log = opts.logger ?? noopLog
    this.clientOptions = opts.clientOptions
  }

  // ─── 连接管理 ───

  /** 连接单个 MCP Server */
  async connect(serverId: string): Promise<void> {
    if (this.connections.has(serverId)) await this.disconnect(serverId)

    const server = this.store.findById(serverId)
    if (!server) {
      this.log.warn(`connect: server ${serverId} 不存在`)
      return
    }

    const conn: McpConnection = {
      client: new Client({ name: 'shuvix', version: '1.0.0' }, this.clientOptions),
      transport: null as unknown as Transport,
      tools: [],
      status: 'connecting'
    }
    this.connections.set(serverId, conn)

    try {
      // url/headers 的 {{ENV_VAR}} 模板替换（内置 + 自定义）；引用的 env 为空则跳过连接
      const { resolved, missingKey } = this.resolveTemplates(server)
      if (missingKey) {
        conn.status = 'error'
        conn.error = `Missing required env variable: ${missingKey}`
        this.log.warn(`skip ${server.name}: env variable ${missingKey} is not set`)
        return
      }

      conn.transport = this.createTransport(resolved)
      conn.transport.onclose = () => {
        this.log.info(`transport closed: ${server.name}`)
        conn.status = 'disconnected'
        conn.tools = []
      }
      conn.transport.onerror = (err: Error) => {
        this.log.error(`transport error: ${server.name} ${err.message}`)
        conn.status = 'error'
        conn.error = err.message
      }

      await conn.client.connect(conn.transport)

      const result = await conn.client.listTools()
      conn.tools = result.tools as McpDiscoveredTool[]
      conn.status = 'connected'
      conn.error = undefined
      this.store.updateCachedTools(
        serverId,
        JSON.stringify(
          conn.tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema
          }))
        )
      )
      this.log.info(`connected: ${server.name} (${conn.tools.length} tools)`)
    } catch (err: unknown) {
      conn.status = 'error'
      conn.error = err instanceof Error ? err.message : String(err)
      this.log.error(`connect failed: ${server.name} ${conn.error}`)
    }
  }

  /** 断开单个 MCP Server */
  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId)
    if (!conn) return
    try {
      await conn.transport?.close()
      await conn.client?.close()
    } catch (err: unknown) {
      this.log.warn(
        `disconnect error: ${serverId} ${err instanceof Error ? err.message : String(err)}`
      )
    }
    this.connections.delete(serverId)
    this.log.info(`disconnected: ${serverId}`)
  }

  /** 启动所有已启用的 MCP Server */
  async connectAll(): Promise<void> {
    const servers = this.store.findEnabled()
    if (servers.length === 0) return
    this.log.info(`connectAll: ${servers.length} server(s)`)
    await Promise.allSettled(servers.map((s) => this.connect(s.id)))
  }

  /** 关闭所有连接 */
  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()]
    await Promise.allSettled(ids.map((id) => this.disconnect(id)))
    this.log.info(`disconnectAll: ${ids.length} server(s) closed`)
  }

  // ─── 状态查询 ───

  getStatus(serverId: string): McpServerStatus {
    return this.connections.get(serverId)?.status ?? 'disconnected'
  }

  getError(serverId: string): string | undefined {
    return this.connections.get(serverId)?.error
  }

  getServerTools(serverId: string): McpDiscoveredTool[] {
    return this.connections.get(serverId)?.tools ?? []
  }

  /** 某个 server 的工具信息（从 DB cachedTools 读 + 附加运行时状态） */
  getServerToolInfos(serverId: string): McpToolInfo[] {
    const server = this.store.findById(serverId)
    if (!server) return []
    const status = this.connections.get(serverId)?.status ?? 'disconnected'
    let tools: McpDiscoveredTool[]
    try {
      tools = JSON.parse(server.cachedTools || '[]') as McpDiscoveredTool[]
    } catch {
      tools = []
    }
    return tools.map((t) => ({
      name: `mcp__${server.name}__${t.name}`,
      label: t.description || t.name,
      description: t.description ?? '',
      group: server.name,
      serverId: server.id,
      serverStatus: status
    }))
  }

  /** 所有 Server 的服务器级信息（每个 server 一条，含离线/禁用） */
  getAllToolInfos(): McpToolInfo[] {
    return this.store.findAll().map((s) => {
      const status = this.connections.get(s.id)?.status ?? 'disconnected'
      let toolCount = 0
      try {
        toolCount = JSON.parse(s.cachedTools || '[]').length
      } catch {
        /* ignore */
      }
      return {
        name: `mcp:${s.name}`,
        label: s.name,
        description: `${toolCount} tool(s)`,
        group: `mcp:${s.name}`,
        serverId: s.id,
        serverStatus: status,
        isBuiltin: !!s.isBuiltin
      }
    })
  }

  // ─── 工具调用 ───

  /**
   * 调用某 server 的工具。
   *
   * `signal` 必须一路透传给 SDK：它会向 server 发 `notifications/cancelled` 并**立即**
   * reject 这次请求。不传的话中止只能等 timeout —— 而 pi 的 `harness.abort()` 会
   * `waitForIdle()` 等工具 promise 落定，于是「中止」按钮要卡到 5～10 分钟后才生效。
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ content: unknown[]; isError?: boolean }> {
    const conn = this.connections.get(serverId)
    if (!conn || conn.status !== 'connected') {
      throw new Error(`MCP server ${serverId} is not connected`)
    }
    // SDK 默认 60s 太短；抬到 5 分钟 + progress 刷新计时 + 10 分钟总上限
    const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: 5 * 60 * 1000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 10 * 60 * 1000,
      signal
    })
    const isError = 'isError' in result ? (result.isError as boolean | undefined) : undefined
    return { content: result.content as unknown[], isError }
  }

  // ─── 桥接层：MCP → AgentTool ───

  private mcpToolToAgentTool(
    serverId: string,
    serverName: string,
    mcpTool: McpDiscoveredTool
  ): AgentTool<TSchema, McpToolDetails> {
    return {
      name: `mcp__${serverName}__${mcpTool.name}`,
      label: mcpTool.description || mcpTool.name,
      description: mcpTool.description ?? '',
      parameters: jsonSchemaToTypebox(mcpTool.inputSchema),
      execute: async (_toolCallId, params, signal): Promise<AgentToolResult<McpToolDetails>> => {
        try {
          const result = await this.callTool(
            serverId,
            mcpTool.name,
            params as Record<string, unknown>,
            signal
          )
          const text = extractTextFromContent(result.content)
          if (result.isError) {
            return {
              content: [{ type: 'text', text: `[MCP Error] ${text}` }],
              details: { type: 'mcp', server: serverName, tool: mcpTool.name, isError: true }
            }
          }
          return {
            content: [{ type: 'text', text }],
            details: { type: 'mcp', server: serverName, tool: mcpTool.name }
          }
        } catch (err: unknown) {
          // 中止时 SDK 抛的是 McpError(RequestTimeout, 'AbortError: ...')，文案会误导用户，
          // 统一按其它工具的约定报成 Aborted。
          const text = signal?.aborted
            ? '[MCP] Aborted'
            : `[MCP Error] ${err instanceof Error ? err.message : String(err)}`
          return {
            content: [{ type: 'text', text }],
            details: { type: 'mcp', server: serverName, tool: mcpTool.name, isError: true }
          }
        }
      }
    }
  }

  /** 某个 Server 的所有工具转 AgentTool[] */
  serverToAgentTools(serverId: string): AgentTool<TSchema, McpToolDetails>[] {
    const conn = this.connections.get(serverId)
    if (!conn || conn.status !== 'connected') return []
    const server = this.store.findById(serverId)
    if (!server) return []
    return conn.tools.map((t) => this.mcpToolToAgentTool(serverId, server.name, t))
  }

  /** 所有已连接 Server 的全部 AgentTool（flat） */
  getAllAgentTools(): AgentTool<TSchema, McpToolDetails>[] {
    return [...this.connections.keys()].flatMap((id) => this.serverToAgentTools(id))
  }

  /** 所有已连接 Server 名（mcp:<name> 格式） */
  getAllToolNames(): string[] {
    const names: string[] = []
    for (const [serverId, conn] of this.connections) {
      if (conn.status !== 'connected') continue
      const server = this.store.findById(serverId)
      if (server) names.push(`mcp:${server.name}`)
    }
    return names
  }

  /** 按名称判断是否已连接（供子智能体依赖预检查） */
  isConnectedByName(serverName: string): boolean {
    for (const [serverId, conn] of this.connections) {
      if (conn.status !== 'connected') continue
      if (this.store.findById(serverId)?.name === serverName) return true
    }
    return false
  }

  /** 按服务器名获取所有 AgentTool（agentToolBuilder 按服务器级注入） */
  getAgentToolsByServerName(serverName: string): AgentTool<TSchema, McpToolDetails>[] {
    for (const [serverId, conn] of this.connections) {
      if (conn.status !== 'connected') continue
      if (this.store.findById(serverId)?.name === serverName) {
        return this.serverToAgentTools(serverId)
      }
    }
    return []
  }

  // ─── 内部 ───

  /** url/headers 做 {{ENV_VAR}} 模板替换（内置 + 自定义都支持，值取自 server.env）；
   *  含 {{VAR}} 但引用的 env 为空 → 回传 missingKey，调用方跳过连接并提示。
   *  无模板的 URL（不含 {{}}）原样返回，行为不变。 */
  private resolveTemplates(server: McpServer): { resolved: McpServer; missingKey?: string } {
    if (!server.url.includes('{{') && !server.headers.includes('{{')) {
      return { resolved: server }
    }
    const env = parseJsonObject(server.env)
    let missingKey: string | undefined
    const substitute = (s: string): string =>
      s.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const val = env[key]
        if (!val) {
          if (!missingKey) missingKey = key
          return ''
        }
        return val
      })
    const url = substitute(server.url)
    const headers = substitute(server.headers)
    if (missingKey) return { resolved: server, missingKey }
    return { resolved: { ...server, url, headers } }
  }
}
