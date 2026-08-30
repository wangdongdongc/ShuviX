/**
 * 多 bot 归属仲裁（设计 §7）—— 一条用户消息只该有一个回复者。
 *
 * 宿主持有的是**跨 run 的汇合点**，而不是分阶段驱动脚本：cohort 建立后一次性把全部成员
 * 派出去（各自独立 run、并行跑意图判定），脚本在判定完调 `claim(intent)`，宿主在这里汇合。
 *
 * **`cohort.size === 1` 是常量退化，不是特判分支**：barrier 建立时胜者就已经定了，
 * `claim` 同步返回 won。这条不变量顺带买到一件事 —— 从不调 `claim` 的自定义管线在单 bot
 * 会话里照常工作（`say` 的前置条件天然满足），而在多 bot 会话里会撞上 `arbitration_bypassed`：
 * 隐式入场等于给「不调 claim」发一张永远赢的票。
 *
 * 「慢」与「沉默」在记录里**分开**：定局后才到的成员记 `claim_timeout`，自己判 ignore 的记
 * `claim_ignored`。把前者转译成后者，等于把一次性能问题写成一次意图判定。
 */

export type ClaimDecision = 'reply' | 'task' | 'clarify' | 'ignore'

export interface ClaimIntent {
  decision: ClaimDecision
  /** 这条消息落在我职责范围内的程度 0..9 —— 不是「我多想回答」 */
  relevance: number
  reason?: string
}

export interface ClaimVerdict {
  won: boolean
  winner?: string
  /**
   * solo=cohort 退化为一人 | won | lost=输给别人 | ignored=自己判定不接 |
   * timeout=定局之后才到 | aborted=会话被中止
   */
  reason: 'solo' | 'won' | 'lost' | 'ignored' | 'timeout' | 'aborted'
}

/** 成员序，非成员排到最后 */
function rank(members: string[], botName: string): number {
  const at = members.indexOf(botName)
  return at < 0 ? Number.POSITIVE_INFINITY : at
}

/** 决策优先序：同分时任务 > 澄清 > 轻回应 */
const DECISION_RANK: Record<Exclude<ClaimDecision, 'ignore'>, number> = {
  task: 0,
  clarify: 1,
  reply: 2
}

/** 首个非 ignore 候选到达之后，给其余成员的宽限窗 */
export const GRACE_MS = 3000

interface Candidate extends ClaimIntent {
  botName: string
  at: number
}

export interface BarrierDeps {
  /** 定局时通知宿主：胜者、败者、以及仍未表态因而该被中止的成员 */
  onSettled?: (result: {
    winner: string | null
    losers: string[]
    /** 定局时连意图都还没交的成员 —— 继续跑纯属烧钱，宿主应中止它们 */
    unresponsive: string[]
  }) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (t: NodeJS.Timeout) => void
}

/**
 * 一条用户消息对应一个 barrier，同 cohort 的全部成员共享它。
 */
export class CohortBarrier {
  private readonly candidates = new Map<string, Candidate>()
  private readonly waiters = new Map<string, (v: ClaimVerdict) => void>()
  private readonly pending: Set<string>
  private graceTimer: NodeJS.Timeout | null = null
  private settledWinner: string | null = null
  private settled = false
  /** 定局是被 settle() 关的还是被 abort() 关的 —— 决定迟到者拿 timeout 还是 aborted */
  private closedBy: 'settle' | 'abort' = 'settle'

  constructor(
    readonly members: string[],
    private readonly deps: BarrierDeps = {}
  ) {
    this.pending = new Set(members)
    // cohort 退化：胜者在建立时就定了，claim 是一次同步的常量返回
    if (members.length === 1) {
      this.settled = true
      this.settledWinner = members[0]
    }
  }

  get winner(): string | null {
    return this.settledWinner
  }

  get isSettled(): boolean {
    return this.settled
  }

  /** cohort 只有一人时为真 —— `say` 的「从未 claim」判定要看它 */
  get isSolo(): boolean {
    return this.members.length === 1
  }

