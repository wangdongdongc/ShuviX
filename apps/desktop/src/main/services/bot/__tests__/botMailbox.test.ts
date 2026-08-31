/**
 * BotMailbox（设计 §5.6）的单测 —— 一个 bot 在一个会话里一次只做一件事，按消息到达的次序。
 *
 * 全程**假时钟**：30 分钟的排队上限与「授予即清定时器」是这个模块的两条时间语义，
 * 真定时器测不了。有序插入、深度合并、超时归因这三件事都只在这一层可见 ——
 * e2e 跑到的永远是「一个人排队」的顺路径。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  BotMailbox,
  MAX_DEPTH,
  MailboxMergedError,
  MailboxAbortedError,
  MailboxTimeoutError,
  QUEUE_MAX_MS,
  mailboxKey,
  type MailboxDeps,
  type QueueItem,
  type TurnSlot
} from '../botMailbox'

interface FakeTimer {
  id: number
  at: number
  fn: () => void
  cleared: boolean
}

interface FakeClock {
  timers: FakeTimer[]
  clearCalls: number[]
  deps: Required<Pick<MailboxDeps, 'now' | 'setTimer' | 'clearTimer'>>
  advance(ms: number): void
}

/** 可手动推进的假时钟；advance 只触发未被 clear 的定时器（与真定时器同语义） */
function makeClock(): FakeClock {
  let now = 0
  let seq = 0
  const timers: FakeTimer[] = []
  const clearCalls: number[] = []
  return {
    timers,
    clearCalls,
    deps: {
      now: () => now,
      setTimer: (fn: () => void, ms: number): NodeJS.Timeout => {
        const t: FakeTimer = { id: ++seq, at: now + ms, fn, cleared: false }
        timers.push(t)
        return t.id as unknown as NodeJS.Timeout
      },
      clearTimer: (handle: NodeJS.Timeout): void => {
        const id = handle as unknown as number
        clearCalls.push(id)
        const t = timers.find((x) => x.id === id)
        if (t) t.cleared = true
      }
    },
    advance(ms: number): void {
      now += ms
      for (const t of [...timers]) {
        if (!t.cleared && t.at <= now) {
          t.cleared = true
          t.fn()
        }
      }
    }
  }
}

type Event = { key: string; kind: string; item: QueueItem; detail?: Record<string, unknown> }

interface Harness {
  mb: BotMailbox
  clock: FakeClock
  events: Event[]
  changes: string[]
  key: string
}

function makeMailbox(): Harness {
  const clock = makeClock()
  const events: Event[] = []
  const changes: string[] = []
  const mb = new BotMailbox({
    ...clock.deps,
    onEvent: (key, kind, item, detail) => events.push({ key, kind, item, detail }),
    onChange: (key) => changes.push(key)
  })
  return { mb, clock, events, changes, key: mailboxKey('s1', 'bot') }
}

function item(seq: number, suffix = ''): QueueItem {
  return { ticketId: `t${seq}${suffix}`, messageSeq: seq, messageId: `m${seq}${suffix}` }
}

/** p 是否仍未落定（成败都算落定）—— 顺带把 rejection 接住，不留 unhandled */
async function isPending(p: Promise<unknown>): Promise<boolean> {
  const guarded = p.then(
    () => 'settled' as const,
    () => 'settled' as const
  )
  let sentinel: Promise<'pending'> = Promise.resolve('pending' as const)
  for (let i = 0; i < 8; i++) sentinel = sentinel.then((v) => v)
  return (await Promise.race([guarded, sentinel])) === 'pending'
}

/** 授予事件的 messageSeq 序列 */
function grantedSeqs(events: Event[]): number[] {
  return events.filter((e) => e.kind === 'mailbox_granted').map((e) => e.item.messageSeq)
}

