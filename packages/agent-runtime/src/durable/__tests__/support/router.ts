/**
 * 派生 agent 路由的测试夹具（P2-05）：不做断言。
 *
 *  - **宿主 R**：宿主 D 的那一套（faux 两个模型、`test.spawn`、marker 变量表、固定时钟、fakeRPM、probe），派发
 *    工具换成**真的** `createDispatchAgentTool`（按会话一份，`manager` = 当前进程的路由），外加 `force_agent`
 *    （真派发工具的改名拷贝，放在按 agent 工具里 —— 不受 `canSpawn` 门控，深度用例用它撞上限）。
 *  - **路由 R**：`createSubAgentManager({sessions: 宿主（记下 get / peek）, broadcast → events, tasks: 真
 *    taskRegistry（coalesceMs 5）, getAbortedNote: 'ABORTED_NOTE'})`。`reopen()` = 换一个进程：新宿主、新路由、
 *    新的事件 / 任务数组（档案表、变量表、fakeRPM 共用）。
 *  - **假协调器 FC**（单元用例）：`fakeSession()` 是一个会话桩，`agents.spawn/continue/interrupt/destroy` 按脚本
 *    走，`onCreated` 由脚本按需调用；`fakeScope()` 是一次工具调用的 scope。
 */
import type { Context } from '@earendil-works/chord'
import { Type } from '@earendil-works/pi-ai'
import {
  defineTool,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import type { SelectableThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { createDispatchAgentTool } from '../../../subagent/dispatchTool'
import type { ResultContract } from '../../../subagent/nextTool'
import {
  createSubAgentManager,
  type RunTaskOutcome,
  type RunTaskParams,
  type SubAgentManager,
  type SubAgentManagerDeps
} from '../../../subagent/manager'
import type { AgentProfile, InProcessAgentType } from '../../../subagent/types'
import { createTaskRegistry, type TaskRegistry } from '../../../task/registry'
import { toolCallScope, type ToolCallScope } from '../../../tools/toolCall'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import type { SpawnedAgentRecord } from '../../agentRecord'
import type { AgentConfig } from '../../seams'
import type { SpawnCreatedInfo, SpawnOutcome, SpawnParams } from '../../spawn'
import { markerVars, type MarkerVars } from './agentConfig'
import { makeHost, primeRoot, type TestHost, type TestHostOptions } from './host'
import { W_NOW, wKit } from './scenario'
import { configD, fakeRpm, probeTool, PROFILES, TEST_SPAWN_EXTENSION, type FakeRpm } from './spawn'

export const ABORTED_NOTE = 'ABORTED_NOTE'

/** 运行投影 → 注册表里的档案（真派发工具按名解析它，再投影回去） */
export function agentProfileOf(profile: InProcessAgentType): AgentProfile {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: [...profile.tools],
    ...(profile.model === undefined ? {} : { model: profile.model }),
    ...(profile.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: profile.thinkingLevel as SelectableThinkingLevel }),
    instructionFiles: [...(profile.instructionFiles ?? [])],
    projectAwareness: profile.projectAwareness ?? false,
    source: 'builtin',
    basePath: ''
  }
}

/** 宿主 R 的档案表（可变：-20 在第二个进程里删掉 explore） */
export function profileTable(
  profiles: Readonly<Record<string, InProcessAgentType>> = PROFILES
): Map<string, AgentProfile> {
  return new Map(Object.entries(profiles).map(([name, p]) => [name, agentProfileOf(p)]))
}

type SubSessionRegister = Extract<ChatEvent, { type: 'sub_session_register' }>
type SubSessionEnd = Extract<ChatEvent, { type: 'sub_session_end' }>

/** 一个进程里路由看到的一切 */
export interface RouterKit {
  readonly router: SubAgentManager
  /** 真 taskRegistry（`tasks: false` 时 undefined） */
  readonly tasks: TaskRegistry | undefined
  readonly events: ChatEvent[]
  readonly taskBroadcasts: TaskInfo[]
  readonly delivered: [string, string][]
  /** 路由经 `sessions` 调过的 get / peek（会话 id，按次序） */
  readonly gets: string[]
  readonly peeks: string[]
  registers(): SubSessionRegister[]
  ends(): SubSessionEnd[]
  /** 带 `user_message` 类型的广播（P3-08 起不该有：追问不再广播） */
  userMessages(): ChatEvent[]
  task(agentId: string): TaskInfo | undefined
  /** 某个 agentId 在 taskBroadcasts 里的状态序列 */
  statuses(agentId: string): string[]
}

