/**
 * 宿主派发（P2-08）的测试夹具：不做断言。
 *
 *  - **宿主 H**：`makeHost`（faux 两个模型、`test.spawn`、fakeRPM、固定时钟），按 agent 的工具 = probe、
 *    askOp、titleProbe；会话配置 work / faux-1 / 思考 low（`configD`）。`shuvix.spawn` 由生产代码装进每个
 *    注册表，这里不传。
 *  - **hookRig**：真 `createHookRunner` + 真路由（`routerKit(H.host)`）+ 真协调器。档案 `titler`（工具
 *    `['titleProbe']`，`shuvix-thinking off`）与 `permission-reviewer`（没有工具，`low`）；hook `TITLE_HOOK`
 *    （auto-title，`session.prompt-accepted`）与 `REVIEW_HOOK`（auto-review，`permission.request`）。
 *    `resolveRunModel` 是生产的锁优先解析（`resolveHookRunModel`，PIN-06）—— 没锁时读 `selection`（缺省 =
 *    会话配置的模型与档位）；`isInterrupted` 读打开着的会话。`onRun` 事件收进 `events`，日志收进 `logs`。
 *  - **askOp**（replay 缺省 unsafe）：`decide('permission.request', permissionPayload({sessionId}), {signal:
 *    ctx.abortSignal, ownerTaskId: api.taskId})` → `'verdict:'+decision`，null → `'asked-human'`。
 *  - **faux 按内容路由**（队列是全局的）：titler 的请求带 `<hook_event trigger="session.prompt-accepted">`、
 *    reviewer 的带 `trigger="permission.request"`，其余是根的（`queueRoles`）。
 */
