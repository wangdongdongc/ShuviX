/**
 * 派生 agent 记录与辅助工作的测试夹具（P2-01）：不做断言。
 *
 *  - `TEST_SPAWN_EXTENSION`（`test.spawn`）：经宿主的 `extensions` 选项预装进每次打开的注册表，带两个任务
 *    定义 —— `TestAnchor`（照抄 durable 示例 23：后台、对话拥有、一跑就完成，中止 → aborted）与
 *    `HoldTask`（等一个闸门，观察中止信号）。
 *  - `rec()` / `hookRec()`：派生 agent 记录的构造（缺省是 explore / faux-2 / `tool` 派发；hook 版是
 *    auto-title 的 titler，带结果契约）。
 *  - `seedAgent()`：**一个提交**里建锚任务（或用给定的拥有者任务）、建子对话、配模型、冻结派生人设、
 *    经生产写入器写记录 —— 也就是 P2-03 将来的创建提交的形状。
 *  - `startRun()`、`liveTasks()`、`requestsWith()`、`mentions()`：起一轮 / 看活任务 / 看请求。
 */
import { Type, type AssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Submission,
  type SubmissionRecord,
  type TaskId,
  type TaskRecord,
  type ToolExecutionApi,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { Context, JsonValue } from '@earendil-works/chord'
import type { ModelSelection } from '../../../models/lockModel'
import type { ResultContract } from '../../../subagent/nextTool'
import type { InProcessAgentType } from '../../../subagent/types'
import { backgroundContext as BG } from '../../context'
import { writeSpawnedAgentRecord, type SpawnedAgentRecord } from '../../agentRecord'
import type { DurableSession } from '../../durableSession'
import { agentExtensionName } from '../../lock'
import { freezePersona } from '../../prompt/persona'
import type { AgentConfig } from '../../seams'
import type { SpawnCreatedInfo, SpawnOutcome } from '../../spawn'
import { markerVars, testProfile, type MarkerVars } from './agentConfig'
import { callTool, type FauxKit } from './faux'
import { makeHost, primeRoot, type TestHost, type TestHostOptions } from './host'
import { W_NOW, wKit } from './scenario'
import { messageText } from './transcript'
import { aborted, deferred, waitFor, type Deferred } from './wait'

// ─────────────────────────── 任务定义 ───────────────────────────

/** 锚：后台任务，一跑就完成（照抄 durable 示例 23）；它拥有的对话落在父对话的 Esc / 空闲范围之外 */
export const TestAnchor = defineTask<null, { phase: 'done' }, null>({
  name: 'test.anchor',
  version: 1,
  initial: () => ({ phase: 'done' }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        context
      )
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
})

const holdGates = new Map<string, Deferred>()

/** 按名取（没有就建）一个 HoldTask 的闸门；用例自己挑不重复的名字 */
export function holdGate(name: string): Deferred {
  let gate = holdGates.get(name)
  if (gate === undefined) {
    gate = deferred()
    holdGates.set(name, gate)
  }
  return gate
}

/** 扣住的任务：等闸门放行就完成；被中止（观察 signal）就走中止流程 */
export const HoldTask = defineTask<{ gate: string }, { phase: 'hold' }, null>({
  name: 'test.hold',
  version: 1,
  initial: () => ({ phase: 'hold' }),
  phases: {
    hold: async (task, runtime, context) => {
      await Promise.race([holdGate(task.input.gate).promise, aborted(runtime.signal)])
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
        context
      )
    }
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context)
})

export const TEST_SPAWN_EXTENSION = defineExtension({
  name: 'test.spawn',
  tasks: [TestAnchor, HoldTask]
})

// ─────────────────────────── 记录 ───────────────────────────

/** 派生 agent 记录（缺省：explore / faux-2 / tool 派发；conversationId 与 ownerTaskId 由 seedAgent 填真值） */
export function rec(overrides: Partial<SpawnedAgentRecord> = {}): SpawnedAgentRecord {
  return {
    conversationId: 2 as ConversationId,
    profileName: 'explore',
    kind: 'spawned',
    model: { provider: 'faux', modelId: 'faux-2' },
    toolNames: ['probe'],
    extensions: ['shuvix.builtin', 'shuvix.agent.2'],
    sandboxed: false,
    mcp: {},
    skills: [],
    createdAt: W_NOW,
    agentId: 'sub-a1',
    depth: 1,
    canSpawn: false,
    dispatch: 'tool',
    parentConversationId: ROOT_CONVERSATION_ID,
    ownerTaskId: 1 as TaskId,
    displayName: 'Explorer',
    description: 'look around',
    ...overrides
  }
}

