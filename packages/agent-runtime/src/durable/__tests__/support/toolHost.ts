/**
 * 测试用 ToolHost（每个「模拟进程」一份 —— 重启 = 新的调用记录、新的假 MCP 服务器）。
 *
 *  - `buildBuiltinTools`：内置工具集（缺省为空；`scenario: 'w'` = 场景 W 的那套，darwin 有 bash、
 *    win32 有 powershell）。bash 的描述带 `sandboxed=<钉子>`，好在请求里看出沙箱钉子。
 *  - `resolveAgentTools`：派发工具按 `offersDispatchTool`（名单含 `agent`，且 root 或 `canSpawn`）；
 *    点了名且宿主有的技能 → 一个技能工具（描述列出技能）；`mcp:<s>` → 连假服务器（连不上就广播一条
 *    error 并跳过，K7），工具名 `mcp__<s>__<t>`，replay unsafe，调用经 `fake.call`（掉线原地重连）。
 *    外加 `agentTools`（总在）与附加工具：请求的 `extraTools` 在前、选项的 `extraTools` 在后（PIN-12），
 *    原样（同一对象）交回。
 *  - `rebuildAgentTools`：只按记录（`skills` / `mcp` / `toolNames`，派生的再看 `canSpawn`）重建，
 *    缺省不连服务器；上下文带 `connect`（option A 的完整初始化）时把记录里的服务器逐台连上（连不上 →
 *    与解析时同一条 error 广播，工具照旧按快照建）。重建上下文的 `extraTools` 原样放进 `extraTools`
 *    （PIN-03 R）。资源按上下文的 `sessionId` 找（PIN-10）。
 *
 * 旋钮：`sandbox`（解析时报的钉子）、`failResolve` / `failRebuild` / `failRebuildFor`（按 agentId / 'root'）、`omitOnRebuild`（重建时故意漏掉的
 * 工具名，附加工具也算）、`platform`。`rebuildContexts` 记每次重建的上下文。
 */
import { Type } from '@earendil-works/pi-ai'
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { McpToolDeclaration } from '../../../mcpManager'
import type { SpawnedAgentRecord } from '../../agentRecord'
import type { LockRecord } from '../../lock'
import {
  offersDispatchTool,
  type AgentToolSet,
  type AgentToolsRebuildContext,
  type AgentToolsRequest,
  type BuiltinToolsRequest,
  type ResolvedAgentTools,
  type ToolHost
} from '../../seams'
import { fakeMcpServer, type FakeMcpServer } from './mcpFake'

export type TestPlatform = 'darwin' | 'win32'

export interface TestToolHostOptions {
  /** 内置工具集：缺省没有；'w' = 场景 W */
  scenario?: 'w'
  platform?: TestPlatform
  /** 宿主上可用的技能 */
  skills?: readonly string[]
  /** 假 MCP 服务器：名字 → 工具声明 */
  mcp?: Readonly<Record<string, readonly McpToolDeclaration[]>>
  /** 每个 agent 都带的工具（按会话给，或同一份；每次解析 / 重建现读） */
  agentTools?:
    | readonly ToolRegistration[]
    | ((sessionId: string, names: readonly string[]) => readonly ToolRegistration[])
  /** 解析时交回的附加工具（排在请求自带的之后） */
  extraTools?: readonly ToolRegistration[]
  /** 解析时报的沙箱钉子（缺省 false） */
  sandbox?: boolean
  /**
   * 派发工具（`set.agent`）的实现（P2-03）：缺省一个只回 `agent ok` 的占位；可按会话给（P2-05：真派发工具
   * 带着会话 id）。给不给照旧按 `offersDispatchTool`（名单含 `agent`，且 root 或 `canSpawn`）
   */
  dispatchTool?: ToolRegistration | ((sessionId: string) => ToolRegistration)
}

