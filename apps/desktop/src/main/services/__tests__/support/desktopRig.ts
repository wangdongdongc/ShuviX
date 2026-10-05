/**
 * P2-12 的桌面整合夹具（docs/pi-durable/p2-12-test-design.md「Harness additions」）：真 SessionHost + 临时目录
 * 里的真 SQLite + **真桌面 ToolHost**（`createDesktopToolHost`，不覆盖 `toolHost`）+ 真 toolRegistry / 包装器 /
 * 安全上下文 / hookService（内置 auto-title 与 auto-review 两份 md）/ permissionReview / 路由（AgentManager）/
 * 子会话运行器 / taskRegistry。不做断言。
 *
 *  - **替身**只到外部为止：DB 换成内存里的 node:sqlite（跑真迁移）、目录换成临时目录、electron、模型注册表
 *    （= 这个进程的 faux 目录）、MCP（没有服务器）、技能（空）、沙箱（不启用）、bot（没有）、档案表
 *    （`PROFILES`：每份档案的正文带 `ROLE:<名字>` 标记，faux 路由据此认人）、用户策略（每例给 md 原文）、
 *    询问通道（`userInputBroker.requestUserInputFor`：记下询问、按脚本答）、设置（可变表）、日志（全记下）。
 *    `tools/allTools` 仍是空的：内置工具只有 `session`（真 SessionTool，import 即自注册）与本夹具经真
 *    `registerBuiltinTool` 注册的 `probe`（safe，记下调用方身份）、`askOp`（unsafe，空身体，由策略设门）。
 *  - **进程**（PIN-01）：`bootProcess()` = `vi.resetModules()` + 重新 import 全套模块 —— 进程内的状态
 *    （taskRegistry、运行器的记账、路由的索引、hook runner、审查状态）与真崩溃一样全部消失；DB 与目录在
 *    hoisted 的 holder 里，跨进程活着。`crash()`（PIN-02）= 限时 `closeAll` → 等上一个进程的发送收尾、吞掉它
 *    的 promise → `bootProcess()`。
 *  - **faux 路由**（PIN-03）：`routedSteps` —— 每条路由一个谓词（系统提示词里的 `ROLE:<档案>`、对话第一条用户
 *    消息）和自己的 FIFO；认不出的请求直接抛（报出它的第一条用户消息）。
 *  - **存储查看**：只用 `host.get` / `peek`，从不 `open`。
 *
 * 替身登记在本模块里（vi.mock 在 import 它的测试文件之前生效）：测试文件**第一个** import 它。
 */
import { vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Type, getCurrentSystemPrompt, type FauxResponseStep } from '@earendil-works/pi-ai'
import {
  defineTool,
  type ConversationId,
  type TaskRecord,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type {
  DurableSession,
  SessionHost,
  SessionHostDeps,
  SpawnedAgentRecord
} from '@shuvix/agent-runtime'
import type { Session } from '../../../dao/types'
import type { ToolAgentIdentity } from '../../toolAgent'
import { fauxKit, testDepsOverrides, transcript, withTimeout, type FauxKit } from './realHost'
import { messageText } from '../../../../../../../packages/agent-runtime/src/durable/__tests__/support/transcript'

// ─────────────────────────── 跨进程的状态（hoisted） ───────────────────────────

const rig = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  toolResults: '',
  userData: '',
  hooksDir: '',
  builtinHooksDir: `${__dirname}/../../../../../../../packages/agent-runtime/src/hook/builtinHooks/md`,
  builtinPoliciesDir: `${__dirname}/../../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`,
  /** 这个进程的模型目录（faux）：`services/models` 的替身交它 */
  catalog: null as null | { registry: unknown; port: Record<string, unknown> },
  /** chatFrontendRegistry / electronEventSink 的广播 */
  broadcasts: [] as Array<Record<string, unknown>>,
  /** settingsService.get 的值表 */
  settings: new Map<string, string>(),
  /** 档案表（agentService.getProfile；用例可改） */
  profiles: {} as Record<string, Record<string, unknown>>,
  /** 用户策略（policyService.getUserPolicies 交回的解析结果） */
  userPolicies: [] as unknown[],
  /** 询问通道收到的询问 */
  asks: [] as Array<{ sessionId: string; request: InputRequest }>,
  /** 询问的脚本答复（缺省允许） */
  answerAsk: ((_sessionId: string, _request: InputRequest): InputResponse => ({
    kind: 'ask',
    allowed: true
  })) as (sessionId: string, request: InputRequest) => InputResponse | Promise<InputResponse>,
  /** 主进程日志：`<模块>: <文本>` */
  logs: [] as Array<{ level: string; scope: string; msg: string }>,
  /** mcpService 的启动期注册：内置 MCP 认调用方的解析器 */
  builtinResolver: null as null | ((sessionId: string, conversationId: number) => unknown),
  ensureServerByName: [] as unknown[]
}))

