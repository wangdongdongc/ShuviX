/**
 * 回退 fork（P3-10a，Mapping #2）的两块与会话状态无关的部件：
 *
 *  - **回退区段**（`RollbackSection`，PIN-22）：`op()` 只计数、不互斥，发送与回退会交错。回退独占
 *    （`exclusive`，彼此按到达次序串行），会**建锁或受理输入**的入口（发送 / steer / followUp / 继续 /
 *    建 agent / 通知 / 中止 / 思考档位）在受理阶段持共享（`enter`）—— 回退在途时新来的共享先等它做完；
 *    回退在动手之前等已经进来的共享走完（`drain`）。共享只覆盖到「受理落定」为止，从不覆盖等 run 落定：
 *    回退要中止的正是那个 run。不变式：存在的锁永远在当前对话上。
 *    共享区段里**不能**再调别的入口（嵌套的 `enter` 在回退等着时会死锁）—— 会话内部走不经区段的那一份。
 *  - **目标与 fork 点**（只读，PIN-19/20/24/25）：目标必须是当前对话里看得见的（fork 感知的历史）
 *    `pi.user` 条目；fork 点 = 目标本身（`keep`），否则当前对话里 id 比它小的最新条目（日期通知、压缩
 *    摘要照样可以是 fork 点）；一条都没有 → 没有前缀（建新对话）。
 *
 * 不依赖 Node / Electron。
 */
import { UserEntry, type Conversation, type EntryId } from '@earendil-works/pi-durable'
import { backgroundContext as BG } from './context'

// ─────────────────────────── 公共类型 ───────────────────────────

/** `rollbackTo` 的选项 */
export interface RollbackOptions {
  /**
   * true = 截断（保留目标那条用户消息本身，fork 在它上面）；缺省 false = 回退（目标也不在了，fork 在它
   * 之前那一条上）
   */
  keep?: boolean
}

/** 回退被拒的原因：目标不在当前对话里 / 不是用户消息 / 会话已关 */
export type RollbackRefusal = 'not_found' | 'invalid_target' | 'closed'

/**
 * `rollbackTo` 的结果（PIN-19）：成功 = 新的当前对话；被拒从不抛出（拒绝之前什么都没动）。
 */
export type RollbackResult =
  | { ok: true; conversationId: number }
  | { ok: false; reason: RollbackRefusal }

// ─────────────────────────── 回退区段（PIN-22） ───────────────────────────

export class RollbackSection {
  /** 回退的串行尾巴 */
  private tail: Promise<void> = Promise.resolve()
  /** 排着 / 在做的回退数 */
  private exclusives = 0
  /** 有回退排着或在做时的闸门：新来的共享等它 */
  private gate: Promise<void> | undefined
  private openGate: (() => void) | undefined
  /** 此刻持着的共享数 */
  private shared = 0
  private drainWaiters: (() => void)[] = []

  /** 进入共享区段（有回退排着 / 在做就先等）；返回幂等的释放函数 */
  async enter(): Promise<() => void> {
    while (this.gate !== undefined) await this.gate
    this.shared++
    let released = false
    return () => {
      if (released) return
      released = true
      this.shared--
      if (this.shared === 0) {
        const waiters = this.drainWaiters.splice(0)
        for (const resolve of waiters) resolve()
      }
    }
  }

  /**
   * 独占地做一件事（同步立起闸门：调用返回之前，之后的 `enter` 就已经要等了）。排在之前的回退之后；
   * `drain()` 等已经进来的共享全部走完。
   */
  exclusive<T>(work: (drain: () => Promise<void>) => Promise<T>): Promise<T> {
    if (this.exclusives++ === 0) {
      this.gate = new Promise<void>((resolve) => (this.openGate = resolve))
    }
    const run = this.tail.then(() => work(() => this.drain()))
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run.finally(() => {
      if (--this.exclusives === 0) {
        const open = this.openGate
        this.gate = undefined
        this.openGate = undefined
        open?.()
      }
    })
  }

  private drain(): Promise<void> {
    if (this.shared === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve))
  }
}

// ─────────────────────────── 目标与 fork 点（只读） ───────────────────────────

/**
 * 校验回退目标（PIN-20，只读）：当前对话的历史（fork 感知）里没有这个 id → `not_found`（不存在、在
 * 别的对话里、只在被放弃的分支上）；有但不是 `pi.user` → `invalid_target`（助手 / 工具结果 / 通知 /
 * 压缩……）。合格 → undefined。
 */
export async function rollbackTargetRefusal(
  conversation: Conversation,
  targetEntryId: number
): Promise<'not_found' | 'invalid_target' | undefined> {
  if (!Number.isSafeInteger(targetEntryId) || targetEntryId <= 0) return 'not_found'
  const id = targetEntryId as EntryId
  const page = await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BG)
  const entry = page.items[0]
  if (entry === undefined || entry.id !== id) return 'not_found'
  return entry.kind === UserEntry.kind ? undefined : 'invalid_target'
}

/**
 * fork 点（PIN-24/25）：`keep` → 目标本身；否则当前对话里 id 比目标小的最新条目（只看这个对话看得见的
 * 历史 —— 子对话的条目 id 虽然交错，却从不在里面）。undefined = 没有前缀。
 */
export async function rollbackForkPoint(
  conversation: Conversation,
  targetEntryId: number,
  keep: boolean
): Promise<EntryId | undefined> {
  if (keep) return targetEntryId as EntryId
  if (targetEntryId <= 1) return undefined
  const page = await conversation.entries(
    { maxEntryId: (targetEntryId - 1) as EntryId },
    1,
    undefined,
    BG
  )
  return page.items[0]?.id
}
