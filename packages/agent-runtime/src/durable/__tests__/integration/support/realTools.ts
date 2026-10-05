/**
 * 真工具与真 ToolHost（P1-12 的「整条链」）：
 *
 *  - 文件工具 = 真 `createFileToolSuite`（read / write / edit）跑在世界级的 MemFs 上；询问走真安全模块
 *    （`createSecurityContext` + 内联的内置策略）—— 桌面口径：工作区 `/ws`、家目录 `/fake-home`、
 *    会话目录刻意给空（`ask-on-external-path` 于是对每一次写都问），工作区在家目录外、读不问；
 *  - `ask` = 真 `createAskTool`；
 *  - 两个测试 BaseTool：`dump`（N 行输出，details 声明 truncated / persisted）与 `boom`（抛 `boom`）；
 *  - 全部经 agent-runtime 的 `wrapDurableOutput(tool, { spill: 'auto', sink })` 包好（PIN-2）；
 *  - MCP 工具来自真 `McpManager`：创建时按名惰性连接、取注册项与声明快照；重开时按锁里的声明建注册项，
 *    **不连**（第一次调用时原地连）。
 *
 * 询问通道是**晚绑定**的：`requestUserInput(sessionId)` 每次现找那条会话此刻打开着的实例（重启之后
 * 是新进程的那个）；找不到就当关停取消。审查接缝（`onPermissionRequest`）只记下事件、回 null（照旧问人）。
 */
import { Type } from 'typebox'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { createAskTool } from '../../../../askTool'
import { createInlinePolicyMdReader } from '../../../../security/builtinPolicies/inlineSources'
import { createSecurityContext } from '../../../../security/context'
import type {
  PermissionRequestEvent,
  SecurityContext,
  SecurityHostProvider
} from '../../../../security/types'
import { BaseTool } from '../../../../tools/baseTool'
import { createFileToolSuite, type FileToolSuite } from '../../../../tools/fileToolSuite'
import type { ToolResult } from '../../../../tools/toolResult'
import { wrapDurableOutput } from '../../../../toolOutput/wrapDurableOutput'
import type { LockRecord } from '../../../lock'
import type {
  AgentToolSet,
  AgentToolsRequest,
  BuiltinToolsRequest,
  ResolvedAgentTools,
  ToolHost
} from '../../../seams'
import type { McpProcess } from './mcpSdk'
import type { MemFs } from './memFs'
import { memorySink, type SpillLog } from './spill'

export const WORKSPACE = '/ws'
export const FAKE_HOME = '/fake-home'

const INLINE_POLICY_MD = createInlinePolicyMdReader()

export type RequestUserInput = (request: InputRequest) => Promise<InputResponse>

/** 桌面口径的安全上下文（见文件头）。`permissionLog` 给了就接上审查接缝（记事件、回 null） */
export function securityFor(
  sessionId: string,
  requestUserInput: RequestUserInput | undefined,
  permissionLog?: PermissionRequestEvent[]
): SecurityContext {
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({
      workspace: WORKSPACE,
      toolResultsBase: '/tool_results',
      skillsDirs: [],
      memoryDirs: [],
      knowledgeRoot: '/kb',
      knowledgeSessionDirs: [],
      home: FAKE_HOME,
      systemDirs: [],
      sessionDirs: [],
      sessionReadDirs: []
    }),
    readBuiltinPolicyMd: INLINE_POLICY_MD,
    getSessionGrants: () => ({ allowList: [] }),
    isDirectory: () => false,
    ...(requestUserInput === undefined ? {} : { requestUserInput }),
    ...(permissionLog === undefined
      ? {}
      : {
          onPermissionRequest: async (event: PermissionRequestEvent) => {
            permissionLog.push(event)
            return null
          }
        })
  }
  return createSecurityContext(
    { kind: 'agent', sessionId, agentKind: 'root' },
    { host: 'desktop' },
    provider
  )
}

export function resolveWorkspacePath(path: string): string {
  return path.startsWith('/') ? path : `${WORKSPACE}/${path}`
}

/** 真文件工具套件（未包装）—— 世界的 ToolHost 用它，测试也拿它直接调一次做对照 */
export function fileSuite(fs: MemFs, security: SecurityContext): FileToolSuite {
  return createFileToolSuite({
    port: fs.port,
    guards: fs.guards,
    resolvePath: resolveWorkspacePath,
    security,
    labels: { read: 'Read', write: 'Write', edit: 'Edit' },
    descriptions: {
      read: 'Read a file in the workspace',
      write: 'Write a file in the workspace',
      edit: 'Edit a file in the workspace'
    }
  })
}

const DumpParams = Type.Object({ lines: Type.Number({ description: 'How many lines to print' }) })

/** `line 1` … `line N`（每行唯一，好断言预览里有没有某一行） */
export function dumpText(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n')
}

