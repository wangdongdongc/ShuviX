/**
 * CohortBarrier（设计 §7）的单测 —— 一条用户消息只该有一个回复者。
 *
 * 全程**假时钟**（deps 注入 now/setTimer/clearTimer）：宽限窗是这个模块唯一的时间语义，
 * 用真定时器测它意味着每条用例白等 3 秒，还会把「窗有没有起」这个真正的判据糊成 flaky。
 * 定时器的**建立次数**因此和定局结果一样是被断言的对象：「首个非 ignore 候选到达时才起窗」
 * 这条纪律，只有数 setTimer 才看得见。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  CohortBarrier,
  GRACE_MS,
  type ClaimIntent,
  type ClaimVerdict,
  type SuppressedIntent
} from '../botArbiter'

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

type Settled = {
  winner: string | null
  suppressed: SuppressedIntent[]
  unresponsive: string[]
}

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
    expect(settled).toEqual([{ winner: null, suppressed: [], unresponsive: [] }])
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
    expect(settled).toEqual([{ winner: 'a', suppressed: [], unresponsive: ['b'] }])
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
    expect(r).toEqual({
      winner: 'a',
      suppressed: [{ botName: 'b', decision: 'reply', relevance: 3 }],
      unresponsive: ['c']
    })
    expect(r.suppressed.map((s) => s.botName)).not.toContain(r.winner)
    expect(r.unresponsive).not.toContain(r.winner)
    expect([...r.suppressed.map((s) => s.botName), ...r.unresponsive].sort()).toEqual(['b', 'c'])
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

/**
 * 落败的候选连同它本来想做的事 —— 救济 chip（「XX 也想回答」）唯一的数据源。
 *
 * 这一节钉的全是**名单本身的形状**，因为宿主对它是纯搬运：`dispatchCohort` 只把
 * botName 换成落树当时的 displayName 就原样存进署名侧车。次序、成员资格、字段有无
 * 一旦在这里错了，UI 上就是「差一点赢的排在最后」「自己说不接的被写成想回答」，
 * 而那时已经没有任何一层能把它纠回来。
 */
