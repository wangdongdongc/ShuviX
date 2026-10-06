/**
 * 智能体监控的前后端契约（P3-13，Monitor → Agents）。
 *
 * 列的是**打开着的会话**里的 agent（根 agent 与加载在打开着的 Harness 里的派生 / hook agent）。一行回答
 * 三件事：
 *  - `phase` + `lastActivityAt` → 区分「在跑」「跑完了闲着」「上个进程留下、停在原地」（interrupted）；
 *  - `contextTokens` / `model.contextWindow` → 它占着多大的上下文（离自动压缩还有多远）；
 *  - `cache` / `cost` → 那段上下文里多少是命中缓存复用的、它花了多少钱（durable 的 `pi.usage` 账本）。
 *
 * 数值一律取自 durable 会话（`DurableSession.monitorSnapshot()`），宿主只补充 pi 不可能知道的会话标题与
 * 根档案的显示名。没有事件计数器、没有「孤儿」：运行时住在会话里，会话没了它也就没了。
 */

/**
 * 相位：`turn` = 这个对话有一轮在跑；`compaction` = 在压缩；`interrupted` = 存储里留着一轮、调度器停着
 * （上个进程中途退出，等用户继续）—— 不在跑，排序与 idle 同等；`idle` = 什么都没有。
 */
export type AgentMonitorPhase = 'idle' | 'turn' | 'compaction' | 'interrupted'

export type AgentMonitorKind = 'root' | 'spawned'

/**
 * 提示词缓存用量 —— 命中率的原料，取自这个对话自己的 `pi.usage`（按模型的桶）。
 *
 * `pi.usage` 是**花费**账本：失败的重试、中止的半截回复、零内容回复、压缩的摘要请求都记在里面，所以这里
 * 同样都算（它们都占了输入）。三项是 pi 归一后的 usage，互不重叠（`input` 已扣掉缓存部分）。
 * 三项全 0 = 还没有数据。
 */
export interface AgentMonitorCacheUsage {
  /** 累计：未命中缓存的输入 */
  input: number
  /** 累计：缓存命中 */
  cacheRead: number
  /** 累计：缓存写入 */
  cacheWrite: number
  /** 最近一条带用量的 assistant 条目（还没有就缺席） */
  last?: { input: number; cacheRead: number; cacheWrite: number }
  /**
   * provider 是否上报过缓存：累计里 cacheRead 或 cacheWrite 大于 0。
   *
   * 「上报了 0」与「根本不上报」在 usage 里都读作 0，唯一能区分的就是它有没有出现过非 0 —— false 时
   * 命中率应显示为未知而不是 0%。代价：真上报、却一次也没命中过也没写过的模型，同样显示为未知。
   */
  reported: boolean
}

/** 一个 agent 的廉价快照（列表轮询用） */
export interface AgentMonitorEntry {
  agentId: string
  kind: AgentMonitorKind
  rootSessionId: string
  parentAgentId?: string
  depth: number
  profileName: string
  displayName: string
  /** 派生 agent 的派发方式：`tool` = agent 派发工具，`hook` = 宿主派发的 hook agent（根没有） */
  dispatch?: 'tool' | 'hook'

  phase: AgentMonitorPhase
  startedAt: number
  /** 在跑（turn / compaction）时 = 此刻；否则 = 最新一条条目的消息时间，没有就是 startedAt */
  lastActivityAt: number
  /** 此刻在跑的工具（只在 turn 时） */
  activeToolName?: string
  /** 排着的用户输入（系统通知形状的插话与被动写入不算） */
  queue: { steer: number; followUp: number }

  model: { provider: string; id: string; contextWindow: number }
  thinkingLevel: string
  /** 提供给模型的工具数（pi 没有「装了但没启用」的工具） */
  toolCount: number
  /**
   * 当前上下文占用（token）：活上下文里最新一条带用量的 assistant 的 provider 真实用量 —— 与 durable
   * 判定自动压缩用的是同一个数，`contextTokens / model.contextWindow` 即「离压缩还有多远」。没有时为 0。
   */
  contextTokens: number
  /** 提示词缓存用量（命中率的原料，见 AgentMonitorCacheUsage） */
  cache: AgentMonitorCacheUsage
  /**
   * 这个 agent 自己的花费（它的对话的 `pi.usage`：按模型与按工具的桶，含重试、压缩）。自定义 provider 的
   * 模型没有价格 → 恒为 0（面板显示「—」与「未定价」说明）。根 agent 回退 fork 之后从 0 起算。
   */
  cost: { total: number }
  /** 整条会话的花费（`harness.usage()`：全部对话，含起标题、权限审查与回退丢下的分支） */
  sessionCost: number

  /** 宿主补充：所属会话标题（认不出 uuid 时的人类可读名） */
  rootSessionTitle?: string
}