export interface RouterKitOptions {
  /** false = 不给路由任务枢纽（ME-24） */
  tasks?: boolean
  /** 包一层任务枢纽（spy / 注入 formatNotice） */
  wrapTasks?: (tasks: TaskRegistry) => TaskRegistry
  /** 包一层路由会话面（spy） */
  wrapSessions?: (sessions: SubAgentManagerDeps['sessions']) => SubAgentManagerDeps['sessions']
  /** 路由的日志（P3-14-03：重建不记警告） */
  logger?: SubAgentManagerDeps['logger']
  /** 宿主的信号就绪（P3-14-12） */
  sessionReady?: SubAgentManagerDeps['sessionReady']
}

/** 建一个路由及它的观察数组（`sessions` 给真宿主或会话桩） */
export function routerKit(
  sessions: SubAgentManagerDeps['sessions'],
  options: RouterKitOptions = {}
): RouterKit {
  const events: ChatEvent[] = []
  const taskBroadcasts: TaskInfo[] = []
  const delivered: [string, string][] = []
  const gets: string[] = []
  const peeks: string[] = []
  const real =
    options.tasks === false
      ? undefined
      : createTaskRegistry({
          broadcast: (task) => taskBroadcasts.push(structuredClone(task)),
          deliver: (sessionId, text) => delivered.push([sessionId, text]),
          coalesceMs: 5
        })
  const tasks = real === undefined ? undefined : (options.wrapTasks?.(real) ?? real)
  const recorded: SubAgentManagerDeps['sessions'] = {
    get: (sessionId) => {
      gets.push(sessionId)
      return sessions.get(sessionId)
    },
    peek: (sessionId) => {
      peeks.push(sessionId)
      return sessions.peek(sessionId)
    }
  }
  const router = createSubAgentManager({
    sessions: options.wrapSessions?.(recorded) ?? recorded,
    broadcast: (event) => events.push(event),
    ...(tasks === undefined ? {} : { tasks }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.sessionReady === undefined ? {} : { sessionReady: options.sessionReady }),
    getAbortedNote: () => ABORTED_NOTE
  })
  const byType = <T extends ChatEvent['type']>(type: T): Extract<ChatEvent, { type: T }>[] =>
    events.filter((event): event is Extract<ChatEvent, { type: T }> => event.type === type)
  return {
    router,
    tasks: real,
    events,
    taskBroadcasts,
    delivered,
    gets,
    peeks,
    registers: () => byType('sub_session_register'),
    ends: () => byType('sub_session_end'),
    userMessages: () => events.filter((event) => (event.type as string) === 'user_message'),
    task: (agentId) => real?.get(agentId),
    statuses: (agentId) =>
      taskBroadcasts.filter((task) => task.taskId === agentId).map((task) => task.status)
  }
}

/** 真派发工具的改名拷贝（名字之外一模一样，按 agent 工具里放它就不受 canSpawn 门控） */
export function renamedTool(tool: ToolRegistration, name: string): ToolRegistration {
  return {
    name,
    description: tool.description,
    parameters: tool.parameters,
    replay: tool.replay,
    execute: (args, api, context) => tool.execute(args, api, context)
  }
}

export interface HostROptions extends RouterKitOptions {
  /** 派发工具看到的路由（包一层：spy / 扣住） */
  wrapManager?: (router: SubAgentManager) => SubAgentManager
  /** 档案表（缺省 PROFILES；重启共用同一张） */
  profiles?: Map<string, AgentProfile>
  /** 额外的按 agent 工具（probe 与 force_agent 之外）；`manager` = 派发工具看到的那个路由（跟着进程换） */
  tools?: (sessionId: string, manager: SubAgentManager) => ToolRegistration[]
  config?: AgentConfig
  host?: Partial<TestHostOptions>
  noPrime?: boolean
  vars?: MarkerVars
  rpm?: FakeRpm
  /**
   * 宿主的开 / 关钩子接到这个进程的路由（P3-14：`onSessionOpened` → `indexSession`，`onSessionClosed` →
   * `onSessionClosed`），与桌面的 AgentManager 接线同形；缺省不接（P2-05 的用例照旧）。`restart()` 沿用。
   */
  indexOnOpen?: boolean
}

export interface HostR extends RouterKit {
  readonly t: TestHost
  /** 会话 s1 */
  readonly session: DurableSession
  readonly profiles: Map<string, AgentProfile>
  readonly vars: MarkerVars
  readonly rpm: FakeRpm
  /** 打开（并建 agent）另一条会话 */
  open(sessionId: string): Promise<DurableSession>
  /**
   * 换一个进程（宿主选项、档案表、变量表、fakeRPM 沿用）：新宿主、新路由、新的观察数组；再打开 s1。
   * `options` 换掉这个进程的路由选项（缺省沿用）。
   */
  reopen(options?: Partial<HostROptions>): Promise<HostR>
}

