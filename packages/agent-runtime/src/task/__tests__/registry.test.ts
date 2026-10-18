/**
 * 后台任务枢纽的等待 / 通知矩阵。
 *
 * 这里锁的是设计里那两条立足点，它们是三条线合并的全部理由：
 *   1. 「前台 / 后台」= `join` 的两组参数（maxWait + onTimeout），不是两种任务；
 *   2. 通知只有一条规则 —— **落定时还有人在等就不通知**。
 * 用真定时器 + 毫秒级窗口，而不是 fake timers：这里要验的正是 promise 与定时器的交错顺序。
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  createTaskRegistry,
  type JoinOutcome,
  type JoinPolicy,
  type TaskRegistry
} from '../registry'
import type { TaskInfo, BashTaskSubject } from '@shuvix/chat-protocol/types/task'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function subject(): BashTaskSubject {
  return {
    kind: 'bash',
    command: 'sleep 1',
    cwd: '/tmp',
    pid: 123,
    logPath: '/tmp/x.log',
    exitCode: null,
    signal: null,
    logCapped: false
  }
}

function setup(): {
  registry: TaskRegistry
  broadcasts: TaskInfo[]
  delivered: Array<{ sessionId: string; text: string }>
  stop: ReturnType<typeof vi.fn>
  create: (over?: Partial<Parameters<TaskRegistry['create']>[0]>) => string
} {
  const broadcasts: TaskInfo[] = []
  const delivered: Array<{ sessionId: string; text: string }> = []
  const stop = vi.fn()
  const registry = createTaskRegistry({
    broadcast: (task) => broadcasts.push(task),
    deliver: (sessionId, text) => delivered.push({ sessionId, text }),
    coalesceMs: 5
  })
  const create = (over = {}): string =>
    registry.create({
      kind: 'bash',
      sessionId: 's1',
      title: 'build',
      subject: subject(),
      formatNotice: (t) => `<background-task id="${t.taskId}">done</background-task>`,
      stop,
      ...over
    })
  return { registry, broadcasts, delivered, stop, create }
}

describe('taskRegistry — 等待策略', () => {
  it('同步等待：落定由本次调用交回，不发通知', async () => {
    const { registry, delivered, create } = setup()
    const id = create()
    const joined = registry.join(id)
    registry.settle(id, { status: 'done' })

    const outcome = await joined
    expect(outcome).toMatchObject({ kind: 'settled', reason: 'finished' })
    expect(outcome?.task.status).toBe('done')
    await sleep(20)
    expect(delivered).toHaveLength(0)
  })

  it('超时降级：不杀，转异步，落定后才通知', async () => {
    const { registry, delivered, stop, create } = setup()
    const id = create()
    const outcome = await registry.join(id, { maxWait: 10, onTimeout: 'detach' })

    expect(outcome).toMatchObject({ kind: 'detached', reason: 'timeout' })
    expect(outcome?.task.detached).toBe(true)
    expect(stop).not.toHaveBeenCalled()

    registry.settle(id, { status: 'done' })
    await sleep(20)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ sessionId: 's1' })
  })

  it('超时杀：等待者留在原地，等 settle 回来，结果带 timeout', async () => {
    const { registry, delivered, stop, create } = setup()
    const id = create()
    const joined = registry.join(id, { maxWait: 10, onTimeout: 'kill', killForce: true })
    await sleep(20)
    // 调用方正等着这次结果 —— 超时不该再走「先温和再升级」那条慢路
    expect(stop).toHaveBeenCalledWith(true)

    registry.settle(id, { status: 'killed' })
    const outcome = await joined
    expect(outcome).toMatchObject({ kind: 'settled', reason: 'timeout' })
    expect(outcome?.task.status).toBe('killed')
    // 这次调用自己拿到了结果 —— 不该再被通知一遍
    await sleep(20)
    expect(delivered).toHaveLength(0)
  })

  it('中止：onAbort=kill 杀掉并交回，onAbort=detach 放手', async () => {
    const { registry, stop, create } = setup()

    const killed = create()
    const ac1 = new AbortController()
    const joinedKill = registry.join(killed, { signal: ac1.signal, onAbort: 'kill' })
    ac1.abort()
    await sleep(5)
    expect(stop).toHaveBeenCalledTimes(1)
    registry.settle(killed, { status: 'killed' })
    expect(await joinedKill).toMatchObject({ kind: 'settled', reason: 'abort' })

    const kept = create()
    const ac2 = new AbortController()
    const joinedKeep = registry.join(kept, { signal: ac2.signal, onAbort: 'detach' })
    ac2.abort()
    expect(await joinedKeep).toMatchObject({ kind: 'detached', reason: 'abort' })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('重新 join 一条已脱离的任务：它重新有人等，落定不再通知', async () => {
    const { registry, delivered, create } = setup()
    const id = create()
    await registry.join(id, { maxWait: 5 })
    expect(registry.get(id)?.detached).toBe(true)

    const rejoined = registry.join(id)
    expect(registry.get(id)?.detached).toBe(false)
    registry.settle(id, { status: 'done' })
    expect(await rejoined).toMatchObject({ kind: 'settled' })
    await sleep(20)
    expect(delivered).toHaveLength(0)
  })

  it('reopen 之后可以重新 join —— 跑完的派生 agent 被追问时又活了过来', async () => {
    const { registry, create } = setup()
    const id = create()
    registry.settle(id, { status: 'done' })
    expect(registry.reopen(id)).toBe(true)
    expect(registry.get(id)).toMatchObject({ status: 'running', endedAt: null })

    const rejoined = registry.join(id)
    registry.settle(id, { status: 'done' })
    expect(await rejoined).toMatchObject({ kind: 'settled' })
    // 还没落定过的任务没有「重开」可言
    expect(registry.reopen(create())).toBe(false)
  })

  it('join 一条已落定的任务立刻返回', async () => {
    const { registry, create } = setup()
    const id = create()
    registry.settle(id, { status: 'error' })
    expect(await registry.join(id)).toMatchObject({ kind: 'settled', reason: 'finished' })
  })
})

describe('taskRegistry — 通知中枢', () => {
  it('没人等的任务落定即通知', async () => {
    const { registry, delivered, create } = setup()
    registry.settle(create(), { status: 'done' })
    await sleep(20)
    expect(delivered).toHaveLength(1)
  })

  it('同一窗口内落定的多条并成一条通知', async () => {
    const { registry, delivered, create } = setup()
    const a = create()
    const b = create()
    registry.settle(a, { status: 'done' })
    registry.settle(b, { status: 'done' })
    await sleep(20)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text.split('\n\n')).toHaveLength(2)
  })

  it('智能体自己停的不通知，用户停的要通知', async () => {
    const { registry, delivered, create } = setup()
    const byAgent = create()
    registry.stop(byAgent, { by: 'agent' })
    registry.settle(byAgent, { status: 'killed' })
    await sleep(20)
    expect(delivered).toHaveLength(0)

    const byUser = create()
    registry.stop(byUser, { by: 'user' })
    registry.settle(byUser, { status: 'killed' })
    await sleep(20)
    expect(delivered).toHaveLength(1)
  })
})

describe('taskRegistry — 宣告', () => {
  it('announceAfter=Infinity 的任务不进面板，除非脱离等待者', async () => {
    const { registry, broadcasts, create } = setup()
    const quiet = create({ announceAfter: Number.POSITIVE_INFINITY })
    registry.settle(quiet, { status: 'done' })
    expect(broadcasts).toHaveLength(0)
    expect(registry.list('s1')).toHaveLength(0)

    const slow = create({ announceAfter: Number.POSITIVE_INFINITY })
    await registry.join(slow, { maxWait: 5 })
    expect(broadcasts.map((b) => b.taskId)).toContain(slow)
    expect(registry.list('s1')).toHaveLength(1)
  })

  it('announceAfter 到点仍在跑才广播', async () => {
    const { registry, broadcasts, create } = setup()
    const fast = create({ announceAfter: 20 })
    registry.settle(fast, { status: 'done' })
    await sleep(40)
    expect(broadcasts).toHaveLength(0)

    create({ announceAfter: 5 })
    await sleep(20)
    expect(broadcasts).toHaveLength(1)
  })

  it('级联清理解开等待者 —— 删会话不该把调用方永远晾在 join 上', async () => {
    const { registry, delivered, create } = setup()
    const id = create()
    const joined = registry.join(id)
    registry.killBySession('s1')
    const outcome = await joined
    expect(outcome).toMatchObject({ kind: 'settled' })
    expect(outcome?.task.status).toBe('killed')
    await sleep(20)
    expect(delivered).toHaveLength(0)
  })

  it('运行中计数与清理', async () => {
    const { registry, create } = setup()
    const a = create()
    create()
    expect(registry.runningCount('s1')).toBe(2)
    registry.settle(a, { status: 'done' })
    expect(registry.runningCount('s1')).toBe(1)
    expect(registry.clearFinished('s1')).toBe(1)
    expect(registry.list('s1')).toHaveLength(1)
  })
})

/*
 * 进入等输入（`update` 到 `waiting-input`）—— 通知规则的第二个触发点（docs/sub-session-design.md §19.3）。
 * 与落定那条同形：说了「交回」（`onInput: 'return'`）的等待者当场放手、把询问带回去；还有人在等就由它
 * 交回；一个等待者都没有才经 `formatInputNotice` 通知 —— 而且文本到合并窗口结束才生成。
 */

