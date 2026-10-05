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
import { Type } from '@earendil-works/pi-ai'
import {
  configure,
  defineExtension,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Submission,
  type TaskId,
  type TaskRecord,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { backgroundContext as BG } from '../../context'
import { writeSpawnedAgentRecord, type SpawnedAgentRecord } from '../../agentRecord'
import type { DurableSession } from '../../durableSession'
import { agentExtensionName } from '../../lock'
import { freezePersona } from '../../prompt/persona'
import type { FauxKit } from './faux'
import { W_NOW } from './scenario'
import { messageText } from './transcript'
import { aborted, deferred, type Deferred } from './wait'

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