export interface TestToolHost extends ToolHost {
  readonly options: TestToolHostOptions
  readonly builtinCalls: BuiltinToolsRequest[]
  readonly resolveCalls: AgentToolsRequest[]
  readonly rebuildCalls: (LockRecord | SpawnedAgentRecord)[]
  /** 每次重建的上下文（与 rebuildCalls 一一对应） */
  readonly rebuildContexts: AgentToolsRebuildContext[]
  /** 解析时报的沙箱钉子（可改） */
  sandbox: boolean
  platform: TestPlatform
  failResolve: Error | undefined
  failRebuild: Error | undefined
  /** 按记录的重建失败（P2-03）：键 = 派生 agent 的 agentId，或 `'root'`（锁） */
  readonly failRebuildFor: Map<string, Error>
  readonly omitOnRebuild: Set<string>
  /** 解析结果交出之前的最后一道改写（注入坏数据用） */
  transformResolved: ((resolved: ResolvedAgentTools) => ResolvedAgentTools) | undefined
  /** 解析开始时调用（可返回一个 promise 卡住解析；观察 signal） */
  beforeResolve: ((signal: AbortSignal) => void | Promise<void>) | undefined
  /** 假 MCP 服务器（按名） */
  mcp(name: string): FakeMcpServer
  readonly servers: ReadonlyMap<string, FakeMcpServer>
}

const SAFE = new Set(['read', 'ls', 'grep', 'glob', 'ask'])

function simpleTool(
  name: string,
  description: string,
  replay: 'safe' | 'unsafe' = 'unsafe'
): ToolRegistration {
  return defineTool({
    name,
    description,
    parameters: Type.Object({}),
    replay,
    execute: async (): Promise<ToolExecutionResult> => ({
      content: [{ type: 'text', text: `${name} ok` }]
    })
  })
}

/** 场景 W 的内置工具（darwin：bash；win32：powershell） */
export function scenarioBuiltins(
  platform: TestPlatform,
  sandboxed: boolean | undefined
): ToolRegistration[] {
  const shell = platform === 'win32' ? 'powershell' : 'bash'
  const names = [
    shell,
    'read',
    'ls',
    'grep',
    'glob',
    'write',
    'edit',
    'ask',
    'session',
    'knowledge',
    'artifact',
    'git'
  ]
  return names.map((name) =>
    name === shell
      ? simpleTool(name, `${name}: run a command (sandboxed=${String(sandboxed)})`)
      : simpleTool(name, `${name}: builtin`, SAFE.has(name) ? 'safe' : 'unsafe')
  )
}

function mcpTool(server: FakeMcpServer, decl: McpToolDeclaration): ToolRegistration {
  return {
    name: `mcp__${server.name}__${decl.name}`,
    description: decl.description ?? '',
    parameters: Type.Unsafe<Record<string, unknown>>(decl.inputSchema as Record<string, unknown>),
    replay: 'unsafe',
    execute: async (args, _api, context) => {
      try {
        return await server.call(decl.name, args, context.abortSignal)
      } catch (error) {
        if (context.abortSignal?.aborted) throw error
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[MCP Error] ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        }
      }
    }
  }
}

function dispatchTool(): ToolRegistration {
  return simpleTool('agent', 'agent: dispatch a sub-agent')
}

function skillTool(skills: readonly string[]): ToolRegistration {
  return simpleTool('skill', `skill: load a skill (${skills.join(', ')})`)
}

