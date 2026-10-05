/**
 * 真 MCP：SDK 的低层 `Server`（与 browser / ssh 内置服务器同一条路 —— 收纯 JSON Schema，不要 zod）
 * 经 `InMemoryTransport` 接到真 `McpManager` 上。
 *
 *  - **每个「进程」一个 McpManager**（重启 = 新管理器、新连接、连接计数从 0 数）；服务器的工具表也可以
 *    按进程给（I5-02 的变体：第二个进程里 docs 只报 [lookup]）。
 *  - **调用日志在世界级**（跨进程累计）：每次 tools/call 的服务器、工具、参数与 `_meta`；处理函数里的
 *    意外错误另记一份（afterEach 断言为空）。
 *  - `slow` 等一道世界级的闸门，并观察 `extra.signal`（客户端放弃 → SDK 发 cancelled → 这里中止），
 *    所以关停从不挂住。
 *  - 配置行用 `stdio` 类型（不是 inproc：inproc 要按会话分身，这里要的是普通的第三方服务器），
 *    transport 由注入的 `createTransport` 造 —— 真进程一个都不起。
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import { McpManager, type McpStore } from '../../../../mcpManager'
import { aborted, deferred, type Deferred } from '../../support/wait'

/** 一台服务器可以报的工具 */
export type SdkToolName = 'lookup' | 'slow' | 'search'

const TOOL_SPECS: Record<SdkToolName, { description: string; inputSchema: object }> = {
  lookup: {
    description: 'Look a term up in the docs',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
  },
  slow: {
    description: 'A slow docs operation',
    inputSchema: { type: 'object', properties: {} }
  },
  search: {
    description: 'Search the notes',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
  }
}

export interface SdkCall {
  readonly server: string
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly meta: Record<string, unknown> | undefined
}

/** 世界级的 MCP 记录（跨进程） */
export interface McpWorldLog {
  readonly calls: SdkCall[]
  /** 处理函数里的意外错误（afterEach 断言为空） */
  readonly errors: string[]
  /** `slow` 等的闸门（世界级；放行后新建一道） */
  slowGate: Deferred
  callsOf(tool: string, server?: string): SdkCall[]
}

export function mcpWorldLog(): McpWorldLog {
  const log: McpWorldLog = {
    calls: [],
    errors: [],
    slowGate: deferred(),
    callsOf: (tool, server) =>
      log.calls.filter(
        (call) => call.tool === tool && (server === undefined || call.server === server)
      )
  }
  return log
}

/** 一个进程里的 MCP：管理器 + 连接计数 */
export interface McpProcess {
  readonly manager: McpManager
  /** createTransport 的调用次数（按服务器名；本进程） */
  readonly connects: Map<string, number>
  connectsOf(server: string): number
  /** 本进程里各服务器报的工具（可改：下一次连接生效） */
  readonly tools: Map<string, SdkToolName[]>
  close(): Promise<void>
}

export function mcpRow(name: string): McpServer {
  return {
    id: `mcp-${name}`,
    name,
    type: 'stdio',
    command: '',
    args: '[]',
    env: '{}',
    url: '',
    headers: '{}',
    metadata: '{}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[]',
    createdAt: 0,
    updatedAt: 0
  }
}

function connectSdkServer(
  name: string,
  tools: readonly SdkToolName[],
  log: McpWorldLog,
  transport: InMemoryTransport
): Promise<void> {
  const server = new Server(
    { name: `test-${name}`, version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({ name: tool, ...TOOL_SPECS[tool] }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    log.calls.push({
      server: name,
      tool,
      args,
      meta: request.params._meta as Record<string, unknown> | undefined
    })
    if (!tools.includes(tool as SdkToolName)) {
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${tool}` }] }
    }
    try {
      if (tool === 'slow') {
        await Promise.race([log.slowGate.promise, aborted(extra.signal)])
        return { content: [{ type: 'text', text: 'slow done' }] }
      }
      return { content: [{ type: 'text', text: `${name}.${tool}:${String(args.q ?? '')}` }] }
    } catch (error) {
      if (!extra.signal.aborted)
        log.errors.push(error instanceof Error ? error.message : String(error))
      throw error
    }
  })
  return server.connect(transport)
}

/**
 * 一个进程的 McpManager。`servers`：服务器名 → 它报的工具（本进程）。
 */
export function mcpProcess(
  servers: Readonly<Record<string, readonly SdkToolName[]>>,
  log: McpWorldLog
): McpProcess {
  const rows = Object.keys(servers).map(mcpRow)
  const tools = new Map(Object.entries(servers).map(([name, list]) => [name, [...list]]))
  const connects = new Map<string, number>()
  const store: McpStore = {
    findById: (id) => rows.find((row) => row.id === id),
    findEnabled: () => rows.filter((row) => row.isEnabled === 1),
    findAll: () => rows,
    updateCachedTools: () => {}
  }
  const manager = new McpManager({
    store,
    createTransport: async (server) => {
      connects.set(server.name, (connects.get(server.name) ?? 0) + 1)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await connectSdkServer(server.name, tools.get(server.name) ?? [], log, serverTransport)
      return clientTransport
    }
  })
  return {
    manager,
    connects,
    connectsOf: (server) => connects.get(server) ?? 0,
    tools,
    close: () => manager.disconnectAll()
  }
}
