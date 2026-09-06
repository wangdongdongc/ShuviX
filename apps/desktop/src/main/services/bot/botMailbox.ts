/**
 * mailbox lane（设计 §5.6）—— **一个会话里一次只做一件事，按消息到达的次序**。
 * 会话是一对一的（一个会话绑定一个 bot），所以一个会话就是一条 lane，键即 sessionId。
 *
 * 它与引擎的重入策略是**两个粒度**：引擎重入管「要不要起 run」（run 级），mailbox 管
 * 「已经在跑的 run 什么时候进入独占临界区」（run 内）。内置管线因此声明
 * `concurrency: parallel` 让引擎重入彻底让位 —— 独占语义 100% 由这里提供，二者不打架。
 *
 * 意图段是并行的、任务段是串行的：这正是「意图并行、执行串行、不丢消息」。
 *
 * 四条纪律，每条都有代价换来的理由：
 *
 *  1. **排队序按 messageSeq，不是 acquire 时刻**。意图段并行意味着到达顺序天然乱序，
 *     按到达序排会让回复次序与消息次序错位（用户先问 A 后问 B，却先收到 B 的答复）。
 *  2. **深度护栏只合并不丢弃**。超深时把队头最老的连续若干项摘下来，它们的 seq 并进
 *     下一次授予的 `slot.superseded`；被合并者的 `acquire` **reject**（fail-closed）——
 *     resolve 带标记的话，一个不检查标记的自定义脚本会把同一件事做两遍，而 reject 让它
 *     以「run 失败」告终。这不违反「可见结局」不变式：那条消息的内容已经交给了授予者。
 *  3. **排队不计墙钟** —— 见 §12.1 的落地偏差：引擎的 run deadline 在起跑瞬间点火且没有
 *     延长接口，所以这里由宿主自己的 30min 计时器先于引擎的 40min 开火，归因永远正确
 *     （用户不会看到一条写着「超时」其实是排队的记录）。代价是执行段预算 = 2400s − 排队时长。
 *  4. **排队本身有上限** —— 即上面两条：深度上限（合并）与时间上限（中止）。
 */

/** 队列深度上限；超过即从队头合并 */
export const MAX_DEPTH = 8
/** 排队时间上限（30min）—— 严格早于内置管线声明的 40min run 墙钟 */
export const QUEUE_MAX_MS = 30 * 60 * 1000

export interface TurnSlot {
  /** 排队时长（ms），0 = 无人在前 */
  queuedMs: number
  /** 排队期间本 bot 自己在这个会话里说过话 —— 出队复核（M5′）的谓词 */
  selfReplied: boolean
  /** 因深度护栏被合并进本次授予的消息序（只合并不丢） */
  superseded: number[]
  /** 排队期间的会话切片 —— M4′ 恒为空，随窗口构建器（M5′）填实 */
  since: unknown[]
}

export interface QueueItem {
  ticketId: string
  messageSeq: number
  messageId: string
}

/** 被深度护栏合并时 `acquire` 抛出的错误 */
export class MailboxMergedError extends Error {
  readonly code = 'mailbox_merged'
  constructor(readonly intoSeq: number) {
    super(`superseded by a newer message (merged into seq ${intoSeq})`)
  }
}

/** 排队超过上限时抛出的错误 */
export class MailboxTimeoutError extends Error {
  readonly code = 'mailbox_timeout'
  constructor() {
    super('queued too long in the bot mailbox')
  }
}

/**
 * 会话被中止时排队者拿到的错误。
 *
 * **与超时分开**：把「会话被删了」转写成「你等太久了」，与仲裁那边把「慢」转写成「沉默」
 * 是同一类错误 —— 排查的人会去调排队上限，而真正发生的事是有人按了停止。
 */
export class MailboxAbortedError extends Error {
  readonly code = 'mailbox_aborted'
  constructor() {
    super('the session was aborted while queued')
  }
}

interface Waiter {
  item: QueueItem
  queuedAt: number
  superseded: number[]
  timer: NodeJS.Timeout | null
  resolve: (slot: TurnSlot) => void
  reject: (err: Error) => void
}

interface Lane {
  active: { item: QueueItem; grantedAt: number } | null
  /** 按 messageSeq 升序的有序插入，**不是 FIFO** */
  queue: Waiter[]
  /** 本 lane 的 bot 在本次授予期间是否已经说过话（出队复核的谓词） */
  repliedSeqs: Set<number>
}

export interface MailboxDeps {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (t: NodeJS.Timeout) => void
  /** 快照变化时通知（宿主广播 bot_mailbox） */
  onChange?: (key: string, snapshot: MailboxSnapshot) => void
  /** 合并 / 超时 / 授予时记决策 */
  onEvent?: (
    key: string,
    kind:
      | 'mailbox_queued'
      | 'mailbox_granted'
      | 'mailbox_merged'
      | 'mailbox_timeout'
      | 'mailbox_aborted',
    item: QueueItem,
    detail?: Record<string, unknown>
  ) => void
}