export const TITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title']
}

/** HOOK：宿主派发的 titler（auto-title），带结果契约 */
export function hookRec(overrides: Partial<SpawnedAgentRecord> = {}): SpawnedAgentRecord {
  return rec({
    profileName: 'titler',
    agentId: 'sub-h1',
    dispatch: 'hook',
    hook: 'auto-title',
    displayName: 'Auto title',
    resultContract: { schema: structuredClone(TITLE_SCHEMA), sourceLabel: 'auto-title' },
    ...overrides
  })
}

// ─────────────────────────── 种一个派生 agent ───────────────────────────

export interface SeedOptions {
  /** 记录模板（缺省 `rec()`）；conversationId / ownerTaskId / extensions 换成真值 */
  record?: SpawnedAgentRecord
  /**
   * 拥有者：缺省（`'anchor'`）= 同一提交里在 `parent` 建一个后台锚任务；给 TaskId 就用它；`'none'` =
   * ownerless 对话（只给进程内的运行状态用例：锚在根里以 completing 陪着子对话的工作活着，会让运行状态
   * 跟着忙 —— 那是 P2-08 的 PIN-12；ownerless 的对话重开时不在扫描范围里）
   */
  owner?: 'anchor' | 'none' | TaskId
  /** 锚任务建好就让它跑完（开启调度器；锚完成时父对话的运行状态会闪一下忙） */
  settle?: boolean
  /** 锚任务所在的对话（= 记录的 parentConversationId；缺省根）。给了 TaskId 拥有者时取那个任务的对话 */
  parent?: ConversationId
  /** 同一提交里冻结一份派生人设（kind / profileName / persona / instructionFiles / rootSessionId；缺省 true） */
  persona?: boolean
  /** 同一提交里在子对话建一个 HoldTask（闸门名） */
  hold?: string
}

export interface Seeded {
  readonly conversationId: ConversationId
  /** 拥有者任务（ownerless 时是模板里的占位值） */
  readonly ownerTaskId: TaskId
  /** 实际写下的记录 */
  readonly record: SpawnedAgentRecord
  readonly holdTaskId?: TaskId
}

/** 一个提交：拥有者（锚）→ 子对话 → 模型 → 派生人设 → 记录（经生产写入器，PIN-01） */
export async function seedAgent(
  session: DurableSession,
  options: SeedOptions = {}
): Promise<Seeded> {
  const template = options.record ?? rec()
  const seeded = await session.harness.commit(async (tx): Promise<Seeded> => {
    let parent = options.parent ?? ROOT_CONVERSATION_ID
    let owner: TaskId | undefined
    if (options.owner === undefined || options.owner === 'anchor') {
      owner = await tx.createTask(TestAnchor, null, {
        ownership: { kind: 'conversation' },
        conversationId: parent,
        background: true
      })
    } else if (options.owner !== 'none') {
      owner = options.owner
      // 表读先于本提交的第一次表写
      parent = (await tx.task(owner))!.conversationId
    }
    const child = await tx.createConversation({
      ownership: owner === undefined ? { kind: 'ownerless' } : { kind: 'task', taskId: owner }
    })
    await configure(tx, child.id, { model: template.model })
    const record: SpawnedAgentRecord = {
      ...template,
      conversationId: child.id,
      ownerTaskId: owner ?? template.ownerTaskId,
      parentConversationId: parent,
      extensions: ['shuvix.builtin', agentExtensionName(child.id)]
    }
    if (options.persona !== false) {
      await freezePersona(tx, child.id, {
        kind: 'spawned',
        profileName: record.profileName,
        rootSessionId: session.sessionId,
        persona: `You are ${record.displayName}`,
        instructionFiles: []
      })
    }
    await writeSpawnedAgentRecord(tx, child.id, record)
    let holdTaskId: TaskId | undefined
    if (options.hold !== undefined) {
      holdTaskId = await tx.createTask(
        HoldTask,
        { gate: options.hold },
        { ownership: { kind: 'conversation' }, conversationId: child.id }
      )
    }
    return {
      conversationId: child.id,
      ownerTaskId: record.ownerTaskId,
      record,
      ...(holdTaskId === undefined ? {} : { holdTaskId })
    }
  }, BG)
  if (options.settle === true) await settleAnchor(session, seeded.ownerTaskId)
  return seeded
}

/**
 * 让锚任务先跑完（开启调度器、等它终态）：锚没跑完时它在父对话里以 completing 挂着、陪着子对话的
 * 工作一起活着（P2-08 才把这种「拥有辅助对话的任务」排除出运行状态，PIN-12）。
 */
