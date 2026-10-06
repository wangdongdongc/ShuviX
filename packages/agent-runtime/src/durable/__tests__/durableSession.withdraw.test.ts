/**
 * P3-11 · 撤回排队输入（设计稿 P3-11-01..04，PIN-09 / PIN-14）：
 *
 *   01 撤回一条排着的 followUp：`aborted`；之后的视图 `queue: []`；它的提交落定且从没被放下（没有 `pi.user`
 *      条目、`onPlaced` 从没调用）；放行之后 run 结束，没有为它再起一次生成
 *   02 已经放下（边界上进了转写，run 正带着它）：`already_placed`；没有提交；条目留在 `view.messages` 里
 *   03 范围之外（PIN-09）：落定了的 → `settled`；不认识的 id、子对话里排着的输入、写入（通知）、通知形状的
 *      插话、回退之后旧分支上的那条 → `not_found`。都没有提交，队列不变
 *   04 句柄已关（PIN-14）：`closed`，从不重开
 */
import { InboxDoc, ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import type { DurableSession } from '../durableSession'
import { answer, held, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { contents, forkedId, rawPublications, rollbackBase, viewOf } from './support/rollback'
import { callAgent, firstChild, hostD } from './support/spawn'
import { transcript } from './support/transcript'
import { waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000

async function inboxIds(
  session: DurableSession,
  conversationId: ConversationId = ROOT_CONVERSATION_ID
): Promise<number[]> {
  const inbox = await session.harness.snapshot(InboxDoc, conversationId, BG)
  return (inbox?.items ?? []).map((item) => item.id as number)
}

async function record(session: DurableSession, id: number) {
  const submission = await session.harness.submission(id as never, BG)
  return submission!.status(BG)
}

/** 一次被拒的撤回：结果、没有发布、收件箱不变 */
async function expectRefused(
  session: DurableSession,
  id: number,
  expected: 'not_found' | 'settled' | 'already_placed',
  conversationId: ConversationId = ROOT_CONVERSATION_ID
): Promise<void> {
  const before = await inboxIds(session, conversationId)
  const recorder = rawPublications(session)
  expect(await session.withdrawQueued(id), `submission ${id}`).toBe(expected)
  recorder.stop()
  expect(recorder.publications, `submission ${id}`).toEqual([])
  expect(await inboxIds(session, conversationId)).toEqual(before)
}

describe('P3-11 · withdrawQueued', () => {
  it(
    'P3-11-01 a queued followUp is withdrawn: aborted, view.queue [], settled without being placed, no follow-up generation',
    async () => {
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      const run = held(answer('a1'))
      t.kit.queue(run.step)
      const sending = session.submitUser('u1')
      await run.reached
      const onPlaced = vi.fn()
      const queued = await session.followUp('later', { onPlaced })
      expect(queued.error).toBeUndefined()
      const S = queued.submissionId!
      expect((await viewOf(session)).queue).toEqual([
        { submissionId: S, mode: 'followUp', text: 'later', imageCount: 0 }
      ])

      expect(await session.withdrawQueued(S)).toBe('aborted')
      expect((await viewOf(session)).queue).toEqual([])
      expect(await inboxIds(session)).toEqual([])
      const settled = await record(session, S)
      expect(settled).toMatchObject({ status: 'unanswered', reason: 'aborted' })
      expect(settled.entry).toBeUndefined()

      run.release()
      expect(await withTimeout(sending, 3000, 'u1')).toEqual({})
      await waitFor(async () => !session.isBusy(), 3000, 'idle')
      expect(t.kit.callCount).toBe(1)
      expect(await transcript(await session.currentConversation())).toEqual([
        'pi.user:u1',
        'pi.assistant:a1'
      ])
      expect(onPlaced).not.toHaveBeenCalled()
      // 撤回之后再撤：已经落定
      expect(await session.withdrawQueued(S)).toBe('settled')
    },
    TIMEOUT
  )

  it(
    'P3-11-02 already placed at the boundary: already_placed, no commit, the entry stays in view.messages',
    async () => {
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      const first = held(answer('a1'))
      const second = held(answer('a2'))
      t.kit.queue(first.step, second.step)
      const sending = session.submitUser('u1')
      await first.reached
      const S = (await session.followUp('later')).submissionId!
      first.release()
      await withTimeout(second.reached, 3000, 'follow-up generation')
      expect((await record(session, S)).status).toBe('placed')

      await expectRefused(session, S, 'already_placed')
      const view = await viewOf(session)
      expect(contents(view)).toContain('later')
      expect(view.queue).toEqual([])

      second.release()
      expect(await withTimeout(sending, 3000, 'u1')).toEqual({})
    },
    TIMEOUT
  )

  it(
    'P3-11-03 out of scope (PIN-09): settled → settled; unknown / child input / notice write / notice-shaped steer / old branch → not_found; no commit, queue unchanged',
    async () => {
      // 落定了的、不认识的、写入、通知形状的插话
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      t.kit.queue(answer('a0'))
      const done = (await session.followUp('idle follow-up')).submissionId!
      await withTimeout(
        (await session.harness.submission(done as never, BG))!.wait(BG),
        3000,
        'idle follow-up settles'
      )
      await expectRefused(session, done, 'settled')
      await expectRefused(session, 999_999, 'not_found')

      const run = held(answer('a1'))
      t.kit.queue(run.step)
      const sending = session.submitUser('u1')
      await run.reached
      const write = await session.writeNotice({ text: 'N', kind: 'background' })
      expect(write.status).toBe('submitted')
      const noticeSteer = await session.steer('<background-task id="7">exit 0</background-task>')
      const user = await session.steer('mine')
      expect((await viewOf(session)).queue.map((item) => item.submissionId)).toEqual([
        user.submissionId
      ])
      expect(await inboxIds(session)).toEqual([
        write.submissionId,
        noticeSteer.submissionId,
        user.submissionId
      ])
      await expectRefused(session, write.submissionId!, 'not_found')
      await expectRefused(session, noticeSteer.submissionId!, 'not_found')
      t.kit.queue(answer('a2'))
      run.release()
      expect(await withTimeout(sending, 3000, 'u1')).toEqual({})
    },
    TIMEOUT
  )

  it(
    "P3-11-03 a child conversation's queued input → not_found; the child's inbox is untouched",
    async () => {
      const d = await hostD()
      const { session, t } = d
      const childRun = held(answer('found'))
      t.kit.queue(callAgent('explore', 'find X'), childRun.step, answer('A2'))
      const sending = session.submitUser('U2')
      await withTimeout(childRun.reached, 5000, 'child generation')
      const C = await firstChild(session)
      const child = (await session.harness.conversation(C, BG))!
      const queued = await child.submit(
        { type: 'input', content: 'child-q', whenBusy: 'followUp' },
        BG
      )
      expect(await inboxIds(session, C)).toEqual([queued.id])
      await expectRefused(session, queued.id, 'not_found', C)
      // 收尾：自己撤掉子对话里的那条，再放行
      expect(await session.harness.abortSubmission(queued.id, BG, C)).toBe('aborted')
      childRun.release()
      expect(await withTimeout(sending, 5000, 'U2')).toEqual({})
    },
    TIMEOUT
  )

  it(
    'P3-11-03 an old-branch item after rollbackTo → not_found',
    async () => {
      const { t, session, ids } = await rollbackBase()
      const stall = stalled()
      t.kit.queue(stall.step)
      const sending = session.submitUser('U4')
      await stall.reached
      const S = (await session.followUp('q')).submissionId!
      forkedId(await withTimeout(session.rollbackTo(ids.u2), 5000, 'rollbackTo'))
      expect(await withTimeout(sending, 3000, 'U4')).toEqual({})
      await expectRefused(session, S, 'not_found')
    },
    TIMEOUT
  )

  it('P3-11-04 a closed handle: closed, never a reopen', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session)
    await t.host.close('s1')
    const opens = t.events.filter((event) => event === 'open:s1').length
    expect(await session.withdrawQueued(1)).toBe('closed')
    expect(t.events.filter((event) => event === 'open:s1').length).toBe(opens)
    expect(t.host.get('s1')).toBeUndefined()
    expect(session.closed).toBe(true)
  })
})