export interface MailboxSnapshot {
  active: { messageSeq: number; messageId: string } | null
  queued: Array<{ messageSeq: number; messageId: string; queuedAt: number }>
}

/** lane 键 —— 宿主自己的键空间，与引擎的 laneKey 无关。一个会话一条 lane，键就是 sessionId */
export function mailboxKey(sessionId: string): string {
  return sessionId
}

export class BotMailbox {
  private readonly lanes = new Map<string, Lane>()
  /** ticketId → 它占着的 lane 键（release 时反查） */
  private readonly heldBy = new Map<string, string>()

  constructor(private readonly deps: MailboxDeps = {}) {}

  /**
   * 取本 lane 的独占段。
   *
   * `acquireBare` 之后**必须**由宿主在 run 收尾时 `releaseByTicket` —— 脚本侧的
   * `turn(fn)` 作用域回调形式把这件事包掉了，「忘记释放」在那个 API 面上不可表达。
   */
  acquireBare(key: string, item: QueueItem): Promise<TurnSlot> {
    const lane = this.laneOf(key)
    const now = this.now()

    if (!lane.active) {
      lane.active = { item, grantedAt: now }
      this.heldBy.set(item.ticketId, key)
      this.deps.onEvent?.(key, 'mailbox_granted', item, { queuedMs: 0 })
      this.emit(key)
      return Promise.resolve(this.slot(lane, item, 0, []))
    }

    return new Promise<TurnSlot>((resolve, reject) => {
      const waiter: Waiter = {
        item,
        queuedAt: now,
        superseded: [],
        timer: null,
        resolve,
        reject
      }
      waiter.timer = this.setTimer(() => this.timeout(key, waiter), QUEUE_MAX_MS)
      // 有序插入：按 messageSeq 升序，而不是到达顺序
      const at = lane.queue.findIndex((w) => w.item.messageSeq > item.messageSeq)
      if (at < 0) lane.queue.push(waiter)
      else lane.queue.splice(at, 0, waiter)

      this.trim(key, lane)
      // depth 记 trim **之后**的真实队列长度 —— 满队时报 9 会让读日志的人以为上限没生效
      this.deps.onEvent?.(key, 'mailbox_queued', item, { depth: lane.queue.length })
      this.emit(key)
    })
  }

  /** 作用域回调形式：无论成败都释放 */
  async acquire<T>(key: string, item: QueueItem, fn: (slot: TurnSlot) => Promise<T>): Promise<T> {
    const slot = await this.acquireBare(key, item)
    try {
      return await fn(slot)
    } finally {
      this.releaseByTicket(item.ticketId)
    }
  }

  /** 释放（幂等）：由持有者的 ticketId 反查 lane */
  releaseByTicket(ticketId: string): void {
    const key = this.heldBy.get(ticketId)
    if (!key) return
    this.heldBy.delete(ticketId)
    const lane = this.lanes.get(key)
    if (!lane || lane.active?.item.ticketId !== ticketId) return
    // **不在这里置 repliedSeqs**：`selfReplied` 的契约是「我排队等着的这段时间里，我自己
    // 已经答过话了」。无条件置位会让输掉仲裁、脚本报错、say 被闸掉的回合统统染成 true，
    // 到 M5′ 的出队复核那里这个谓词就没有区分力了。唯一的置位口是 `noteReplied`（say 成功后）
    lane.active = null
    this.grantNext(key, lane)
    this.emit(key)
    this.gc(key, lane)
  }

  /** 记下「这个 bot 在本会话说过话」—— 出队复核的谓词材料 */
  noteReplied(key: string, messageSeq: number): void {
    this.laneOf(key).repliedSeqs.add(messageSeq)
  }

  snapshot(key: string): MailboxSnapshot {
    const lane = this.lanes.get(key)
    if (!lane) return { active: null, queued: [] }
    return {
      active: lane.active
        ? { messageSeq: lane.active.item.messageSeq, messageId: lane.active.item.messageId }
        : null,
      queued: lane.queue.map((w) => ({
        messageSeq: w.item.messageSeq,
        messageId: w.item.messageId,
        queuedAt: w.queuedAt
      }))
    }
  }