/** 宿主 R：真派发工具 + 真路由（见文件头） */
export async function hostR(options: HostROptions = {}): Promise<HostR> {
  const profiles = options.profiles ?? profileTable()
  const vars = options.vars ?? markerVars('M1')
  const rpm = options.rpm ?? fakeRpm()
  /** 这个进程派发工具看到的路由（重启时换）；`router` = 没包过的那个（开 / 关钩子接它） */
  const current: { manager: SubAgentManager | undefined; router: SubAgentManager | undefined } = {
    manager: undefined,
    router: undefined
  }
  const proxy: SubAgentManager = {
    runTask: (params) => current.manager!.runTask(params),
    continueTask: (params) => current.manager!.continueTask(params),
    interrupt: (agentId) => current.manager!.interrupt(agentId),
    destroy: (agentId) => current.manager!.destroy(agentId),
    has: (agentId) => current.manager!.has(agentId),
    locate: (agentId) => current.manager!.locate(agentId),
    getRuntimeInfo: (agentId) => current.manager!.getRuntimeInfo(agentId),
    indexSession: (session) => current.manager!.indexSession(session),
    onSessionClosed: (sessionId, reason) => current.manager!.onSessionClosed(sessionId, reason)
  }
  const registry = {
    list: () => [...profiles.values()],
    get: (name: string) => profiles.get(name)
  }
  const dispatchFor = (sessionId: string): ToolRegistration =>
    createDispatchAgentTool({ registry, manager: proxy, sessionId, abortError: 'Aborted' })
  const agentTools = (sessionId: string): ToolRegistration[] => [
    probeTool(),
    renamedTool(dispatchFor(sessionId), 'force_agent'),
    ...(options.tools?.(sessionId, proxy) ?? [])
  ]
  const t = await makeHost({
    makeKit: wKit,
    extensions: [TEST_SPAWN_EXTENSION],
    promptVars: vars.promptVars,
    now: () => W_NOW,
    resolveProfileModel: rpm.resolve,
    toolHost: { agentTools, dispatchTool: dispatchFor },
    agentConfig: options.config ?? configD(),
    ...(options.indexOnOpen === true
      ? {
          onSessionOpened: (session: DurableSession) => current.router?.indexSession(session),
          onSessionClosed: (sessionId: string, reason: 'remove' | 'destroy') =>
            current.router?.onSessionClosed(sessionId, reason)
        }
      : {}),
    ...options.host
  })

  const build = async (host: TestHost, routerOptions: HostROptions): Promise<HostR> => {
    const kit = routerKit(host.host, routerOptions)
    current.router = kit.router
    current.manager = routerOptions.wrapManager?.(kit.router) ?? kit.router
    const session = await host.open('s1')
    if (options.noPrime !== true) await primeRoot(session)
    return {
      ...kit,
      t: host,
      session,
      profiles,
      vars,
      rpm,
      open: async (sessionId) => {
        const other = await host.open(sessionId)
        await primeRoot(other)
        return other
      },
      reopen: async (next) => build(await host.restart(), { ...routerOptions, ...next })
    }
  }
  return build(t, options)
}

export interface ContractToolOptions {
  /** 工具名（缺省 `contract_agent`） */
  name?: string
  sessionId?: string
  contract: ResultContract
  /** 路由交回的结果 / 拒绝（按完成次序） */
  outcomes: (RunTaskOutcome | { rejected: string })[]
  profile?: InProcessAgentType
}

/**
 * 带结果契约的派发工具（测试拥有者：真派发工具从不传 resultContract）：参数 `{prompt}`，把
 * `{sessionId, owner: {tool: scope}, resultContract}` 交给路由；结果文本 = outcome.result，拒绝 = 原话。
 */
export function contractTool(
  manager: SubAgentManager,
  options: ContractToolOptions
): ToolRegistration {
  return defineTool({
    name: options.name ?? 'contract_agent',
    description: 'contract_agent: dispatch a sub-agent with a result contract',
    parameters: Type.Object({ prompt: Type.String() }),
    replay: 'safe',
    execute: async (args, api, context) => {
      try {
        const outcome = await manager.runTask({
          sessionId: options.sessionId ?? 's1',
          owner: { tool: toolCallScope(api, context) },
          agentType: options.profile ?? PROFILES.explore,
          prompt: args.prompt,
          description: 'contract',
          parentToolCallId: api.callId,
          resultContract: options.contract
        })
        options.outcomes.push(outcome)
        return { content: [{ type: 'text', text: outcome.result }] }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        options.outcomes.push({ rejected: message })
        return { content: [{ type: 'text', text: message }] }
      }
    }
  })
}

/** 根对话里一次派发调用（缺省 id `call-agent`）的 provider id */
export const CALL = 'call-agent'

