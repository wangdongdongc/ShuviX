/**
 * 宿主派发 · P2-01 辅助工作用例的锚拥有变体（P2-08-54）：P2-01 的那几条用 ownerless 的 hook 对话绕开了根里的
 * 锚（PIN-12）；P2-08 把「后台、且拥有的对话全是辅助工作」的任务排除出运行状态（PIN-02）之后，同样的用例
 * 换成锚拥有（`seedAgent({owner: 'anchor'})`，同一提交里建 TestAnchor）期望逐字相同 —— 不再需要先让锚跑完。
 * 生产锚（`shuvix.spawn.anchor`，经真 runner / 路由派发）的同形用例在 hosted.titler.test.ts：-09（-44 / -49）、
 * -10（-45）、-15（-47）。
 */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import type { DurableSession } from '../durableSession'
import { answer, held } from './support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from './support/host'
import { wKit } from './support/scenario'
import {
  holdGate,
  hookRec,
  liveTasks,
  seedAgent,
  startRun,
  TEST_SPAWN_EXTENSION
} from './support/spawn'
import { sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

function host(options: Partial<TestHostOptions> = {}): Promise<TestHost> {
  return makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION], ...options })
}

/** 锚任务（seedAgent 建在根里的 TestAnchor）此刻的状态 */
async function anchorStatus(session: DurableSession, id: number): Promise<string | undefined> {
  return (await session.harness.commit((tx) => tx.task(id as never), BG))?.state.status
}

describe('P2-08-54 anchor-owned variants of the P2-01 auxiliary cases', () => {
  it('P2-01-41(a) anchor-owned: one commit (anchor + hook conversation + record + held task) never makes the session busy', async () => {
    const t = await host()
    const session = await t.open()
    const gate = `p2-08-54-41a-${Math.random()}`
    const seeded = await seedAgent(session, { record: hookRec(), owner: 'anchor', hold: gate })
    expect(session.isInterrupted()).toBe(false)
    expect(session.runState).toBe('idle')
    session.harness.resume()
    await waitFor(async () =>
      (await liveTasks(session, seeded.conversationId)).some(
        (task) => task.state.status === 'running'
      )
    )
    // 锚已经跑过、以 completing 陪着名下的工作 —— 照样不算忙
    await waitFor(async () => (await anchorStatus(session, seeded.ownerTaskId)) === 'completing')
    expect(session.runState).toBe('idle')
    holdGate(gate).resolve()
    await waitFor(async () => (await liveTasks(session)).length === 0)
    await sleep(20)
    expect(t.statesOf('s1')).not.toContain('busy')
  })

  it('P2-01-44 anchor-owned: the mirror stays idle while titler work runs', async () => {
    const t = await host()
    const session = await t.open()
    const seeded = await seedAgent(session, { record: hookRec(), owner: 'anchor' })
    const run = held(answer('Title'))
    t.kit.queue(run.step)
    const submission = await startRun(session, seeded.conversationId, 'TITLE-ME')
    await run.reached
    expect(session.runState).toBe('idle')
    expect(session.isBusy()).toBe(false)
    expect(session.isInterrupted()).toBe(false)
    run.release()
    expect((await withTimeout(submission.wait(BG), 3000, 'titler run')).status).toBe('done')
    await waitFor(async () => (await liveTasks(session)).length === 0)
    await sleep(30)
    expect(t.statesOf('s1')).toEqual(['idle'])
  })

  it('P2-01-45 anchor-owned: a root run beside titler work gives one busy/idle pair; the titler ending reports nothing', async () => {
    const t = await host()
    const session = await t.open()
    await primeRoot(session)
    const seeded = await seedAgent(session, { record: hookRec(), owner: 'anchor' })
    const titler = held(answer('Title'))
    t.kit.queue(titler.step)
    const titlerRun = await startRun(session, seeded.conversationId, 'TITLE-ME')
    await titler.reached
    const root = held(answer('root'))
    t.kit.queue(root.step)
    const result = session.submitUser('hi')
    await root.reached
    root.release()
    expect(await withTimeout(result, 3000, 'root run')).toEqual({})
    await waitFor(() => t.statesOf('s1').at(-1) === 'idle', 3000, 'idle reported')
    expect(t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])
    expect((await liveTasks(session, seeded.conversationId)).length).toBeGreaterThan(0)
    titler.release()
    expect((await withTimeout(titlerRun.wait(BG), 3000, 'titler run')).status).toBe('done')
    await waitFor(async () => (await liveTasks(session)).length === 0)
    await sleep(30)
    expect(t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])
  })

  it(
    'P2-01-47 anchor-owned, no settle needed: no busy marker from titler work, and process 2 reports idle',
    async () => {
      const first = await host()
      const session = await first.open()
      const seeded = await seedAgent(session, { record: hookRec(), owner: 'anchor' })
      const mark = first.statesOf('s1').length
      const run = held(answer('Title'))
      first.kit.queue(run.step)
      await startRun(session, seeded.conversationId, 'TITLE-ME')
      await run.reached
      await sleep(20)
      expect(first.statesOf('s1').slice(mark)).toEqual([])
      const t = await first.restart()
      const reopened = await t.open()
      await sleep(10)
      expect(t.statesOf('s1')).toEqual(['idle'])
      expect(reopened.runState).toBe('idle')
      expect(reopened.isInterrupted()).toBe(false)
      expect(
        (await liveTasks(reopened, seeded.conversationId)).every((task) => task.abortRequested)
      ).toBe(true)
      // 锚本身不打标记（PIN-02）：名下的工作收场时它自己完成
      expect(
        (await liveTasks(reopened, ROOT_CONVERSATION_ID)).every((task) => !task.abortRequested)
      ).toBe(true)
    },
    RESTART_TIMEOUT
  )

  async function anchoredTitlerHeld(): Promise<{
    t: TestHost
    a: DurableSession
    release: () => void
    done: Promise<unknown>
  }> {
    const t = await host({ maxIdleOpen: 1 })
    const a = await t.open('a')
    const seeded = await seedAgent(a, { record: hookRec(), owner: 'anchor' })
    const run = held(answer('Title'))
    t.kit.queue(run.step)
    const submission = await startRun(a, seeded.conversationId, 'TITLE-ME')
    await run.reached
    await t.open('b')
    await sleep(30)
    expect(t.events.filter((event) => event.startsWith('close:'))).toEqual([])
    await t.open('c')
    await waitFor(() => t.events.includes('close:b'), 3000, 'b closed')
    return { t, a, release: run.release, done: submission.wait(BG) }
  }

  it('P2-01-48 anchor-owned: running auxiliary work blocks eviction although the session reports idle', async () => {
    const { t, a, release, done } = await anchoredTitlerHeld()
    expect(a.closed).toBe(false)
    expect(a.runState).toBe('idle')
    expect(t.events.includes('close:a')).toBe(false)
    release()
    await withTimeout(done, 3000, 'titler run')
  })

  it('P2-01-49 anchor-owned: when the work (and its anchor) ends the host trims again without another open', async () => {
    const { t, a, release, done } = await anchoredTitlerHeld()
    expect(a.closed).toBe(false)
    release()
    await withTimeout(done, 3000, 'titler run')
    await waitFor(() => t.events.includes('close:a'), 3000, 'a closed after the titler ended')
    expect(t.host.get('c')).toBeDefined()
  })
})