describe('授予与释放', () => {
  it('空 lane 立即授予：queuedMs 0、无 superseded、不记排队事件', async () => {
    const { mb, events, key } = makeMailbox()
    const slot = await mb.acquireBare(key, item(1))

    expect(slot).toEqual({ queuedMs: 0, selfReplied: false, superseded: [], since: [] })
    expect(events.map((e) => e.kind)).toEqual(['mailbox_granted'])
    expect(events[0].detail).toEqual({ queuedMs: 0 })
  })

  it('占用中则排队：promise 挂起、depth 计入事件、snapshot 两头都有', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))

    expect(await isPending(queued)).toBe(true)
    expect(events.find((e) => e.kind === 'mailbox_queued')?.detail).toEqual({ depth: 1 })
    expect(mb.snapshot(key)).toMatchObject({
      active: { messageSeq: 1, messageId: 'm1' },
      queued: [{ messageSeq: 2, messageId: 'm2' }]
    })
  })

  it('release 自动 grantNext，并把排队时长交给下一位', async () => {
    const { mb, clock, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))

    clock.advance(500)
    mb.releaseByTicket('t1')
    expect((await queued).queuedMs).toBe(500)
  })

  it('release 幂等：同一 ticketId 连调两次不会越级授予', async () => {
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const second = mb.acquireBare(key, item(2))
    const third = mb.acquireBare(key, item(3))

    mb.releaseByTicket('t1')
    await second
    mb.releaseByTicket('t1')

    expect(await isPending(third)).toBe(true)
    expect(mb.snapshot(key).queued).toHaveLength(1)
  })

  it('未知 ticketId 的 release 是空操作', async () => {
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))

    expect(() => mb.releaseByTicket('nobody')).not.toThrow()
    expect(await isPending(queued)).toBe(true)
  })

  it('非持有者的 release 不抢别人的坑', async () => {
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    mb.abortSession('s1') // active 被清掉，t1 不再是持有者
    await mb.acquireBare(key, item(3))
    const queued = mb.acquireBare(key, item(4))

    mb.releaseByTicket('t1')
    expect(await isPending(queued)).toBe(true)
    expect(mb.snapshot(key).active).toMatchObject({ messageSeq: 3 })
  })

  it('acquire(fn)：成功与抛错都释放', async () => {
    const ok = makeMailbox()
    const okRun = ok.mb.acquire(ok.key, item(1), async () => 'done')
    const okNext = ok.mb.acquireBare(ok.key, item(2))
    await expect(okRun).resolves.toBe('done')
    await expect(okNext).resolves.toMatchObject({ queuedMs: 0 })

    const bad = makeMailbox()
    const badRun = bad.mb.acquire(bad.key, item(1), async () => {
      throw new Error('boom')
    })
    const badNext = bad.mb.acquireBare(bad.key, item(2))
    await expect(badRun).rejects.toThrow('boom')
    await expect(badNext).resolves.toMatchObject({ queuedMs: 0 })
  })

  it('acquireBare 失败时不执行 fn（错误直接外抛）', async () => {
    const { mb, clock, key } = makeMailbox()
    const fn = vi.fn(async () => 'never')
    await mb.acquireBare(key, item(1))
    const run = mb.acquire(key, item(2), fn)

    clock.advance(QUEUE_MAX_MS)
    await expect(run).rejects.toBeInstanceOf(MailboxTimeoutError)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('有序插入', () => {
  it('按 messageSeq 授予，而不是到达序', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const p5 = mb.acquireBare(key, item(5))
    const p3 = mb.acquireBare(key, item(3))
    const p4 = mb.acquireBare(key, item(4))

    mb.releaseByTicket('t0')
    await p3
    mb.releaseByTicket('t3')
    await p4
    mb.releaseByTicket('t4')
    await p5

    expect(grantedSeqs(events)).toEqual([0, 3, 4, 5])
  })

  it('更小的 seq 插到队头', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    void mb.acquireBare(key, item(9))
    const p2 = mb.acquireBare(key, item(2))

    mb.releaseByTicket('t0')
    await p2
    expect(grantedSeqs(events)).toEqual([0, 2])
  })

  it('相等 seq 排在既有同 seq 之后（findIndex 是严格大于）', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const first = mb.acquireBare(key, item(5, 'a'))
    void mb.acquireBare(key, item(5, 'b'))

    mb.releaseByTicket('t0')
    await first
    expect(events.filter((e) => e.kind === 'mailbox_granted').at(-1)?.item.messageId).toBe('m5a')
  })

  it('snapshot().queued 是 seq 序而非到达序', async () => {
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    for (const seq of [5, 3, 4]) void mb.acquireBare(key, item(seq))

    expect(mb.snapshot(key).queued.map((q) => q.messageSeq)).toEqual([3, 4, 5])
  })
})

