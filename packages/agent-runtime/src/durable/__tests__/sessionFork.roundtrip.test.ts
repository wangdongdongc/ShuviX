/**
 * 会话 fork · 往返（SQLite）：源会话 s1 的 `whileIdle` 里 `VACUUM INTO` 拷成 s2 的文件（与宿主
 * `copyDurableStorage` 同一做法）→ 按路径开那份拷贝 `resetForkedSessionState` → 宿主打开 s2。
 *
 *   RT-1 三轮、已锁：拷贝期间 s1 什么都没发布；s2 的视图与 id 和 s1 一样、没有锁、没建 agent；s2.branchAt(A1)
 *        → s2 [U1, A1]，s1 仍是六条；两边各自发送，请求各带各的历史
 *   RT-2 s1 是被驱动的子会话（标记留着，seam 失败）：收尾过的 s2 打开时 seam 从不为 s2 调用（对照：没收尾的
 *        拷贝 s3 打开时会替 s3 报一次）
 *   RT-3 s1 有一条待送达通知：s2 的第一次发送不落通知；s1 的照样落
 *   RT-4 s1 回退过：整段 fork 显示的是回退后的分支，接着发送也在那上面
 *   RT-5 s2 第一次发送（建锁）之后，当前对话 AgentStateDoc 的 rootSessionId 是 's2'（拷来的是 's1'）
 */
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, SessionStateDoc } from '../docs'
import type { DrivenSettledEvent, DurableSession } from '../durableSession'
import { answer } from './support/faux'
import { copyStorageFile, forkStorage } from './support/fork'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import {
  contents,
  forkedId,
  messageIds,
  noticeTexts,
  rawPublications,
  rollbackBase,
  threeTurns,
  viewOf
} from './support/rollback'
import { allEntries, requestTexts } from './support/transcript'
import { sleep, waitFor } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000

const SIX = ['U1', 'A1', 'U2', 'A2', 'U3', 'A3']

/** 同一批消息换成另一条会话的（消息带着它所属会话的 id，其余逐字相同） */
function inSession(messages: readonly ChatMessage[], sessionId: string): ChatMessage[] {
  return messages.map((message) => ({ ...message, sessionId }))
}

/** fork 成功（拷了、收了尾） */
async function fork(t: TestHost, source: DurableSession, toId: string): Promise<void> {
  expect(await forkStorage(t, source, toId)).toEqual({ ok: true, value: undefined })
}

