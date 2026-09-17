/**
 * McpManager —— 宿主无关的 MCP 客户端核心（桌面/扩展单一来源）。
 *
 * 承载：连接/断开、工具发现、callTool、MCP 工具 → pi-agent-core AgentTool 转换、状态跟踪、
 * 内置 server 的 {{ENV}} 模板替换。两处只有「存储」和「transport 创建」不同，经构造参数注入：
 *  - store：server 配置读取 + cachedTools 持久化（桌面 mcpDao / 扩展 chrome.storage）
 *  - createTransport：按 server.type 造 transport（桌面 stdio+http / 扩展仅 http）
 *
 * **惰性启动**：没有「开机连全部」这回事 —— 连接只发生在装配工具那一刻（宿主创建 Agent 时按名
 * `ensureServerByName` / `ensureEnabled`），以及用户在设置页手动点连接。失败也不进后台重试队列：
 * 下次用到它时原地再连一次（`ensureConnected` 对 error/disconnected 一律重开）。惰性路径带超时
 * （`LAZY_CONNECT_TIMEOUT_MS`）—— 一台挂掉的服务器不能把整次 Agent 创建拖住；手动连接不带超时，
 * 用户就在旁边看着，首次 npx 冷启动慢是可以等的。
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
import type { BuiltinMcpScope } from './builtinMcpRegistry'

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
  /**
   * 按 server 造 transport（桌面 stdio+http+inproc；扩展仅 http，遇 stdio 抛错）。
   *
   * `scope` 只在 `type: 'inproc'` 的内置能力服务器上有值 —— 它们按会话实例化，工厂据此把
   * server side 接到这条会话自己的实例上（见 builtinMcpRegistry）。返回值允许是 Promise：
   * 内置服务器要 await `server.connect(transport)` 才算接好。
   */
  createTransport: (server: McpServer, scope?: BuiltinMcpScope) => Transport | Promise<Transport>
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
  /** 配置行 id —— 连接键可能带会话后缀，所以身份记在连接上，不靠解析键 */
  serverId: string
  /** 配置行名（工具名前缀 `mcp__<name>__*` 取它） */
  serverName: string
  /** 仅 `inproc`：这份实例归哪条会话 */
  sessionId?: string
}

/**
 * 连接键 —— 全局服务器（stdio/http）就是 serverId；`inproc` 内置能力服务器按会话分身，
 * 键是 `serverId#sessionId`。「一个会话一份 server 实例」落到记账上就是这一行。
 */
function connKeyOf(server: McpServer, sessionId?: string): string {
  return server.type === 'inproc' ? `${server.id}#${sessionId ?? ''}` : server.id
}

/**
 * 一次连接尝试的结果。
 *
 * `ok:false` 且没有 `error` = 这台服务器压根不该连（名字不存在 / 已停用）—— 不是失败，
 * 调用方静默跳过；带 `error` 才是真连不上，宿主据此向会话报一条提示。
 */
export interface McpConnectResult {
  ok: boolean
  error?: string
}

/**
 * 惰性连接的超时（毫秒）。用到才连意味着这段等待直接压在用户发出的那条消息上，
 * 所以宁可短：连不上就先把 Agent 建起来（少这台的工具），而不是让人干等。
 */