describe('被压制候选名单 —— 救济面的数据源', () => {
  it('名单按排名而不是按到达序（到达序会给出相反的答案）', () => {
    // 到达序是网络抖动，不是任何有意义的顺序。candidates 是 Map，遍历它拿到的就是
    // 到达序 —— 这条用例把两者刻意排成互相矛盾的形状：到达 c→a→b，排名 a>b>c
    const { barrier, settled } = makeBarrier(['a', 'b', 'c'])
    void barrier.claim('c', intent('reply', 2))
    void barrier.claim('a', intent('reply', 9))
    void barrier.claim('b', intent('task', 7)) // 全员表态即刻定局

    expect(barrier.winner).toBe('a')
    expect(settled[0].suppressed).toEqual([
      { botName: 'b', decision: 'task', relevance: 7 },
      { botName: 'c', decision: 'reply', relevance: 2 }
    ])
  })

  it('同分时名单次序也走 task > clarify > reply，最后才是成员序', () => {
    // 名单序与胜负判定共用同一个 ranked 数组 —— 「谁差一点赢」和「谁赢了」必须是
    // 同一把尺子量出来的，否则 chip 的顺序会与用户看到的结果自相矛盾
    const { barrier, settled } = makeBarrier(['a', 'b', 'c', 'd'])
    void barrier.claim('a', intent('reply', 9))
    void barrier.claim('b', intent('reply', 5))
    void barrier.claim('c', intent('task', 5))
    void barrier.claim('d', intent('clarify', 5))

    expect(barrier.winner).toBe('a')
    expect(settled[0].suppressed.map((s) => s.botName)).toEqual(['c', 'd', 'b'])
  })

  it('自判 ignore 既不在 suppressed 也不在 unresponsive —— 它并不想说话', () => {
    // 「被压制」的意思是「想说而没轮到」。把 ignore 者写进名单，UI 上就是
    // 「它也想回答」—— 恰好是它刚刚明确否认过的那句话
    const { barrier, settled } = makeBarrier(['a', 'b', 'c'])
    void barrier.claim('a', intent('ignore', 9))
    void barrier.claim('b', intent('reply', 5))
    void barrier.claim('c', intent('reply', 4))

    const r = settled[0]
    expect(r.winner).toBe('b')
    expect(r.suppressed).toEqual([{ botName: 'c', decision: 'reply', relevance: 4 }])
    expect(r.unresponsive).toEqual([])
    // 三个集合合起来也不该提到它：ignore 是一个已经有解释的结局，不是待救济的候选
    expect([...r.suppressed.map((s) => s.botName), ...r.unresponsive]).not.toContain('a')
    for (const s of r.suppressed) expect(s.decision).not.toBe('ignore')
  })

  it('定局之后才到的候选进不了名单，onSettled 也不会再发一次', async () => {
    // 名单是**定局那一刻**的快照：迟到者若能追加进去，胜者那条消息上的 chip 就会
    // 在它已经落树之后凭空多出一项（更糟的是宿主早已把它取走了）
    const { barrier, clock, settled, onSettled } = makeBarrier(['a', 'b', 'c'])
    const pa = barrier.claim('a', intent('reply', 5))
    void barrier.claim('b', intent('reply', 4))
    clock.advance(GRACE_MS)
    await pa

    await expect(barrier.claim('c', intent('reply', 9))).resolves.toEqual({
      won: false,
      winner: 'a',
      reason: 'timeout'
    })
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(settled[0].suppressed).toEqual([{ botName: 'b', decision: 'reply', relevance: 4 }])
  })

  it('reason 原样带上；没写理由时这个键根本不存在', () => {
    // reason 就是 chip 的 tooltip。铺一个 `reason: undefined` 出去，署名侧车里就会
    // 落一个 `"reason": null`（JSON 没有 undefined），重开会话时它又变成一句空理由
    const { barrier, settled } = makeBarrier(['a', 'b', 'c'])
    void barrier.claim('a', intent('reply', 9))
    void barrier.claim('b', { decision: 'reply', relevance: 5, reason: '这条像是我的' })
    void barrier.claim('c', intent('reply', 1))

    const suppressed = settled[0].suppressed
    expect(suppressed[0]).toEqual({
      botName: 'b',
      decision: 'reply',
      relevance: 5,
      reason: '这条像是我的'
    })
    expect(Object.keys(suppressed[1])).toEqual(['botName', 'decision', 'relevance'])
  })

  it('纯空白的 reason 等于没有理由（归一在入口，不留两套判空口径）', () => {
    const { barrier, settled } = makeBarrier(['a', 'b'])
    void barrier.claim('a', intent('reply', 9))
    void barrier.claim('b', { decision: 'reply', relevance: 5, reason: '   ' })

    expect(settled[0].suppressed[0]).not.toHaveProperty('reason')
  })

  it('定局之后的二次 claim 同样直接抛（settle 清空了 waiters，判重不能只靠它）', async () => {
    // 这条保护此前只在定局前有效。定局后的二次 claim 会走 settled 分支，把这个成员的
    // 裁决理由从 lost 改写成 timeout —— 进而改写沉默事件里它的结局和它那份决策记录
    const { barrier } = makeBarrier(['a', 'b'])
    const pa = barrier.claim('a', intent('reply', 9))
    await barrier.claim('b', intent('reply', 1))
    expect(barrier.isSettled).toBe(true)

    expect(() => barrier.claim('a', intent('reply', 9))).toThrow(/called twice/)
    expect(await pa).toMatchObject({ won: true, reason: 'won' })
  })

  it('wasAborted 只在被 abort() 关掉时为真 —— 宿主据此不发全体沉默提示', async () => {
    // 用户自己按的停止不属于「无从解释的沉默」。少了这个分辨，点一次停止就会弹一条
    // 「全体沉默：有东西坏了」，跟单 bot 那条降级气泡的 `!signal.aborted` 是同一条纪律
    const open = makeBarrier(['a', 'b'])
    expect(open.barrier.wasAborted).toBe(false) // 尚未定局

    const natural = makeBarrier(['a', 'b'])
    void natural.barrier.claim('a', intent('reply', 5))
    await natural.barrier.claim('b', intent('reply', 1))
    expect(natural.barrier.isSettled).toBe(true)
    expect(natural.barrier.wasAborted).toBe(false)

    open.barrier.abort()
    expect(open.barrier.wasAborted).toBe(true)
  })
})
