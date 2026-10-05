/**
 * P2-09 · 重新挂上（re-attach，`submitUser` 带一个当前对话里已有的 requestId）：
 *
 *  - 已落定 → 直接读结果（纯读：不建 agent、不开启调度器、不写显示侧车、不调受理回调）；
 *  - 没落定 → 跳过忙拒绝、中断策略、发送前送达、日期通知、显示侧车，等那条输入落定；被中断时按
 *    「继续」的准备续上（不等空闲；推迟的通知在它的下一个边界落下）；
 *  - 排着队却没有 run → 立刻 `{ code: 'queued' }`；同一 id 是写入 → `{ error }`；
 *  - requestId 的作用域是当前对话（旁支 / 回退 fork 里旧的 id 是新的）；
 *  - G 段：另一种中断策略（continue-then-queue）下仍然成立。
 *
 * 重启用例都用 SQLite、真实计时器、约 15 秒的超时。
 */
import {
  InboxDoc,
  ROOT_CONVERSATION_ID,
  type SubmissionId,
  type SubmissionRecord
} from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, DisplayDoc, SessionStateDoc } from '../docs'
import type { DurableSession, SubmitResult } from '../durableSession'
import { recordPublications } from './support/commits'
import { crashWith } from './support/crash'
import { answer, held, modelError } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { allEntries, requestTexts, transcript } from './support/transcript'
import { sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID
const D1 = '2026-10-04'
const D2 = '2026-10-05'

async function scheduling(session: DurableSession): Promise<string> {
  return (await session.harness.inspect(BG)).scheduling
}

async function lines(session: DurableSession): Promise<string[]> {
  return transcript(await session.currentConversation())
}

async function inboxModes(session: DurableSession): Promise<string[]> {
  const inbox = await session.harness.snapshot(InboxDoc, ROOT, BG)
  return (inbox?.items ?? []).map((item) => item.mode)
}

async function placedSubmissionId(session: DurableSession): Promise<SubmissionId> {
  const placed = (await session.harness.inspect(BG)).submissions.filter(
    (submission) => submission.status === 'placed'
  )
  expect(placed).toHaveLength(1)
  return placed[0]!.id
}

async function byRequest(
  session: DurableSession,
  requestId: string,
  conversationId = ROOT
): Promise<SubmissionRecord | undefined> {
  return session.harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), BG)
}

async function submissionStatus(
  session: DurableSession,
  id: SubmissionId
): Promise<SubmissionRecord> {
  return (await session.harness.submission(id, BG))!.status(BG)
}

/** 一个 promise 此刻落定了没有（只看标记，不等它） */
function track<T>(promise: Promise<T>): {
  readonly settled: boolean
  readonly promise: Promise<T>
} {
  const state = { settled: false, promise }
  void promise.then(
    () => (state.settled = true),
    () => (state.settled = true)
  )
  return state
}

