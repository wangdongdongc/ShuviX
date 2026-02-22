import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Type, type TSchema } from '@sinclair/typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import { mcpDao } from '../dao/mcpDao'
import type { McpServer, McpServerStatus, McpToolInfo } from '../types'

/** MCP tools/list 返回的单个工具结构 */
interface McpDiscoveredTool {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, object>
    required?: string[]
    [key: string]: unknown
  }
}

/** 单个 MCP Server 的运行时连接状态 */
interface McpConnection {
  client: Client
  transport: Transport
  tools: McpDiscoveredTool[]
  status: McpServerStatus
  error?: string
}

/**
 * 将 JSON Schema 对象转换为 TypeBox TSchema
 * MCP 工具的 inputSchema 是标准 JSON Schema，需要转为 pi-agent-core 所需的 TypeBox 格式
 * 这里采用简化方案：用 Type.Unsafe 直接包装 JSON Schema
 */
function jsonSchemaToTypebox(schema: McpDiscoveredTool['inputSchema']): TSchema {
  // Type.Unsafe 允许传入任意 JSON Schema，TypeBox 会原样透传给 LLM
  return Type.Unsafe<Record<string, unknown>>(schema as Record<string, unknown>)
}

/**
 * 将 MCP callTool 结果中的 content 块提取为纯文本
 */
function extractTextFromContent(content: unknown[]): string {
  return content
    .map((c: any) => {
      if (c.type === 'text') return c.text
      if (c.type === 'image') return `[image: ${c.mimeType}]`
      if (c.type === 'resource') return JSON.stringify(c.resource)
      return JSON.stringify(c)
    })
    .join('\n')
}

/**
 * MCP 服务 — 管理所有 MCP Server 的连接、工具发现和工具调用
 *
 * 应用级单例，不绑定会话。所有会话通过 getAllAgentTools() 共享 MCP 工具。
 */
class McpService {
  /** serverId → 运行时连接 */
  private connections = new Map<string, McpConnection>()

  // ─── 连接管理 ───

  /** 连接单个 MCP Server（根据 type 自动选择 transport） */
  async connect(serverId: string): Promise<void> {
    // 如果已连接，先断开
    if (this.connections.has(serverId)) {
      await this.disconnect(serverId)
    }

    const server = mcpDao.findById(serverId)
    if (!server) {
      console.warn(`[MCP] connect: server ${serverId} 不存在`)
      return
    }

    // 初始化连接记录
    const conn: McpConnection = {
      client: new Client({ name: 'shuvix', version: '1.0.0' }),
      transport: null as unknown as Transport,
      tools: [],
      status: 'connecting'
    }
    this.connections.set(serverId, conn)

    try {
      // 根据类型创建 transport
      conn.transport = this.createTransport(server)

      // 监听 transport 关闭事件（子进程退出等）
      conn.transport.onclose = () => {
        console.log(`[MCP] transport closed: ${server.name}`)
        conn.status = 'disconnected'
        conn.tools = []
      }
      conn.transport.onerror = (err: Error) => {
        console.error(`[MCP] transport error: ${server.name}`, err.message)
        conn.status = 'error'
        conn.error = err.message
      }

      // 连接并初始化
      await conn.client.connect(conn.transport)

      // 发现工具
      const result = await conn.client.listTools()
      conn.tools = result.tools as McpDiscoveredTool[]
      conn.status = 'connected'
      conn.error = undefined

      console.log(`[MCP] connected: ${server.name} (${conn.tools.length} tools)`)
    } catch (err: any) {
      conn.status = 'error'
      conn.error = err?.message || String(err)
      console.error(`[MCP] connect failed: ${server.name}`, conn.error)
    }
  }