export async function settleAnchor(session: DurableSession, anchor: TaskId): Promise<void> {
  await session.harness.waitForTask(anchor, BG)
}

// ─────────────────────────── 起一轮 / 看状态 ───────────────────────────

/** 给某个对话发一条输入（用例自己先排好应答） */
export async function startRun(
  session: DurableSession,
  conversationId: ConversationId,
  text: string
): Promise<Submission> {
  const conversation = await session.harness.conversation(conversationId, BG)
  return conversation!.submit({ type: 'input', content: text }, BG)
}

/** 此刻活着的任务记录（可按对话过滤） */
export async function liveTasks(
  session: DurableSession,
  conversationId?: ConversationId
): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
  return (await session.harness.inspect(BG)).tasks
    .map((task) => task.record)
    .filter((record) => conversationId === undefined || record.conversationId === conversationId)
}

/** 一个任务此刻的记录（终态的也读得到） */
export async function taskRecord(
  session: DurableSession,
  id: TaskId
): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
  return session.harness.commit((tx) => tx.task(id), BG)
}

/** 某对话里某种任务（缺省 generation）的 id —— 包括已终态的（扫描全部状态） */
export async function tasksOf(
  session: DurableSession,
  conversationId: ConversationId,
  kind = 'pi.generation'
): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
  return session.harness.commit(async (tx) => {
    const page = await tx.scanTasks({ conversationId, kind }, 256)
    return [...page.items]
  }, BG)
}

/** 最后一条用户消息的文本等于 `text` 的那些请求 */
export function requestsWith(kit: FauxKit, text: string): FauxKit['requests'] {
  return kit.requests.filter(
    (request) =>
      messageText([...request.messages].reverse().find((m) => m.role === 'user')) === text
  )
}

/** 有没有哪个请求的哪条消息提到 `text` */
export function mentions(kit: FauxKit, text: string): boolean {
  return kit.requests.some((request) =>
    request.messages.some((message) => messageText(message).includes(text))
  )
}

/** 记下每次调用时 `session.agentIdentity(api.conversationId)` 的工具 */
export function identityProbe(
  getSession: () => DurableSession,
  seen: unknown[],
  name = 'probe'
): ToolRegistration {
  return defineTool({
    name,
    description: `${name}: records the calling agent`,
    parameters: Type.Object({}),
    execute: async (_args, api) => {
      seen.push(getSession().agentIdentity(api.conversationId))
      return { content: [{ type: 'text', text: `${name} done` }] }
    }
  })
}

// ─────────────────────────── 派发（P2-03） ───────────────────────────

/** 测试派发工具的选项 */
export interface DispatchOptions {
  getSession: () => DurableSession
  profiles: Readonly<Record<string, InProcessAgentType>>
  /** 每次派发的结果（按完成次序） */
  outcomes: SpawnOutcome[]
  contract?: ResultContract
  /** 包一层工具 API（注入失败用） */
  wrapApi?: (api: ToolExecutionApi) => ToolExecutionApi
  /** 拿到结果之后、返回之前（扣住测试工具用；扣住时要观察工具的 signal，否则关停会等下去） */
  afterSpawn?: (context: Context) => Promise<void>
  onCreated?: (info: SpawnCreatedInfo) => void
  /** 缺省 `agent`；`force_agent` = 不受 canSpawn 门控的那份 */
  name?: string
  /** 缺省 safe */
  replay?: 'safe' | 'unsafe'
}

/**
 * 测试派发工具：参数 `{name, prompt, description}`，把派发交给 `session.agents.spawn`，结果推进
 * `outcomes`，以 `o.result` 作结果文本（不带 details）。
 */
export function dispatch(options: DispatchOptions): ToolRegistration {
  const name = options.name ?? 'agent'
  return defineTool({
    name,
    description: `${name}: dispatch a sub-agent`,
    parameters: Type.Object({
      name: Type.String(),
      prompt: Type.String(),
      description: Type.String()
    }),
    replay: options.replay ?? 'safe',
    execute: async (args, api, context) => {
      const profile = options.profiles[args.name]
      if (profile === undefined) throw new Error(`unknown profile ${args.name}`)
      const outcome = await options.getSession().agents.spawn(
        {
          owner: { tool: options.wrapApi?.(api) ?? api },
          profile,
          prompt: args.prompt,
          description: args.description,
          ...(options.contract === undefined ? {} : { resultContract: options.contract }),
          ...(options.onCreated === undefined ? {} : { onCreated: options.onCreated })
        },
        context
      )
      options.outcomes.push(outcome)
      await options.afterSpawn?.(context)
      return { content: [{ type: 'text', text: outcome.result }] }
    }
  })
}