describe('re-attach · settled and in-process', () => {
  it('P2-09-01 idle, settled done: resolves {} at once; no run, no entry, no display, no onAdmitted, no publication', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1', { requestId: 'q1' })).toEqual({})
    const recorder = recordPublications(session.harness)
    const onAdmitted = vi.fn()
    const result = await withTimeout(
      session.submitUser('OTHER', {
        requestId: 'q1',
        whenBusy: 'reject',
        display: { text: 'x' },
        onAdmitted
      }),
      1000,
      're-attach'
    )
    recorder.stop()
    expect(result).toEqual({})
    expect(t.kit.callCount).toBe(1)
    expect(await lines(session)).toEqual(['pi.user:u1', 'pi.assistant:a1'])
    expect((await session.harness.snapshot(DisplayDoc, ROOT, BG))?.items).not.toHaveProperty('q1')
    expect(onAdmitted).not.toHaveBeenCalled()
    expect(recorder.publications).toEqual([])
  })

  it(
    'P2-09-02 a settled error maps to the same result, also after a restart (paused, no request)',
    async () => {
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      t.kit.queue(modelError('boom'))
      const original = await session.submitUser('u1', { requestId: 'q1' })
      expect(original).toEqual({ error: 'boom', code: 'model_error' })
      expect(await session.submitUser('again', { requestId: 'q1' })).toEqual(original)
      expect(t.kit.callCount).toBe(1)

      const t2 = await t.restart()
      const reopened = await t2.open()
      expect(await reopened.submitUser('again', { requestId: 'q1' })).toEqual(original)
      expect(await scheduling(reopened)).toBe('paused')
      await sleep(50)
      expect(t2.kit.callCount).toBe(0)
    },
    RESTART_TIMEOUT
  )

  it('P2-09-03 busy with the same submission: the re-attach waits (never busy) and both resolve {}', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    const run = held(answer('a'))
    t.kit.queue(run.step)
    const a = session.submitUser('go', { requestId: 'q' })
    await run.reached
    const onAdmitted = vi.fn()
    const b = track(session.submitUser('go', { requestId: 'q', onAdmitted }))
    await sleep(50)
    expect(b.settled).toBe(false)
    run.release()
    expect(await a).toEqual({})
    expect(await b.promise).toEqual({})
    expect(await lines(session)).toEqual(['pi.user:go', 'pi.assistant:a'])
    expect(t.kit.callCount).toBe(1)
    expect(await inboxModes(session)).toEqual([])
    expect(onAdmitted).not.toHaveBeenCalled()
  })

  it("P2-09-04 busy with another run, the id is a queued follow-up: no busy error; resolves after F's own answer", async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    const run = held(answer('a1'))
    t.kit.queue(run.step, answer('aF'))
    const first = session.submitUser('u1')
    await run.reached
    const queued = session.submitUser('F', { requestId: 'f', whenBusy: 'followUp' })
    await waitFor(async () => (await inboxModes(session)).length === 1, 3000, 'queued')
    const reattach = track(session.submitUser('F', { requestId: 'f' }))
    await sleep(50)
    expect(reattach.settled).toBe(false)
    expect(await inboxModes(session)).toEqual(['followUp'])
    run.release()
    expect(await reattach.promise).toEqual({})
    // 落定那一刻 F 的回答已经在了
    expect(await lines(session)).toEqual([
      'pi.user:u1',
      'pi.assistant:a1',
      'pi.user:F',
      'pi.assistant:aF'
    ])
    expect(await first).toEqual({})
    expect(await queued).toEqual({})
    expect(t.kit.callCount).toBe(2)
  })
})