  /** 断开单个 MCP Server */
  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId)
    if (!conn) return

    try {
      await conn.transport?.close()
      await conn.client?.close()
    } catch (err: any) {
      console.warn(`[MCP] disconnect error: ${serverId}`, err?.message)
    }

    this.connections.delete(serverId)
    console.log(`[MCP] disconnected: ${serverId}`)
  }

  /** 启动所有已启用的 MCP Server */
  async connectAll(): Promise<void> {
    const servers = mcpDao.findEnabled()
    if (servers.length === 0) return

    console.log(`[MCP] connectAll: ${servers.length} server(s)`)
    // 并行连接，单个失败不影响其他
    await Promise.allSettled(servers.map((s) => this.connect(s.id)))
  }

  /** 关闭所有连接 */
  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()]
    await Promise.allSettled(ids.map((id) => this.disconnect(id)))
    console.log(`[MCP] disconnectAll: ${ids.length} server(s) closed`)
  }

  // ─── 状态查询 ───

  /** 获取连接状态 */
  getStatus(serverId: string): McpServerStatus {
    return this.connections.get(serverId)?.status ?? 'disconnected'
  }

  /** 获取错误信息 */
  getError(serverId: string): string | undefined {
    return this.connections.get(serverId)?.error
  }

  /** 获取某个 server 发现的原始工具列表 */
  getServerTools(serverId: string): McpDiscoveredTool[] {
    return this.connections.get(serverId)?.tools ?? []
  }

  /** 获取某个 server 的工具信息（用于 IPC 返回给前端） */
  getServerToolInfos(serverId: string): McpToolInfo[] {
    const server = mcpDao.findById(serverId)
    if (!server) return []
    const conn = this.connections.get(serverId)
    if (!conn || conn.status !== 'connected') return []
    return conn.tools.map((t) => ({
      name: `mcp__${server.name}__${t.name}`,
      label: t.description || t.name,
      description: t.description ?? '',
      group: server.name,
      serverId: server.id
    }))
  }

  // ─── 工具调用 ───

  /** 调用 MCP 工具（原始调用） */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown[]; isError?: boolean }> {
    const conn = this.connections.get(serverId)
    if (!conn || conn.status !== 'connected') {
      throw new Error(`MCP server ${serverId} is not connected`)
    }
    const result = await conn.client.callTool({ name: toolName, arguments: args })
    return { content: result.content as unknown[], isError: (result as any).isError }
  }

  // ─── 桥接层：MCP → AgentTool ───

  /** 将单个 MCP 工具转为 AgentTool */
  private mcpToolToAgentTool(
    serverId: string,
    serverName: string,
    mcpTool: McpDiscoveredTool
  ): AgentTool<any> {
    const self = this
    return {
      name: `mcp__${serverName}__${mcpTool.name}`,
      label: mcpTool.description || mcpTool.name,
      description: mcpTool.description ?? '',
      parameters: jsonSchemaToTypebox(mcpTool.inputSchema),
      execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
        try {
          const result = await self.callTool(serverId, mcpTool.name, params)
          const text = extractTextFromContent(result.content)
          if (result.isError) {
            return {
              content: [{ type: 'text', text: `[MCP Error] ${text}` }],
              details: { server: serverName, tool: mcpTool.name, isError: true }
            }
          }
          return {
            content: [{ type: 'text', text }],
            details: { server: serverName, tool: mcpTool.name }
          }
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `[MCP Error] ${err?.message || String(err)}` }],
            details: { server: serverName, tool: mcpTool.name, isError: true }
          }
        }
      }
    }
  }

  /** 将单个 Server 的所有工具转为 AgentTool[] */
  serverToAgentTools(serverId: string): AgentTool<any>[] {
    const conn = this.connections.get(serverId)
    if (!conn || conn.status !== 'connected') return []
    const server = mcpDao.findById(serverId)
    if (!server) return []
    return conn.tools.map((t) => this.mcpToolToAgentTool(serverId, server.name, t))
  }

  /** 获取所有已连接 Server 的全部 AgentTool（flat 数组） */
  getAllAgentTools(): AgentTool<any>[] {
    return [...this.connections.keys()].flatMap((id) => this.serverToAgentTools(id))
  }

  /** 获取所有已连接 Server 的全部工具名 */
  getAllToolNames(): string[] {
    return this.getAllAgentTools().map((t) => t.name)
  }

  /** 获取所有已连接 Server 的工具信息（用于 tools:list IPC） */
  getAllToolInfos(): McpToolInfo[] {
    return [...this.connections.keys()].flatMap((id) => this.getServerToolInfos(id))
  }

  // ─── 内部方法 ───

  /** 根据 server 配置创建对应的 transport */
  private createTransport(server: McpServer): Transport {
    if (server.type === 'stdio') {
      const args = this.parseJsonArray(server.args)
      const env = this.parseJsonObject(server.env)
      return new StdioClientTransport({
        command: server.command,
        args,
        env: { ...process.env as Record<string, string>, ...env }
      })
    } else if (server.type === 'http') {
      const headers = this.parseJsonObject(server.headers)
      // 优先使用 Streamable HTTP（MCP 最新规范），失败后回退 SSE
      try {
        return new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            headers: headers as Record<string, string>
          }
        })
      } catch {
        return new SSEClientTransport(new URL(server.url), {
          requestInit: {
            headers: headers as Record<string, string>
          }
        })
      }
    }
    throw new Error(`不支持的 MCP transport 类型: ${server.type}`)
  }

  /** 安全解析 JSON 数组 */
  private parseJsonArray(json: string): string[] {
    try {
      const parsed = JSON.parse(json)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 安全解析 JSON 对象 */
  private parseJsonObject(json: string): Record<string, string> {
    try {
      const parsed = JSON.parse(json)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  }
}

export const mcpService = new McpService()