// ─────────────────────────── 假协调器（单元用例） ───────────────────────────

export interface FakeSpawnScript {
  /** 派发：拿到参数自己决定何时 onCreated、交回什么（缺省：建好就答 'found'） */
  spawn?: (params: SpawnParams, context: Context) => Promise<SpawnOutcome>
  continue?: (conversationId: number, text: string) => Promise<SpawnOutcome>
  /** `agentInfo` 的快照（缺省 `fakeAgentInfo`；返回 undefined = 那个对话没有 agent） */
  info?: (conversationId: number) => AgentRuntimeInfo | undefined
  /** `spawnedRecords()` 交回的派生记录（P3-14 的重建；缺省没有） */
  records?: () => SpawnedAgentRecord[]
}

export interface FakeSession {
  readonly session: DurableSession
  readonly spawnCalls: SpawnParams[]
  readonly continueCalls: [number, string][]
  readonly interruptCalls: number[]
  readonly destroyCalls: number[]
  /** `agentInfo` 被问过的对话（P3-06） */
  readonly infoCalls: number[]
}

/** 建好的信息（缺省 agentId sub-a1、对话 2、深度 1） */
export function createdInfo(overrides: Partial<SpawnCreatedInfo> = {}): SpawnCreatedInfo {
  return {
    agentId: 'sub-a1',
    conversationId: 2 as ConversationId,
    depth: 1,
    displayName: 'Explorer',
    description: 'look',
    parentConversationId: ROOT_CONVERSATION_ID,
    reattached: false,
    ...overrides
  }
}

/** 会话桩：只有 `agents` 与 `agentIdentity`（根） */
export function fakeSession(script: FakeSpawnScript = {}): FakeSession {
  const spawnCalls: SpawnParams[] = []
  const continueCalls: [number, string][] = []
  const interruptCalls: number[] = []
  const destroyCalls: number[] = []
  const agents = {
    spawn: async (params: SpawnParams, context: Context): Promise<SpawnOutcome> => {
      spawnCalls.push(params)
      if (script.spawn !== undefined) return script.spawn(params, context)
      const info = createdInfo()
      params.onCreated?.(info)
      return { result: 'found', conversationId: info.conversationId, agentId: info.agentId }
    },
    continue: async (conversationId: number, text: string): Promise<SpawnOutcome> => {
      continueCalls.push([conversationId, text])
      return script.continue?.(conversationId, text) ?? { result: 'more ok' }
    },
    interrupt: async (conversationId: number) => void interruptCalls.push(conversationId),
    destroy: async (conversationId: number) => void destroyCalls.push(conversationId),
    ensureInstalled: async () => {}
  }
  const infoCalls: number[] = []
  const session = {
    sessionId: 's1',
    closed: false,
    agents,
    agentIdentity: () => undefined,
    spawnedRecords: () => script.records?.() ?? [],
    agentInfo: async (conversationId: number) => {
      infoCalls.push(conversationId)
      return script.info?.(conversationId) ?? fakeAgentInfo(conversationId)
    }
  } as unknown as DurableSession
  return { session, spawnCalls, continueCalls, interruptCalls, destroyCalls, infoCalls }
}

/** 会话桩 `agentInfo` 的缺省快照（P3-06：对话 id 写进系统提示词，好认出路由读的是哪个对话） */
export function fakeAgentInfo(conversationId: number): AgentRuntimeInfo {
  return {
    systemPrompt: `fake info of conversation ${conversationId}`,
    model: {
      provider: 'faux',
      id: 'faux-1',
      name: 'faux-1',
      api: 'faux',
      contextWindow: 1000,
      maxTokens: 100,
      reasoning: false,
      input: ['text']
    },
    thinkingLevel: 'off',
    tools: [],
    messageCount: 0,
    isStreaming: false
  }
}

/** 一次工具调用的 scope（api 只是个占位对象） */
export function fakeScope(overrides: Partial<ToolCallScope> = {}): ToolCallScope {
  return {
    callId: 'tc-1',
    taskId: 7 as TaskId,
    conversationId: ROOT_CONVERSATION_ID,
    signal: undefined,
    api: { taskId: 7, conversationId: ROOT_CONVERSATION_ID } as unknown as ToolExecutionApi,
    context: BG,
    ...overrides
  }
}

/** 工具派发的 runTask 参数（缺省 explore / 'find X' / 'look'） */
export function toolParams(overrides: Partial<RunTaskParams> = {}): RunTaskParams {
  return {
    sessionId: 's1',
    owner: { tool: fakeScope() },
    agentType: PROFILES.explore,
    prompt: 'find X',
    description: 'look',
    parentToolCallId: 'tc-1',
    ...overrides
  }
}