// ─────────────────────────── 替身 ───────────────────────────

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9',
    getPath: () => rig.userData,
    isPackaged: false,
    on: () => undefined
  },
  shell: { openPath: async () => '' }
}))
vi.mock('../../../dao/database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return rig.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (rig.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => rig.db } }
})
vi.mock('../../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: () => [],
    findEnabled: () => [],
    findEnabledModels: () => [],
    findAllEnabledModels: () => []
  }
}))
vi.mock('../../../dao/settingsDao', () => ({ settingsDao: { findByKey: () => undefined } }))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: () => undefined }
}))
vi.mock('../../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: () => undefined } }))
vi.mock('../../../utils/paths', () => ({
  getSessionsDir: () => rig.sessionsDir,
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-p212/tmp/${sid}`,
  getToolResultsBase: () => rig.toolResults,
  getToolResultsDir: (sid: string) => {
    const dir = `${rig.toolResults}/${sid}`
    mkdirSync(dir, { recursive: true })
    return dir
  },
  getSessionArtifactsDir: (sid: string) => `/nonexistent/shuvix-p212/artifacts/${sid}`,
  isSafeSessionId: () => true,
  getBuiltinHooksDir: () => rig.builtinHooksDir,
  getDefaultHooksDir: () => rig.hooksDir,
  getDefaultSkillsDir: () => '/nonexistent/shuvix-p212/skills',
  getBuiltinSkillsDir: () => '/nonexistent/shuvix-p212/builtin-skills',
  getMemoryRootDir: () => '/nonexistent/shuvix-p212/memory',
  getDefaultBotsDir: () => '/nonexistent/shuvix-p212/bots',
  getDefaultPoliciesDir: () => '/nonexistent/shuvix-p212/policies',
  getDefaultAgentsDir: () => '/nonexistent/shuvix-p212/agents',
  getBuiltinKnowledgeDir: () => '/nonexistent/shuvix-p212/builtin-knowledge',
  getShuvixKnowledgeRootDir: () => '/nonexistent/shuvix-p212/knowledge'
}))
vi.mock('../../models', () => ({
  getModelRegistry: () => {
    if (!rig.catalog) throw new Error('no faux catalog in this process')
    return rig.catalog.registry
  },
  providerCredentialPort: new Proxy(
    {},
    {
      get: (_target, key) => {
        const port = rig.catalog?.port as Record<string | symbol, unknown> | undefined
        const value = port?.[key]
        return typeof value === 'function' ? (value as () => unknown).bind(port) : value
      }
    }
  )
}))
// 运行时事件与前端广播都进同一张表（electronEventSink = 注册表 + 通知旁路，这里直通）
vi.mock('../../agentRuntimeAdapters', () => ({
  electronEventSink: {
    broadcast: (event: Record<string, unknown>) => void rig.broadcasts.push(event),
    hasUserInputCapability: () => true
  },
  runtimeLogger: {
    info: (m: string) => void rig.logs.push({ level: 'info', scope: 'runtime', msg: m }),
    warn: (m: string) => void rig.logs.push({ level: 'warn', scope: 'runtime', msg: m }),
    error: (m: string) => void rig.logs.push({ level: 'error', scope: 'runtime', msg: m })
  }
}))
vi.mock('../../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: {
    broadcast: (event: Record<string, unknown>) => void rig.broadcasts.push(event)
  },
  ChatFrontendRegistry: class {}
}))
vi.mock('../../settingsService', () => ({
  settingsService: { get: (key: string) => rig.settings.get(key) }
}))
vi.mock('../../sessionDayPromptService', () => ({
  recordPromptAdmitted: () => undefined,
  recordFromUserMessageEvent: () => undefined
}))
vi.mock('../../toolAggregator', () => ({ filterAvailableTools: (tools: string[]) => tools }))
vi.mock('../../mcpService', () => ({
  mcpService: {
    closeSession: async () => {},
    getAllToolInfos: () => [],
    statusByName: () => 'disconnected',
    ensureServerByName: async (...args: unknown[]) => {
      rig.ensureServerByName.push(args)
      return { ok: false }
    },
    declarationsOf: () => [],
    registrationsFromDeclarations: () => []
  },
  setBuiltinMcpAgentResolver: (resolver: typeof rig.builtinResolver) => {
    rig.builtinResolver = resolver
  }
}))
vi.mock('../../agentService', () => ({
  agentService: {
    getProfile: (name: string) => rig.profiles[name],
    isSessionProfile: () => true,
    listAll: () => Object.values(rig.profiles),
    loadAgentFromRef: async () => undefined
  }
}))
vi.mock('../../bgTaskService', () => ({
  killBySession: () => undefined,
  setBgTaskNotifier: () => undefined
}))
vi.mock('../../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: () => undefined,
  broadcastSessionListChanged: () => undefined,
  broadcastSessionTitleChanged: (sessionId: string, title: string) =>
    void rig.broadcasts.push({ type: 'titleChanged', sessionId, title })
}))
vi.mock('../../artifacts/store', () => ({ deleteSessionArtifacts: () => undefined }))
vi.mock('../../sandbox', () => ({
  cleanupSession: () => undefined,
  sandboxGloballyActive: () => false,
  sessionDirsView: () => ({ sessionDirs: [], sessionReadDirs: [] }),
  planFor: () => null,
  whyUnconfined: () => 'disabled'
}))
vi.mock('../../../utils/toolUtils/fileTime', () => ({
  clearSession: () => undefined,
  recordRead: () => undefined
}))
vi.mock('../../../tools/allTools', () => ({}))
vi.mock('../../builtinMcp/dbConnections', () => ({
  dbManager: { runtimeStatus: () => undefined, getConnectionInfo: () => undefined }
}))
vi.mock('../../builtinMcp/sshServer', () => ({
  sshRuntimeStatuses: () => ({}),
  sshDisconnectRuntime: () => undefined
}))
vi.mock('../../skillService', () => ({
  skillService: {
    findEnabled: () => [],
    findAll: () => [],
    listExternalDirs: () => [],
    enabledSkillRoots: () => []
  }
}))
vi.mock('../../botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../instruction', () => ({ resolveInstructionContent: () => null }))
vi.mock('../../memory', () => ({ resolveProjectMemoryIndex: () => null }))
vi.mock('../../knowledge', () => ({ enabledBaseChoices: () => [] }))
vi.mock('../../knowledge/sessionBundle', () => ({ enabledTargets: () => [] }))
vi.mock('../../shellParserService', () => ({ shellParser: {} }))
vi.mock('../../policyService', () => ({
  policyService: {
    getUserPolicies: () => rig.userPolicies,
    readBuiltinPolicyMd: (fileName: string) => {
      try {
        return readFileSync(join(rig.builtinPoliciesDir, fileName), 'utf-8')
      } catch {
        return null
      }
    }
  }
}))
vi.mock('../../userInputBroker', () => ({
  requestUserInputFor: async (sessionId: string, request: InputRequest) => {
    rig.asks.push({ sessionId, request })
    return rig.answerAsk(sessionId, request)
  },
  respondToUserInput: () => false,
  registerUserInputParticipant: () => undefined
}))
vi.mock('../../../i18n', () => ({
  t: (key: string, vars?: Record<string, string>) =>
    vars?.reason !== undefined ? `${key}:${vars.reason}` : key
}))
vi.mock('../../../logger', () => ({
  createLogger: (scope: string) => ({
    info: (...args: unknown[]) => void rig.logs.push({ level: 'info', scope, msg: args.join(' ') }),
    warn: (...args: unknown[]) => void rig.logs.push({ level: 'warn', scope, msg: args.join(' ') }),
    error: (...args: unknown[]) =>
      void rig.logs.push({ level: 'error', scope, msg: args.join(' ') }),
    debug: () => undefined
  })
}))

// ─────────────────────────── 档案 ───────────────────────────

/** 一份档案（agentService.getProfile 的形状）；正文带 `ROLE:<名字>` 标记 */
export function profile(
  name: string,
  tools: string[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name,
    displayName: name,
    description: `${name} profile`,
    tools,
    systemPrompt: `ROLE:${name}`,
    instructionFiles: [],
    projectAwareness: false,
    ...extra
  }
}

/** 缺省档案表（设计 Harness 4）：chat、explore、coding（K5-06）、titler（思考关）、permission-reviewer */
export function defaultProfiles(): Record<string, Record<string, unknown>> {
  return {
    chat: profile('chat', ['session', 'agent', 'probe', 'askOp']),
    explore: profile('explore', ['probe']),
    coding: profile('coding', ['session', 'probe']),
    titler: profile('titler', ['session'], { thinkingLevel: 'off', displayName: 'Titler' }),
    'permission-reviewer': profile('permission-reviewer', [], {
      displayName: 'Permission Reviewer'
    })
  }
}

// ─────────────────────────── 测试工具（probe / askOp） ───────────────────────────

/** probe 的一次调用：调用方会话、对话、任务，及两条身份来源 */
export interface ProbeCall {
  sessionId: string
  conversationId: number
  taskId: number
  /** 安全主体用的那个身份（getDesktopSecurityContext 经 withCallAgent 按这次调用现取的） */
  subject: ToolAgentIdentity | undefined
  /** 启动时注册的内置 MCP 解析器对 (会话, 对话) 的回答 */
  resolved: unknown
}

export const probeCalls: ProbeCall[] = []
export const askOpCalls: Array<{ sessionId: string; conversationId: number; taskId: number }> = []

// ─────────────────────────── faux 路由 ───────────────────────────

/** 路由看见的一次请求 */
export interface RoutedRequest {
  readonly systemPrompt: string
  /** 对话里第一条用户消息的文本 */
  readonly firstUser: string
  /** 最后一条用户消息的文本 */
  readonly lastUser: string
}

export type Step = Parameters<FauxKit['queue']>[0]

export interface Router {
  /** 给一条路由追加应答（路由不存在就按谓词新建）；同时排上同样多的派发步骤 */
  on(name: string, match: (request: RoutedRequest) => boolean, ...steps: Step[]): void
  /** 给已有的路由追加应答 */
  push(name: string, ...steps: Step[]): void
  /** 每个被应答的请求是哪条路由（按次序） */
  readonly served: string[]
  /** 认不出的请求（第一条用户消息） */
  readonly unmatched: string[]
  /** 某条路由还剩几个应答 */
  left(name: string): number
  /** 某条路由应答过的请求（按次序） */
  requests(name: string): FauxKit['requests']
}

/** 系统提示词里的 `ROLE:<档案>`（可选：再按对话第一条用户消息区分同档案的两条会话） */
export function role(name: string, firstUser?: string): (request: RoutedRequest) => boolean {
  return (request) =>
    request.systemPrompt.includes(`ROLE:${name}`) &&
    (firstUser === undefined || request.firstUser === firstUser)
}

export function routedSteps(kit: FauxKit): Router {
  const routes: Array<{
    name: string
    match: (request: RoutedRequest) => boolean
    steps: Step[]
  }> = []
  const served: string[] = []
  const unmatched: string[] = []
  const indices: Array<{ name: string; index: number }> = []
  const dispatcher: FauxResponseStep = async (context, options, state, model) => {
    const users = context.messages.filter((m) => m.role === 'user')
    const request: RoutedRequest = {
      systemPrompt: getCurrentSystemPrompt([...context.messages]),
      firstUser: messageText(users[0]),
      lastUser: messageText(users.at(-1))
    }
    const route = routes.find((r) => r.match(request) && r.steps.length > 0)
    if (route === undefined) {
      unmatched.push(request.firstUser)
      const known = routes.filter((r) => r.match(request)).map((r) => r.name)
      throw new Error(
        `unrouted faux request (first user text: ${JSON.stringify(request.firstUser.slice(0, 120))}${known.length ? `; exhausted: ${known.join(', ')}` : ''})`
      )
    }
    served.push(route.name)
    indices.push({ name: route.name, index: kit.requests.length - 1 })
    const step = route.steps.shift()!
    return typeof step === 'function' ? step(context, options, state, model) : step
  }
  const push = (name: string, steps: Step[]): void => {
    const route = routes.find((r) => r.name === name)
    if (route === undefined) throw new Error(`no route ${name}`)
    route.steps.push(...steps)
    for (let index = 0; index < steps.length; index++) kit.queue(dispatcher)
  }
  return {
    on: (name, match, ...steps) => {
      if (!routes.some((r) => r.name === name)) routes.push({ name, match, steps: [] })
      push(name, steps)
    },
    push: (name, ...steps) => push(name, steps),
    served,
    unmatched,
    left: (name) => routes.find((r) => r.name === name)?.steps.length ?? 0,
    requests: (name) =>
      indices.filter((entry) => entry.name === name).map((entry) => kit.requests[entry.index]!)
  }
}

// ─────────────────────────── 进程 ───────────────────────────

type SessionHostModule = typeof import('../../sessionHost')

export interface Proc {
  readonly n: number
  readonly kit: FauxKit
  readonly router: Router
  readonly host: SessionHost
  readonly runtime: typeof import('@shuvix/agent-runtime')
  readonly sessionHostModule: SessionHostModule
  readonly sessionService: (typeof import('../../sessionService'))['sessionService']
  readonly sessionRecords: (typeof import('../../sessionRecords'))['sessionRecords']
  readonly chatGateway: (typeof import('../../../frontend/core/DefaultChatGateway'))['chatGateway']
  readonly runner: (typeof import('../../subSessionRunner'))['subSessionRunner']
  readonly taskRegistry: (typeof import('../../taskRegistry'))['taskRegistry']
  readonly agentManager: (typeof import('../../../agents/AgentManager'))['agentManager']
  readonly hookService: (typeof import('../../hookService'))['hookService']
  readonly permissionReview: typeof import('../../permissionReview')
  readonly sessionTriggerFacts: typeof import('../../sessionTriggerFacts')
  readonly agentSessionModule: typeof import('../../agentSession')
  readonly transcriptSource: typeof import('../../transcriptSource')
  /** `spyToolHost` 时真 ToolHost 收到的调用 */
  readonly toolHostCalls: ToolHostCalls
  /** onRunStateChange 的记录（会话 id → 依次报出的状态） */
  readonly states: Map<string, string[]>
  /** beforeAbort 的记录（会话 id，按次序） */
  readonly aborts: string[]
  /** 本进程发起、崩溃时要吞掉的 promise */
  track<T>(promise: Promise<T>): Promise<T>
}

export interface BootOptions {
  /** 额外的宿主依赖覆盖（从不覆盖 toolHost / onDrivenSettled） */
  deps?: Partial<SessionHostDeps>
  /**
   * 给真桌面 ToolHost 套一层记录（K5-04）：仍是 `createDesktopToolHost` 造的那一个（sessionOf 同样读单例
   * 宿主），只是每次 resolve / rebuild 记下入参
   */
  spyToolHost?: boolean
  /** 每次打开会话存储（真 `openSessionStorage`）之前记一笔（K1-02：C 只被打开一次） */
  onOpenStorage?: (sessionId: string) => void
}

/** 真 ToolHost 收到的调用（`spyToolHost`） */
export interface ToolHostCalls {
  resolve: unknown[]
  rebuild: Array<{ record: { kind: string; agentId?: string }; context: { sessionId: string } }>
}

let current: Proc | undefined
let processCount = 0
const tracked = new Set<Promise<unknown>>()

/** 现在这个进程 */
export function proc(): Proc {
  if (!current) throw new Error('no process booted')
  return current
}

/** 换一个全新的模块图，建这个进程的单例宿主（真桌面 ToolHost） */
export async function bootProcess(options: BootOptions = {}): Promise<Proc> {
  vi.resetModules()
  const runtime = await import('@shuvix/agent-runtime')
  const sessionHostModule = await import('../../sessionHost')
  const { sessionService } = await import('../../sessionService')
  const { sessionRecords } = await import('../../sessionRecords')
  const { writeSessionMirror } = await import('../../sessionMirror')
  const { chatGateway } = await import('../../../frontend/core/DefaultChatGateway')
  const { subSessionRunner: runner } = await import('../../subSessionRunner')
  const { taskRegistry } = await import('../../taskRegistry')
  const { agentManager } = await import('../../../agents/AgentManager')
  const { hookService } = await import('../../hookService')
  const permissionReview = await import('../../permissionReview')
  const sessionTriggerFacts = await import('../../sessionTriggerFacts')
  const agentSessionModule = await import('../../agentSession')
  const toolContext = await import('../../toolContext')
  const transcriptSource = await import('../../transcriptSource')
  const { registerBuiltinTool } = await import('../../toolRegistry')
  const { setBuiltinMcpAgentResolver } = await import('../../mcpService')
  // 真 session 工具 import 即自注册；派发工具的展示项同理（工厂不在内置表里 —— 它按 agent 解析）
  // eslint-disable-next-line boundaries/dependencies -- 整合夹具有意让真的 session 工具进内置表、驱动真的运行器（产品里由 allTools 引入；这里 allTools 是空的替身）
  await import('../../../tools/session')
  await import('../../../agents/AgentTool')

  registerBuiltinTool({
    name: 'probe',
    group: 'general',
    getLabel: () => 'probe',
    getHint: () => '',
    factory: (ctx) => probeTool(ctx as ProbeCtx, toolContext.withCallAgent)
  })
  registerBuiltinTool({
    name: 'askOp',
    group: 'general',
    getLabel: () => 'askOp',
    getHint: () => '',
    factory: (ctx) => askOpTool(ctx as ProbeCtx)
  })

  // main/index.ts 的启动接线：hook runner、询问点的自动审查、内置 MCP 的调用方解析器
  hookService.init()
  toolContext.setPermissionReviewer(permissionReview.reviewPermissionRequest)
  setBuiltinMcpAgentResolver(sessionHostModule.sessionAgentResolver())

  const toolHostCalls: ToolHostCalls = { resolve: [], rebuild: [] }
  let spied: Partial<SessionHostDeps> = {}
  if (options.spyToolHost) {
    const { createDesktopToolHost } = await import('../../../agents/agentHost')
    const real = createDesktopToolHost({
      sessionOf: (sessionId) => sessionHostModule.getSessionHost().get(sessionId)
    })
    spied = {
      toolHost: {
        buildBuiltinTools: (request) => real.buildBuiltinTools(request),
        resolveAgentTools: (request, opts) => {
          toolHostCalls.resolve.push(request)
          return real.resolveAgentTools(request, opts)
        },
        rebuildAgentTools: (record, context) => {
          toolHostCalls.rebuild.push({
            record: record as ToolHostCalls['rebuild'][number]['record'],
            context
          })
          return real.rebuildAgentTools(record, context)
        }
      }
    }
  }

  if (options.onOpenStorage) {
    const storage = await import('../../sessionStorage')
    const record = options.onOpenStorage
    spied = {
      ...spied,
      openStorage: (async (sessionId: string, ...rest: unknown[]) => {
        record(sessionId)
        return (storage.openSessionStorage as (...args: unknown[]) => unknown)(sessionId, ...rest)
      }) as SessionHostDeps['openStorage']
    }
  }

  const kit = fauxKit()
  const states = new Map<string, string[]>()
  const aborts: string[] = []
  const overrides = testDepsOverrides(
    kit,
    {
      onRunStateChange: (sessionId, state) => {
        states.set(sessionId, [...(states.get(sessionId) ?? []), state])
        writeSessionMirror(sessionId, { runState: state })
      },
      beforeAbort: (sessionId) => {
        aborts.push(sessionId)
        sessionHostModule.beforeSessionAbort(sessionId)
      },
      ...options.deps,
      ...spied
    },
    { realToolHost: true }
  )
  rig.catalog = overrides.modelCatalog as unknown as typeof rig.catalog
  sessionHostModule.resetSessionHostForTests(overrides)
  const host = sessionHostModule.getSessionHost()
  processCount += 1
  current = {
    n: processCount,
    kit,
    router: routedSteps(kit),
    host,
    runtime,
    sessionHostModule,
    sessionService,
    sessionRecords,
    chatGateway,
    runner,
    taskRegistry,
    agentManager,
    hookService,
    permissionReview,
    sessionTriggerFacts,
    agentSessionModule,
    transcriptSource,
    toolHostCalls,
    states,
    aborts,
    track: <T>(promise: Promise<T>): Promise<T> => {
      const settled = promise.catch(() => undefined)
      tracked.add(settled)
      void settled.finally(() => tracked.delete(settled))
      return promise
    }
  }
  return current
}

/** 关掉现在这个进程：限时 closeAll，等发送收尾，吞掉它的 promise */
export async function shutdown(): Promise<void> {
  const p = current
  if (!p) return
  await withTimeout(p.host.closeAll(), 15000, 'closeAll').catch(() => undefined)
  await withTimeout(p.runner.drainForTests(), 10000, 'drain runner').catch(() => undefined)
  await withTimeout(Promise.all([...tracked]), 10000, 'process promises').catch(() => undefined)
  tracked.clear()
  p.taskRegistry.killAll()
  current = undefined
}

/** 崩溃（PIN-02）：关掉现在的进程，起一个新的 */
export async function crash(options: BootOptions = {}): Promise<Proc> {
  await shutdown()
  return bootProcess(options)
}

// ─────────────────────────── 每例的准备 / 收尾 ───────────────────────────

export const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => void unhandled.push(reason)

/** beforeEach：新 DB（真迁移）、新目录、清空记录、缺省档案与设置 */
export async function setupRig(): Promise<void> {
  const { migrations } = await import('../../../dao/migrations')
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as never)
  rig.db = db
  rig.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-p212-s-'))
  rig.toolResults = mkdtempSync(join(tmpdir(), 'shuvix-p212-tr-'))
  rig.userData = mkdtempSync(join(tmpdir(), 'shuvix-p212-ud-'))
  rig.hooksDir = mkdtempSync(join(tmpdir(), 'shuvix-p212-hooks-'))
  rig.broadcasts.length = 0
  rig.settings.clear()
  rig.profiles = defaultProfiles()
  rig.userPolicies = []
  rig.asks.length = 0
  rig.answerAsk = () => ({ kind: 'ask', allowed: true })
  rig.logs.length = 0
  rig.builtinResolver = null
  rig.ensureServerByName.length = 0
  probeCalls.length = 0
  askOpCalls.length = 0
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
}

/** afterEach：关掉进程、删目录 */
export async function teardownRig(): Promise<void> {
  await shutdown()
  process.off('unhandledRejection', onUnhandled)
  for (const dir of [rig.sessionsDir, rig.toolResults, rig.userData, rig.hooksDir]) {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─────────────────────────── 会话行 ───────────────────────────

/** 缺省标题（i18n 替身交回键名）：auto-title 只给它起名 */
export const DEFAULT_TITLE = 'agent.defaultTitle'

const FAUX_SELECTION = { provider: 'faux', modelId: 'faux-1' }

/** 插一条会话行（durable 存储；缺省标题 = id，即「不是默认标题」） */
export function insert(id: string, patch: Partial<Session> = {}): string {
  proc().sessionRecords.insert({
    id,
    title: id,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: { enabledTools: [], model: FAUX_SELECTION },
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  })
  return id
}

export function settingsOf(id: string): Record<string, unknown> {
  return (proc().sessionRecords.findById(id)?.settings ?? {}) as Record<string, unknown>
}

/** 用户策略（md 原文 → 解析好的 UserPolicyFile） */
export function setUserPolicy(name: string, match: string, effect = 'ask'): void {
  const md = [
    '---',
    'shuvix: policy v1',
    `name: ${name}`,
    'shuvix-policy-scope:',
    '  subject.kind: [agent]',
    '  object.type: [invocation]',
    'shuvix-policy-rules:',
    `  - effect: ${effect}`,
    '    action: [execute]',
    `    match: ${JSON.stringify(match)}`,
    '---',
    '',
    `${name} (P2-12 test policy).`
  ].join('\n')
  const parsed = proc().runtime.parsePolicyDefinitionFile(md, name, (msg: string) => {
    throw new Error(msg)
  })
  if (!parsed) throw new Error(`policy ${name} failed to parse`)
  rig.userPolicies = [...rig.userPolicies, { ...parsed, fileName: `${name}.md` }]
}

// ─────────────────────────── 查看（从不 open） ───────────────────────────

/** 打开着的会话；没开就 peek（存储在才打开，从不创建） */
export async function sessionOf(sessionId: string): Promise<DurableSession | undefined> {
  const host = proc().host
  return host.get(sessionId) ?? (await host.peek(sessionId))
}

async function mustSession(sessionId: string): Promise<DurableSession> {
  const session = await sessionOf(sessionId)
  if (!session) throw new Error(`session ${sessionId} has no storage`)
  return session
}

const BG = (): import('@earendil-works/chord').Context => proc().runtime.backgroundContext

/** 当前对话的转写（`<kind>:<text>`） */
export async function transcriptOf(sessionId: string): Promise<string[]> {
  const session = await mustSession(sessionId)
  return transcript(await session.currentConversation())
}

/** 某个对话的转写 */
export async function conversationTranscript(
  sessionId: string,
  conversationId: number
): Promise<string[]> {
  const session = await mustSession(sessionId)
  const conversation = await session.harness.conversation(conversationId as ConversationId, BG())
  if (!conversation) throw new Error(`no conversation ${conversationId} in ${sessionId}`)
  return transcript(conversation)
}

export interface ConversationView {
  id: number
  owner: { conversationId: number; taskId: number } | undefined
  record: SpawnedAgentRecord | undefined
}

/** 全部对话：id、owner、派生 agent 记录 */
export async function conversationsOf(sessionId: string): Promise<ConversationView[]> {
  const session = await mustSession(sessionId)
  const records = await session.harness.commit(async (tx) => {
    const page = await tx.scanConversations({}, 256)
    return [...page.items]
  }, BG())
  const views: ConversationView[] = []
  for (const record of records.sort((a, b) => a.id - b.id)) {
    const owner = (record as { owner?: { conversationId: number; taskId: number } }).owner
    views.push({
      id: record.id,
      owner: owner ? { conversationId: owner.conversationId, taskId: owner.taskId } : undefined,
      record: await proc().runtime.spawnedAgentRecordOf(session.harness, record.id, BG())
    })
  }
  return views
}

/** 全部任务（活着的与终结的） */
export async function tasksOf(
  sessionId: string
): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
  const session = await mustSession(sessionId)
  return session.harness.commit(async (tx) => {
    const page = await tx.scanTasks({}, 1024)
    return [...page.items]
  }, BG())
}

/** 活着的任务 */
export async function liveTasksOf(
  sessionId: string
): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
  return (await tasksOf(sessionId)).filter((task) => task.state.status !== 'terminal')
}

/** 某个对话里某个 requestId 的提交 */
export async function submissionOf(
  sessionId: string,
  requestId: string,
  conversationId?: number
): Promise<{ id: number; status: string; reason?: string } | undefined> {
  const session = await mustSession(sessionId)
  const conv = conversationId ?? (await session.currentConversation()).id
  const record = await session.harness.commit(
    (tx) => tx.submissionByRequest(conv as ConversationId, requestId),
    BG()
  )
  if (!record) return undefined
  return {
    id: record.id as number,
    status: record.status,
    ...(record.status === 'unanswered' ? { reason: record.reason } : {})
  }
}

/** 会话目录里的文件名（排好序） */
export function sqliteFiles(): string[] {
  return readdirSync(rig.sessionsDir).sort()
}

/** 只看会话 id：`<id>.sqlite` 及 -wal / -shm 归一成 id */
export function storageIds(): string[] {
  return [...new Set(sqliteFiles().map((name) => name.replace(/\.sqlite(-wal|-shm)?$/, '')))].sort()
}

/** 子会话通知（pi.user 或写入的通知条目里带 `<sub-session` 围栏） */
export function noticesIn(entries: string[]): string[] {
  return entries.filter(
    (e) =>
      (e.startsWith('pi.user:') || e.startsWith('shuvix.notice:')) && e.includes('<sub-session id=')
  )
}

/** 某类广播 */
export function broadcastsOf(type: string): Array<Record<string, unknown>> {
  return rig.broadcasts.filter((event) => event.type === type)
}

/** 日志行（`<scope>: <msg>`） */
export function logLines(): string[] {
  return rig.logs.map((l) => `${l.scope}: ${l.msg}`)
}

/** 一个请求的最后一条用户消息文本 */
export function lastUserText(request: FauxKit['requests'][number]): string {
  const users = request.messages.filter((m) => m.role === 'user')
  return messageText(users.at(-1))
}

/** 一个请求的全部用户消息文本 */
export function userTexts(request: FauxKit['requests'][number]): string[] {
  return request.messages.filter((m) => m.role === 'user').map((m) => messageText(m))
}

/** 调试：把值写进草稿目录（仅开发时用） */
export function dump(value: unknown, name = 'dbg'): void {
  const dir = process.env.P212_DUMP_DIR
  if (!dir) return
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 1))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─────────────────────────── 工具实现 ───────────────────────────

interface ProbeCtx {
  sessionId: string
  agent?: ToolAgentIdentity
  agentOf?: (conversationId: number) => ToolAgentIdentity | undefined
}

/**
 * probe（safe）：记下这次调用的会话 / 对话 / 任务，安全主体用的身份（withCallAgent 按这次调用的对话现取，
 * 与 getDesktopSecurityContext 每次 enforce 用的是同一个），以及启动时注册的内置 MCP 解析器的回答。
 */
function probeTool(
  ctx: ProbeCtx,
  withCallAgent: (typeof import('../../toolAgent'))['withCallAgent']
): ToolRegistration {
  return defineTool({
    name: 'probe',
    description: 'probe: records who called it',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async (_args, api) => {
      probeCalls.push({
        sessionId: ctx.sessionId,
        conversationId: api.conversationId,
        taskId: api.taskId,
        subject: withCallAgent(ctx, api).agent,
        resolved: rig.builtinResolver?.(ctx.sessionId, api.conversationId)
      })
      return { content: [{ type: 'text', text: 'probed' }] }
    }
  })
}

/** askOp（unsafe，空身体）：门由用户策略设 */
function askOpTool(ctx: ProbeCtx): ToolRegistration {
  return defineTool({
    name: 'askOp',
    description: 'askOp: an operation the policies want judged',
    parameters: Type.Object({}),
    replay: 'unsafe',
    execute: async (_args, api) => {
      askOpCalls.push({
        sessionId: ctx.sessionId,
        conversationId: api.conversationId,
        taskId: api.taskId
      })
      return { content: [{ type: 'text', text: 'askOp done' }] }
    }
  })
}

export { rig }