export function makeTestToolHost(
  options: TestToolHostOptions,
  broadcast: (event: ChatEvent) => void
): TestToolHost {
  const servers = new Map<string, FakeMcpServer>()
  for (const [name, decls] of Object.entries(options.mcp ?? {})) {
    servers.set(name, fakeMcpServer(name, decls))
  }
  const dispatchOf = (sessionId: string): ToolRegistration => {
    const source = options.dispatchTool
    if (source === undefined) return dispatchTool()
    return typeof source === 'function' ? source(sessionId) : source
  }
  /** 函数形式拿到这次解析 / 重建的名单（请求的 names / 记录的 toolNames），可以按名单筛 */
  const agentToolsOf = (
    sessionId: string,
    names: readonly string[]
  ): readonly ToolRegistration[] => {
    const source = options.agentTools
    if (source === undefined) return []
    return typeof source === 'function' ? source(sessionId, names) : source
  }
  const host: TestToolHost = {
    options,
    builtinCalls: [],
    resolveCalls: [],
    rebuildCalls: [],
    rebuildContexts: [],
    sandbox: options.sandbox ?? false,
    platform: options.platform ?? 'darwin',
    failResolve: undefined,
    failRebuild: undefined,
    failRebuildFor: new Map(),
    omitOnRebuild: new Set(),
    transformResolved: undefined,
    beforeResolve: undefined,
    servers,
    mcp: (name) => {
      const server = servers.get(name)
      if (server === undefined) throw new Error(`no fake MCP server ${name}`)
      return server
    },
    buildBuiltinTools: (request) => {
      host.builtinCalls.push({ ...request })
      return options.scenario === 'w' ? scenarioBuiltins(host.platform, request.sandboxed) : []
    },
    resolveAgentTools: async (request, { signal }) => {
      host.resolveCalls.push(request)
      await host.beforeResolve?.(signal)
      if (host.failResolve !== undefined) throw host.failResolve
      const available = new Set(options.skills ?? [])
      const skills = request.names
        .filter((name) => name.startsWith('skill:'))
        .map((name) => name.slice('skill:'.length))
        .filter((name) => available.has(name))
      const mcp: NonNullable<ResolvedAgentTools['mcp']>[number][] = []
      for (const name of request.names) {
        if (!name.startsWith('mcp:')) continue
        const server = servers.get(name.slice('mcp:'.length))
        if (server === undefined) continue
        try {
          await server.connect(signal)
        } catch (error) {
          if (signal.aborted) throw error
          broadcast({
            type: 'error',
            sessionId: request.sessionId,
            error: `MCP server ${server.name} failed to connect: ${error instanceof Error ? error.message : String(error)}`
          })
          continue
        }
        const declarations = server.declarations
        mcp.push({
          server: server.name,
          declarations,
          tools: declarations.map((decl) => mcpTool(server, decl))
        })
      }
      const extras =
        request.extraTools === undefined && options.extraTools === undefined
          ? undefined
          : [...(request.extraTools ?? []), ...(options.extraTools ?? [])]
      const resolved: ResolvedAgentTools = {
        ...(offersDispatchTool(request) ? { agent: dispatchOf(request.sessionId) } : {}),
        ...(skills.length > 0 ? { skill: skillTool(skills) } : {}),
        skills,
        mcp,
        tools: [...agentToolsOf(request.sessionId, request.names)],
        ...(extras === undefined ? {} : { extraTools: extras }),
        sandboxed: host.sandbox
      }
      return host.transformResolved ? host.transformResolved(resolved) : resolved
    },
    rebuildAgentTools: (record, context) => {
      host.rebuildCalls.push(record)
      host.rebuildContexts.push({ ...context })
      if (host.failRebuild !== undefined) throw host.failRebuild
      const keyed = host.failRebuildFor.get('agentId' in record ? record.agentId : 'root')
      if (keyed !== undefined) throw keyed
      const { sessionId } = context
      const keep = (tool: ToolRegistration): boolean => !host.omitOnRebuild.has(tool.name)
      const dispatch = offersDispatchTool({
        kind: record.kind,
        names: record.toolNames,
        ...('canSpawn' in record ? { canSpawn: record.canSpawn } : {})
      })
      const set: AgentToolSet = {
        ...(dispatch ? { agent: dispatchOf(sessionId) } : {}),
        ...(record.skills.length > 0 ? { skill: skillTool(record.skills) } : {}),
        mcp: Object.entries(record.mcp).map(([name, declarations]) => {
          const server = servers.get(name) ?? fakeMcpServer(name, [])
          return { server: name, tools: declarations.map((decl) => mcpTool(server, decl)) }
        }),
        tools: [...agentToolsOf(sessionId, record.toolNames)]
      }
      const extras = (context.extraTools ?? []).filter(keep)
      const rebuilt: AgentToolSet = {
        ...(set.agent !== undefined && keep(set.agent) ? { agent: set.agent } : {}),
        ...(set.skill !== undefined && keep(set.skill) ? { skill: set.skill } : {}),
        mcp: (set.mcp ?? []).map((entry) => ({
          server: entry.server,
          tools: entry.tools.filter(keep)
        })),
        tools: (set.tools ?? []).filter(keep),
        ...(extras.length > 0 ? { extraTools: extras } : {})
      }
      const connect = context.connect
      if (connect === undefined) return rebuilt
      // 完整初始化（option A）：记录里的服务器当场连（连不上与解析时同一条广播，工具照旧按快照建）
      return (async () => {
        for (const name of Object.keys(record.mcp)) {
          const server = servers.get(name)
          if (server === undefined) continue
          try {
            await server.connect(connect.signal)
          } catch (error) {
            if (connect.signal.aborted) throw error
            broadcast({
              type: 'error',
              sessionId,
              error: `MCP server ${server.name} failed to connect: ${error instanceof Error ? error.message : String(error)}`
            })
          }
        }
        return rebuilt
      })()
    }
  }
  return host
}