describe('深度护栏', () => {
  /** 占位 + 填满队列到 depth 个等待者；返回它们的 promise（已接住 rejection） */
  function fill(mb: BotMailbox, key: string, seqs: number[]): Array<Promise<TurnSlot>> {
    return seqs.map((seq) => {
      const p = mb.acquireBare(key, item(seq))
      p.catch(() => {})
      return p
    })
  }

  it('恰好 MAX_DEPTH 不合并', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const queued = fill(
      mb,
      key,
      Array.from({ length: MAX_DEPTH }, (_, i) => i + 1)
    )

    for (const p of queued) expect(await isPending(p)).toBe(true)
    expect(events.some((e) => e.kind === 'mailbox_merged')).toBe(false)
  })

  it('超一格：队头最老者被合并并 reject', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const queued = fill(
      mb,
      key,
      Array.from({ length: MAX_DEPTH + 1 }, (_, i) => i + 1)
    )

    await expect(queued[0]).rejects.toMatchObject({
      code: 'mailbox_merged',
      intoSeq: 2
    })
    await expect(queued[0]).rejects.toBeInstanceOf(MailboxMergedError)
    expect(events.find((e) => e.kind === 'mailbox_merged')).toMatchObject({
      item: { messageSeq: 1 },
      detail: { intoSeq: 2 }
    })
  })

  it('被合并者的 seq 交给下一个授予者（升序）', async () => {
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const queued = fill(
      mb,
      key,
      Array.from({ length: MAX_DEPTH + 1 }, (_, i) => i + 1)
    )
    await expect(queued[0]).rejects.toBeInstanceOf(MailboxMergedError)

    mb.releaseByTicket('t0')
    expect((await queued[1]).superseded).toEqual([1])
  })

  it('连锁合并累加且排序', async () => {
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const queued = fill(
      mb,
      key,
      Array.from({ length: MAX_DEPTH + 2 }, (_, i) => i + 1)
    )
    await expect(queued[0]).rejects.toBeInstanceOf(MailboxMergedError)
    await expect(queued[1]).rejects.toBeInstanceOf(MailboxMergedError)

    mb.releaseByTicket('t0')
    expect((await queued[2]).superseded).toEqual([1, 2])
  })

  it('被合并者的超时定时器被清除（不会再被 reject 一次）', async () => {
    const { mb, clock, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const queued = fill(
      mb,
      key,
      Array.from({ length: MAX_DEPTH + 1 }, (_, i) => i + 1)
    )
    await expect(queued[0]).rejects.toBeInstanceOf(MailboxMergedError)
    expect(clock.clearCalls).toHaveLength(1)

    clock.advance(QUEUE_MAX_MS)
    expect(
      events.filter((e) => e.kind === 'mailbox_timeout').map((e) => e.item.messageSeq)
    ).not.toContain(1)
  })

  it('合并的是队头最老者，哪怕它就是刚插进来的那个', async () => {
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    fill(
      mb,
      key,
      Array.from({ length: MAX_DEPTH }, (_, i) => i + 10)
    )
    const newest = mb.acquireBare(key, item(1))

    await expect(newest).rejects.toMatchObject({ code: 'mailbox_merged', intoSeq: 10 })
  })

  it('mailbox_queued 的 depth 是 trim 之后的真实队列长度', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    fill(
      mb,
      key,
      Array.from({ length: MAX_DEPTH + 1 }, (_, i) => i + 1)
    )

    // 满队时报 MAX_DEPTH+1 会让读日志的人以为上限没生效 —— depth 与 snapshot 必须对得上
    const depths = events.filter((e) => e.kind === 'mailbox_queued').map((e) => e.detail?.depth)
    expect(depths.at(-1)).toBe(MAX_DEPTH)
    expect(mb.snapshot(key).queued).toHaveLength(MAX_DEPTH)
  })
})

describe('排队超时', () => {
  it('到 QUEUE_MAX_MS 即 reject 并出队', async () => {
    const { mb, clock, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))

    clock.advance(QUEUE_MAX_MS)
    await expect(queued).rejects.toMatchObject({ code: 'mailbox_timeout' })
    await expect(queued).rejects.toBeInstanceOf(MailboxTimeoutError)
    expect(events.some((e) => e.kind === 'mailbox_timeout')).toBe(true)
    expect(mb.snapshot(key).queued).toHaveLength(0)
  })

  it('已被授予者不会再超时', async () => {
    const { mb, clock, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))
    mb.releaseByTicket('t1')
    await queued

    clock.advance(QUEUE_MAX_MS * 2)
    expect(events.some((e) => e.kind === 'mailbox_timeout')).toBe(false)
  })

  it('中间者超时不打乱其余顺序', async () => {
    const { mb, clock, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const doomed = mb.acquireBare(key, item(2)) // 最早排队 → 最早到期
    doomed.catch(() => {})
    clock.advance(1000)
    const p1 = mb.acquireBare(key, item(1))
    const p3 = mb.acquireBare(key, item(3))

    clock.advance(QUEUE_MAX_MS - 1000)
    await expect(doomed).rejects.toBeInstanceOf(MailboxTimeoutError)

    mb.releaseByTicket('t0')
    await p1
    mb.releaseByTicket('t1')
    await p3
    expect(grantedSeqs(events)).toEqual([0, 1, 3])
  })
})

