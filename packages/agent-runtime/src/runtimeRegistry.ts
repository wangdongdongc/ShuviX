/**
 * AgentRuntimeRegistry —— 活跃 pi agent 运行时的唯一登记簿（跨端共享，业务无关）。
 *
 * 与 `agentRegistry.ts` 是**两层**，不要混：
 *  - `AgentRegistry` 管血缘语义（parent/depth），且刻意只登记派生 agent；
 *  - 本类管**运行时对象本身**，root 与 spawned 一视同仁，全量登记。
 *
 * 登记点唯一：`agentProfile/createAgent.ts` 里 `new HarnessSession` 之后 —— 全仓唯一的
 * 构造处，root/spawned 都过它，因此无需散点埋点。注销由 `CreatedAgent.dispose()` 驱动。
 *
 * **只存 pi 原生对象**（`AgentHarness` + `Session`）加一组不透明的身份标签：本类不认识
 * ShuviX 的会话、档案、项目，快照的每个字段都从 pi 自己的读取面取。这条边界是它能被
 * 两端共用、也能被将来任何消费者共用的原因。
 *
 * ## 为什么需要事件影子
 *
 * pi 的 `AgentHarness.phase`、三条队列、token 用量都是**私有字段，没有 getter**，只在
 * 事件流里露面。所以本类对每个 harness `subscribe` 一次，把事件归约成一份实时状态；
 * "私有遮挡"在这里补齐一次，消费者不必各自订阅。
 *
 * 两条硬约束（对着 pi 0.80.10 的实现核过，改动务必保持）：
 *  1. **订阅回调抛错会被 pi rethrow 成 hook error，打断本轮 run**（`emitOwn` 的 catch
 *     直接 `throw normalizeHookError(error)`）。故归约整体包在 try/catch 里，监控绝不
 *     能成为 agent 跑挂的原因。
 *  2. **绝不能用 `harness.on()`**：那是 hook 通道，`emitHook` 取"最后一个非 undefined
 *     结果"生效，挂 `tool_call` 会和安全询问门抢返回值。只用 `subscribe()`（底层是 Set，
 *     多订阅安全，返回 unsubscribe）。
 */
import { calculateContextTokens } from '@earendil-works/pi-agent-core'
import type { AgentHarness, Session } from '@earendil-works/pi-agent-core'
import type { Usage } from '@earendil-works/pi-ai'

export type AgentRuntimeKind = 'root' | 'spawned'

/**
 * 相位影子。pi 自己的 `AgentHarnessPhase` 有五态，但 `retry` 不在任何事件里露面，
 * 无法观测 —— 刻意不建模，宁可少一态也不假造。
 */
export type AgentRuntimePhase = 'idle' | 'turn' | 'compaction' | 'branch_summary'

/** 身份标签：登记方给什么就是什么，本类不解释语义 */
export interface AgentRuntimeIdentity {
  agentId: string
  kind: AgentRuntimeKind
  /** 归属根会话 id（root 时等于 agentId） */
  rootSessionId: string
  parentAgentId?: string
  /** 派生层级（root = 0） */
  depth: number
  profileName: string
  displayName: string
}

/** 事件流归约出来的累计量 */
export interface AgentRuntimeCounters {
  turns: number
  toolCalls: number
  /** provider 往返次数（按收到响应计，见 reduce 里的说明） */
  providerRequests: number
  aborts: number
  compactions: number
}

