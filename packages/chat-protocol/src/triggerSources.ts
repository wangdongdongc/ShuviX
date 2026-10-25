/**
 * 触发源（实验）—— 产生全局埋点事件的东西，是一项系统设置（设置 → 触发源）。今天只有一种类型：timer，内置一个
 * 开箱即开的实例，每分钟触发一次 `timer.fired`。以后加文件监视、webhook 之类，是在这里多一种 `kind`。
 *
 * **触发源与 bot 解绑**（用户 2026-10-24）：触发源只管发事件，不知道谁会响应 —— 每个 bot 在事件到来时用自己
 * 绑定里的 CEL `when` 决定命不命中，从条件反推「谁订阅了它」靠不住。用户感知「哪个事件叫起了哪个 bot」靠
 * 触发日志（TriggerLogEntry）：命中的那一刻记一条。
 */
export interface TriggerSourceStatus {
  /** 实例 id（事件与来源记录里的 `sourceId`；内置 timer：`timer:builtin:minute`） */
  id: string
  kind: 'timer'
  /** 随应用内置（不能删，只能关） */
  builtin: boolean
  enabled: boolean
  /** 本次运行里上一次触发的时刻（ISO）；还没触发过 → 缺省 */
  lastFiredAt?: string
  /**
   * 上一次触发的原始事件 —— 就是 bot 绑定的 `when` 里看到的 `event`（载荷加上 `trigger` 字段）；还没触发过 → 缺省
   */
  lastEvent?: Record<string, unknown>
}

/** 触发日志一条的结果 */
export type TriggerLogOutcome =
  /** 命中、已开出运行会话，这一轮还在跑 */
  | 'started'
  /** 那一轮正常结束 */
  | 'completed'
  /** 会话没开出来、模型被拒或这一轮出错（`error` 里是原因） */
  | 'failed'
  /** 命中，但同一条绑定上一次还没跑完，这次没起 */
  | 'skipped'
  /** 绑定的 `when` 求值出错（同一个错误只记一次；`error` 里是 CEL 的报错） */
  | 'condition-error'

/** 触发日志的一条：某个触发源的一次事件命中了某个 bot 的某条绑定（或那条绑定的条件出错） */
export interface TriggerLogEntry {
  id: string
  /** 记下的时刻（毫秒） */
  createdAt: number
  /** 最后一次更新（started → completed / failed）的时刻（毫秒） */
  updatedAt: number
  /** 发出事件的触发源实例（如 `timer:builtin:minute`） */
  sourceId: string
  /** 触发点 id（如 `timer.fired`） */
  trigger: string
  /** bot 的名字（会话的 `settings.bot`） */
  bot: string
  /** bot 的显示名（记下时的） */
  botDisplayName: string
  /** bot 文件名（点开它的笔记本） */
  botFile: string
  /** 第几条绑定（从 0 数） */
  bindingIndex: number
  /** 绑定的 `when` 原文（没写为空串） */
  when: string
  outcome: TriggerLogOutcome
  /** 开出的运行会话（started / completed / failed 才有，会话没开出来的 failed 没有） */
  sessionId: string
  /** 失败与条件出错的原因 */
  error: string
  /** 命中时的原始事件（`when` 看到的 `event`） */
  event: Record<string, unknown>
}
