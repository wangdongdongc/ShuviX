/**
 * 会话 fork · `whileIdle`（取样，在源会话上）：回退区段的独占里确认此刻没有可续的工作（活着的非辅助任务；
 * 压缩与 hook agent 不算）才跑 `work`；有 → busy，`work` 不跑；只读、不开启调度器。
 *
 *   WI-1  空闲、已锁 → {ok:true, value}，work 恰好一次，没有发布，锁不动；（1b）重开之后调度器停着，取样不开启它
 *   WI-2  run 在跑 → busy，work 没跑
 *   WI-3  被中断（上个进程崩在 run 中途）→ busy
 *   WI-4  根空闲、后台的派生子 agent 还在跑 → busy
 *   WI-5  只有宿主派发的辅助工作（titler 形状的 hook agent）在跑 → ok
 *   WI-6  只有后台压缩在跑 → ok
 *   WI-7  work 没落定时开始的 submitUser 等它落定才受理，之后照常跑完
 *   WI-8  紧挨在前面受理的发送（扣住的一轮）→ busy（drain 等它受理完，看得见它起的 run）
 *   WI-9  work 抛 E → 原样以 E 拒绝；之后发送与再一次 whileIdle 照常
 *   WI-10 调用前句柄已关 → closed，work 没跑
 */
import { fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai'
import { CompactionEntry } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { crashWith } from './support/crash'
import { answer, fauxKit, held } from './support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from './support/host'
import { contents, rawPublications, rollbackBase, viewOf } from './support/rollback'
import { wKit } from './support/scenario'
import { hookRec, liveTasks, seedAgent, startRun, TEST_SPAWN_EXTENSION } from './support/spawn'
import { allEntries } from './support/transcript'
import { aborted, deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 15000

function spawnHost(options: Partial<TestHostOptions> = {}): Promise<TestHost> {
  return makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION], ...options })
}

/** 记下被调用次数的 work */
function counted<T>(value: T): { readonly work: () => Promise<T>; readonly calls: () => number } {
  let calls = 0
  return {
    work: async () => {
      calls++
      return value
    },
    calls: () => calls
  }
}

/** 一次 busy 的取样：结果、work 没跑、没有发布 */
async function expectBusy(session: DurableSession): Promise<void> {
  const probe = counted('copied')
  const recorder = rawPublications(session)
  expect(await session.whileIdle(probe.work)).toEqual({ ok: false, reason: 'busy' })
  recorder.stop()
  expect(probe.calls()).toBe(0)
  expect(recorder.publications).toEqual([])
}

/** 一次 ok 的取样：结果带着值、work 恰好一次、没有发布 */
async function expectIdle(session: DurableSession): Promise<void> {
  const probe = counted('copied')
  const recorder = rawPublications(session)
  expect(await session.whileIdle(probe.work)).toEqual({ ok: true, value: 'copied' })
  recorder.stop()
  expect(probe.calls()).toBe(1)
  expect(recorder.publications).toEqual([])
}