/** 派发调用 `agent({name, prompt, description})` */
export function callAgent(
  name: string,
  prompt: string,
  options: { description?: string; id?: string; tool?: string } = {}
): AssistantMessage {
  return callTool(
    options.tool ?? 'agent',
    { name, prompt, description: options.description ?? 'look' },
    options.id ?? 'call-agent'
  )
}

export const PROFILES = {
  explore: testProfile({
    name: 'explore',
    displayName: 'Explorer',
    tools: ['probe'],
    systemPrompt: 'You are {{shuvix:marker}} explorer'
  }),
  nester: testProfile({
    name: 'nester',
    displayName: 'Nester',
    tools: ['probe', 'agent'],
    systemPrompt: 'You are {{shuvix:marker}} nester'
  }),
  modeled: testProfile({
    name: 'modeled',
    displayName: 'Modeled',
    tools: ['probe', 'agent'],
    systemPrompt: 'You are modeled',
    model: 'spec:faux-2'
  }),
  thinker: testProfile({
    name: 'thinker',
    displayName: 'Thinker',
    tools: ['probe'],
    thinkingLevel: 'high'
  }),
  aware: testProfile({
    name: 'aware',
    displayName: 'Aware',
    tools: ['probe', 'knowledge'],
    systemPrompt: 'You are {{shuvix:marker}} aware',
    instructionFiles: ['AGENTS.md'],
    projectAwareness: true
  })
} satisfies Record<string, InProcessAgentType>

/** fakeRPM：`spec:faux-2` → faux-2；`spec:nope` → 不存在的模型；其余 → null。调用记进 `calls` */
export interface FakeRpm {
  readonly calls: string[]
  /** 给了就抛它 */
  fail?: Error
  readonly resolve: (spec: string) => ModelSelection | null
}

export function fakeRpm(): FakeRpm {
  const rpm: FakeRpm = {
    calls: [],
    resolve: (spec) => {
      rpm.calls.push(spec)
      if (rpm.fail !== undefined) throw rpm.fail
      if (spec === 'spec:faux-2') return { provider: 'faux', modelId: 'faux-2' }
      if (spec === 'spec:nope') return { provider: 'faux', modelId: 'nope' }
      return null
    }
  }
  return rpm
}

/** 一个简单的 probe 工具（`probe done`） */
export function probeTool(name = 'probe'): ToolRegistration {
  return defineTool({
    name,
    description: `${name}: probes`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: `${name} done` }] })
  })
}

/** 宿主 D 的会话配置：work 档案（agent + probe）、faux-1、思考 low */
export function configD(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    profile: testProfile({ name: 'work', displayName: 'Work', tools: ['agent', 'probe'] }),
    model: { provider: 'faux', modelId: 'faux-1' },
    thinkingLevel: 'low',
    ...overrides
  }
}

export interface HostD {
  readonly t: TestHost
  readonly session: DurableSession
  readonly vars: MarkerVars
  readonly rpm: FakeRpm
  readonly outcomes: SpawnOutcome[]
  /** 按 agent 的测试工具（同一份数组） */
  readonly tools: ToolRegistration[]
  readonly getSession: () => DurableSession
  /**
   * 换一个进程（`t.restart()` 沿用全部宿主选项，包括派发工具；结果数组、变量表、fakeRPM 共用）再打开会话。
   * `before` 在新宿主建好、会话打开之前调用（设 ToolHost 旋钮用）。
   */
  readonly reopen: (before?: (t: TestHost) => void) => Promise<HostD>
}

export interface HostDOptions {
  /** 额外的按 agent 工具（probe 之外；派发工具经 ToolHost 的 dispatchTool 给） */
  tools?: (getSession: () => DurableSession, outcomes: SpawnOutcome[]) => ToolRegistration[]
  /** 派发工具的额外选项 */
  dispatch?: Partial<Omit<DispatchOptions, 'getSession' | 'outcomes'>>
  config?: AgentConfig
  host?: Partial<TestHostOptions>
  /** 不建根 agent */
  noPrime?: boolean
  /** 自带变量表 / fakeRPM（重启共用） */
  vars?: MarkerVars
  rpm?: FakeRpm
}