  claim(botName: string, intent: ClaimIntent): Promise<ClaimVerdict> {
    if (this.isSolo) {
      return Promise.resolve({ won: true, winner: botName, reason: 'solo' })
    }
    if (this.settled) {
      // 定局之后才到。记为 timeout 而不是 ignored（「慢」不是「不想说」）—— 但会话被中止
      // 又是另一回事：把它也写成 timeout，等于让排查的人去调宽限窗，而实际是有人按了停止
      this.pending.delete(botName)
      if (this.closedBy === 'abort') {
        return Promise.resolve({ won: false, reason: 'aborted' })
      }
      return Promise.resolve({
        won: this.settledWinner === botName,
        winner: this.settledWinner ?? undefined,
        reason: this.settledWinner === botName ? 'won' : 'timeout'
      })
    }
    // 同一个 bot 二次 claim：第一个 Promise 的 resolve 会被覆盖而永不落定，run 要挂到
    // 引擎墙钟才收 —— 而 say 的三道闸都拦不住「卡住」。当脚本 bug 抛，与 asClaimIntent 同策
    if (this.waiters.has(botName)) {
      throw new Error(`claim() called twice by "${botName}" in one run`)
    }
    this.pending.delete(botName)

    if (intent.decision === 'ignore') {
      // 自己判定不接：立即返回，**永不参与评分**
      this.maybeSettle()
      return Promise.resolve({ won: false, reason: 'ignored' })
    }

    this.candidates.set(botName, { ...intent, botName, at: this.now() })
    const verdict = new Promise<ClaimVerdict>((resolve) => this.waiters.set(botName, resolve))

    // 首个非 ignore 候选到达时才起宽限窗 —— 全员 ignore 的会话不必白等 3 秒
    if (!this.graceTimer && this.candidates.size === 1 && this.pending.size > 0) {
      this.graceTimer = this.setTimer(() => this.settle(), GRACE_MS)
    }
    this.maybeSettle()
    return verdict
  }

  /** 会话被中止：所有等待者立即拿到 aborted */
  abort(): void {
    if (this.settled) return
    this.settled = true
    this.closedBy = 'abort'
    this.clearGrace()
    for (const [, resolve] of this.waiters) resolve({ won: false, reason: 'aborted' })
    this.waiters.clear()
  }

  private maybeSettle(): void {
    if (this.settled) return
    // 全员都表态了就不必等满宽限窗
    if (this.pending.size === 0) this.settle()
  }

  private settle(): void {
    if (this.settled) return
    this.settled = true
    this.clearGrace()

    const ranked = [...this.candidates.values()].sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance
      const ra = DECISION_RANK[a.decision as Exclude<ClaimDecision, 'ignore'>] ?? 9
      const rb = DECISION_RANK[b.decision as Exclude<ClaimDecision, 'ignore'>] ?? 9
      if (ra !== rb) return ra - rb
      // 最后一级：成员序。非成员（indexOf === -1）排到最后而不是最前 ——
      // 今天调用点恒来自 ticket 所以不可达，但让一个不在 cohort 里的人夺冠是个
      // 「接自定义管线时才现形」的隐式不变量
      return rank(this.members, a.botName) - rank(this.members, b.botName)
    })
    this.settledWinner = ranked[0]?.botName ?? null

    const losers: string[] = []
    for (const [botName, resolve] of this.waiters) {
      if (botName === this.settledWinner) {
        resolve({ won: true, winner: botName, reason: 'won' })
      } else {
        losers.push(botName)
        resolve({ won: false, winner: this.settledWinner ?? undefined, reason: 'lost' })
      }
    }
    this.waiters.clear()

    // 定局时仍未表态的成员：连意图都还没交，继续跑纯属烧钱 —— 交给宿主中止。
    // 已经 claim 的败者**不**中止：让脚本按 verdict.won === false 自己优雅收尾，
    // `say` 的强制点是它的兜底
    this.deps.onSettled?.({
      winner: this.settledWinner,
      losers,
      unresponsive: [...this.pending]
    })
  }

  private clearGrace(): void {
    if (!this.graceTimer) return
    ;(this.deps.clearTimer ?? clearTimeout)(this.graceTimer)
    this.graceTimer = null
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private setTimer(fn: () => void, ms: number): NodeJS.Timeout {
    return (this.deps.setTimer ?? setTimeout)(fn, ms)
  }
}
