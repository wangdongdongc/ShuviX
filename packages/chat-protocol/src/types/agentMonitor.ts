/**
 * 智能体监控的前后端契约。
 *
 * 面向的问题是**资源占用诊断**而非"谁在跑"：派生 agent 跑完并不销毁（面板要支持继续
 * 追问），桌面端又没有级联清理，于是一个进程里可能堆着一批早已 idle、却仍完整持有
 * harness 与内存会话树的 agent。这里的字段就是为了把那批东西认出来：
 *  - `phase` + `lastActivityAt` → 区分"在跑"与"跑完了赖着"；
 *  - `rootSessionExists` → 认出根会话都没了的孤儿；
 *  - `contextTokens` / `model.contextWindow` → 它占着多大的上下文；
 *  - `cache` → 那段上下文里有多少是命中提示词缓存复用的（命中率）。
 *
 * 数值一律取自 pi 原生运行时对象（`AgentHarness` 的读取面 + 事件流），宿主只补充
 * pi 不可能知道的会话身份。
 */

/** 相位。pi 的 `retry` 态不在任何事件里露面，无法观测，故不建模。 */
export type AgentMonitorPhase = 'idle' | 'turn' | 'compaction' | 'branch_summary'

export type AgentMonitorKind = 'root' | 'spawned'

/**
 * 事件流归约出的累计量（自登记起算，不跨运行时重建）。
 * 只记「做了多少动作」，不记 token 花费 —— 本页回答的是占用，不是成本。
 */
export interface AgentMonitorCounters {
  turns: number
  toolCalls: number
  providerRequests: number
  aborts: number
  compactions: number
}

/**
 * 提示词缓存用量（自登记起累计，不跨运行时重建）—— 只为算命中率而存。
 *
 * 与「不记 token 花费」并不矛盾：命中率是效率比例，回答的是「这段上下文有多少是
 * 被复用的」，不是「花了多少」。所以面板只显示比例，这几个和不直接展示。
 *
 * 三项是 pi 归一后的 usage，互不重叠（`input` 已扣掉缓存部分）。只计入完整的调用：
 * 中止 / 出错的消息 usage 不完整（OpenAI 系的 usage 在流的最后一块才到，断在中途即全 0），
 * 零内容空回复的 usage 是坏数据（见 agent-runtime `harness/zeroContent.ts`），都不计。
 */
export interface AgentMonitorCacheUsage {
  /** 计入的调用次数 */
  calls: number
  /** 累计：未命中缓存的输入 */
  input: number
  /** 累计：缓存命中 */
  cacheRead: number
  /** 累计：缓存写入 */
  cacheWrite: number
  /** 最近一次计入的调用（calls 为 0 时缺席） */
  last?: { input: number; cacheRead: number; cacheWrite: number }
  /**
   * provider 是否上报过缓存：任一次计入的调用里 cacheRead 或 cacheWrite 大于 0。
   *
   * 「上报了 0」与「根本不上报」（字段名 pi 不认得、或服务商 / 中转站压根不给）在 usage 里
   * 都读作 0，唯一能区分的就是它有没有出现过非 0 —— false 时命中率应显示为未知而不是 0%。
   * 代价：真上报、却一次也没命中过也没写过的模型，同样显示为未知。
   */
  reported: boolean
}

/** 一个活跃 agent 运行时的廉价快照（列表拉取用，不碰会话树） */
export interface AgentMonitorEntry {
  agentId: string
  kind: AgentMonitorKind
  rootSessionId: string
  parentAgentId?: string
  depth: number
  profileName: string
  displayName: string

  phase: AgentMonitorPhase
  startedAt: number
  lastActivityAt: number
  activeToolName?: string
  queue: { steer: number; followUp: number; nextTurn: number }
  counters: AgentMonitorCounters

  model: { provider: string; id: string; contextWindow: number }
  thinkingLevel: string
  toolCount: number
  activeToolCount: number
  /**
   * 当前上下文占用（token）。取自最近一条 assistant 消息的 provider 真实用量，
   * 与 pi 判定自动压缩用的是同一个数 —— `contextTokens / model.contextWindow`
   * 即"离压缩还有多远"。尚未完成过一条 assistant 消息时为 0。
   */
  contextTokens: number
  /** 提示词缓存用量（命中率的原料，见 AgentMonitorCacheUsage） */
  cache: AgentMonitorCacheUsage

  /** 宿主补充：所属会话标题（认不出 uuid 时的人类可读名） */
  rootSessionTitle?: string
  /**
   * 宿主补充：所属会话是否还在。
   *
   * false = 会话已被删除但这个运行时还挂着 —— 纯滞留，不可能再被用到。
   */
  rootSessionExists: boolean
}
