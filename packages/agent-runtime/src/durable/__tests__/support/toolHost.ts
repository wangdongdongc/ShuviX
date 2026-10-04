/**
 * 测试用 ToolHost（每个「模拟进程」一份 —— 重启 = 新的调用记录、新的假 MCP 服务器）。
 *
 *  - `buildBuiltinTools`：内置工具集（缺省为空；`scenario: 'w'` = 场景 W 的那套，darwin 有 bash、
 *    win32 有 powershell）。bash 的描述带 `sandboxed=<钉子>`，好在请求里看出沙箱钉子。
 *  - `resolveAgentTools`：名单含 `agent` → 派发工具；点了名且宿主有的技能 → 一个技能工具（描述列出
 *    技能）；`mcp:<s>` → 连假服务器（连不上就广播一条 error 并跳过，K7），工具名 `mcp__<s>__<t>`，
 *    replay unsafe，调用经 `fake.call`（掉线原地重连）。外加 `agentTools`（总在）与 `extraTools`。
 *  - `rebuildAgentTools`：只按锁记录（`lock.skills` / `lock.mcp` / `lock.toolNames`）重建，不连服务器。
 *
 * 旋钮：`sandbox`（解析时报的钉子）、`failResolve` / `failRebuild`、`omitOnRebuild`（重建时故意漏掉的
 * 工具名）、`platform`。
 */
import { Type } from '@earendil-works/pi-ai'
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { McpToolDeclaration } from '../../../mcpManager'
import type { LockRecord } from '../../lock'
import type {
  AgentToolSet,
  AgentToolsRequest,
  BuiltinToolsRequest,
  ResolvedAgentTools,
  ToolHost
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
  agentTools?: readonly ToolRegistration[] | ((sessionId: string) => readonly ToolRegistration[])
  /** 解析时交回的附加工具 */
  extraTools?: readonly ToolRegistration[]
  /** 解析时报的沙箱钉子（缺省 false） */
  sandbox?: boolean
}

export interface TestToolHost extends ToolHost {
  readonly options: TestToolHostOptions
  readonly builtinCalls: BuiltinToolsRequest[]
  readonly resolveCalls: AgentToolsRequest[]
  readonly rebuildCalls: LockRecord[]
  /** 解析时报的沙箱钉子（可改） */
  sandbox: boolean
  platform: TestPlatform
  failResolve: Error | undefined
  failRebuild: Error | undefined
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
  const agentToolsOf = (sessionId: string): readonly ToolRegistration[] => {
    const source = options.agentTools
    if (source === undefined) return []
    return typeof source === 'function' ? source(sessionId) : source
  }
  const host: TestToolHost = {
    options,
    builtinCalls: [],
    resolveCalls: [],
    rebuildCalls: [],
    sandbox: options.sandbox ?? false,
    platform: options.platform ?? 'darwin',
    failResolve: undefined,
    failRebuild: undefined,
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
      const resolved: ResolvedAgentTools = {
        ...(request.names.includes('agent') ? { agent: dispatchTool() } : {}),
        ...(skills.length > 0 ? { skill: skillTool(skills) } : {}),
        skills,
        mcp,
        tools: [...agentToolsOf(request.sessionId)],
        ...(options.extraTools === undefined ? {} : { extraTools: options.extraTools }),
        sandboxed: host.sandbox
      }
      return host.transformResolved ? host.transformResolved(resolved) : resolved
    },
    rebuildAgentTools: (lock, { sessionId }) => {
      host.rebuildCalls.push(lock)
      if (host.failRebuild !== undefined) throw host.failRebuild
      const keep = (tool: ToolRegistration): boolean => !host.omitOnRebuild.has(tool.name)
      const set: AgentToolSet = {
        ...(lock.toolNames.includes('agent') ? { agent: dispatchTool() } : {}),
        ...(lock.skills.length > 0 ? { skill: skillTool(lock.skills) } : {}),
        mcp: Object.entries(lock.mcp).map(([name, declarations]) => {
          const server = servers.get(name) ?? fakeMcpServer(name, [])
          return { server: name, tools: declarations.map((decl) => mcpTool(server, decl)) }
        }),
        tools: [...agentToolsOf(sessionId)]
      }
      return {
        ...(set.agent !== undefined && keep(set.agent) ? { agent: set.agent } : {}),
        ...(set.skill !== undefined && keep(set.skill) ? { skill: set.skill } : {}),
        mcp: (set.mcp ?? []).map((entry) => ({
          server: entry.server,
          tools: entry.tools.filter(keep)
        })),
        tools: (set.tools ?? []).filter(keep)
      }
    }
  }
  return host
}