describe('selfReplied', () => {
  it('首次授予恒为 false', async () => {
    const { mb, key } = makeMailbox()
    expect((await mb.acquireBare(key, item(7))).selfReplied).toBe(false)
  })

  it('noteReplied 之后：严格小于才算', async () => {
    const bigger = makeMailbox()
    bigger.mb.noteReplied(bigger.key, 5)
    expect((await bigger.mb.acquireBare(bigger.key, item(7))).selfReplied).toBe(true)

    const smaller = makeMailbox()
    smaller.mb.noteReplied(smaller.key, 5)
    expect((await smaller.mb.acquireBare(smaller.key, item(3))).selfReplied).toBe(false)
  })

  it('相等的 seq 不算（那是「我这一轮」，不是「排队期间」）', async () => {
    const { mb, key } = makeMailbox()
    mb.noteReplied(key, 5)
    expect((await mb.acquireBare(key, item(5))).selfReplied).toBe(false)
  })

  it('从未说过话的释放不置位：selfReplied 只认 noteReplied（说出口才算）', async () => {
    // 契约是「排队期间本 bot **说过话**」（M5′ 出队复核的谓词）。若 releaseByTicket 无条件
    // 置位，它就退化成「这条 lane 之前有人占过」—— 输掉仲裁、脚本报错、say 被闸掉的回合
    // 统统会把它染成 true，到 M5′ 那里这个谓词就没有区分力了
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))
    mb.releaseByTicket('t1') // 全程没有 noteReplied

    expect((await queued).selfReplied).toBe(false)
  })
})

describe('abortSession / lane 生命周期', () => {
  it('只清本会话的 lane（s1 不误伤 s10）', async () => {
    const { mb } = makeMailbox()
    const k1 = mailboxKey('s1', 'bot')
    const k10 = mailboxKey('s10', 'bot')
    const k2 = mailboxKey('s2', 'bot')
    for (const [i, k] of [k1, k10, k2].entries()) {
      await mb.acquireBare(k, item(i * 10 + 1))
    }
    const q1 = mb.acquireBare(k1, item(2))
    q1.catch(() => {})
    const q10 = mb.acquireBare(k10, item(12))
    const q2 = mb.acquireBare(k2, item(22))

    mb.abortSession('s1')
    await expect(q1).rejects.toBeInstanceOf(MailboxAbortedError)
    expect(await isPending(q10)).toBe(true)
    expect(await isPending(q2)).toBe(true)
    expect(mb.snapshot(k10).active).not.toBeNull()
  })

  it('中止用 MailboxAbortedError 并记 mailbox_aborted（「被停掉」不是「等太久」）', async () => {
    // 把「会话被删了」转写成「你等太久了」，排查的人会去调排队上限，
    // 而真正发生的事是有人按了停止
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))

    mb.abortSession('s1')
    await expect(queued).rejects.toMatchObject({ code: 'mailbox_aborted' })
    expect(events.some((e) => e.kind === 'mailbox_aborted')).toBe(true)
    expect(events.some((e) => e.kind === 'mailbox_timeout')).toBe(false)
  })

  it('中止清掉排队者的定时器（之后推进时钟不会二次 reject）', async () => {
    const { mb, clock, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))
    mb.abortSession('s1')
    await expect(queued).rejects.toBeInstanceOf(MailboxAbortedError)

    expect(clock.clearCalls).toHaveLength(1)
    clock.advance(QUEUE_MAX_MS)
    expect(events.some((e) => e.kind === 'mailbox_timeout')).toBe(false)
  })

  it('中止后 lane 消失：说过话的痕迹不会串到下一轮', async () => {
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    mb.noteReplied(key, 1)
    mb.abortSession('s1')

    expect((await mb.acquireBare(key, item(5))).selfReplied).toBe(false)
  })

  it('释放后空 lane 被回收：同 key 的下一次 acquire 从 false 起步', async () => {
    // gc 的判据是「这条道闲下来了」，不含 repliedSeqs —— 否则任何正常释放过一次的 lane
    // 都永远删不掉，而键含 sessionId+botName，长跑进程里会真的长起来
    const { mb, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    mb.releaseByTicket('t1')

    expect((await mb.acquireBare(key, item(2))).selfReplied).toBe(false)
  })
})

