/**
 * 崩溃 / 重开（SQLite，模拟的进程重启）：打开从不续跑；中断状态的判定（R2）；读路径从不开启调度器；
 * continue；中断会话上的发送策略（R5，缺省 abort-then-send，另一种 continue-then-queue）。
 */
import { AssistantEntry, InboxDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import type { InterruptedSendPolicy } from '../seams'
import { answer, callTool, fauxKit, held, modelError, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { holdTool } from './support/tools'
import { allEntries, requestTexts, transcript } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RECOVERY_TIMEOUT = 15000

async function scheduling(session: DurableSession): Promise<string> {
  return (await session.harness.inspect(BG)).scheduling
}

async function placedSubmissionId(session: DurableSession): Promise<number> {
  const placed = (await session.harness.inspect(BG)).submissions.filter(
    (submission) => submission.status === 'placed'
  )
  expect(placed).toHaveLength(1)
  return placed[0]!.id
}

/** 进程 1：发 'hello'，请求挂住时关掉一切；返回进程 2 的宿主（尚未打开会话） */
async function crashMidRequest(
  policy?: InterruptedSendPolicy
): Promise<{ t: TestHost; firstResult: Promise<unknown> }> {
  const first = await makeHost()
  const session = await first.open()
  await primeRoot(session, first.kit)
  const stall = stalled()
  first.kit.queue(stall.step)
  const firstResult = session.submitUser('hello')
  await stall.reached
  await withTimeout(first.host.closeAll(), 5000, 'closeAll process 1')
  const t = await first.restart(policy === undefined ? {} : { interruptedSendPolicy: policy })
  return { t, firstResult }
}

describe('recovery', () => {
  it(
    'RC-01 crash mid-request: reopen is interrupted and paused, never re-sends; continue finishes the run',
    async () => {
      const { t, firstResult } = await crashMidRequest()
      expect(await firstResult).toEqual({ error: expect.any(String), code: 'closed' })
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)
      expect(await scheduling(session)).toBe('paused')
      await sleep(150)
      expect(t.kit.callCount).toBe(0)
      expect(await transcript(await session.currentConversation())).toEqual(['pi.user:hello'])
      const submissionId = await placedSubmissionId(session)

      t.kit.queue(answer('resumed'))
      expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
      expect(await transcript(await session.currentConversation())).toEqual([
        'pi.user:hello',
        'pi.assistant:resumed'
      ])
      expect(session.isInterrupted()).toBe(false)
      expect(session.isBusy()).toBe(false)
      const submission = await session.harness.submission(submissionId as never, BG)
      expect((await withTimeout(submission!.wait(BG), 3000, 'old submission')).status).toBe('done')
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-02 crash mid tool round → interrupted after reopen',
    async () => {
      const gate = deferred()
      const running = deferred()
      const tools = [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
      const first = await makeHost({ tools })
      const session = await first.open()
      await primeRoot(session, first.kit)
      first.kit.queue(callTool('hold'))
      void session.submitUser('go')
      await running.promise
      const t = await first.restart()
      const reopened = await t.open()
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.isBusy()).toBe(false)
      expect(reopened.runState).toBe('interrupted')
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-03 closing an idle session leaves nothing interrupted',
    async () => {
      const first = await makeHost()
      const session = await first.open()
      await primeRoot(session, first.kit)
      first.kit.queue(answer('a1'))
      await session.submitUser('u1')
      const t = await first.restart()
      const reopened = await t.open()
      expect(reopened.isInterrupted()).toBe(false)
      expect(reopened.runState).toBe('idle')
      await sleep(20)
      // 打开时总报一次此刻的状态（PIN-R）：空闲重开报 idle，且只报这一次
      expect(t.statesOf('s1')).toEqual(['idle'])
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-04 a leftover queued input without a run is not an interruption; the item stays queued',
    async () => {
      const first = await makeHost()
      const session = await first.open()
      await primeRoot(session, first.kit)
      const run = held(modelError('boom'))
      first.kit.queue(run.step)
      const failed = session.submitUser('u1')
      await run.reached
      void session.submitUser('F', { whenBusy: 'followUp' })
      await waitFor(async () => {
        const inbox = await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG)
        return (inbox?.items.length ?? 0) === 1
      })
      run.release()
      expect(await failed).toMatchObject({ code: 'model_error' })
      const t = await first.restart()
      const reopened = await t.open()
      expect(reopened.isInterrupted()).toBe(false)
      const inbox = await reopened.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG)
      expect(inbox?.items.map((item) => item.mode)).toEqual(['followUp'])
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-05 read paths never resume the scheduler',
    async () => {
      const { t } = await crashMidRequest()
      const session = await t.open()
      const conversation = await session.currentConversation()
      expect(session.isBusy()).toBe(false)
      await conversation.context(BG)
      const view = await conversation.viewState(BG)
      view.dispose()
      const graph = await session.harness.watchTaskGraph(BG)
      await graph.stop()
      await session.harness.snapshot(LiveDoc, conversation.id, BG)
      await session.setThinkingLevel('high')
      expect((await session.writeNotice({ text: 'N', kind: 'background' })).status).toBe('deferred')
      await sleep(50)
      expect(await scheduling(session)).toBe('paused')
      expect(session.isInterrupted()).toBe(true)
      expect(t.kit.callCount).toBe(0)
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-06 isBusy on an interrupted session is false (R2)',
    async () => {
      const { t } = await crashMidRequest()
      const session = await t.open()
      expect(session.isBusy()).toBe(false)
      expect(session.isInterrupted()).toBe(true)
      expect(session.runState).toBe('interrupted')
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-07 continue on an idle session resolves at once; concurrent continues on an interrupted one share one run',
    async () => {
      const idle = await makeHost()
      const plain = await idle.open()
      await primeRoot(plain, idle.kit)
      expect(await withTimeout(plain.continue(), 2000, 'idle continue')).toEqual({})
      expect(idle.kit.callCount).toBe(0)

      const { t } = await crashMidRequest()
      const session = await t.open()
      t.kit.queue(answer('once'))
      const results = await withTimeout(
        Promise.all([session.continue(), session.continue()]),
        5000,
        'concurrent continue'
      )
      expect(results).toEqual([{}, {}])
      expect(t.kit.callCount).toBe(1)
      expect(await transcript(await session.currentConversation())).toEqual([
        'pi.user:hello',
        'pi.assistant:once'
      ])
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-08 a crash during continue leaves the session interrupted; a second continue completes',
    async () => {
      const { t } = await crashMidRequest()
      const session = await t.open()
      const stall = stalled()
      t.kit.queue(stall.step)
      const continuing = session.continue()
      await stall.reached
      await withTimeout(t.host.closeAll(), 5000, 'closeAll during continue')
      expect(await withTimeout(continuing, 2000, 'continue')).toMatchObject({ code: 'closed' })
      const next = await t.restart()
      const reopened = await next.open()
      expect(reopened.isInterrupted()).toBe(true)
      next.kit.queue(answer('finally'))
      expect(await withTimeout(reopened.continue(), 5000, 'second continue')).toEqual({})
      expect(await transcript(await reopened.currentConversation())).toEqual([
        'pi.user:hello',
        'pi.assistant:finally'
      ])
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-09 default abort-then-send: the interrupted request is never re-sent; the old submission ends aborted',
    async () => {
      const { t } = await crashMidRequest()
      const session = await t.open()
      const oldId = await placedSubmissionId(session)
      t.kit.queue(answer('fresh'))
      expect(await withTimeout(session.submitUser('new'), 5000, 'send')).toEqual({})
      const old = await session.harness.submission(oldId as never, BG)
      expect(await old!.status(BG)).toMatchObject({ status: 'unanswered', reason: 'aborted' })
      expect(t.kit.callCount).toBe(1)
      expect(requestTexts(t.kit, 0).at(-1)).toBe('user:new')
      expect(await transcript(await session.currentConversation())).toEqual([
        'pi.user:hello',
        'pi.user:new',
        'pi.assistant:fresh'
      ])
    },
    RECOVERY_TIMEOUT
  )

  it(
    "RC-10 whenBusy 'reject' on an interrupted session applies the interrupted-send policy, not busy",
    async () => {
      const { t } = await crashMidRequest()
      const session = await t.open()
      t.kit.queue(answer('fresh'))
      expect(await session.submitUser('new', { whenBusy: 'reject' })).toEqual({})

      const queued = await crashMidRequest('continue-then-queue')
      const other = await queued.t.open()
      queued.t.kit.queue(answer('old'), answer('new'))
      expect(
        await withTimeout(other.submitUser('new', { whenBusy: 'reject' }), 5000, 'queued send')
      ).toEqual({})
      expect(queued.t.kit.callCount).toBe(2)
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-11 continue-then-queue: the interrupted run finishes first, then the new message runs as a follow-up',
    async () => {
      const { t } = await crashMidRequest('continue-then-queue')
      const session = await t.open()
      const oldId = await placedSubmissionId(session)
      t.kit.queue(answer('old'), answer('new'))
      expect(await withTimeout(session.submitUser('new'), 5000, 'send')).toEqual({})
      expect(await transcript(await session.currentConversation())).toEqual([
        'pi.user:hello',
        'pi.assistant:old',
        'pi.user:new',
        'pi.assistant:new'
      ])
      const old = await session.harness.submission(oldId as never, BG)
      expect((await old!.status(BG)).status).toBe('done')
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-12 an idle restart keeps the current conversation, thinking level and entries',
    async () => {
      const first = await makeHost()
      const session = await first.open()
      await primeRoot(session, first.kit)
      first.kit.queue(answer('a1'))
      await session.submitUser('u1')
      const root = await session.currentConversation()
      const userEntry = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
      const fork = await root.fork(userEntry.id, { ownership: { kind: 'ownerless' } }, BG)
      await session.harness.commit(async (tx) => {
        ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
      }, BG)
      await session.setThinkingLevel('high')
      const before = await transcript(root)
      const t = await first.restart()
      const reopened = await t.open()
      expect(reopened.isInterrupted()).toBe(false)
      const current = await reopened.currentConversation()
      expect(current.id).toBe(fork.id)
      expect((await current.agent(BG)).thinkingLevel).toBe('high')
      const reopenedRoot = (await reopened.harness.conversation(ROOT_CONVERSATION_ID, BG))!
      expect(await transcript(reopenedRoot)).toEqual(before)
    },
    RECOVERY_TIMEOUT
  )

  it(
    'RC-13 a partial answer committed before the crash becomes an aborted assistant entry before the final answer',
    async () => {
      const first = await makeHost({ kit: fauxKit({ tokensPerSecond: 20 }) })
      const session = await first.open()
      await primeRoot(session, first.kit)
      first.kit.queue(answer(`partial ${'words '.repeat(200)}`))
      void session.submitUser('hello')
      const conversation = await session.currentConversation()
      await waitFor(
        async () =>
          (await session.harness.snapshot(LiveDoc, conversation.id, BG))?.generation?.message !==
          undefined,
        5000,
        'partial committed'
      )
      const t = await first.restart()
      const reopened = await t.open()
      expect(reopened.isInterrupted()).toBe(true)
      t.kit.queue(answer('final'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      const entries = (await allEntries(await reopened.currentConversation())).filter(
        (entry) => entry.kind !== 'pi.system'
      )
      expect(entries.map((entry) => entry.kind)).toEqual([
        'pi.user',
        'pi.assistant',
        'pi.assistant'
      ])
      const partial = entries[1]!
      expect(AssistantEntry.is(partial)).toBe(true)
      expect(partial.model?.[0]).toMatchObject({ role: 'assistant', stopReason: 'aborted' })
      expect((await transcript(await reopened.currentConversation())).at(-1)).toBe(
        'pi.assistant:final'
      )
    },
    RECOVERY_TIMEOUT
  )
})
