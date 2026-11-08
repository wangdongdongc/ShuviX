/**
 * 目标模式（`/goal`，docs/goal-mode-design.md）的共享类型：会话上的目标记录、判定结论、前端看到的目标视图。
 *
 * 一条会话同一时刻至多一个目标。目标由人设定（输入框 `/goal <条件>`），之后每次根运行结束，由判定型埋点
 * `goal.check` 上的 hook（内置 `goal-check` → `goal-judge`）判断达成没有；没达成，宿主带着判定理由让会话接着干。
 * 干活的 agent 没有任何目标工具：它不能设目标、改目标，也不能自己宣布完成（裁决 D1，2026-11-07）。
 */

/** 目标条件的长度上限（与 Claude Code / Codex 相同） */
export const GOAL_OBJECTIVE_MAX_CHARS = 4000

/** 判定结论。数组次序即严格程度：多个 hook 都给了结论时取最严的 —— 只要有一个认为没做完，就接着做 */
export const GOAL_VERDICTS = ['met', 'impossible', 'not_met'] as const
export type GoalVerdictKind = (typeof GOAL_VERDICTS)[number]

/** `goal.check` 的结论契约（派发时即 `next` 工具的参数） */
export interface GoalVerdict {
  verdict: GoalVerdictKind
  /** 依据什么判断（给人看，也给干活的 agent 看） */
  reason: string
  /** not_met 时：下一步最该做什么 */
  next_step?: string
}

export const GOAL_VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['verdict', 'reason'],
  properties: {
    verdict: {
      type: 'string',
      enum: [...GOAL_VERDICTS],
      description:
        'met = the goal is achieved and the evidence shows it; not_met = not yet, or the evidence is missing or uncertain; impossible = something outside the agent’s reach blocks it.'
    },
    reason: {
      type: 'string',
      description:
        'One or two sentences in the language of the conversation naming the evidence you judged by. The user and the working agent both read it.'
    },
    next_step: {
      type: 'string',
      description:
        'For not_met: the single most useful next step, or the check that would settle the question. One sentence.'
    }
  },
  additionalProperties: false
}

/** 形状守卫 —— 捕获值来自模型，`next` 已按 schema 校验过，这里是交给执行方之前的最后一道 */
export function isGoalVerdict(value: unknown): value is GoalVerdict {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (GOAL_VERDICTS as readonly unknown[]).includes(v.verdict) &&
    typeof v.reason === 'string' &&
    (v.next_step === undefined || typeof v.next_step === 'string')
  )
}

/** 严格程度：数大者更严 */
export function goalVerdictSeverity(verdict: GoalVerdictKind): number {
  return GOAL_VERDICTS.indexOf(verdict)
}

/**
 * 目标状态。`met` / `impossible` 是终态（重新开始 = 设一个新目标）；`paused` 只有用户能恢复。
 * 清除目标不是一种状态：记录直接删掉，转写里留一条通知行。
 */
export type GoalStatus = 'active' | 'paused' | 'met' | 'impossible'

/** 为什么暂停 —— 每一种都由宿主判定，不由 agent 说 */
export const GOAL_PAUSE_REASONS = [
  /** 用户点了暂停 */
  'user',
  /** 用户停止了这一轮 */
  'stopped',
  /** 应用重启时目标还在进行中、会话却是空闲的（没有任何东西会把它推起来） */
  'restart',
  /** 会话是 fork 出来的：两条会话不该同时朝同一个目标改同一份东西 */
  'forked',
  /** 花费到了上限 */
  'budget',
  /** 宿主续跑的轮数到了上限 */
  'turns',
  /** 连续几轮没有进展 */
  'stalled',
  /** 累计时长到了上限 */
  'wall-clock',
  /** 没有判定结论（判定超时、出错，或者没有 hook 在判） */
  'judge-unavailable',
  /** 这一轮出错结束 */
  'run-error'
] as const
export type GoalPauseReason = (typeof GOAL_PAUSE_REASONS)[number]

/** 宿主执行的上限。设定时取设置里的默认值，之后可以在目标栏单独改 */
export interface GoalLimits {
  /** 花费上限（美元）；不设 = 不限。模型价格未知时花费恒为 0，这一条不生效 */
  costUsd?: number
  /** 宿主为目标续跑的轮数上限（用户自己发的轮不计） */
  maxTurns: number
  /** 连续无进展多少轮就暂停 */
  stallTurns: number
  /** 处于进行中的累计时长上限（分钟）；不设 = 不限 */
  wallClockMin?: number
}

export const DEFAULT_GOAL_LIMITS: GoalLimits = { costUsd: 5, maxTurns: 50, stallTurns: 3 }

