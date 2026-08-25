/**
 * 智能体监控的前后端契约。
 *
 * 面向的问题是**资源占用诊断**而非"谁在跑"：派生 agent 跑完并不销毁（面板要支持继续
 * 追问），桌面端又没有级联清理，于是一个进程里可能堆着一批早已 idle、却仍完整持有
 * harness 与内存会话树的 agent。这里的字段就是为了把那批东西认出来：
 *  - `phase` + `lastActivityAt` → 区分"在跑"与"跑完了赖着"；
 *  - `rootSessionExists` → 认出根会话都没了的孤儿；
 *  - `contextTokens` / `model.contextWindow` → 它占着多大的上下文。
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

  /** 宿主补充：所属会话标题（认不出 uuid 时的人类可读名） */
  rootSessionTitle?: string
  /**
   * 宿主补充：所属会话是否还在。
   *
   * false = 会话已被删除但这个运行时还挂着 —— 纯滞留，不可能再被用到。
   */
  rootSessionExists: boolean
}