describe('session fork · whileIdle', () => {
  it('WI-1 an idle locked session: {ok:true, value}, work runs once, no publication, the lock untouched', async () => {
    const { session } = await rollbackBase()
    const lock = session.lock
    expect(lock).toBeDefined()
    const state = await session.harness.snapshot(SessionStateDoc, BG)
    await expectIdle(session)
    expect(session.lock).toBe(lock)
    expect(await session.harness.snapshot(SessionStateDoc, BG)).toEqual(state)
    expect(session.runState).toBe('idle')
  })

  it(
    'WI-1b after a reopen the scheduler is paused, and sampling does not start it',
    async () => {
      const { t } = await rollbackBase()
      const t2 = await t.restart()
      const session = await t2.open('s1')
      expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
      await expectIdle(session)
      expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
      expect(t2.kit.callCount).toBe(0)
    },
    TIMEOUT
  )

  it('WI-2 a run in flight: busy, work not called', async () => {
    const { t, session } = await rollbackBase()
    const run = held(answer('late'))
    t.kit.queue(run.step)
    const sending = session.submitUser('U4')
    await run.reached
    await expectBusy(session)
    run.release()
    expect(await withTimeout(sending, 3000, 'held send')).toEqual({})
    await expectIdle(session)
  })

  it(
    'WI-3 interrupted (the previous process died mid-run): busy',
    async () => {
      const { t } = await crashWith()
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)
      await expectBusy(session)
      expect(session.isInterrupted()).toBe(true)
      expect(t.kit.callCount).toBe(0)
    },
    TIMEOUT
  )

  it(
    'WI-4 the root is idle but a background spawned agent is still running: busy; idle again once it has finished',
    async () => {
      const t = await spawnHost()
      const session = await t.open()
      await primeRoot(session)
      // 锚是根里的后台任务（派发工具的后台形状）；子 agent 是 `tool` 派发、不是辅助工作
      const seeded = await seedAgent(session)
      const run = held(answer('child done'))
      t.kit.queue(run.step)
      const submission = await startRun(session, seeded.conversationId, 'CHILD-Q')
      await run.reached
      expect(session.isBusy()).toBe(false)
      await expectBusy(session)
      run.release()
      expect((await withTimeout(submission.wait(BG), 3000, 'child run')).status).toBe('done')
      await waitFor(async () => (await liveTasks(session)).length === 0, 3000, 'no live tasks')
      await expectIdle(session)
    },
    TIMEOUT
  )

  it(
    'WI-5 only auxiliary hook-agent work (titler shape) is running: ok',
    async () => {
      const t = await spawnHost()
      const session = await t.open()
      await primeRoot(session)
      const seeded = await seedAgent(session, { record: hookRec() })
      const run = held(answer('Title'))
      t.kit.queue(run.step)
      const submission = await startRun(session, seeded.conversationId, 'TITLE-ME')
      await run.reached
      expect((await liveTasks(session, seeded.conversationId)).length).toBeGreaterThan(0)
      await expectIdle(session)
      run.release()
      expect((await withTimeout(submission.wait(BG), 3000, 'titler run')).status).toBe('done')
    },
    TIMEOUT
  )

  it(
    'WI-6 only a background compaction is running: ok',
    async () => {
      const gate = deferred()
      const summarizing = deferred()
      const t = await makeHost({
        makeKit: () => fauxKit({ models: [{ id: 'faux-1', contextWindow: 3000 }] }),
        // 与 lock.compaction LW-07 同一组数：两条长回答之后在后台压缩
        settingsOverrides: { retry: { enabled: false }, compaction: { keepRecentTokens: 100 } }
      })
      const respond: FauxResponseStep = async (context, options) => {
        const first = context.messages[0]
        if (
          first?.role === 'system' &&
          typeof first.content === 'string' &&
          first.content.includes('summar')
        ) {
          summarizing.resolve()
          await Promise.race([gate.promise, aborted(options!.signal!)])
          return fauxAssistantMessage('## Goal\nsummary')
        }
        return fauxAssistantMessage(`answer ${'details '.repeat(800)}`)
      }
      for (let index = 0; index < 6; index++) t.kit.queue(respond)
      const session = await t.open()
      expect(await session.submitUser('first question')).toEqual({})
      expect(await session.submitUser('second question')).toEqual({})
      await withTimeout(summarizing.promise, 5000, 'compaction request')
      const live = await liveTasks(session)
      expect(live.map((task) => task.kind)).toEqual(['pi.compaction'])
      await expectIdle(session)
      gate.resolve()
      const conversation = await session.currentConversation()
      await waitFor(
        async () => (await allEntries(conversation)).some((entry) => CompactionEntry.is(entry)),
        5000,
        'compaction summary'
      )
    },
    TIMEOUT
  )

  it('WI-7 a submitUser started while work is pending is not admitted until work resolves; then it completes normally', async () => {
    const { t, session } = await rollbackBase()
    const gate = deferred<string>()
    let workCalls = 0
    const sampling = session.whileIdle(async () => {
      workCalls++
      return gate.promise
    })
    let admitted = 0
    t.kit.queue(answer('A4'))
    const calls = t.kit.callCount
    const sending = session.submitUser('U4', { onAdmitted: () => admitted++ })
    await waitFor(() => workCalls === 1, 3000, 'work started')
    await sleep(50)
    expect(admitted).toBe(0)
    expect(t.kit.callCount).toBe(calls)
    expect(contents(await viewOf(session))).toEqual(['U1', 'A1', 'U2', 'A2', 'U3', 'A3'])
    gate.resolve('copied')
    expect(await sampling).toEqual({ ok: true, value: 'copied' })
    expect(await withTimeout(sending, 3000, 'send after work')).toEqual({})
    expect(admitted).toBe(1)
    expect(contents(await viewOf(session))).toEqual([
      'U1',
      'A1',
      'U2',
      'A2',
      'U3',
      'A3',
      'U4',
      'A4'
    ])
  })

  it('WI-8 a send admitted just before (a held turn): busy — the sampling waits for the admission and sees its run', async () => {
    const { t, session } = await rollbackBase()
    const run = held(answer('A4'))
    t.kit.queue(run.step)
    const probe = counted('copied')
    // 发送先进区段（受理阶段），取样紧跟其后：drain 等它受理完
    const sending = session.submitUser('U4')
    const sampled = await session.whileIdle(probe.work)
    expect(sampled).toEqual({ ok: false, reason: 'busy' })
    expect(probe.calls()).toBe(0)
    await run.reached
    run.release()
    expect(await withTimeout(sending, 3000, 'held send')).toEqual({})

    // 在受理回调里（共享区段还没释放）开始的取样：同样 busy
    const second = held(answer('A5'))
    t.kit.queue(second.step)
    let inner: Promise<unknown> | undefined
    const again = session.submitUser('U5', {
      onAdmitted: () => {
        inner = session.whileIdle(probe.work)
      }
    })
    await second.reached
    expect(await inner).toEqual({ ok: false, reason: 'busy' })
    expect(probe.calls()).toBe(0)
    second.release()
    expect(await withTimeout(again, 3000, 'second send')).toEqual({})
  })

  it('WI-9 work throws E: rejects with E; afterwards a send and another whileIdle work', async () => {
    const { t, session } = await rollbackBase()
    const failure = new Error('copy failed')
    await expect(
      session.whileIdle(async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(session.closed).toBe(false)
    t.kit.queue(answer('A4'))
    expect(await withTimeout(session.submitUser('U4'), 3000, 'send after throw')).toEqual({})
    await expectIdle(session)
  })

  it('WI-10 closed before the call: closed, work not called', async () => {
    const { t, session } = await rollbackBase()
    await t.host.close('s1')
    const opens = t.events.filter((event) => event === 'open:s1').length
    const probe = counted('copied')
    expect(await session.whileIdle(probe.work)).toEqual({ ok: false, reason: 'closed' })
    expect(probe.calls()).toBe(0)
    expect(t.events.filter((event) => event === 'open:s1').length).toBe(opens)
  })
})