export interface GoalVerdictRecord {
  verdict: GoalVerdictKind
  reason: string
  nextStep?: string
  at: number
}

/** 会话存储里的目标记录（`shuvix.goal` 文档，scope session） */
export interface GoalRecord {
  /** 每次「设定」新生成；编辑不换 */
  id: string
  /** 用户的原话 */
  objective: string
  status: GoalStatus
  pauseReason?: GoalPauseReason
  setAt: number
  limits: GoalLimits
  /** 设定时会话已经花掉的（美元）—— 目标的花费 = 此后的增量 */
  baselineCostUsd: number
  /** 宿主为目标续跑的轮数 */
  turns: number
  /** 连续无进展的轮数 */
  stalls: number
  lastVerdict?: GoalVerdictRecord
  /** 已结束的进行中时段累计（毫秒） */
  activeMs: number
  /** 当前进行中时段的起点；不在进行中时缺省 */
  activeSince?: number
  /** 到达终态的时刻 */
  endedAt?: number
  /**
   * 目标规划员（goal-planner）开工前写下的验收规格文件（工作目录里，位置与名字由它定；绝对路径）。没有 = 目标本来就够清楚，
   * 或者规划没成。内容与格式不做约定：干活的 agent 与检查员每次都读它此刻的内容（2026-11-08 用户裁决：不做硬卡点，靠提示词约束）
   */
  specPath?: string
}

/** 推给前端的目标视图：记录 + 宿主现算的事实 */
export interface GoalView extends GoalRecord {
  sessionId: string
  /** 目标期间的花费（美元，含目标期间新建的子会话） */
  costUsd: number
  /** 判定正在进行 */
  judging: boolean
  /** 目标规划员正在整理验收规格（目标还没开始干） */
  planning: boolean
  /** 没有任何 hook 订阅 `goal.check`（内置的 goal-check 被停用了）—— 目标栏要明说 */
  checkerMissing: boolean
}

/** 目标规划员的结论契约（派发时即 `next` 的参数）：够清楚，或写好了规格文件 —— 规格本身的格式不约定 */
export interface GoalPlan {
  verdict: 'ready' | 'spec'
  /** verdict 为 spec 时：规格文件的路径（工作目录里，绝对或相对工作目录） */
  specPath?: string
}

export const GOAL_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['ready', 'spec'],
      description:
        'ready = the goal already states its end state and how to check it, nothing written; spec = you wrote the acceptance spec file.'
    },
    specPath: {
      type: 'string',
      description:
        'For spec: the path of the file you wrote (absolute, or relative to the working directory).'
    }
  },
  additionalProperties: false
}

export function isGoalPlan(value: unknown): value is GoalPlan {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.verdict === 'ready' || v.verdict === 'spec') &&
    (v.specPath === undefined || typeof v.specPath === 'string')
  )
}

/** 处于进行中的累计时长（毫秒） */
export function goalActiveMs(
  goal: Pick<GoalRecord, 'activeMs' | 'activeSince'>,
  now: number
): number {
  return goal.activeMs + (goal.activeSince !== undefined ? Math.max(0, now - goal.activeSince) : 0)
}

/** 上限补丁：按键覆盖；`null` = 不限（只对花费、时长有效 —— 经 JSON 传不了 undefined） */
export type GoalLimitsPatch = { [K in keyof GoalLimits]?: GoalLimits[K] | null }

/** 前端对目标的操作（经 ChatApi） */
export type GoalAction =
  | { type: 'set'; objective: string; limits?: GoalLimitsPatch }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'edit'; objective?: string; limits?: GoalLimitsPatch }
  | { type: 'clear' }

/** 目标操作的结果：被拒时 `error` 是给人读的文案 */
export type GoalActResult = { ok: true } | { ok: false; error: string }

function limitsPatchOk(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!['costUsd', 'maxTurns', 'stallTurns', 'wallClockMin'].includes(key)) return false
    if (item !== null && item !== undefined && typeof item !== 'number') return false
  }
  return true
}

/**
 * 形状守卫 —— `agent:goalAct` 的参数来自前端（含局域网里的网络客户端），任意 JSON 都可能进来：认不出的类型、
 * 不是字符串的原文、不是数字的上限 → false，宿主回 `{ok:false}`，什么也不写。
 */
export function isGoalAction(value: unknown): value is GoalAction {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  switch (v.type) {
    case 'set':
      return typeof v.objective === 'string' && limitsPatchOk(v.limits)
    case 'edit':
      return (
        (v.objective === undefined || typeof v.objective === 'string') && limitsPatchOk(v.limits)
      )
    case 'pause':
    case 'resume':
    case 'clear':
      return true
    default:
      return false
  }
}