describe('re-attach · interrupted sessions', () => {
  it(
    'P2-09-05 headline: re-sending the interrupted run’s own id resumes it (same submission, done) — never aborts it',
    async () => {
      const beforeAbort = vi.fn()
      const { t, firstResult } = await crashWith({
        text: 'task',
        requestId: 'R',
        restart: { beforeAbort }
      })
      expect(await firstResult).toMatchObject({ code: 'closed' })
      const session = await t.open()
      const oldId = await placedSubmissionId(session)
      t.kit.queue(answer('done'))
      expect(
        await withTimeout(session.submitUser('task', { requestId: 'R' }), 5000, 're-attach')
      ).toEqual({})
      expect(await submissionStatus(session, oldId)).toMatchObject({ status: 'done' })
      expect(t.kit.callCount).toBe(1)
      expect(requestTexts(t.kit, 0).at(-1)).toBe('user:task')
      expect(await lines(session)).toEqual(['pi.user:task', 'pi.assistant:done'])
      expect(beforeAbort).not.toHaveBeenCalled()
      expect(session.isInterrupted()).toBe(false)
      await waitFor(() => t.statesOf('s1').length >= 3, 3000, 'states')
      expect(t.statesOf('s1')).toEqual(['interrupted', 'busy', 'idle'])
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-06 an interrupted re-attach skips the date notice and the display sidecar, and places deferred notices at the next boundary',
    async () => {
      const { t } = await crashWith({
        text: 'task',
        requestId: 'R',
        host: { today: () => D1 },
        restart: { today: () => D2 },
        before: async (session, first) => {
          first.kit.queue(answer('a0'))
          expect(await session.submitUser('u0')).toEqual({})
        }
      })
      const session = await t.open()
      expect(
        await session.writeNotice({ text: 'N', kind: 'background', requestId: 'n' })
      ).toMatchObject({ status: 'deferred' })
      t.kit.queue(answer('done'))
      expect(
        await withTimeout(
          session.submitUser('task', { requestId: 'R', display: { text: 'd' } }),
          5000,
          're-attach'
        )
      ).toEqual({})
      await waitFor(
        async () => (await lines(session)).includes('shuvix.notice:N'),
        3000,
        'notice placed'
      )
      expect((await lines(session)).slice(-3)).toEqual([
        'pi.user:task',
        'pi.assistant:done',
        'shuvix.notice:N'
      ])
      const dates = (await allEntries(await session.currentConversation())).filter(
        (entry) =>
          entry.kind === 'shuvix.notice' && (entry.data as { kind?: string }).kind === 'date'
      )
      expect(dates).toEqual([])
      expect((await session.harness.snapshot(AgentStateDoc, ROOT, BG))?.lastAnnouncedDate).toBe(D1)
      expect((await session.harness.snapshot(DisplayDoc, ROOT, BG))?.items).not.toHaveProperty('R')
      expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])

      t.kit.queue(answer('ok'))
      expect(await session.submitUser('next')).toEqual({})
      const tail = (await allEntries(await session.currentConversation())).slice(-3)
      expect(tail.map((entry) => entry.kind)).toEqual(['shuvix.notice', 'pi.user', 'pi.assistant'])
      expect(tail[0]!.data as { kind?: string; date?: string }).toMatchObject({
        kind: 'date',
        date: D2
      })
      expect((await lines(session)).slice(-2)).toEqual(['pi.user:next', 'pi.assistant:ok'])
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-07 interrupted, but the re-sent id is already settled: {} at once; nothing resumes, nothing aborts',
    async () => {
      const beforeAbort = vi.fn()
      const { t } = await crashWith({
        text: 'b',
        restart: { beforeAbort },
        before: async (session, first) => {
          first.kit.queue(answer('a-answer'))
          expect(await session.submitUser('a', { requestId: 'R1' })).toEqual({})
        }
      })
      const session = await t.open()
      const placed = await placedSubmissionId(session)
      expect(
        await withTimeout(session.submitUser('a', { requestId: 'R1' }), 1000, 're-attach')
      ).toEqual({})
      expect(await scheduling(session)).toBe('paused')
      expect(session.isInterrupted()).toBe(true)
      await sleep(150)
      expect(t.kit.callCount).toBe(0)
      expect(beforeAbort).not.toHaveBeenCalled()
      expect(await submissionStatus(session, placed)).toMatchObject({ status: 'placed' })
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-08 interrupted, the id is queued behind the interrupted run: resumes without the policy; resolves after aF',
    async () => {
      const beforeAbort = vi.fn()
      const { t } = await crashWith({
        text: 'u1',
        followUp: { text: 'F', requestId: 'f' },
        restart: { beforeAbort }
      })
      const session = await t.open()
      const u1 = await placedSubmissionId(session)
      t.kit.queue(answer('a1'), answer('aF'))
      expect(
        await withTimeout(session.submitUser('F', { requestId: 'f' }), 5000, 're-attach')
      ).toEqual({})
      expect(await lines(session)).toEqual([
        'pi.user:u1',
        'pi.assistant:a1',
        'pi.user:F',
        'pi.assistant:aF'
      ])
      expect(await submissionStatus(session, u1)).toMatchObject({ status: 'done' })
      expect(t.kit.callCount).toBe(2)
      expect(beforeAbort).not.toHaveBeenCalled()
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-09-09 an unknown id on an interrupted session takes the fresh path (abort-then-send)',
    async () => {
      const beforeAbort = vi.fn()
      const { t } = await crashWith({ restart: { beforeAbort } })
      const session = await t.open()
      const old = await placedSubmissionId(session)
      t.kit.queue(answer('fresh'))
      expect(
        await withTimeout(session.submitUser('new', { requestId: 'R2' }), 5000, 'send')
      ).toEqual({})
      expect(await submissionStatus(session, old)).toMatchObject({
        status: 'unanswered',
        reason: 'aborted'
      })
      expect(t.kit.callCount).toBe(1)
      expect(requestTexts(t.kit, 0).at(-1)).toBe('user:new')
      expect(await lines(session)).toEqual(['pi.user:hello', 'pi.user:new', 'pi.assistant:fresh'])
      expect(beforeAbort).toHaveBeenCalledTimes(1)
      expect(await session.requestState('R2')).toBe('settled')
    },
    RESTART_TIMEOUT
  )
})

describe('re-attach · scope, close and refusals', () => {
  it("P2-09-10 another conversation's id is fresh: a side conversation's id, and a root id after a rollback fork", async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    t.kit.queue(answer('ar'))
    expect(await session.submitUser('r', { requestId: 'Y' })).toEqual({})

    const side = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    await side.configure({ model: t.kit.model }, BG)
    t.kit.queue(answer('side-answer'))
    const sideSubmission = await side.submit({ type: 'input', content: 'side', requestId: 'X' }, BG)
    expect((await sideSubmission.wait(BG)).status).toBe('done')

    t.kit.queue(answer('root-answer'))
    expect(await session.submitUser('rootmsg', { requestId: 'X' })).toEqual({})
    const root = (await session.harness.conversation(ROOT, BG))!
    const rootLines = await transcript(root)
    expect(rootLines).toEqual([
      'pi.user:r',
      'pi.assistant:ar',
      'pi.user:rootmsg',
      'pi.assistant:root-answer'
    ])

    const firstAnswer = (await allEntries(root)).find((entry) => entry.kind === 'pi.assistant')!
    const fork = await root.fork(firstAnswer.id, { ownership: { kind: 'ownerless' } }, BG)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
    }, BG)
    t.kit.queue(answer('fork-answer'))
    expect(await session.submitUser('again', { requestId: 'Y' })).toEqual({})
    expect(await transcript(fork)).toEqual([
      'pi.user:r',
      'pi.assistant:ar',
      'pi.user:again',
      'pi.assistant:fork-answer'
    ])
    expect(await transcript(root)).toEqual(rootLines)
  })

  it('P2-09-11 closing during a re-attach wait: both the original and the re-attach resolve closed', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    const run = held(answer('never'))
    t.kit.queue(run.step)
    const a = session.submitUser('go', { requestId: 'q' })
    await run.reached
    const b = session.submitUser('go', { requestId: 'q' })
    await sleep(20)
    await withTimeout(t.host.close('s1'), 5000, 'close')
    const results: SubmitResult[] = await withTimeout(Promise.all([a, b]), 3000, 'both settle')
    for (const result of results) {
      expect(result).toEqual({ error: expect.any(String), code: 'closed' })
    }
  })

  it('P2-09-12 the id belongs to a write: { error } without a code; nothing placed, nothing run, nothing thrown', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    expect(
      await session.writeNotice({ text: 'W', kind: 'background', requestId: 'w' })
    ).toMatchObject({ status: 'submitted' })
    const result = await session.submitUser('x', { requestId: 'w' })
    expect(result.error).toMatch(/type write/)
    expect(result).not.toHaveProperty('code')
    expect(await lines(session)).toEqual(['shuvix.notice:W'])
    await sleep(50)
    expect(t.kit.callCount).toBe(0)
  })

  it('P2-09-13 a queued leftover with no run: { code: queued } at once — never hangs; the inbox keeps F', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    const run = held(modelError('boom'))
    t.kit.queue(run.step)
    const first = session.submitUser('u1')
    await run.reached
    void session.submitUser('F', { requestId: 'f', whenBusy: 'followUp' })
    await waitFor(async () => (await inboxModes(session)).length === 1, 3000, 'queued')
    run.release()
    expect(await first).toEqual({ error: 'boom', code: 'model_error' })
    const calls = t.kit.callCount
    const result = await withTimeout(session.submitUser('F', { requestId: 'f' }), 500, 're-attach')
    expect(result).toEqual({ error: expect.stringContaining('queued'), code: 'queued' })
    expect(await inboxModes(session)).toEqual(['followUp'])
    expect(t.kit.callCount).toBe(calls)
  })

  it('P2-09-14 a settled re-attach needs no agent: no creation, no config read, no ToolHost call', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1', { requestId: 'q1' })).toEqual({})
    await withTimeout(session.destroyAgent(), 5000, 'destroy')
    expect(session.lock).toBeUndefined()
    const configCalls = t.configCalls.length
    const resolveCalls = t.toolHost.resolveCalls.length
    const builtinCalls = t.toolHost.builtinCalls.length
    expect(await session.submitUser('u1', { requestId: 'q1' })).toEqual({})
    expect(session.lock).toBeUndefined()
    expect(t.configCalls).toHaveLength(configCalls)
    expect(t.toolHost.resolveCalls).toHaveLength(resolveCalls)
    expect(t.toolHost.builtinCalls).toHaveLength(builtinCalls)
  })

  it('P2-09-15 a re-attach leaves the coalescing window and the user-stop flag alone', async () => {
    const t = await makeHost({ noticeCoalesceMs: 200 })
    const session = await t.open()
    await primeRoot(session)
    t.kit.queue(answer('a1'))
    expect(await session.submitUser('u1', { requestId: 'q1' })).toEqual({})

    // (a) 窗口里的通知不被带走：窗口到期照常自动续跑
    t.kit.queue(answer('ack'))
    await session.notify('N')
    expect(await session.submitUser('u1', { requestId: 'q1' })).toEqual({})
    await waitFor(
      async () => (await lines(session)).includes('pi.assistant:ack'),
      3000,
      'auto-resume after the window'
    )
    expect((await lines(session)).slice(-2)).toEqual(['pi.user:N', 'pi.assistant:ack'])

    // (b) 显式喊停之后重新挂上不解除它：通知照样只写不跑
    await withTimeout(session.abort(), 3000, 'abort')
    const calls = t.kit.callCount
    expect(await session.submitUser('u1', { requestId: 'q1' })).toEqual({})
    await session.notify('M')
    await sleep(300)
    expect((await lines(session)).at(-1)).toBe('shuvix.notice:M')
    expect(t.kit.callCount).toBe(calls)
  })
})