describe('session fork · copy, reset, open', () => {
  it(
    'RT-1 a three-turn locked session: nothing published during the copy; s2 has the same view and ids, no lock, no agent; s2.branchAt(A1) leaves s1 alone; sends go to their own histories',
    async () => {
      const { t, session: s1, ids } = await rollbackBase()
      const lock = s1.lock
      expect(lock).toBeDefined()
      const before = await viewOf(s1)
      const recorder = rawPublications(s1)
      await fork(t, s1, 's2')
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(s1.lock).toBe(lock)

      const configCalls = t.configCalls.length
      const s2 = await t.open('s2')
      const view = await viewOf(s2)
      expect(view.sessionId).toBe('s2')
      expect(view.conversationId).toBe(before.conversationId)
      expect(view.messages).toStrictEqual(inSession(before.messages, 's2'))
      expect(messageIds(view)).toEqual([ids.u1, ids.a1, ids.u2, ids.a2, ids.u3, ids.a3].map(String))
      expect(view.run.state).toBe('idle')
      expect(s2.lock).toBeUndefined()
      expect((await s2.harness.snapshot(SessionStateDoc, BG))?.lock).toBeUndefined()
      expect(t.configCalls.slice(configCalls)).not.toContain('s2')
      expect(t.mirror).not.toContainEqual(['s2', true])
      expect(s2.isInterrupted()).toBe(false)
      // s1 原样
      expect(await viewOf(s1)).toStrictEqual(before)

      const branched = await s2.branchAt(ids.a1)
      expect(branched).toEqual({ ok: true, conversationId: expect.any(Number) })
      expect(contents(await viewOf(s2))).toEqual(['U1', 'A1'])
      expect(contents(await viewOf(s1))).toEqual(SIX)
      expect((await s1.currentConversation()).id).toBe(before.conversationId)

      const n = t.kit.requests.length
      t.kit.queue(answer('B4'))
      expect(await s2.submitUser('U4')).toEqual({})
      expect(requestTexts(t.kit, n)).toEqual(['user:U1', 'assistant:A1', 'user:U4'])
      t.kit.queue(answer('C4'))
      expect(await s1.submitUser('V4')).toEqual({})
      expect(requestTexts(t.kit, n + 1)).toEqual([
        'user:U1',
        'assistant:A1',
        'user:U2',
        'assistant:A2',
        'user:U3',
        'assistant:A3',
        'user:V4'
      ])
      expect(contents(await viewOf(s2))).toEqual(['U1', 'A1', 'U4', 'B4'])
      expect(contents(await viewOf(s1))).toEqual([...SIX, 'V4', 'C4'])
    },
    TIMEOUT
  )

  it(
    'RT-2 a driven sub-session (marker kept, the seam failed): opening the reset fork never calls the seam for s2; an unreset copy would report for its own id',
    async () => {
      const seam = vi.fn(async (event: DrivenSettledEvent) => {
        if (event.sessionId === 's1') throw new Error('parent offline')
      })
      const t = await makeHost({ onDrivenSettled: seam })
      const s1 = await t.open('s1')
      await primeRoot(s1)
      t.kit.queue(answer('done'))
      expect(
        await s1.submitUser('task', { requestId: 'R', driven: { parentId: 'P', background: true } })
      ).toEqual({})
      await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called for s1')
      expect((await s1.harness.snapshot(SessionStateDoc, BG))?.driven).toBeDefined()

      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      await sleep(80)
      expect(seam.mock.calls.filter(([event]) => event.sessionId === 's2')).toEqual([])
      expect((await s2.harness.snapshot(SessionStateDoc, BG))?.driven).toBeUndefined()
      // s2 自己的一轮也不报（它没被驱动）
      t.kit.queue(answer('own'))
      expect(await s2.submitUser('own turn')).toEqual({})
      await sleep(30)
      expect(seam.mock.calls.filter(([event]) => event.sessionId === 's2')).toEqual([])

      // 对照：不收尾的整拷，打开时的扫描会替拷贝向父会话报一次
      expect(await s1.whileIdle(async () => copyStorageFile(t.file('s1'), t.file('s3')))).toEqual({
        ok: true,
        value: undefined
      })
      await t.open('s3')
      await waitFor(
        () => seam.mock.calls.some(([event]) => event.sessionId === 's3'),
        3000,
        'seam called for the unreset copy'
      )
    },
    TIMEOUT
  )

  it(
    'RT-3 a deferred notice on s1: the first send on s2 lands no notice; s1’s next send still does',
    async () => {
      const { t, session: s1 } = await rollbackBase()
      await s1.harness.commit(async (tx) => {
        const state = await tx.doc(SessionStateDoc)
        state.deferredNotices.push({ requestId: 'n1', text: 'N1', kind: 'background' })
      }, BG)
      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect((await s2.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])

      t.kit.queue(answer('B4'))
      expect(await s2.submitUser('U4')).toEqual({})
      expect(noticeTexts(await allEntries(await s2.currentConversation()))).toEqual([])

      t.kit.queue(answer('C4'))
      expect(await s1.submitUser('V4')).toEqual({})
      const s1Entries = await allEntries(await s1.currentConversation())
      expect(noticeTexts(s1Entries)).toEqual(['N1'])
      expect((await s1.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])
      // 通知恰好排在这次发送之前
      const kinds = s1Entries.filter((entry) => entry.kind !== 'pi.system').map((e) => e.kind)
      expect(kinds.slice(-3)).toEqual(['shuvix.notice', 'pi.user', 'pi.assistant'])
    },
    TIMEOUT
  )

  it(
    'RT-4 after a rollback on s1, a whole fork shows the rolled-back branch and continues on it',
    async () => {
      const { t, session: s1, ids } = await rollbackBase()
      const F = forkedId(await s1.rollbackTo(ids.u2))
      const before = await viewOf(s1)
      expect(contents(before)).toEqual(['U1', 'A1'])

      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect((await s2.currentConversation()).id).toBe(F)
      const view = await viewOf(s2)
      expect(view.conversationId).toBe(F)
      expect(view.messages).toStrictEqual(inSession(before.messages, 's2'))

      const n = t.kit.requests.length
      t.kit.queue(answer('B4'))
      expect(await s2.submitUser('U4')).toEqual({})
      expect(requestTexts(t.kit, n)).toEqual(['user:U1', 'assistant:A1', 'user:U4'])
      expect(s2.lock?.conversationId).toBe(F)
    },
    TIMEOUT
  )

  it(
    "RT-5 after the first send on s2 the current conversation's AgentStateDoc.rootSessionId is 's2' (the copy carried 's1')",
    async () => {
      const t = await makeHost()
      const s1 = await t.open('s1')
      await primeRoot(s1)
      await threeTurns(s1, t)
      const conversation = (await s1.currentConversation()).id
      expect((await s1.harness.snapshot(AgentStateDoc, conversation, BG))?.rootSessionId).toBe('s1')

      await fork(t, s1, 's2')
      const s2 = await t.open('s2')
      expect((await s2.harness.snapshot(AgentStateDoc, conversation, BG))?.rootSessionId).toBe('s1')
      t.kit.queue(answer('B4'))
      expect(await s2.submitUser('U4')).toEqual({})
      const current = (await s2.currentConversation()).id
      expect((await s2.harness.snapshot(AgentStateDoc, current, BG))?.rootSessionId).toBe('s2')
      expect((await s1.harness.snapshot(AgentStateDoc, conversation, BG))?.rootSessionId).toBe('s1')
    },
    TIMEOUT
  )
})