import { Type, type AssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai'
import {
  defineTool,
  type ConversationId,
  type TaskId,
  type TaskRecord,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import {
  createHookRunner,
  type HookDecideOptions,
  type HookRegistryEntry,
  type HookRunEvent,
  type HookRunner,
  type HookRunnerDeps
} from '../../../hook/hookRunner'
import type { ParsedHookFile } from '../../../hook/hookFile'
import { resolveHookRunModel, type HookModelSelection } from '../../../hook/runModel'
import type { TriggerPayloadMap } from '../../../hook/triggerPoints'
import type { SubAgentManager } from '../../../subagent/manager'
import type { InProcessAgentType } from '../../../subagent/types'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import { SPAWN_ANCHOR_TASK } from '../../anchor'
import type { AgentConfig } from '../../seams'
import { fauxCatalog, testProfile } from './agentConfig'
import type { FauxKit } from './faux'
import { makeHost, primeRoot, type TestHost, type TestHostOptions } from './host'
import { routerKit, type RouterKit } from './router'
import { W_NOW, wKit } from './scenario'
import { configD, fakeRpm, probeTool, TEST_SPAWN_EXTENSION, type FakeRpm } from './spawn'
import { messageText } from './transcript'

// ─────────────────────────── 档案与 hook ───────────────────────────

export const TITLER = testProfile({
  name: 'titler',
  displayName: 'Titler',
  tools: ['titleProbe'],
  thinkingLevel: 'off',
  systemPrompt: 'You name sessions'
})

export const REVIEWER = testProfile({
  name: 'permission-reviewer',
  displayName: 'Permission Reviewer',
  tools: [],
  thinkingLevel: 'low',
  systemPrompt: 'You review operations'
})

export const HOOK_PROFILES: Record<string, InProcessAgentType> = {
  titler: TITLER,
  'permission-reviewer': REVIEWER
}

export const TITLE_HOOK: ParsedHookFile = {
  name: 'auto-title',
  displayName: 'Automatic Session Titles',
  description: '',
  agent: 'titler',
  bindings: [{ trigger: 'session.prompt-accepted' }],
  prompt: 'Title this session.'
}

export const REVIEW_HOOK: ParsedHookFile = {
  name: 'auto-review',
  displayName: 'Automatic Review',
  description: '',
  agent: 'permission-reviewer',
  bindings: [{ trigger: 'permission.request' }],
  prompt: 'Judge it.'
}

export const TITLE_FENCE = '<hook_event trigger="session.prompt-accepted">'
export const REVIEW_FENCE = '<hook_event trigger="permission.request">'

export function promptPayload(
  over: Partial<TriggerPayloadMap['session.prompt-accepted']> = {}
): TriggerPayloadMap['session.prompt-accepted'] {
  return {
    sessionId: 's1',
    profileName: 'work',
    title: 'New Chat',
    isDefaultTitle: true,
    promptText: 'hi',
    ...over
  }
}

export function permissionPayload(
  over: Partial<TriggerPayloadMap['permission.request']> = {}
): TriggerPayloadMap['permission.request'] {
  return {
    sessionId: 's1',
    agent: { profile: 'work', kind: 'root' },
    operation: {
      tool: 'bash',
      action: 'execute',
      objectType: 'command',
      target: 'rm -rf build',
      facts: { channel: 'bash', sandboxed: false }
    },
    policy: { names: ['ask-on-command'], prompt: 'Commands outside the sandbox.' },
    userMessages: ['clean the build directory'],
    delegatedTasks: [],
    recentOperations: [],
    ...over
  }
}

// ─────────────────────────── 工具 ───────────────────────────

/** titleProbe 的调用（调用它的会话 id、对话、任务） */
export interface TitleCall {
  sessionId: string
  conversationId: number
  taskId: number
}

export interface AskOpCall {
  sessionId: string
  taskId: number
  result: string
}

// ─────────────────────────── 夹具 ───────────────────────────

export interface HookRigOptions {
  timeoutMs?: number
  decideTimeoutMs?: number
  /** 额外 / 替换的 hook（缺省 TITLE_HOOK + REVIEW_HOOK） */
  hooks?: ParsedHookFile[]
  /** 档案表（缺省 HOOK_PROFILES；可变：用例可以改） */
  profiles?: Record<string, InProcessAgentType>
  askReplay?: 'safe' | 'unsafe'
  /** askOp 每次用的 signal（缺省工具自己的）—— -28 用测试拥有的 controller */
  askSignal?: () => AbortSignal | undefined
  /** askOp 给不给 ownerTaskId（缺省给） */
  askOwner?: boolean
  config?: AgentConfig
  host?: Partial<TestHostOptions>
  /** 没锁时的会话选择（缺省 = 会话配置的模型与档位） */
  selection?: (sessionId: string) => HookModelSelection | null
  rpm?: FakeRpm
  /** 不给 s1 建 agent */
  noPrime?: boolean
  /** 额外的按 agent 工具 */
  tools?: (sessionId: string, rig: () => HookRig) => ToolRegistration[]
}

export interface HookRig {
  readonly t: TestHost
  readonly kit: FauxKit
  /** 会话 s1 */
  readonly session: DurableSession
  readonly router: RouterKit
  readonly manager: SubAgentManager
  readonly runner: HookRunner
  readonly events: HookRunEvent[]
  readonly logs: { level: 'info' | 'warn'; msg: string }[]
  readonly titleCalls: TitleCall[]
  readonly askCalls: AskOpCall[]
  readonly rpm: FakeRpm
  readonly profiles: Record<string, InProcessAgentType>
  /** 打开（并建 agent）另一条会话 */
  open(sessionId: string, prime?: boolean): Promise<DurableSession>
  /** 换一个进程（同一目录）：新宿主、新路由、新 runner；再打开 s1 */
  reopen(options?: Partial<TestHostOptions>): Promise<HookRig>
  ends(): Extract<HookRunEvent, { type: 'end' }>[]
  starts(): Extract<HookRunEvent, { type: 'start' }>[]
  skips(): Extract<HookRunEvent, { type: 'skip' }>[]
  warns(): string[]
  infos(): string[]
  /** 判定（askOp 之外直接调） */
  decide(
    payload?: TriggerPayloadMap['permission.request'],
    opts?: HookDecideOptions
  ): ReturnType<HookRunner['decide']>
}

function sessionConfig(source: TestHostOptions['agentConfig'], sessionId: string): AgentConfig {
  const config = typeof source === 'function' ? source(sessionId) : source
  return config ?? rigConfig()
}

/** 宿主 H 的会话配置：work 档案（agent / probe / askOp / titleProbe）、faux-1、思考 low */
export function rigConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return configD({
    profile: testProfile({
      name: 'work',
      displayName: 'Work',
      tools: ['agent', 'probe', 'askOp', 'titleProbe']
    }),
    ...overrides
  })
}

export async function hookRig(options: HookRigOptions = {}): Promise<HookRig> {
  const profiles = options.profiles ?? { ...HOOK_PROFILES }
  const rpm = options.rpm ?? fakeRpm()
  const titleCalls: TitleCall[] = []
  const askCalls: AskOpCall[] = []
  const current: { rig: HookRig | undefined } = { rig: undefined }
  const rig = (): HookRig => current.rig!
  const config = options.config ?? rigConfig()

  const askOp = (sessionId: string): ToolRegistration =>
    defineTool({
      name: 'askOp',
      description: 'askOp: an operation the policies want judged',
      parameters: Type.Object({}),
      replay: options.askReplay ?? 'unsafe',
      execute: async (_args, api, context) => {
        const signal = options.askSignal?.() ?? context.abortSignal
        const decision = await rig().runner.decide(
          'permission.request',
          permissionPayload({ sessionId }),
          options.askOwner === false
            ? { ...(signal === undefined ? {} : { signal }) }
            : { ...(signal === undefined ? {} : { signal }), ownerTaskId: api.taskId }
        )
        const result = decision === null ? 'asked-human' : `verdict:${decision.result.decision}`
        askCalls.push({ sessionId, taskId: api.taskId, result })
        return { content: [{ type: 'text', text: result }] }
      }
    })

  const titleProbe = (sessionId: string): ToolRegistration =>
    defineTool({
      name: 'titleProbe',
      description: 'titleProbe: applies a title',
      parameters: Type.Object({ title: Type.Optional(Type.String()) }),
      execute: async (_args, api) => {
        titleCalls.push({ sessionId, conversationId: api.conversationId, taskId: api.taskId })
        return { content: [{ type: 'text', text: 'titled' }] }
      }
    })

  /** 按名单筛（档案点了谁才给谁：titler 的请求恰 [titleProbe]、审查员一个都没有） */
  const agentTools = (sessionId: string, names: readonly string[]): ToolRegistration[] =>
    [
      probeTool(),
      askOp(sessionId),
      titleProbe(sessionId),
      ...(options.tools?.(sessionId, rig) ?? [])
    ].filter((tool) => names.includes(tool.name))

  const first = await makeHost({
    makeKit: wKit,
    extensions: [TEST_SPAWN_EXTENSION],
    now: () => W_NOW,
    resolveProfileModel: rpm.resolve,
    toolHost: { agentTools },
    agentConfig: config,
    ...options.host
  })

  const build = async (t: TestHost): Promise<HookRig> => {
    const router = routerKit(t.host)
    const events: HookRunEvent[] = []
    const logs: { level: 'info' | 'warn'; msg: string }[] = []
    const catalog = fauxCatalog(t.kit, t.port)
    const deps: HookRunnerDeps = {
      manager: router.router,
      listHooks: (): HookRegistryEntry[] =>
        (options.hooks ?? [TITLE_HOOK, REVIEW_HOOK]).map((file) => ({ file, source: 'builtin' })),
      resolveAgentProfile: (name) => profiles[name] ?? null,
      resolveRunModel: ({ sessionId }) =>
        resolveHookRunModel({
          session: t.host.get(sessionId),
          selection: () => {
            if (options.selection !== undefined) return options.selection(sessionId)
            const cfg = sessionConfig(t.options.agentConfig, sessionId)
            return {
              model: cfg.model ?? null,
              ...(cfg.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: cfg.thinkingLevel as ThinkingLevel })
            }
          },
          catalog
        }),
      isInterrupted: ({ sessionId }) => t.host.get(sessionId)?.isInterrupted() === true,
      env: { host: 'desktop', platform: 'darwin' },
      onRun: (event) => events.push(event),
      logger: {
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'warn', msg })
      },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.decideTimeoutMs === undefined
        ? {}
        : { decideTimeoutMs: options.decideTimeoutMs })
    }
    const runner = createHookRunner(deps)
    const built: HookRig = {
      t,
      kit: t.kit,
      session: undefined as unknown as DurableSession,
      router,
      manager: router.router,
      runner,
      events,
      logs,
      titleCalls,
      askCalls,
      rpm,
      profiles,
      open: async (sessionId, prime = true) => {
        const other = await t.host.open(sessionId)
        if (prime) await primeRoot(other)
        return other
      },
      reopen: async (overrides) => build(await t.restart(overrides)),
      ends: () =>
        events.filter((e): e is Extract<HookRunEvent, { type: 'end' }> => e.type === 'end'),
      starts: () =>
        events.filter((e): e is Extract<HookRunEvent, { type: 'start' }> => e.type === 'start'),
      skips: () =>
        events.filter((e): e is Extract<HookRunEvent, { type: 'skip' }> => e.type === 'skip'),
      warns: () => logs.filter((l) => l.level === 'warn').map((l) => l.msg),
      infos: () => logs.filter((l) => l.level === 'info').map((l) => l.msg),
      decide: (payload = permissionPayload(), opts = {}) =>
        runner.decide('permission.request', payload, opts)
    }
    current.rig = built
    const session = await t.host.open('s1')
    if (options.noPrime !== true && session.lock === undefined) await primeRoot(session)
    ;(built as { session: DurableSession }).session = session
    return built
  }
  return build(first)
}

