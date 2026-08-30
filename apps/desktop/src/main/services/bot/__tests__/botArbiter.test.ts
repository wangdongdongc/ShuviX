/**
 * CohortBarrier（设计 §7）的单测 —— 一条用户消息只该有一个回复者。
 *
 * 全程**假时钟**（deps 注入 now/setTimer/clearTimer）：宽限窗是这个模块唯一的时间语义，
 * 用真定时器测它意味着每条用例白等 3 秒，还会把「窗有没有起」这个真正的判据糊成 flaky。
 * 定时器的**建立次数**因此和定局结果一样是被断言的对象：「首个非 ignore 候选到达时才起窗」
 * 这条纪律，只有数 setTimer 才看得见。
 */
import { describe, it, expect, vi } from 'vitest'
import { CohortBarrier, GRACE_MS, type ClaimIntent, type ClaimVerdict } from '../botArbiter'

interface FakeTimer {
  id: number
  at: number
  fn: () => void
  cleared: boolean
}

interface FakeClock {
  timers: FakeTimer[]
  /** 每次 setTimer 的 ms —— 「窗有没有起」只有数它才看得见 */
  setCalls: number[]
  clearCalls: number[]
  deps: {
    now: () => number
    setTimer: (fn: () => void, ms: number) => NodeJS.Timeout
    clearTimer: (handle: NodeJS.Timeout) => void
  }
  advance(ms: number): void
  fireAll(): void
}