/** 测试 BaseTool：交回 N 行，details 声明 truncated / persisted（包装器把截断 / 落盘 OR 进去） */
class DumpTool extends BaseTool<typeof DumpParams> {
  readonly name = 'dump'
  readonly label = 'Dump'
  readonly description = 'Print N lines'
  readonly parameters = DumpParams
  override readonly replay = 'safe' as const

  async preExecute(): Promise<void> {
    /* nothing to prepare */
  }
  protected async securityCheck(): Promise<void> {
    /* no gate: a test tool */
  }
  protected async executeInternal(
    _toolCallId: string,
    params: { lines: number }
  ): Promise<ToolResult<{ type: 'dump'; truncated: boolean; persisted: boolean }>> {
    return {
      content: [{ type: 'text', text: dumpText(params.lines) }],
      details: { type: 'dump', truncated: false, persisted: false }
    }
  }
}

const NoParams = Type.Object({})

/** 测试 BaseTool：抛 `boom`（Q12：模型看到的就是这句，不进 `<harness>`） */
class BoomTool extends BaseTool<typeof NoParams> {
  readonly name = 'boom'
  readonly label = 'Boom'
  readonly description = 'Always fails'
  readonly parameters = NoParams
  override readonly replay = 'unsafe' as const

  async preExecute(): Promise<void> {
    /* nothing to prepare */
  }
  protected async securityCheck(): Promise<void> {
    /* no gate: a test tool */
  }
  protected async executeInternal(): Promise<ToolResult> {
    throw new Error('boom')
  }
}

export interface RealToolHostOptions {
  readonly fs: MemFs
  readonly mcp: McpProcess
  readonly spill: SpillLog
  /** 某会话的询问通道（晚绑定，见文件头） */
  readonly requestUserInput: (sessionId: string) => RequestUserInput
  /** 审查接缝收到的事件（跨会话） */
  readonly permissionLog: PermissionRequestEvent[]
}

export interface RealToolHost extends ToolHost {
  readonly builtinCalls: BuiltinToolsRequest[]
  readonly resolveCalls: AgentToolsRequest[]
  readonly rebuildCalls: LockRecord[]
}

/** 真工具的 ToolHost（每个「进程」一个；MemFs / 落盘记录 / 审查记录是世界级的） */
export function realToolHost(options: RealToolHostOptions): RealToolHost {
  const { fs, mcp, spill } = options
  const securities = new Map<string, SecurityContext>()
  const securityOf = (sessionId: string): SecurityContext => {
    let security = securities.get(sessionId)
    if (security === undefined) {
      const ask: RequestUserInput = (request) => options.requestUserInput(sessionId)(request)
      security = securityFor(sessionId, ask, options.permissionLog)
      securities.set(sessionId, security)
    }
    return security
  }
  const wrap = (sessionId: string, tool: ToolRegistration): ToolRegistration =>
    wrapDurableOutput(tool, { spill: 'auto', sink: memorySink(fs, sessionId, spill) })

  const host: RealToolHost = {
    builtinCalls: [],
    resolveCalls: [],
    rebuildCalls: [],
    buildBuiltinTools: (request) => {
      host.builtinCalls.push({ ...request })
      const { sessionId } = request
      const suite = fileSuite(fs, securityOf(sessionId))
      const ask = createAskTool({
        requestUserInput: (input) => options.requestUserInput(sessionId)(input)
      })
      return [suite.read, suite.write, suite.edit, ask, new DumpTool(), new BoomTool()].map(
        (tool) => wrap(sessionId, tool)
      )
    },
    resolveAgentTools: async (request): Promise<ResolvedAgentTools> => {
      host.resolveCalls.push(request)
      const { sessionId } = request
      const entries: NonNullable<ResolvedAgentTools['mcp']>[number][] = []
      for (const name of request.names) {
        if (!name.startsWith('mcp:')) continue
        const server = name.slice('mcp:'.length)
        const result = await mcp.manager.ensureServerByName(server, { sessionId })
        if (!result.ok) continue
        entries.push({
          server,
          declarations: mcp.manager.declarationsOf(server, sessionId),
          tools: mcp.manager
            .getRegistrationsByServerName(server, sessionId)
            .map((tool) => wrap(sessionId, tool))
        })
      }
      return { mcp: entries, skills: [], sandboxed: false }
    },
    rebuildAgentTools: (lock, { sessionId }): AgentToolSet => {
      host.rebuildCalls.push(lock)
      return {
        mcp: Object.entries(lock.mcp).map(([server, declarations]) => ({
          server,
          tools: mcp.manager
            .registrationsFromDeclarations(server, sessionId, declarations)
            .map((tool) => wrap(sessionId, tool))
        }))
      }
    }
  }
  return host
}