  /**
   * 单票中止（per-bot 停止，A2）：若该 ticket 还在某条 lane 里**排队**，摘下并以
   * MailboxAbortedError 拒绝 —— 引擎的 run 级 abort 唤不醒一个 await 在宿主 Promise 上
   * 的脚本，不在这里拒绝它就只能等到排队超时。
   *
   * **持有者（active）不在此处理**：它的 run 正被 AbortController 结束，独占段随脚本
   * 自身的 finally 释放（turn 的作用域回调形式），这里抢先清 active 反而会让下一个
   * 授予者与还没退完场的持有者并行进独占段。
   */
  abortTicket(ticketId: string): void {
    for (const [key, lane] of this.lanes) {
      const at = lane.queue.findIndex((w) => w.item.ticketId === ticketId)
      if (at < 0) continue
      const [w] = lane.queue.splice(at, 1)
      if (w.timer) this.clearTimer(w.timer)
      this.deps.onEvent?.(key, 'mailbox_aborted', w.item)
      w.reject(new MailboxAbortedError())
      this.emit(key)
      this.gc(key, lane)
      return
    }
  }

  /** 会话被中止：该会话 lane 的等待者立即失败 */
  abortSession(sessionId: string): void {
    for (const [key, lane] of [...this.lanes]) {
      if (key !== mailboxKey(sessionId)) continue
      for (const w of lane.queue.splice(0)) {
        if (w.timer) this.clearTimer(w.timer)
        this.deps.onEvent?.(key, 'mailbox_aborted', w.item)
        w.reject(new MailboxAbortedError())
      }
      if (lane.active) this.heldBy.delete(lane.active.item.ticketId)
      lane.active = null
      this.emit(key)
      this.gc(key, lane)
    }
  }

  private grantNext(key: string, lane: Lane): void {
    const next = lane.queue.shift()
    if (!next) return
    if (next.timer) this.clearTimer(next.timer)
    const queuedMs = this.now() - next.queuedAt
    lane.active = { item: next.item, grantedAt: this.now() }
    this.heldBy.set(next.item.ticketId, key)
    this.deps.onEvent?.(key, 'mailbox_granted', next.item, {
      queuedMs,
      superseded: next.superseded
    })
    next.resolve(this.slot(lane, next.item, queuedMs, next.superseded))
  }

  /** 深度护栏：只合并不丢弃 —— 队头最老的连续若干项并进下一个授予者 */
  private trim(key: string, lane: Lane): void {
    while (lane.queue.length > MAX_DEPTH) {
      const dropped = lane.queue.shift()!
      // 循环条件保证 shift 之后队列至少还有 MAX_DEPTH 个 —— into 必然存在。
      // 不为它写防御：那个分支永远测不到，而它的回退值会说出「你被合并进了你自己」
      const into = lane.queue[0]
      if (dropped.timer) this.clearTimer(dropped.timer)
      into.superseded.push(dropped.item.messageSeq, ...dropped.superseded)
      into.superseded.sort((a, b) => a - b)
      this.deps.onEvent?.(key, 'mailbox_merged', dropped.item, { intoSeq: into.item.messageSeq })
      dropped.reject(new MailboxMergedError(into.item.messageSeq))
    }
  }

  private timeout(key: string, waiter: Waiter): void {
    const lane = this.lanes.get(key)
    if (!lane) return
    const at = lane.queue.indexOf(waiter)
    if (at < 0) return
    lane.queue.splice(at, 1)
    this.deps.onEvent?.(key, 'mailbox_timeout', waiter.item)
    waiter.reject(new MailboxTimeoutError())
    this.emit(key)
  }

  private slot(lane: Lane, item: QueueItem, queuedMs: number, superseded: number[]): TurnSlot {
    return {
      queuedMs,
      // 排队期间本 bot 说过话（seq 比自己小的那些）—— M5′ 的出队复核据此决定要不要重判
      selfReplied: [...lane.repliedSeqs].some((seq) => seq < item.messageSeq),
      superseded,
      since: []
    }
  }

  private laneOf(key: string): Lane {
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { active: null, queue: [], repliedSeqs: new Set() }
      this.lanes.set(key, lane)
    }
    return lane
  }

  /** 空 lane 即删条目 —— 键是 sessionId，留 0 值条目会随会话数长起来 */
  private gc(key: string, lane: Lane): void {
    // 判据是「这条道闲下来了」，**不含 repliedSeqs** —— `releaseByTicket` 每次都会往里加一条，
    // 把它算进条件等于让 lane 永远删不掉（键是 sessionId，会随会话数长起来）。
    //
    // 连同 repliedSeqs 一起丢掉是对的：`selfReplied` 要回答的是「**我排队等着的这段时间里**，
    // 我自己是不是已经答过话了」—— 而闲道意味着下一个请求根本没排队，那个问题无从谈起。
    if (!lane.active && lane.queue.length === 0) this.lanes.delete(key)
  }

  private emit(key: string): void {
    this.deps.onChange?.(key, this.snapshot(key))
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private setTimer(fn: () => void, ms: number): NodeJS.Timeout {
    return (this.deps.setTimer ?? setTimeout)(fn, ms)
  }

  private clearTimer(t: NodeJS.Timeout): void {
    ;(this.deps.clearTimer ?? clearTimeout)(t)
  }
}