export const LAZY_CONNECT_TIMEOUT_MS = 5000

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
  /** 连接键（见 connKeyOf）→ 连接。`inproc` 服务器每条会话一个条目 */
  private connections = new Map<string, McpConnection>()
  /** 进行中的连接（按连接键）—— 同一条连接的并发请求合流，不重复拉起进程 */
  private pending = new Map<string, Promise<McpConnectResult>>()
  private store: McpStore
  private createTransport: (
    server: McpServer,
    scope?: BuiltinMcpScope
  ) => Transport | Promise<Transport>
  private log: NonNullable<McpManagerOptions['logger']>
  private clientOptions?: ConstructorParameters<typeof Client>[1]

  constructor(opts: McpManagerOptions) {
    this.store = opts.store
    this.createTransport = opts.createTransport
    this.log = opts.logger ?? noopLog
    this.clientOptions = opts.clientOptions
  }

  // ─── 连接管理 ───

  /**
   * 显式连接单个 MCP Server（设置页手动连 / 重连、配置变更后）。已连上的先断开再重连。
   *
   * 并发合流：同一台服务器已有尝试在跑时，晚到者等那一次的结果 —— 惰性路径上「两条会话
   * 同时创建 Agent」是常态，重复拉起 stdio 子进程既慢又会留残。搭车的一方沿用**先发起那次**
   * 的超时：手动连接撞上在途的惰性连接时也会在 5 秒后失败，再点一次才是全新的、不设限的尝试。
   */
  async connect(
    serverId: string,
    opts?: { timeoutMs?: number; sessionId?: string }
  ): Promise<McpConnectResult> {
    const server = this.store.findById(serverId)
    if (!server) {
      this.log.warn(`connect: server ${serverId} 不存在`)
      return { ok: false }
    }
    // inproc 是按会话实例化的：没有会话就没有可用的实例，属于调用方用错了 API 而非连不上
    if (server.type === 'inproc' && !opts?.sessionId) {
      this.log.warn(`connect: 内置能力服务器 ${server.name} 需要 sessionId`)
      return { ok: false }
    }
    const key = connKeyOf(server, opts?.sessionId)
    const inflight = this.pending.get(key)
    if (inflight) return inflight
    const task = this.openConnection(server, key, opts?.sessionId, opts?.timeoutMs).finally(() => {
      this.pending.delete(key)
    })
    this.pending.set(key, task)
    return task
  }

  /**
   * 用到才连：已连上直接用，连接中就等它，**其余（没连过 / 上次失败）一律重开**。
   * 「自动重试」就是这一行 —— 重试发生在下一次用到它的时候，没有后台重试队列。
   */
  async ensureConnected(
    serverId: string,
    opts?: { timeoutMs?: number; sessionId?: string }
  ): Promise<McpConnectResult> {
    const server = this.store.findById(serverId)
    if (!server) return { ok: false }
    const key = connKeyOf(server, opts?.sessionId)
    if (this.connections.get(key)?.status === 'connected') return { ok: true }
    return this.connect(serverId, opts)
  }

  /**
   * 按名惰性连接（宿主装配 `mcp:<name>` 工具时调用）。
   * 名字不在已启用列表里 → `ok:false` 且不带 error：没这台，不是连不上。
   */
  async ensureServerByName(
    serverName: string,
    opts?: { timeoutMs?: number; sessionId?: string }
  ): Promise<McpConnectResult> {
    const server = this.store.findEnabled().find((s) => s.name === serverName)
    if (!server) return { ok: false }
    return this.ensureConnected(server.id, opts)
  }

  /** 连上全部已启用 server（扩展宿主：会话没有逐台勾选，装配时要全量工具），并发进行 */
  async ensureEnabled(opts?: {
    timeoutMs?: number
    sessionId?: string
  }): Promise<Array<{ name: string; result: McpConnectResult }>> {
    return Promise.all(
      this.store
        .findEnabled()
        // inproc 要会话上下文；全量装配（扩展宿主）没有逐会话概念，跳过而不是报错
        .filter((s) => s.type !== 'inproc' || !!opts?.sessionId)
        .map(async (s) => ({ name: s.name, result: await this.ensureConnected(s.id, opts) }))
    )
  }

  /**
   * 断开单个 MCP Server。
   *
   * 不带 sessionId 时断的是全局连接；`inproc` 服务器的实例挂在会话上，此时**断开它的全部会话
   * 实例** —— 设置页停用/改配置是对这台服务器整体下的判断，不该只清掉其中一条会话的分身。
   */
  async disconnect(serverId: string, sessionId?: string): Promise<void> {
    const keys =
      sessionId === undefined
        ? [...this.connections].filter(([, c]) => c.serverId === serverId).map(([k]) => k)
        : [`${serverId}#${sessionId}`]
    for (const key of keys) {
      const conn = this.connections.get(key)
      if (!conn) continue
      await this.closeConnection(conn, key)
      this.connections.delete(key)
      this.log.info(`disconnected: ${key}`)
    }
  }

  /**
   * 关掉某条会话名下的全部内置能力服务器实例（会话删除 / 运行时销毁时调用）。
   *
   * **只关 inproc**：全局服务器是跨会话共享的，一条会话结束不该影响别人。
   */
  async closeSession(sessionId: string): Promise<void> {
    const keys = [...this.connections].filter(([, c]) => c.sessionId === sessionId).map(([k]) => k)
    if (keys.length === 0) return
    await Promise.allSettled(
      keys.map(async (key) => {
        const conn = this.connections.get(key)
        if (!conn) return
        await this.closeConnection(conn, key)
        this.connections.delete(key)
      })
    )
    this.log.info(`closeSession ${sessionId}: ${keys.length} builtin server(s) closed`)
  }

  /** 真正的连接过程（握手 + tools/list + 写 cachedTools）；失败把 error 留在状态里给设置页显示 */
  private async openConnection(
    server: McpServer,
    key: string,
    sessionId: string | undefined,
    timeoutMs?: number
  ): Promise<McpConnectResult> {
    const serverId = server.id
    if (this.connections.has(key)) await this.disconnect(serverId, sessionId)

    const conn: McpConnection = {
      client: new Client({ name: 'shuvix', version: '1.0.0' }, this.clientOptions),
      transport: null as unknown as Transport,
      tools: [],
      status: 'connecting',
      serverId,
      serverName: server.name,
      sessionId: server.type === 'inproc' ? sessionId : undefined
    }
    this.connections.set(key, conn)

    const fail = (message: string): McpConnectResult => {
      conn.status = 'error'
      conn.error = message
      return { ok: false, error: message }
    }

    // url/headers 的 {{ENV_VAR}} 模板替换（内置 + 自定义）；引用的 env 为空则跳过连接
    const { resolved, missingKey } = this.resolveTemplates(server)
    if (missingKey) {
      this.log.warn(`skip ${server.name}: env variable ${missingKey} is not set`)
      return fail(`Missing required env variable: ${missingKey}`)
    }

    try {
      conn.transport = await this.createTransport(
        resolved,
        server.type === 'inproc' && sessionId ? { sessionId } : undefined
      )
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

      // 握手 + 工具发现合起来才算「连上」，超时按整段算
      const handshake = (async () => {
        await conn.client.connect(conn.transport)
        const result = await conn.client.listTools()
        conn.tools = result.tools as McpDiscoveredTool[]
      })()
      await this.withTimeout(handshake, timeoutMs)

      // 这期间可能有人把这台停用/删掉了（disconnect 摘掉条目时，本次连接可能还没造出 transport，
      // 那一下根本关不到它）。此刻自己收尾，否则 stdio 会留下一个谁也管不到的子进程。
      if (this.connections.get(key) !== conn) {
        await this.closeConnection(conn, server.name)
        this.log.info(`connect aborted: ${server.name} 已在连接期间被断开`)
        return { ok: false }
      }

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
      return { ok: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      // 超时时握手可能还在跑：必须收掉 transport，否则 stdio 会留下一个没人管的子进程
      await this.closeConnection(conn, server.name)
      this.log.error(`connect failed: ${server.name} ${message}`)
      return fail(message)
    }
  }

  /**
   * 收掉 transport/client。先摘回调再关：onclose 会把状态改回 disconnected，
   * 顺序反了失败原因就被它抹掉了。
   */
  private async closeConnection(conn: McpConnection, label: string): Promise<void> {
    if (conn.transport) {
      conn.transport.onclose = undefined
      conn.transport.onerror = undefined
    }
    try {
      await conn.transport?.close()
      await conn.client?.close()
    } catch (err: unknown) {
      this.log.warn(
        `disconnect error: ${label} ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /** 超时包装（不传时长即不设限：手动连接等得起）。原任务的收尾在调用方的 catch 里 */
  private async withTimeout<T>(task: Promise<T>, timeoutMs?: number): Promise<T> {
    if (!timeoutMs) return task
    // 超时返回之后原任务可能才失败 —— 先标记已处理，免得冒成未捕获拒绝
    task.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`connect timed out after ${timeoutMs}ms`)),
            timeoutMs
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 关闭所有连接 */
  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()]
    await Promise.allSettled(ids.map((id) => this.disconnect(id)))
    this.log.info(`disconnectAll: ${ids.length} server(s) closed`)
  }

  // ─── 状态查询 ───

  /**
   * 某台服务器的连接状态。`inproc` 不带 sessionId 时给**聚合值**：任一会话连着就算 connected ——
   * 设置页问的是「这台能力在用吗」，而不是某条会话的分身。
   */
  getStatus(serverId: string, sessionId?: string): McpServerStatus {
    if (sessionId !== undefined) {
      return this.connections.get(`${serverId}#${sessionId}`)?.status ?? 'disconnected'
    }
    const direct = this.connections.get(serverId)
    if (direct) return direct.status
    let fallback: McpServerStatus = 'disconnected'
    for (const conn of this.connections.values()) {
      if (conn.serverId !== serverId) continue
      if (conn.status === 'connected') return 'connected'
      if (conn.status === 'connecting') fallback = 'connecting'
      else if (conn.status === 'error' && fallback !== 'connecting') fallback = 'error'
    }
    return fallback
  }

  getError(serverId: string, sessionId?: string): string | undefined {
    if (sessionId !== undefined) return this.connections.get(`${serverId}#${sessionId}`)?.error
    const direct = this.connections.get(serverId)
    if (direct) return direct.error
    for (const conn of this.connections.values()) {
      if (conn.serverId === serverId && conn.error) return conn.error
    }
    return undefined
  }

  /** 按 server 名读连接状态（名字不存在也算 disconnected）—— 宿主据此决定要不要报「正在连接」 */
  statusByName(serverName: string, sessionId?: string): McpServerStatus {
    const server = this.store.findAll().find((s) => s.name === serverName)
    return server ? this.getStatus(server.id, sessionId) : 'disconnected'
  }

  /** 某个 server 的工具信息（从 DB cachedTools 读 + 附加运行时状态） */
  getServerToolInfos(serverId: string): McpToolInfo[] {
    const server = this.store.findById(serverId)
    if (!server) return []
    const status = this.getStatus(serverId)
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
      const status = this.getStatus(s.id)
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
    connKey: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ content: unknown[]; isError?: boolean }> {
    const conn = this.connections.get(connKey)
    if (!conn || conn.status !== 'connected') {
      throw new Error(`MCP server ${connKey} is not connected`)
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
    connKey: string,
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
            connKey,
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

  /** 某条连接（连接键）的所有工具转 AgentTool[] */
  serverToAgentTools(connKey: string): AgentTool<TSchema, McpToolDetails>[] {
    const conn = this.connections.get(connKey)
    if (!conn || conn.status !== 'connected') return []
    return conn.tools.map((t) => this.mcpToolToAgentTool(connKey, conn.serverName, t))
  }

  /** 所有已连接 Server 的全部 AgentTool（flat） */
  getAllAgentTools(): AgentTool<TSchema, McpToolDetails>[] {
    return [...this.connections.keys()].flatMap((key) => this.serverToAgentTools(key))
  }

  /**
   * 已启用 Server 名（`mcp:<name>`）—— 可用性看配置，不看连接状态。
   *
   * 惰性启动下「还没连」是常态而不是不可用：按连接状态过滤会把用户勾好的服务器在创建
   * Agent 的前一刻抹掉，而它恰恰要在下一步才被连起来。
   */
  getEnabledToolNames(): string[] {
    return this.store.findEnabled().map((s) => `mcp:${s.name}`)
  }

  /**
   * 按服务器名获取所有 AgentTool（宿主按服务器级注入）。
   *
   * `inproc` 的实例按会话分身，所以必须连 sessionId 一起匹配 —— 否则 A 会话会拿到
   * B 会话那份实例的工具闭包，跨会话操作彼此的资源。
   */
  getAgentToolsByServerName(
    serverName: string,
    sessionId?: string
  ): AgentTool<TSchema, McpToolDetails>[] {
    for (const [key, conn] of this.connections) {
      if (conn.status !== 'connected') continue
      if (conn.serverName !== serverName) continue
      if (conn.sessionId !== undefined && conn.sessionId !== sessionId) continue
      return this.serverToAgentTools(key)
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