/**
 * abortTicket —— per-bot 停止的 mailbox 半边（A2，设计 §5.4）。
 *
 * 它只处理**还在排队**的票（引擎的 run 级 abort 唤不醒 await 在宿主 Promise 上的脚本），
 * 对 ACTIVE 持有者刻意 no-op：那个 run 正被 AbortController 结束，独占段随脚本自身的
 * finally 释放 —— 这里抢先清 active 会让下一个授予者与还没退完场的持有者并行进独占段。
 */
describe('abortTicket —— per-bot 停止（A2）', () => {
  it('A2-B1 命中排队票：MailboxAbortedError reject、出队、mailbox_aborted 恰一次、快照更新', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))

    mb.abortTicket('t2')
    await expect(queued).rejects.toBeInstanceOf(MailboxAbortedError)
    await expect(queued).rejects.toMatchObject({ code: 'mailbox_aborted' })
    expect(events.filter((e) => e.kind === 'mailbox_aborted')).toHaveLength(1)
    expect(events.find((e) => e.kind === 'mailbox_aborted')?.item.messageSeq).toBe(2)
    // 快照同步更新：active 原地不动，队列已经空了
    expect(mb.snapshot(key)).toEqual({ active: { messageSeq: 1, messageId: 'm1' }, queued: [] })
  })

  it('A2-B2 命中 ACTIVE 持有者：完全 no-op（active 不清、队列不动、零事件、不越级授予）', async () => {
    // 抢先清 active 的后果是下一个授予者与还没退完场的持有者并行进独占段 ——
    // 三个断言面（active / 队列+事件 / 排队 promise 仍挂起）一起钉死这个 no-op
    const { mb, events, changes, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))
    const eventCount = events.length
    const changeCount = changes.length

    mb.abortTicket('t1')

    expect(mb.snapshot(key).active).toEqual({ messageSeq: 1, messageId: 'm1' })
    expect(mb.snapshot(key).queued.map((q) => q.messageSeq)).toEqual([2])
    expect(events).toHaveLength(eventCount)
    expect(changes).toHaveLength(changeCount)
    // 不越级授予：排队者仍然挂着，没有因为一次「停止持有者」而被提前放进独占段
    expect(await isPending(queued)).toBe(true)
  })

  it('A2-B3 未知 ticketId：no-op、零事件', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))
    const eventCount = events.length

    expect(() => mb.abortTicket('nobody')).not.toThrow()
    expect(events).toHaveLength(eventCount)
    expect(await isPending(queued)).toBe(true)
    expect(mb.snapshot(key).queued).toHaveLength(1)
  })

  it('A2-B4 被中止票的超时定时器被清：推过 QUEUE_MAX_MS 无二次 reject / timeout 事件', async () => {
    const { mb, clock, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    const queued = mb.acquireBare(key, item(2))

    mb.abortTicket('t2')
    await expect(queued).rejects.toBeInstanceOf(MailboxAbortedError)
    expect(clock.clearCalls).toHaveLength(1)

    clock.advance(QUEUE_MAX_MS)
    expect(events.some((e) => e.kind === 'mailbox_timeout')).toBe(false)
    expect(events.filter((e) => e.kind === 'mailbox_aborted')).toHaveLength(1)
  })

  it('A2-B5 中止队列中间一票：其余按 messageSeq 的授予序不变', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(0))
    const p1 = mb.acquireBare(key, item(1))
    const p2 = mb.acquireBare(key, item(2))
    p2.catch(() => {})
    const p3 = mb.acquireBare(key, item(3))

    mb.abortTicket('t2')
    await expect(p2).rejects.toBeInstanceOf(MailboxAbortedError)

    mb.releaseByTicket('t0')
    await p1
    mb.releaseByTicket('t1')
    await p3
    expect(grantedSeqs(events)).toEqual([0, 1, 3])
  })

  it('A2-B6 中止唯一排队票后持有者 release：无越级授予、lane 被 gc（selfReplied 从 false 起步）', async () => {
    const { mb, events, key } = makeMailbox()
    await mb.acquireBare(key, item(1))
    mb.noteReplied(key, 1)
    const queued = mb.acquireBare(key, item(2))

    mb.abortTicket('t2')
    await expect(queued).rejects.toBeInstanceOf(MailboxAbortedError)
    mb.releaseByTicket('t1')

    // 队列已空，release 只清 active —— 不会把早已 reject 的那张票再授予一次
    expect(events.filter((e) => e.kind === 'mailbox_granted')).toHaveLength(1)
    // lane 已被 gc：repliedSeqs 随 lane 一起丢弃，同 key 的下一次 acquire 从 false 起步
    expect((await mb.acquireBare(key, item(9))).selfReplied).toBe(false)
  })
})