describe('re-attach · the alternative interrupted-send policy', () => {
  it(
    'P2-09-45 continue-then-queue: (a) a fresh send queues behind the old run; (b) a re-attach behaves as in -05',
    async () => {
      // (a)
      const a = await crashWith({ restart: { interruptedSendPolicy: 'continue-then-queue' } })
      const first = await a.t.open()
      const old = await placedSubmissionId(first)
      a.t.kit.queue(answer('old'), answer('new-answer'))
      expect(await withTimeout(first.submitUser('new', { requestId: 'R2' }), 5000, 'send')).toEqual(
        {}
      )
      expect(await lines(first)).toEqual([
        'pi.user:hello',
        'pi.assistant:old',
        'pi.user:new',
        'pi.assistant:new-answer'
      ])
      expect(await submissionStatus(first, old)).toMatchObject({ status: 'done' })
      await a.t.host.closeAll()

      // (b)
      const beforeAbort = vi.fn()
      const b = await crashWith({
        text: 'task',
        requestId: 'R',
        restart: { interruptedSendPolicy: 'continue-then-queue', beforeAbort }
      })
      const session = await b.t.open()
      const oldId = await placedSubmissionId(session)
      b.t.kit.queue(answer('done'))
      expect(
        await withTimeout(session.submitUser('task', { requestId: 'R' }), 5000, 're-attach')
      ).toEqual({})
      expect(await submissionStatus(session, oldId)).toMatchObject({ status: 'done' })
      expect(b.t.kit.callCount).toBe(1)
      expect(await lines(session)).toEqual(['pi.user:task', 'pi.assistant:done'])
      expect(beforeAbort).not.toHaveBeenCalled()
      expect(await byRequest(session, 'R')).toMatchObject({ id: oldId, status: 'done' })
    },
    RESTART_TIMEOUT * 2
  )
})
