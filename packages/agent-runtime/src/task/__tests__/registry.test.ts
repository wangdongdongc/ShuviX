/**
 * 后台任务枢纽的等待 / 通知矩阵。
 *
 * 这里锁的是设计里那两条立足点，它们是三条线合并的全部理由：
 *   1. 「前台 / 后台」= `join` 的两组参数（maxWait + onTimeout），不是两种任务；
 *   2. 通知只有一条规则 —— **落定时还有人在等就不通知**。
 * 用真定时器 + 毫秒级窗口，而不是 fake timers：这里要验的正是 promise 与定时器的交错顺序。
 */
import { describe, it, expect, vi } from 'vitest'
import { createTaskRegistry, type TaskRegistry } from '../registry'
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
    const joined = registry.join(id, { maxWait: 10, onTimeout: 'kill' })
    await sleep(20)
    expect(stop).toHaveBeenCalledTimes(1)

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