/** 一次拉取的**廉价**快照：只读 pi getter + 事件影子，不碰会话树 */
export interface AgentRuntimeSnapshot extends AgentRuntimeIdentity {
  phase: AgentRuntimePhase
  startedAt: number
  /** 最近一次收到任何事件的时刻 —— 判断"跑完了还赖着"的主要依据 */
  lastActivityAt: number
  activeToolName?: string
  queue: { steer: number; followUp: number; nextTurn: number }
  counters: AgentRuntimeCounters
  model: { provider: string; id: string; contextWindow: number }
  thinkingLevel: string
  toolCount: number
  activeToolCount: number
  /**
   * 当前上下文占用（token），取自最近一条 assistant 消息的 provider 真实用量，
   * 与 pi 判定自动压缩用的是同一个数（`calculateContextTokens`）——所以
   * `contextTokens / model.contextWindow` 就是"离压缩还有多远"。
   *
   * 尚未完成过一条 assistant 消息时为 0。最近一条 assistant 之后追加的
   * user/toolResult（至多一轮）要等下条 assistant 才计入 —— 监控要的是量级，
   * 不值得为这点尾差去重建上下文。
   */
  contextTokens: number
}

interface LiveEntry {
  identity: AgentRuntimeIdentity
  harness: AgentHarness
  /**
   * 会话树。当前没有读取方（上下文占用改由事件影子维护后，测量入口已撤），仍然登记是因为
   * pi 把 `AgentHarness.session` 设成了私有 —— 不在这里存一份，注册中心就再也够不到
   * 运行时的另一半，将来任何要看 entry 明细的消费者都得重新改登记签名。
   */
  session: Session
  unsubscribe: () => void
  startedAt: number
  lastActivityAt: number
  phase: AgentRuntimePhase
  activeToolName?: string
  queue: { steer: number; followUp: number; nextTurn: number }
  counters: AgentRuntimeCounters
  contextTokens: number
}

const emptyCounters = (): AgentRuntimeCounters => ({
  turns: 0,
  toolCalls: 0,
  providerRequests: 0,
  aborts: 0,
  compactions: 0
})

export class AgentRuntimeRegistry {
  private readonly entries = new Map<string, LiveEntry>()

  /**
   * 登记一个运行时，返回注销函数。
   *
   * 同 id 重复登记视为替换（先注销旧的）—— 会话运行时失效重建时 id 不变，
   * 漏注销会留下一个指向已弃运行时的死条目。
   */
  register(identity: AgentRuntimeIdentity, harness: AgentHarness, session: Session): () => void {
    this.unregister(identity.agentId)
    const now = Date.now()
    const entry: LiveEntry = {
      identity,
      harness,
      session,
      unsubscribe: () => {},
      startedAt: now,
      lastActivityAt: now,
      phase: 'idle',
      queue: { steer: 0, followUp: 0, nextTurn: 0 },
      counters: emptyCounters(),
      contextTokens: 0
    }
    // 监控绝不能成为 agent 跑挂的原因：pi 会把订阅者抛出的错 rethrow 成 hook error
    entry.unsubscribe = harness.subscribe((event) => {
      try {
        reduce(entry, event as { type: string } & Record<string, unknown>)
      } catch {
        /* 归约失败只损失一次监控采样，绝不外溢 */
      }
    })
    this.entries.set(identity.agentId, entry)
    return () => this.unregister(identity.agentId)
  }

  unregister(agentId: string): void {
    const entry = this.entries.get(agentId)
    if (!entry) return
    try {
      entry.unsubscribe()
    } catch {
      /* 退订失败不阻断移除 */
    }
    this.entries.delete(agentId)
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId)
  }

  /** 全部活跃运行时的廉价快照（不碰会话树） */
  list(): AgentRuntimeSnapshot[] {
    return [...this.entries.values()].map((entry) => snapshotOf(entry))
  }

  get(agentId: string): AgentRuntimeSnapshot | undefined {
    const entry = this.entries.get(agentId)
    return entry ? snapshotOf(entry) : undefined
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    for (const agentId of [...this.entries.keys()]) this.unregister(agentId)
  }
}

/** 快照 = 事件影子 + pi 的读取面（每次现取，不缓存 —— 模型/工具可在运行中被换掉） */
function snapshotOf(entry: LiveEntry): AgentRuntimeSnapshot {
  const model = entry.harness.getModel()
  return {
    ...entry.identity,
    phase: entry.phase,
    startedAt: entry.startedAt,
    lastActivityAt: entry.lastActivityAt,
    activeToolName: entry.activeToolName,
    queue: { ...entry.queue },
    counters: { ...entry.counters },
    contextTokens: entry.contextTokens,
    model: {
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow
    },
    thinkingLevel: String(entry.harness.getThinkingLevel()),
    toolCount: entry.harness.getTools().length,
    activeToolCount: entry.harness.getActiveTools().length
  }
}