/** 宿主 D：faux 两个模型、test.spawn 扩展、marker 变量表、固定时钟、fakeRPM、派发工具 + probe */
export async function hostD(options: HostDOptions = {}): Promise<HostD> {
  const vars = options.vars ?? markerVars('M1')
  const rpm = options.rpm ?? fakeRpm()
  const outcomes: SpawnOutcome[] = []
  let current: DurableSession | undefined
  const getSession = (): DurableSession => current!
  const dispatchTool = dispatch({
    getSession,
    profiles: PROFILES,
    outcomes,
    ...options.dispatch
  })
  const tools: ToolRegistration[] = [probeTool(), ...(options.tools?.(getSession, outcomes) ?? [])]
  const t = await makeHost({
    makeKit: wKit,
    extensions: [TEST_SPAWN_EXTENSION],
    promptVars: vars.promptVars,
    now: () => W_NOW,
    resolveProfileModel: rpm.resolve,
    toolHost: { agentTools: tools, dispatchTool },
    agentConfig: options.config ?? configD(),
    ...options.host
  })
  current = await t.open()
  if (options.noPrime !== true) await primeRoot(current)
  const build = (host: TestHost): HostD => ({
    t: host,
    session: current!,
    vars,
    rpm,
    outcomes,
    tools,
    getSession,
    reopen: async (before) => {
      const next = await host.restart()
      before?.(next)
      current = await next.open()
      return build(next)
    }
  })
  return build(t)
}

/** 某个任务拥有的对话（`scanConversations({ownerTaskId})`） */
export async function childOf(session: DurableSession, taskId: TaskId): Promise<ConversationId[]> {
  return session.harness.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: taskId }, 256)
    return page.items.map((record) => record.id)
  }, BG)
}

/** 某对话里某次工具调用（按 callId，缺省 `call-agent`）的 `pi.tool` 任务 */
export async function dispatchTask(
  session: DurableSession,
  callId = 'call-agent',
  conversationId: ConversationId = ROOT_CONVERSATION_ID
): Promise<TaskId> {
  const tasks = await tasksOf(session, conversationId, 'pi.tool')
  const found = tasks.find((task) => (task.input as { callId?: string }).callId === callId)
  if (found === undefined) throw new Error(`no pi.tool task for ${callId} in ${conversationId}`)
  return found.id
}

/** 全部对话的 id（升序） */
export async function conversationIds(session: DurableSession): Promise<ConversationId[]> {
  return session.harness.commit(async (tx) => {
    const page = await tx.scanConversations({}, 256)
    return page.items.map((record) => record.id).sort((a, b) => a - b)
  }, BG)
}

/**
 * 按请求的最后一条用户消息挑应答的 faux 步骤（同时跑着两个对话时用）：`routes[文本]` 按次序取一个，
 * 应答可以是消息或步骤（held / stalled）。
 */
export function routed(
  routes: Record<string, (AssistantMessage | FauxResponseStep)[]>
): FauxResponseStep {
  return async (context, streamOptions, state, model) => {
    const user = [...context.messages].reverse().find((message) => message.role === 'user')
    const text = messageText(user)
    const next = routes[text]?.shift()
    if (next === undefined) throw new Error(`no faux route for "${text}"`)
    return typeof next === 'function' ? next(context, streamOptions, state, model) : next
  }
}

/** 按路由表里的应答总数排同一个路由步骤 */
export function queueRouted(
  kit: FauxKit,
  routes: Record<string, (AssistantMessage | FauxResponseStep)[]>
): void {
  const step = routed(routes)
  const count = Object.values(routes).reduce((sum, list) => sum + list.length, 0)
  for (let index = 0; index < count; index++) kit.queue(step)
}

/** 某对话的提交（按 requestId） */
export async function submissionByRequest(
  session: DurableSession,
  conversationId: ConversationId,
  requestId: string
): Promise<SubmissionRecord | undefined> {
  return session.harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), BG)
}

/** 系统提示词含 `marker` 的请求（子 agent 的请求：它的人设带 marker，根的没有） */
export function requestsOf(kit: FauxKit, marker: string): FauxKit['requests'] {
  return kit.requests.filter((request) => request.systemPrompt.includes(marker))
}

/** 等某对话（缺省根）里第一个派发工具任务建好它的子对话，返回子对话 id */
export async function firstChild(
  session: DurableSession,
  conversationId: ConversationId = ROOT_CONVERSATION_ID,
  timeoutMs = 3000
): Promise<ConversationId> {
  let found: ConversationId | undefined
  await waitFor(
    async () => {
      for (const task of await tasksOf(session, conversationId, 'pi.tool')) {
        const [child] = await childOf(session, task.id)
        if (child !== undefined) {
          found = child
          return true
        }
      }
      return false
    },
    timeoutMs,
    `a child of conversation ${conversationId}`
  )
  return found!
}
