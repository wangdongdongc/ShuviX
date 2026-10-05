/**
 * P3-03 · 指针变化换挂载（设计稿 P3-03-28..31；PIN-07）：
 *
 *   28 一次提交里 fork + 指针指过去：恰好一次换挂载修订，操作恰好是 `[["r", value]]`；前缀消息 id 不变；
 *      没有生命周期信号
 *   29 换挂载前后的提交：指针提交之后立刻在 fork 上发送 → 最终值含它、= freshMount；之后旧根上的提交
 *      不产生修订
 *   30 没有前缀的新对话：messages 为空、新的 conversationId、一条 `r`
 *   31 指针指向不存在的对话（R11）：视图留在对话 1，不抛错，记警告
 */
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { SessionStateDoc, noticeEntryDraft } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { answer } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { waitFor } from '../../__tests__/support/wait'
import { freshMount, opsOf, recordLifecycle, settleFrames } from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 20000

async function rootTwoTurns(
  session: DurableSession,
  t: Awaited<ReturnType<typeof makeHost>>
): Promise<{ u1: EntryRecord; a1: EntryRecord }> {
  t.kit.queue(answer('A1'), answer('A2'))
  expect(await session.submitUser('U1')).toEqual({})
  expect(await session.submitUser('U2')).toEqual({})
  const entries = await allEntries(await session.currentConversation())
  return { u1: entries[0]!, a1: entries[1]! }
}

async function forkAndPoint(session: DurableSession, at: number): Promise<ConversationId> {
  return session.harness.commit(async (tx) => {
    const fork = await tx.forkConversation(1 as ConversationId, at as never, {
      ownership: { kind: 'ownerless' }
    })
    ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
    return fork.id
  }, BG)
}

describe('P3-03 · fork remount', () => {
  it(
    'P3-03-28 a pointer change remounts: one revision, ops exactly [["r", value]], prefix ids unchanged, no lifecycle',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      const { u1, a1 } = await rootTwoTurns(session, t)
      const proj = await session.projector()
      const h = proj.acquire()
      const lc = recordLifecycle(proj)
      const before = h.state.value.messages.slice(0, 2)
      const ops = opsOf(h.state)
      const forkId = await forkAndPoint(session, a1.id)
      await waitFor(() => h.state.value.conversationId === forkId, 3000, 'remounted')
      await settleFrames()
      expect(ops.revisions).toHaveLength(1)
      expect(ops.revisions[0]!.ops).toEqual([['r', h.state.value]])
      expect(h.state.value.messages.map((m) => m.id)).toEqual([String(u1.id), String(a1.id)])
      expect(h.state.value.messages).toStrictEqual(before)
      expect(lc.signals).toEqual([])
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-29 commits around a remount: a send on the fork right after the pointer commit lands; = freshMount; old-root commits produce no revision',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      const { a1 } = await rootTwoTurns(session, t)
      const proj = await session.projector()
      const h = proj.acquire()
      const forkId = await forkAndPoint(session, a1.id)
      // 不等换挂载的微任务：锁换到 fork 上（销毁后下一次发送按 fork 重建），立刻发送
      t.kit.queue(answer('X-ANSWER'))
      const sending = (async () => {
        await session.destroyAgent()
        return session.submitUser('x')
      })()
      expect(await sending).toEqual({})
      await waitFor(
        () => h.state.value.messages.some((m) => m.content === 'X-ANSWER'),
        3000,
        'fork send visible'
      )
      await settleFrames()
      expect(h.state.value.conversationId).toBe(forkId)
      expect(h.state.value.messages.map((m) => m.content)).toEqual(['U1', 'A1', 'x', 'X-ANSWER'])
      expect(h.state.value).toStrictEqual(await freshMount(session))
      const ops = opsOf(h.state)
      await session.harness.commit(async (tx) => {
        await tx.appendEntry(
          1 as ConversationId,
          noticeEntryDraft({ text: 'old root', kind: 'background' }, 0)
        )
      }, BG)
      await settleFrames()
      expect(ops.revisions).toEqual([])
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it('P3-03-30 fork with no prefix: messages [], the new id, a single r op', async () => {
    const t = await makeHost({ ephemeral: ['s1'] })
    const session = await t.open('s1')
    await rootTwoTurns(session, t)
    const proj = await session.projector()
    const h = proj.acquire()
    const ops = opsOf(h.state)
    const created = await session.harness.commit(async (tx) => {
      const record = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      ;(await tx.doc(SessionStateDoc)).currentConversation = record.id
      return record.id
    }, BG)
    await waitFor(() => h.state.value.conversationId === created, 3000, 'remounted')
    await settleFrames()
    expect(h.state.value.messages).toEqual([])
    expect(ops.revisions).toHaveLength(1)
    expect(ops.revisions[0]!.ops).toEqual([['r', h.state.value]])
    ops.stop()
    h.release()
  })

  it('P3-03-31 a pointer to a missing conversation (R11): stays on conversation 1, no throw, a warning', async () => {
    const t = await makeHost({ ephemeral: ['s1'] })
    const session = await t.open('s1')
    await primeRoot(session)
    const proj = await session.projector()
    const h = proj.acquire()
    const ops = opsOf(h.state)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = 99 as ConversationId
    }, BG)
    await waitFor(
      () => t.warnings.some((w) => w.includes('current conversation 99 does not exist')),
      3000,
      'R11 warning'
    )
    await settleFrames()
    expect(h.state.value.conversationId).toBe(1)
    expect(ops.revisions).toEqual([])
    expect(h.state.value).toStrictEqual(await freshMount(session))
    ops.stop()
    h.release()
  })
})