/**
 * 事件归约。相位取值来自两组事件：
 *  - agent 循环事件 `agent_start` / `agent_end` → turn 的起止；
 *  - harness 自有事件 `session_before_compact` / `session_compact`（压缩）与
 *    `session_before_tree` / `session_tree`（分支摘要）→ 两个非 turn 相位。
 */
function reduce(entry: LiveEntry, event: { type: string } & Record<string, unknown>): void {
  entry.lastActivityAt = Date.now()
  switch (event.type) {
    case 'agent_start':
      entry.phase = 'turn'
      entry.counters.turns++
      break
    case 'agent_end':
      entry.phase = 'idle'
      entry.activeToolName = undefined
      break
    case 'tool_execution_start':
      entry.counters.toolCalls++
      entry.activeToolName = String(event.toolName ?? '')
      break
    case 'tool_execution_end':
      entry.activeToolName = undefined
      break
    // 数**响应**而非请求：`before_provider_request` / `before_provider_payload` 走的是
    // pi 的 hook 通道（`getHandlers(type)`，只发给 `on()` 注册的处理器），订阅者永远收不到 ——
    // 挂在那两个事件上的计数器会恒为 0。只有 `after_provider_response` 经 emitOwn 到订阅者。
    case 'after_provider_response':
      entry.counters.providerRequests++
      break
    case 'message_end':
      updateContextTokens(entry, event.message)
      break
    case 'queue_update':
      entry.queue = {
        steer: lengthOf(event.steer),
        followUp: lengthOf(event.followUp),
        nextTurn: lengthOf(event.nextTurn)
      }
      break
    case 'abort':
      entry.counters.aborts++
      entry.phase = 'idle'
      entry.activeToolName = undefined
      break
    case 'session_before_compact':
      entry.phase = 'compaction'
      break
    case 'session_compact':
      entry.counters.compactions++
      entry.phase = 'idle'
      break
    case 'session_before_tree':
      entry.phase = 'branch_summary'
      break
    case 'session_tree':
      entry.phase = 'idle'
      break
    default:
      break
  }
}

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/**
 * 从 provider 真实用量更新当前上下文占用 —— 一条 assistant 消息的用量，就是发出它时
 * 上下文有多大（pi 把 usage 挂在 assistant 消息上）。
 *
 * 用 pi 自己的 `calculateContextTokens` 而不是自己加字段，是为了让这个数与驱动自动
 * 压缩的那个**定义相同**：否则监控页显示"快满了"而压缩不触发（或反过来）就成了误导。
 *
 * 中止/出错的消息跳过：pi 的 `getAssistantUsage` 同样排除它们（用量不完整，拿来当
 * 上下文尺寸会突然缩水）。
 *
 * 刻意**不累计** token 花费 —— 那是"花了多少"，本登记簿只回答"占着多少"。
 */
function updateContextTokens(entry: LiveEntry, message: unknown): void {
  const msg = message as { usage?: Usage; stopReason?: string } | undefined
  if (!msg?.usage) return
  if (msg.stopReason === 'aborted' || msg.stopReason === 'error') return
  const context = calculateContextTokens(msg.usage)
  if (context > 0) entry.contextTokens = context
}

/**
 * 进程内唯一实例。
 *
 * 单例而非工厂（对比 `createSessionTreeRegistry`）：本类不需要任何注入依赖 —— 它只持有
 * pi 对象和字符串标签。登记方是 `createAgent` 这个全仓单点，消费方是各宿主的监控入口，
 * 中间不需要可替换的接缝。
 */
export const agentRuntimeRegistry = new AgentRuntimeRegistry()