// ─────────────────────────── faux 路由 ───────────────────────────

export type Role = 'root' | 'titler' | 'reviewer'

/** 一次请求是谁的：任何一条用户消息带了哪个 hook 围栏 */
export function roleOf(messages: readonly { role: string }[]): Role {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = messageText(message as never)
    if (text.includes(TITLE_FENCE)) return 'titler'
    if (text.includes(REVIEW_FENCE)) return 'reviewer'
  }
  return 'root'
}

export type RoleScript = Partial<Record<Role, (AssistantMessage | FauxResponseStep)[]>>

/** 按角色挑应答：每个角色按次序取一个；排的步骤数 = 应答总数 */
export function queueRoles(kit: FauxKit, routes: RoleScript): void {
  const step: FauxResponseStep = async (context, streamOptions, state, model) => {
    const role = roleOf(context.messages)
    const next = routes[role]?.shift()
    if (next === undefined) throw new Error(`no faux route for role ${role}`)
    return typeof next === 'function' ? next(context, streamOptions, state, model) : next
  }
  const count = Object.values(routes).reduce((sum, list) => sum + (list?.length ?? 0), 0)
  for (let index = 0; index < count; index++) kit.queue(step)
}

/** 某角色的请求 */
export function requestsOfRole(kit: FauxKit, role: Role): FauxKit['requests'] {
  return kit.requests.filter((request) => roleOf(request.messages) === role)
}

// ─────────────────────────── 查看 ───────────────────────────

/** 锚任务（活着的与终结的） */
export async function anchors(
  session: DurableSession
): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
  return session.harness.commit(async (tx) => {
    const page = await tx.scanTasks({ kind: SPAWN_ANCHOR_TASK }, 256)
    return [...page.items]
  }, BG)
}

/** 某任务拥有的对话 */
export async function reviewerOf(
  session: DurableSession,
  taskId: TaskId | number
): Promise<ConversationId[]> {
  return session.harness.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: taskId as TaskId }, 256)
    return page.items.map((record) => record.id)
  }, BG)
}