/** 可手动推进的假时钟：记录每次 setTimer/clearTimer，advance 只触发未被 clear 的 */
function makeClock(): FakeClock {
  let now = 0
  let seq = 0
  const timers: FakeTimer[] = []
  const setCalls: number[] = []
  const clearCalls: number[] = []
  return {
    timers,
    setCalls,
    clearCalls,
    deps: {
      now: () => now,
      setTimer: (fn: () => void, ms: number): NodeJS.Timeout => {
        const t: FakeTimer = { id: ++seq, at: now + ms, fn, cleared: false }
        timers.push(t)
        setCalls.push(ms)
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
    },
    /** 手动触发全部回调，**包括已被 clear 的** —— 钉「定局后回调是空操作」 */
    fireAll(): void {
      for (const t of [...timers]) t.fn()
    }
  }
}

type Settled = { winner: string | null; losers: string[]; unresponsive: string[] }

function makeBarrier(members: string[]): {
  barrier: CohortBarrier
  clock: FakeClock
  settled: Settled[]
  onSettled: ReturnType<typeof vi.fn>
} {
  const clock = makeClock()
  const settled: Settled[] = []
  const onSettled = vi.fn((r: Settled) => {
    settled.push(r)
  })
  const barrier = new CohortBarrier(members, { ...clock.deps, onSettled })
  return { barrier, clock, settled, onSettled }
}

function intent(decision: ClaimIntent['decision'], relevance = 5): ClaimIntent {
  return { decision, relevance }
}

const PENDING = Symbol('pending')

/** p 若在微任务层面已落定就返回它的值，否则返回 PENDING */
async function outcome(p: Promise<ClaimVerdict>): Promise<ClaimVerdict | typeof PENDING> {
  let sentinel: Promise<typeof PENDING> = Promise.resolve(PENDING)
  for (let i = 0; i < 8; i++) sentinel = sentinel.then((v) => v)
  return await Promise.race([p, sentinel])
}

describe('solo —— cohort 退化为常量', () => {
  it('单成员：建立即定局，且不起任何定时器', () => {
    const { barrier, clock } = makeBarrier(['a'])
    expect(barrier.isSolo).toBe(true)
    expect(barrier.isSettled).toBe(true)
    expect(barrier.winner).toBe('a')
    expect(clock.setCalls).toHaveLength(0)
  })

  it('claim 同步返回 solo/won，全程零定时器', async () => {
    const { barrier, clock } = makeBarrier(['a'])
    await expect(barrier.claim('a', intent('reply'))).resolves.toEqual({
      won: true,
      winner: 'a',
      reason: 'solo'
    })
    expect(clock.setCalls).toHaveLength(0)
  })

  it('solo 下 decision: ignore 仍判 won（F-5：solo 不看 intent）', async () => {
    // 1:1 会话里「不说话」只能靠脚本自己不调 say —— 内置管线若改成看 verdict.won
    // 决定要不要 say，就会连 ignore 一起漏掉
    const { barrier } = makeBarrier(['a'])
    await expect(barrier.claim('a', intent('ignore', 9))).resolves.toMatchObject({
      won: true,
      reason: 'solo'
    })
  })

  it('solo 从不触发 onSettled', async () => {
    const { barrier, onSettled } = makeBarrier(['a'])
    await barrier.claim('a', intent('reply'))
    expect(onSettled).not.toHaveBeenCalled()
  })
})

describe('ignore —— 立即返回且永不参与评分', () => {
  it('高 relevance 的 ignore 者不夺冠', async () => {
    const { barrier } = makeBarrier(['a', 'b', 'c'])
    const va = await barrier.claim('a', intent('ignore', 9))
    expect(va).toEqual({ won: false, reason: 'ignored' })

    const pb = barrier.claim('b', intent('reply', 1))
    const pc = barrier.claim('c', intent('reply', 0))
    expect(await pb).toMatchObject({ won: true, reason: 'won' })
    expect(await pc).toMatchObject({ won: false, winner: 'b', reason: 'lost' })
  })

  it('全员 ignore：不起宽限窗、当场定局', async () => {
    const { barrier, clock, settled } = makeBarrier(['a', 'b'])
    await barrier.claim('a', intent('ignore'))
    await barrier.claim('b', intent('ignore'))

    expect(clock.setCalls).toHaveLength(0)
    expect(settled).toEqual([{ winner: null, losers: [], unresponsive: [] }])
  })

  it('定局之后才到的 ignore 记 timeout（F-6：settled 分支先于 ignore 分支）', async () => {
    const { barrier, clock } = makeBarrier(['a', 'b', 'c'])
    const pa = barrier.claim('a', intent('reply', 5))
    clock.advance(GRACE_MS)
    await pa

    await expect(barrier.claim('c', intent('ignore', 0))).resolves.toEqual({
      won: false,
      winner: 'a',
      reason: 'timeout'
    })
  })
})

describe('宽限窗', () => {
  it('首个非 ignore 候选才起窗，窗长为 GRACE_MS', async () => {
    const { barrier, clock } = makeBarrier(['a', 'b', 'c'])
    await barrier.claim('a', intent('ignore'))
    expect(clock.setCalls).toHaveLength(0)

    void barrier.claim('b', intent('reply'))
    expect(clock.setCalls).toEqual([GRACE_MS])
  })

  it('后续候选不重启、不叠加定时器', async () => {
    const { barrier, clock } = makeBarrier(['a', 'b', 'c', 'd'])
    await barrier.claim('a', intent('ignore'))
    void barrier.claim('b', intent('reply'))
    void barrier.claim('c', intent('reply'))
    expect(clock.setCalls).toEqual([GRACE_MS])
  })

  it('末位成员是首个候选时不起窗，且只 settle 一次', async () => {
    // pending.delete 先于起窗判断：`candidates.size === 1 && pending.size > 0` 这个合取
    // 正好挡住「首个候选就是最后一个表态者」—— 不起窗，紧随的 maybeSettle 定局一次
    const { barrier, clock, onSettled } = makeBarrier(['a', 'b'])
    await barrier.claim('a', intent('ignore'))
    await expect(barrier.claim('b', intent('reply'))).resolves.toMatchObject({ won: true })

    expect(clock.setCalls).toHaveLength(0)
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('定局之后定时器回调是空操作', async () => {
    const { barrier, clock, onSettled } = makeBarrier(['a', 'b', 'c'])
    void barrier.claim('a', intent('reply', 5))
    void barrier.claim('b', intent('reply', 4))
    await barrier.claim('c', intent('reply', 3))
    expect(onSettled).toHaveBeenCalledTimes(1)

    clock.fireAll() // 手动触发已被 clear 的那个回调
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('窗到期定局，未表态者进 unresponsive', async () => {
    const { barrier, clock, settled } = makeBarrier(['a', 'b'])
    const pa = barrier.claim('a', intent('reply', 5))
    clock.advance(GRACE_MS)

    await expect(pa).resolves.toEqual({ won: true, winner: 'a', reason: 'won' })
    expect(settled).toEqual([{ winner: 'a', losers: [], unresponsive: ['b'] }])
  })
})

describe('评分矩阵', () => {
  it('relevance 降序压过 decision（reply@7 胜 task@3）', async () => {
    const { barrier } = makeBarrier(['a', 'b'])
    const pa = barrier.claim('a', intent('reply', 7))
    const pb = barrier.claim('b', intent('task', 3))
    expect(await pa).toMatchObject({ won: true })
    expect(await pb).toMatchObject({ won: false, winner: 'a', reason: 'lost' })
  })

  it('同分按 decision 序 task < clarify < reply', async () => {
    const three = makeBarrier(['a', 'b', 'c'])
    void three.barrier.claim('a', intent('reply', 5))
    void three.barrier.claim('b', intent('clarify', 5))
    await three.barrier.claim('c', intent('task', 5))
    expect(three.barrier.winner).toBe('c')

    const two = makeBarrier(['a', 'b'])
    void two.barrier.claim('a', intent('reply', 5))
    await two.barrier.claim('b', intent('clarify', 5))
    expect(two.barrier.winner).toBe('b')
  })

  it('同分同 decision 按成员序，与到达序无关', async () => {
    const { barrier } = makeBarrier(['b', 'a'])
    void barrier.claim('a', intent('reply', 5)) // a 先到
    await barrier.claim('b', intent('reply', 5))
    expect(barrier.winner).toBe('b')
  })

  it('全部等待者都被 resolve：胜者 won、败者 lost', async () => {
    const { barrier } = makeBarrier(['a', 'b', 'c'])
    const all = Promise.all([
      barrier.claim('a', intent('reply', 9)),
      barrier.claim('b', intent('reply', 1)),
      barrier.claim('c', intent('reply', 0))
    ])
    expect(await all).toEqual([
      { won: true, winner: 'a', reason: 'won' },
      { won: false, winner: 'a', reason: 'lost' },
      { won: false, winner: 'a', reason: 'lost' }
    ])
  })
})

describe('迟到 / 中止 / 误用', () => {
  it('定局后首次 claim 记 timeout 而不是 ignored', async () => {
    const { barrier, clock } = makeBarrier(['a', 'b'])
    const pa = barrier.claim('a', intent('reply', 5))
    clock.advance(GRACE_MS)
    await pa

    await expect(barrier.claim('b', intent('reply', 9))).resolves.toEqual({
      won: false,
      winner: 'a',
      reason: 'timeout'
    })
  })

  it('onSettled 的三个集合互斥且完整', async () => {
    const { barrier, clock, settled } = makeBarrier(['a', 'b', 'c'])
    void barrier.claim('a', intent('reply', 5))
    void barrier.claim('b', intent('reply', 3))
    clock.advance(GRACE_MS)

    const r = settled[0]
    expect(r).toEqual({ winner: 'a', losers: ['b'], unresponsive: ['c'] })
    expect(r.losers).not.toContain(r.winner)
    expect(r.unresponsive).not.toContain(r.winner)
    expect([...r.losers, ...r.unresponsive].sort()).toEqual(['b', 'c'])
  })

  it('abort 前的等待者拿 aborted，且宽限窗被清', async () => {
    const { barrier, clock } = makeBarrier(['a', 'b'])
    const pa = barrier.claim('a', intent('reply'))
    expect(clock.setCalls).toHaveLength(1)

    barrier.abort()
    await expect(pa).resolves.toEqual({ won: false, reason: 'aborted' })
    expect(clock.clearCalls).toHaveLength(1)
  })

  it('abort 后再 abort / 已定局后 abort 都是空操作', async () => {
    const { barrier, onSettled } = makeBarrier(['a', 'b'])
    void barrier.claim('a', intent('reply', 5))
    await barrier.claim('b', intent('reply', 1))
    expect(onSettled).toHaveBeenCalledTimes(1)

    barrier.abort()
    barrier.abort()
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('abort 之后的 claim 返回 aborted（「被停掉」不是「你太慢」）', async () => {
    // 写成 timeout 会让排查的人去调宽限窗，而实际是有人按了停止 ——
    // settled 分支据 closedBy 分辨自己是被 abort() 还是被 settle() 关的
    const { barrier } = makeBarrier(['a', 'b'])
    barrier.abort()
    await expect(barrier.claim('a', intent('reply'))).resolves.toEqual({
      won: false,
      reason: 'aborted'
    })
  })

  it('同一 bot 二次 claim 直接抛（第一个 Promise 若被覆盖会永不落定）', async () => {
    // waiters 是 Map<botName, resolve>，二次 claim 会覆盖旧 resolve —— 第一个 await
    // 从此永不落定，run 挂到引擎墙钟才收，而 say 的三道闸都拦不住「卡住」。
    // 所以当脚本 bug 抛，与 asClaimIntent 同策
    const { barrier } = makeBarrier(['a', 'b'])
    const first = barrier.claim('a', intent('reply', 9))
    expect(() => barrier.claim('a', intent('reply', 9))).toThrow(/twice/)

    await barrier.claim('b', intent('reply', 1))
    expect(await outcome(first)).toMatchObject({ won: true, reason: 'won' })
  })

  it('非成员 claim 排到最后，夺不了冠', async () => {
    // 今天调用点恒来自 ticket 所以不可达，但让一个不在 cohort 里的人夺冠，
    // 是那种「以后接自定义管线时才现形」的隐式不变量
    const { barrier, clock } = makeBarrier(['a', 'b'])
    const outsider = barrier.claim('x', intent('reply', 5))
    const pa = barrier.claim('a', intent('reply', 5))
    clock.advance(GRACE_MS)

    expect(await pa).toMatchObject({ won: true, winner: 'a', reason: 'won' })
    expect(await outsider).toMatchObject({ won: false, winner: 'a', reason: 'lost' })
  })
})