type Ctx = ReturnType<typeof setup>
type InputSpy = Mock<(task: TaskInfo) => string>

/** join 还挂着：ms 毫秒内没交回 = true */
const pendingAfter = (p: Promise<unknown>, ms = 10): Promise<boolean> =>
  Promise.race([p.then(() => false), sleep(ms).then(() => true)])

const askText = (id: string): string => `<sub-session id="${id}">asking</sub-session>`
const doneText = (id: string): string => `<background-task id="${id}">done</background-task>`

/** 拥有者的询问通知文案 */
function inputSpy(): InputSpy {
  return vi.fn<(task: TaskInfo) => string>((t) => askText(t.taskId))
}

/** WP1-05 的现场：唯一的等待者说了「交回」，任务进入等输入，这次调用已放手 */
async function handedBack(): Promise<
  Ctx & { spy: InputSpy; id: string; outcome: JoinOutcome | undefined }
> {
  const ctx = setup()
  const spy = inputSpy()
  const id = ctx.create({ formatInputNotice: spy })
  const joined = ctx.registry.join(id, { onInput: 'return' })
  ctx.registry.update(id, { status: 'waiting-input' })
  return { ...ctx, spy, id, outcome: await joined }
}

describe('taskRegistry — 进入等输入', () => {
  describe('默认 onInput（接着等）', () => {
    it.each<[string, JoinPolicy['onInput']]>([
      ['WP1-01 不给 onInput', undefined],
      ['WP1-02 显式 wait', 'wait']
    ])(
      '%s：进入等输入时接着等、不问 formatInputNotice，落定由这次调用交回',
      async (_label, onInput) => {
        const { registry, delivered, create } = setup()
        const spy = inputSpy()
        const id = create({ formatInputNotice: spy })
        const joined = onInput === undefined ? registry.join(id) : registry.join(id, { onInput })
        registry.update(id, { status: 'waiting-input' })
        await sleep(20)
        expect(await pendingAfter(joined)).toBe(true)
        expect(registry.get(id)).toMatchObject({
          status: 'waiting-input',
          detached: false,
          endedAt: null
        })
        expect(spy).not.toHaveBeenCalled()
        expect(delivered).toHaveLength(0)

        registry.settle(id, { status: 'done' })
        const outcome = await joined
        expect(outcome).toMatchObject({ kind: 'settled', reason: 'finished' })
        expect(outcome?.task.status).toBe('done')
        await sleep(20)
        expect(delivered).toHaveLength(0)
      }
    )

    it('WP1-03 默认 join 一条已经在等输入的任务：不当场返回，它重新有人等，落定由这次调用交回', async () => {
      const { registry, delivered, create } = setup()
      const id = create()
      // 先让它脱离一次（detached = true），下面「重新有人等」才有意义
      await registry.join(id, { maxWait: 5 })
      registry.update(id, { status: 'waiting-input' })
      await sleep(20)
      delivered.length = 0

      const joined = registry.join(id)
      expect(await pendingAfter(joined)).toBe(true)
      expect(registry.get(id)?.detached).toBe(false)
      registry.settle(id, { status: 'done' })
      expect(await joined).toMatchObject({ kind: 'settled', reason: 'finished' })
      await sleep(20)
      expect(delivered).toHaveLength(0)
    })

    it('WP1-04 没给 formatInputNotice 的任务进入等输入：不抛、不投递', async () => {
      const { registry, delivered, create } = setup()
      const id = create()
      expect(() => registry.update(id, { status: 'waiting-input' })).not.toThrow()
      await sleep(20)
      expect(delivered).toHaveLength(0)
      expect(registry.get(id)?.status).toBe('waiting-input')
    })
  })

  describe('onInput=return：跑到一半进入等输入', () => {
    it('WP1-05 这次调用以 detached/input 交回：不落定、不杀', async () => {
      const { registry, stop, id, outcome } = await handedBack()
      expect(outcome).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(outcome?.task).toMatchObject({
        status: 'waiting-input',
        detached: true,
        endedAt: null
      })
      expect(stop).not.toHaveBeenCalled()
      expect(registry.get(id)).toMatchObject({ status: 'waiting-input', endedAt: null })
      expect(registry.runningCount('s1')).toBe(1)
    })

    it('WP1-06 放手之后的落定照常通知', async () => {
      const { registry, delivered, id } = await handedBack()
      registry.update(id, { status: 'running' })
      registry.settle(id, { status: 'done' })
      await sleep(20)
      expect(delivered).toEqual([{ sessionId: 's1', text: doneText(id) }])
    })

    it('WP1-07 唯一的等待者已把询问交回：不再经 formatInputNotice 通知（同一条询问不报两次）', async () => {
      const { delivered, spy } = await handedBack()
      await sleep(20)
      expect(spy).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)
    })

    it('WP1-08 放手后又弹出一条询问、此时没人在等：经 formatInputNotice 通知', async () => {
      const { registry, delivered, spy, id } = await handedBack()
      await sleep(20)
      delivered.length = 0
      const n = spy.mock.calls.length

      registry.update(id, { status: 'waiting-input' })
      await sleep(20)
      expect(spy).toHaveBeenCalledTimes(n + 1)
      expect(spy.mock.calls[n][0]).toMatchObject({ taskId: id, status: 'waiting-input' })
      expect(delivered).toEqual([{ sessionId: 's1', text: askText(id) }])
    })

    it('WP1-09 放手 → 回到 running → 再 join(return) 再次交回 → 最后正常收尾', async () => {
      const { registry, delivered, id } = await handedBack()
      registry.update(id, { status: 'running' })
      const second = registry.join(id, { onInput: 'return' })
      expect(await pendingAfter(second)).toBe(true)
      expect(registry.get(id)?.detached).toBe(false)
      registry.update(id, { status: 'waiting-input' })
      expect(await second).toMatchObject({ kind: 'detached', reason: 'input' })

      registry.update(id, { status: 'running' })
      const third = registry.join(id)
      registry.settle(id, { status: 'done' })
      expect(await third).toMatchObject({ kind: 'settled', reason: 'finished' })
      // 两次询问都由调用交回、落定时有人在等 —— 自始至终一条通知都没有
      await sleep(20)
      expect(delivered).toHaveLength(0)
    })

    it('WP1-10 onInput=return 不影响正常落定', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      const joined = registry.join(id, { onInput: 'return' })
      registry.settle(id, { status: 'done' })
      expect(await joined).toMatchObject({ kind: 'settled', reason: 'finished' })
      await sleep(20)
      expect(spy).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)
    })
  })

  describe('join 时任务已经在等输入', () => {
    /** 没人等时进入等输入，那条询问通知已经走完 */
    async function alreadyWaiting(): Promise<Ctx & { spy: InputSpy; id: string }> {
      const ctx = setup()
      const spy = inputSpy()
      const id = ctx.create({ formatInputNotice: spy })
      ctx.registry.update(id, { status: 'waiting-input' })
      await sleep(20)
      return { ...ctx, spy, id }
    }

    it('WP1-11 onInput=return：当场交回，不挂等待者', async () => {
      const { registry, delivered, id } = await alreadyWaiting()
      delivered.length = 0

      const joined = registry.join(id, { onInput: 'return' })
      // 不必等任何 update
      expect(await pendingAfter(joined, 0)).toBe(false)
      const outcome = await joined
      expect(outcome).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(outcome?.task).toMatchObject({ status: 'waiting-input', detached: true })

      // 没挂上等待者：落定走通知
      registry.settle(id, { status: 'done' })
      await sleep(20)
      expect(delivered).toEqual([{ sessionId: 's1', text: doneText(id) }])
    })

    it('WP1-12 当场交回不算一条新询问：不问 formatInputNotice', async () => {
      const { registry, delivered, spy, id } = await alreadyWaiting()
      const n = spy.mock.calls.length
      const before = delivered.length

      await registry.join(id, { onInput: 'return' })
      await sleep(20)
      expect(spy).toHaveBeenCalledTimes(n)
      expect(delivered).toHaveLength(before)
    })

    it('WP1-13 仍在等输入时连续 join(return)：每次都当场交回（拥有者代答后得先回 running 再 join）', async () => {
      const { registry, create } = setup()
      const id = create()
      registry.update(id, { status: 'waiting-input' })
      expect(await registry.join(id, { onInput: 'return' })).toMatchObject({
        kind: 'detached',
        reason: 'input'
      })
      expect(await registry.join(id, { onInput: 'return' })).toMatchObject({
        kind: 'detached',
        reason: 'input'
      })
    })

    it('WP1-14 已落定的任务 join(return)：落定优先', async () => {
      const { registry, create } = setup()
      const id = create()
      registry.settle(id, { status: 'error' })
      const outcome = await registry.join(id, { onInput: 'return' })
      expect(outcome).toMatchObject({ kind: 'settled', reason: 'finished' })
      expect(outcome?.task.status).toBe('error')
    })
  })

  describe('formatInputNotice 与投递', () => {
    it('WP1-15 没人等时进入等输入：以快照调用 formatInputNotice，经合并窗口投递到任务所属会话', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ sessionId: 's1', formatInputNotice: spy })
      registry.update(id, { status: 'waiting-input' })
      // 合并窗口还没到
      expect(delivered).toHaveLength(0)
      await sleep(20)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toMatchObject({
        taskId: id,
        kind: 'bash',
        status: 'waiting-input',
        endedAt: null,
        subject: subject()
      })
      expect(delivered).toEqual([{ sessionId: 's1', text: askText(id) }])
    })

    it.each<[string, string | null | undefined]>([
      ['空串', ''],
      ['null', null],
      ['undefined', undefined]
    ])('WP1-16 formatInputNotice 交回%s：不投递', async (_label, value) => {
      const { registry, delivered, create } = setup()
      const id = create({ formatInputNotice: () => value })
      registry.update(id, { status: 'waiting-input' })
      await sleep(20)
      expect(delivered).toHaveLength(0)
      expect(registry.get(id)?.status).toBe('waiting-input')
    })

    it('WP1-17 已经在等输入时再来一条询问也问一次：分属两个窗口 → 两条', async () => {
      const { registry, delivered, create } = setup()
      let n = 0
      const spy = vi.fn<(task: TaskInfo) => string>(() => `ask#${++n}`)
      const id = create({ formatInputNotice: spy })
      registry.update(id, { status: 'waiting-input' })
      await sleep(20)
      registry.update(id, { status: 'waiting-input' })
      await sleep(20)

      expect(spy).toHaveBeenCalledTimes(2)
      expect(delivered.map((d) => d.text)).toEqual(['ask#1', 'ask#2'])
    })

    it('WP1-17 变体：同一窗口里连来两条询问 → 并成一次投递，块按序', async () => {
      const { registry, delivered, create } = setup()
      let n = 0
      const id = create({ formatInputNotice: () => `ask#${++n}` })
      registry.update(id, { status: 'waiting-input' })
      registry.update(id, { status: 'waiting-input' })
      await sleep(20)

      expect(delivered).toHaveLength(1)
      expect(delivered[0].text.split('\n\n')).toEqual(['ask#1', 'ask#2'])
    })

    it('WP1-18 有「接着等」的等待者时根本不问 formatInputNotice（不是调了再丢）', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      void registry.join(id)
      registry.update(id, { status: 'waiting-input' })
      registry.update(id, { status: 'waiting-input' })
      await sleep(20)
      expect(spy).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)
    })

    it('WP1-19 非等输入的 update 不触发任何等输入逻辑', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      const joined = registry.join(id, { onInput: 'return' })
      registry.update(id, { status: 'running' })
      registry.update(id, { subject: { logCapped: true } })
      await sleep(20)

      expect(await pendingAfter(joined)).toBe(true)
      expect(spy).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)
      expect(registry.get(id)?.subject).toMatchObject({ logCapped: true })
    })

    it('WP1-20 询问通知投到各自的会话', async () => {
      const { registry, delivered, create } = setup()
      const a = create({ sessionId: 's1', formatInputNotice: inputSpy() })
      const b = create({ sessionId: 's2', formatInputNotice: inputSpy() })
      registry.update(a, { status: 'waiting-input' })
      registry.update(b, { status: 'waiting-input' })
      await sleep(20)

      expect(delivered).toHaveLength(2)
      expect(delivered).toEqual(
        expect.arrayContaining([
          { sessionId: 's1', text: askText(a) },
          { sessionId: 's2', text: askText(b) }
        ])
      )
    })

    it('WP1-21 update 同时带 waiting-input 与 subject：subject 在放手前已合并', async () => {
      const { registry, create } = setup()
      const id = create()
      const joined = registry.join(id, { onInput: 'return' })
      registry.update(id, { status: 'waiting-input', subject: { logCapped: true } })
      const outcome = await joined
      expect(outcome).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(outcome?.task.subject).toMatchObject({ logCapped: true })
    })
  })

  describe('合并窗口', () => {
    it('WP1-22 询问通知与完成通知同窗口、同会话 → 并成一条，块按入队顺序', async () => {
      const { registry, delivered, create } = setup()
      const a = create({ formatInputNotice: inputSpy() })
      const b = create()
      registry.update(a, { status: 'waiting-input' })
      registry.settle(b, { status: 'done' })
      await sleep(20)

      expect(delivered).toHaveLength(1)
      expect(delivered[0].text.split('\n\n')).toEqual([askText(a), doneText(b)])
    })

    it('WP1-23 询问在合并窗口内已被答掉：文本到点才生成，拥有者交回空就不发', async () => {
      const { registry, delivered, create } = setup()
      let answered = false
      const format = vi.fn<(task: TaskInfo) => string>(() => (answered ? '' : 'asking'))
      const id = create({ formatInputNotice: format })
      registry.update(id, { status: 'waiting-input' })
      // update 当下不求值
      expect(format).not.toHaveBeenCalled()
      // 窗口还没到就答掉了（同步，必在窗口内）
      answered = true
      registry.update(id, { status: 'running' })
      await sleep(20)

      expect(format).toHaveBeenCalledTimes(1)
      // 拿到的是窗口结束那一刻的快照
      expect(format.mock.calls[0][0].status).toBe('running')
      expect(delivered).toHaveLength(0)
    })

    it('WP1-23 变体：窗口内隔了一段异步才答掉，同样不发', async () => {
      const delivered: Array<{ sessionId: string; text: string }> = []
      const registry = createTaskRegistry({
        broadcast: () => {},
        deliver: (sessionId, text) => delivered.push({ sessionId, text }),
        coalesceMs: 30
      })
      let answered = false
      const id = registry.create({
        kind: 'bash',
        sessionId: 's1',
        title: 'build',
        subject: subject(),
        formatInputNotice: () => (answered ? '' : 'asking')
      })
      registry.update(id, { status: 'waiting-input' })
      await sleep(5)
      answered = true
      registry.update(id, { status: 'running' })
      await sleep(60)
      expect(delivered).toHaveLength(0)
    })

    it('WP1-24 询问入队后、窗口内同一任务落定（无人等）：到点照样问拥有者，它交回什么就发什么', async () => {
      const { registry, delivered, create } = setup()
      const format = vi.fn<(task: TaskInfo) => string>(() => 'asking')
      const id = create({ formatInputNotice: format })
      registry.update(id, { status: 'waiting-input' })
      registry.settle(id, { status: 'done' })
      await sleep(20)

      // 枢纽不替拥有者判断：照样调用，参数是落定之后的快照
      expect(format).toHaveBeenCalledTimes(1)
      expect(format.mock.calls[0][0]).toMatchObject({ status: 'done' })
      expect(format.mock.calls[0][0].endedAt).not.toBeNull()
      expect(delivered).toHaveLength(1)
      expect(delivered[0].text.split('\n\n')).toEqual(['asking', doneText(id)])
    })

    it('WP1-24 变体：拥有者据「已落定」交回空 → 只剩完成那一块', async () => {
      const { registry, delivered, create } = setup()
      const id = create({ formatInputNotice: (t) => (t.endedAt !== null ? '' : 'asking') })
      registry.update(id, { status: 'waiting-input' })
      registry.settle(id, { status: 'done' })
      await sleep(20)

      expect(delivered).toEqual([{ sessionId: 's1', text: doneText(id) }])
    })

    it.each<[string, 'killBySession' | 'killAll']>([
      ['WP1-25', 'killBySession'],
      ['WP1-26', 'killAll']
    ])('%s %s 清掉已入队的询问通知', async (_label, how) => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      registry.update(id, { status: 'waiting-input' })
      if (how === 'killBySession') registry.killBySession('s1')
      else registry.killAll()
      await sleep(20)

      expect(delivered).toHaveLength(0)
      expect(spy).not.toHaveBeenCalled()
      expect(registry.get(id)).toBeUndefined()
    })
  })

  describe('多个等待者 / 竞态', () => {
    it('WP1-27 一个 return + 一个 wait：只有前者放手，且不通知', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      const ret = registry.join(id, { onInput: 'return' })
      const wait = registry.join(id)
      registry.update(id, { status: 'waiting-input' })

      expect(await ret).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(await pendingAfter(wait)).toBe(true)
      await sleep(20)
      expect(spy).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)

      registry.settle(id, { status: 'done' })
      expect(await wait).toMatchObject({ kind: 'settled', reason: 'finished' })
      await sleep(20)
      expect(delivered).toHaveLength(0)
    })

    it('WP1-28 return 的放手了、还有人在等：detached 保持 false', async () => {
      const { registry, broadcasts, create } = setup()
      const id = create()
      const ret = registry.join(id, { onInput: 'return' })
      void registry.join(id)
      registry.update(id, { status: 'waiting-input' })

      const outcome = await ret
      expect(outcome).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(outcome?.task.detached).toBe(false)
      expect(registry.get(id)?.detached).toBe(false)
      expect(broadcasts.at(-1)).toMatchObject({
        taskId: id,
        status: 'waiting-input',
        detached: false
      })
    })

    it('WP1-28 变体：当场交回（join 时已在等输入）而还有人在等，detached 同样保持 false', async () => {
      const { registry, create } = setup()
      const id = create()
      const wait = registry.join(id)
      registry.update(id, { status: 'waiting-input' })

      const outcome = await registry.join(id, { onInput: 'return' })
      expect(outcome).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(outcome?.task.detached).toBe(false)
      expect(registry.get(id)?.detached).toBe(false)
      expect(await pendingAfter(wait)).toBe(true)
    })

    it('WP1-28 对照（现状）：超时 / 中止的放手仍无条件置 detached，即使还有人在等', async () => {
      const { registry, create } = setup()
      const timedOut = create()
      void registry.join(timedOut)
      expect(await registry.join(timedOut, { maxWait: 5 })).toMatchObject({
        kind: 'detached',
        reason: 'timeout'
      })
      expect(registry.get(timedOut)?.detached).toBe(true)

      const aborted = create()
      void registry.join(aborted)
      const ac = new AbortController()
      const joined = registry.join(aborted, { signal: ac.signal, onAbort: 'detach' })
      ac.abort()
      expect(await joined).toMatchObject({ kind: 'detached', reason: 'abort' })
      expect(registry.get(aborted)?.detached).toBe(true)
    })

    it('WP1-29 两个 return 等待者：都放手，询问已被交回 → 不通知', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      const p1 = registry.join(id, { onInput: 'return' })
      const p2 = registry.join(id, { onInput: 'return' })
      registry.update(id, { status: 'waiting-input' })

      expect(await p1).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(await p2).toMatchObject({ kind: 'detached', reason: 'input' })
      // 两次调用都已不在等
      expect(registry.get(id)?.detached).toBe(true)
      await sleep(20)
      expect(spy).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)
    })

    it('WP1-30 等输入期间落定、有「接着等」的等待者：由它交回，无任何通知', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      const joined = registry.join(id)
      registry.update(id, { status: 'waiting-input' })
      registry.settle(id, { status: 'error' })

      const outcome = await joined
      expect(outcome).toMatchObject({ kind: 'settled', reason: 'finished' })
      expect(outcome?.task.status).toBe('error')
      expect(outcome?.task.endedAt).not.toBeNull()
      await sleep(20)
      expect(spy).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)
    })

    it('WP1-31 等输入期间落定、没人等（return 已放手）：落定照常通知', async () => {
      const { registry, delivered, id } = await handedBack()
      await sleep(20)
      delivered.length = 0
      // 不回 running，直接落定
      registry.settle(id, { status: 'done' })
      await sleep(20)

      expect(registry.get(id)?.status).toBe('done')
      expect(delivered).toEqual([{ sessionId: 's1', text: doneText(id) }])
    })
  })

  describe('与其它等待策略交错', () => {
    it('WP1-32 return 放手后，超时杀的计时器失效', async () => {
      const { registry, stop, create } = setup()
      const id = create()
      const joined = registry.join(id, {
        onInput: 'return',
        maxWait: 10,
        onTimeout: 'kill',
        killForce: true
      })
      registry.update(id, { status: 'waiting-input' })
      expect(await joined).toMatchObject({ kind: 'detached', reason: 'input' })
      await sleep(30)

      expect(stop).not.toHaveBeenCalled()
      expect(registry.get(id)?.endedAt).toBeNull()
    })

    it('WP1-33 return 放手后，中止信号不再杀', async () => {
      const { registry, stop, create } = setup()
      const id = create()
      const ac = new AbortController()
      const joined = registry.join(id, { onInput: 'return', signal: ac.signal, onAbort: 'kill' })
      registry.update(id, { status: 'waiting-input' })
      expect(await joined).toMatchObject({ kind: 'detached', reason: 'input' })
      ac.abort()
      await sleep(5)

      expect(stop).not.toHaveBeenCalled()
      expect(registry.get(id)?.status).toBe('waiting-input')
    })

    it('WP1-34 先超时脱离、后进入等输入：结果仍是 timeout，询问走通知', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      const joined = registry.join(id, { onInput: 'return', maxWait: 5, onTimeout: 'detach' })
      expect(await joined).toMatchObject({ kind: 'detached', reason: 'timeout' })

      registry.update(id, { status: 'waiting-input' })
      await sleep(20)
      // 已交回的结果不被改写
      expect(await joined).toMatchObject({ kind: 'detached', reason: 'timeout' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(delivered).toEqual([{ sessionId: 's1', text: askText(id) }])
    })

    it('WP1-35 「接着等」的等待者在等输入期间超时脱离：超时那一刻不问 formatInputNotice', async () => {
      const { registry, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      const joined = registry.join(id, { maxWait: 15, onTimeout: 'detach' })
      // 此时有人在等 → 不通知
      registry.update(id, { status: 'waiting-input' })

      const outcome = await joined
      expect(outcome).toMatchObject({ kind: 'detached', reason: 'timeout' })
      expect(outcome?.task.status).toBe('waiting-input')
      await sleep(20)
      // 只在 update 到 waiting-input 时问，脱离不补问
      expect(spy).not.toHaveBeenCalled()
      expect(delivered).toHaveLength(0)

      registry.settle(id, { status: 'done' })
      await sleep(20)
      expect(delivered).toEqual([{ sessionId: 's1', text: doneText(id) }])
    })

    it.each<[string, 'timeout' | 'abort']>([
      ['超时杀', 'timeout'],
      ['中止杀', 'abort']
    ])(
      'WP1-36 %s已下令、等 settle 期间进入等输入：不再被询问放手，结果仍是被杀的那个落定，不发通知',
      async (_label, how) => {
        const { registry, delivered, stop, create } = setup()
        const spy = inputSpy()
        const id = create({ formatInputNotice: spy })
        const ac = new AbortController()
        const joined =
          how === 'timeout'
            ? registry.join(id, {
                onInput: 'return',
                maxWait: 5,
                onTimeout: 'kill',
                killForce: true
              })
            : registry.join(id, {
                onInput: 'return',
                signal: ac.signal,
                onAbort: 'kill',
                killForce: true
              })
        if (how === 'abort') ac.abort()
        await sleep(15)
        expect(stop).toHaveBeenCalledWith(true)

        registry.update(id, { status: 'waiting-input' })
        expect(await pendingAfter(joined)).toBe(true)

        registry.settle(id, { status: 'killed' })
        const outcome = await joined
        expect(outcome).toMatchObject({ kind: 'settled', reason: how })
        expect(outcome?.task.status).toBe('killed')
        await sleep(20)
        expect(spy).not.toHaveBeenCalled()
        expect(delivered).toHaveLength(0)
      }
    )

    it.each(['agent', 'user'] as const)(
      'WP1-37 stop(by: %s) 之后、settle 之前进入等输入：不排询问通知（落定那条规则照旧）',
      async (by) => {
        const { registry, delivered, create } = setup()
        const spy = inputSpy()
        const id = create({ formatInputNotice: spy })
        expect(registry.stop(id, { by })).toBe(true)
        registry.update(id, { status: 'waiting-input' })
        await sleep(20)
        expect(spy).not.toHaveBeenCalled()
        expect(delivered).toHaveLength(0)

        // 智能体自己停的不通知，用户停的要通知 —— 不受上面影响
        registry.settle(id, { status: 'killed' })
        await sleep(20)
        expect(delivered).toHaveLength(by === 'user' ? 1 : 0)
      }
    )

    it('WP1-38（记录现状）已在等输入 + 已中止的 signal + return + onAbort=detach：当场交回先于中止，原因是 input', async () => {
      const { registry, stop, create } = setup()
      const id = create()
      registry.update(id, { status: 'waiting-input' })
      const ac = new AbortController()
      ac.abort()
      const outcome = await registry.join(id, {
        onInput: 'return',
        signal: ac.signal,
        onAbort: 'detach'
      })
      expect(outcome).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(stop).not.toHaveBeenCalled()
    })
  })

  describe('宣告与 detached 广播', () => {
    it('WP1-39 未宣告的任务（announceAfter=Infinity）因等输入放手 → 立刻宣告', async () => {
      const { registry, broadcasts, create } = setup()
      const id = create({
        announceAfter: Number.POSITIVE_INFINITY,
        formatInputNotice: inputSpy()
      })
      const joined = registry.join(id, { onInput: 'return' })
      expect(broadcasts).toHaveLength(0)

      registry.update(id, { status: 'waiting-input' })
      await joined
      expect(broadcasts.map((b) => b.taskId)).toContain(id)
      expect(broadcasts.at(-1)).toMatchObject({
        taskId: id,
        status: 'waiting-input',
        detached: true
      })
      expect(registry.list('s1').map((t) => t.taskId)).toEqual([id])
    })

    it('WP1-40 当场交回的路径同样宣告', async () => {
      const { registry, broadcasts, create } = setup()
      const id = create({ announceAfter: Number.POSITIVE_INFINITY })
      registry.update(id, { status: 'waiting-input' })
      // 没宣告过：状态变了也不广播
      expect(broadcasts).toHaveLength(0)
      expect(registry.list('s1')).toHaveLength(0)

      await registry.join(id, { onInput: 'return' })
      expect(broadcasts).toHaveLength(1)
      expect(broadcasts[0]).toMatchObject({ taskId: id, status: 'waiting-input', detached: true })
      expect(registry.list('s1').map((t) => t.taskId)).toEqual([id])
    })

    it('WP1-41 已宣告任务的等输入往返都广播', () => {
      const { registry, broadcasts, create } = setup()
      const id = create()
      expect(broadcasts).toHaveLength(1)
      void registry.join(id)
      registry.update(id, { status: 'waiting-input' })
      registry.update(id, { status: 'running' })

      expect(broadcasts.slice(1)).toMatchObject([
        { taskId: id, status: 'waiting-input', detached: false },
        { taskId: id, status: 'running' }
      ])
    })

    it('WP1-42 宣告计时器到点时任务正在等输入 → 照样宣告', async () => {
      const { registry, broadcasts, create } = setup()
      const id = create({ announceAfter: 40 })
      void registry.join(id)
      await sleep(5)
      registry.update(id, { status: 'waiting-input' })
      await sleep(5)
      // 还没到点：未宣告不广播
      expect(broadcasts).toHaveLength(0)

      await sleep(60)
      expect(broadcasts).toHaveLength(1)
      expect(broadcasts[0]).toMatchObject({ taskId: id, status: 'waiting-input' })
    })

    it('WP1-43 return 放手：最后一条广播是 waiting-input + detached', async () => {
      const { registry, broadcasts, create } = setup()
      const id = create()
      const joined = registry.join(id, { onInput: 'return' })
      const before = broadcasts.length

      registry.update(id, { status: 'waiting-input' })
      await joined
      // 条数不做强约束，只看末条
      expect(broadcasts.length).toBeGreaterThan(before)
      expect(broadcasts.at(-1)).toMatchObject({
        taskId: id,
        status: 'waiting-input',
        detached: true
      })
    })
  })

  describe('生命周期边界', () => {
    it('WP1-44 已结束的任务 update(waiting-input) 无效', async () => {
      const { registry, broadcasts, delivered, create } = setup()
      const spy = inputSpy()
      const id = create({ formatInputNotice: spy })
      registry.settle(id, { status: 'done' })
      await sleep(20)
      const broadcastCount = broadcasts.length
      const deliveredCount = delivered.length

      registry.update(id, { status: 'waiting-input' })
      await sleep(20)
      expect(registry.get(id)?.status).toBe('done')
      expect(spy).not.toHaveBeenCalled()
      expect(broadcasts).toHaveLength(broadcastCount)
      expect(delivered).toHaveLength(deliveredCount)
    })

    it('WP1-45 未知 taskId 的 update(waiting-input)：不抛、无副作用', async () => {
      const { registry, broadcasts, delivered } = setup()
      expect(() => registry.update('nope', { status: 'waiting-input' })).not.toThrow()
      await sleep(20)
      expect(broadcasts).toHaveLength(0)
      expect(delivered).toHaveLength(0)
    })

    it('WP1-46 等输入中的任务算「未结束」（含 return 放手之后的）', async () => {
      const { registry, create, id } = await handedBack()
      const other = create()
      void registry.join(other)
      registry.update(other, { status: 'waiting-input' })

      expect(registry.runningCount('s1')).toBe(2)
      expect(registry.dismiss(id)).toBe(false)
      expect(registry.dismiss(other)).toBe(false)
      expect(registry.clearFinished('s1')).toBe(0)
      expect(
        registry
          .list('s1')
          .map((t) => t.taskId)
          .sort()
      ).toEqual([id, other].sort())
    })

    it('WP1-47 删会话时等输入中的等待者被解开', async () => {
      const { registry, delivered, stop, create } = setup()
      const id = create({ formatInputNotice: inputSpy() })
      const ret = registry.join(id, { onInput: 'return' })
      const wait = registry.join(id)
      registry.update(id, { status: 'waiting-input' })
      expect(await ret).toMatchObject({ kind: 'detached', reason: 'input' })

      registry.killBySession('s1')
      const outcome = await wait
      expect(outcome).toMatchObject({ kind: 'settled' })
      expect(outcome?.task.status).toBe('killed')
      expect(stop).toHaveBeenCalledWith(true)
      await sleep(20)
      expect(delivered).toHaveLength(0)
    })

    it('WP1-48 reopen 之后可以再次进入等输入并交回', async () => {
      const { registry, create } = setup()
      const id = create()
      registry.settle(id, { status: 'done' })
      expect(registry.reopen(id)).toBe(true)

      const joined = registry.join(id, { onInput: 'return' })
      registry.update(id, { status: 'waiting-input' })
      const outcome = await joined
      expect(outcome).toMatchObject({ kind: 'detached', reason: 'input' })
      expect(outcome?.task).toMatchObject({ status: 'waiting-input', endedAt: null })
    })
  })

  describe('类型面（由 typecheck:node 检查，本文件在其 include 里）', () => {
    it('WP1-49 input 只在 detached 一侧；settle 不收等输入；onInput 只有 wait | return', () => {
      const reason: JoinOutcome['reason'] = 'input'
      expect(reason).toBe('input')

      // 只做类型检查，不执行。每个变量都被用到：noUnusedLocals 的报错若落在期待报错的
      // 那一行，会替那条期待「兑现」，类型本身错没错就看不出来了
      const typeOnly = (registry: TaskRegistry, id: string, outcome: JoinOutcome): string => {
        // 按 kind 收窄之后，settled 一侧的 reason 不含 input
        const settled: 'finished' | 'timeout' | 'abort' | null =
          outcome.kind === 'settled' ? outcome.reason : null
        // @ts-expect-error settled 一侧没有 input
        const bad: JoinOutcome = { kind: 'settled', reason: 'input', task: outcome.task }
        // @ts-expect-error SettlePatch 不接受 waiting-input（等输入不是落定）
        registry.settle(id, { status: 'waiting-input' })
        // @ts-expect-error onInput 只有 'wait' | 'return'
        void registry.join(id, { onInput: 'detach' })
        return `${settled}/${bad.kind}`
      }
      expect(typeOnly).toBeTypeOf('function')
    })
  })
})
