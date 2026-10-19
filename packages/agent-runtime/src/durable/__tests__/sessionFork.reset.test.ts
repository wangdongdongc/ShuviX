/**
 * 会话 fork · `resetForkedSessionState`（拷贝收尾：新会话的存储第一次被打开之前，清掉属于源会话那一场的
 * 会话级状态）。存储状态由一条真会话造好、关掉之后按路径另开一份原始存储来收尾与读取。
 *
 *   RS-1 锁、driven-run 标记、两条待送达通知、当前对话 F → 收尾之后锁与标记不在、待送达 []、当前对话仍是 F；
 *        对话、条目、任务、AgentStateDoc 原样
 *   RS-2 收尾关掉交给它的存储（之后同一个文件能再开）
 *   RS-3 幂等：已经干净的存储再收尾一次什么都不变；全新的空存储收尾不抛
 */
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DrivenSettledEvent } from '../durableSession'
import { resetForkedSessionState } from '../sessionFork'
import { answer } from './support/faux'
import { readStorage } from './support/fork'
import { registerHostCleanup, type TestHost } from './support/host'
import { forkedId, rollbackBase } from './support/rollback'
import { waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 15000

/**
 * s1：三轮（已锁）→ 回退到 U2 前（当前对话 F）→ F 上一轮被驱动的发送（父会话的 seam 失败，标记留着；
 * 锁重建在 F 上）→ 两条待送达通知 → 关掉。交回宿主、F 与文件路径。
 */
async function dirtyStorage(): Promise<{ t: TestHost; F: number; file: string }> {
  const seam = vi.fn(async (_event: DrivenSettledEvent) => {
    throw new Error('parent offline')
  })
  const { t, session, ids } = await rollbackBase({ onDrivenSettled: seam })
  const F = forkedId(await session.rollbackTo(ids.u2))
  t.kit.queue(answer('driven-answer'))
  expect(
    await session.submitUser('driven task', {
      requestId: 'R',
      driven: { parentId: 'P', background: true }
    })
  ).toEqual({})
  await waitFor(() => seam.mock.calls.length === 1, 3000, 'seam called')
  await session.harness.commit(async (tx) => {
    const state = await tx.doc(SessionStateDoc)
    state.deferredNotices.push(
      { requestId: 'n1', text: 'N1', kind: 'background' },
      { requestId: 'n2', text: 'N2', kind: 'background', data: { taskId: 't2' } }
    )
  }, BG)
  await withTimeout(t.host.close('s1'), 5000, 'close s1')
  return { t, F, file: t.file('s1') }
}

describe('session fork · resetForkedSessionState', () => {
  it(
    'RS-1 lock, driven marker and deferred notices are cleared; the pointer stays on F; conversations, entries, tasks and AgentStateDoc are untouched',
    async () => {
      const { F, file } = await dirtyStorage()
      const before = await readStorage(file)
      // 前提：四样都在
      expect(before.state?.lock).toBeDefined()
      expect(before.state?.driven).toEqual({
        requestId: 'R',
        parentId: 'P',
        background: true,
        conversationId: F
      })
      expect(before.state?.deferredNotices.map((notice) => notice.requestId)).toEqual(['n1', 'n2'])
      expect(before.state?.currentConversation).toBe(F)
      expect(before.conversations.map((record) => record.id)).toContain(F)
      expect(before.tasks.length).toBeGreaterThan(0)

      await resetForkedSessionState(await openNodeSqliteStorage(file))

      const after = await readStorage(file)
      expect(after.state).toEqual({ currentConversation: F, deferredNotices: [] })
      expect(after.state).not.toHaveProperty('lock')
      expect(after.state).not.toHaveProperty('driven')
      expect(after.conversations).toEqual(before.conversations)
      expect(after.entries).toEqual(before.entries)
      expect(after.tasks).toEqual(before.tasks)
      expect(after.agentStates).toEqual(before.agentStates)
    },
    TIMEOUT
  )

  it(
    'RS-2 it closes the storage it was given; the same file opens again afterwards',
    async () => {
      const { file } = await dirtyStorage()
      const storage = await openNodeSqliteStorage(file)
      const close = vi.spyOn(storage, 'close')
      await resetForkedSessionState(storage)
      expect(close).toHaveBeenCalledTimes(1)
      expect((await readStorage(file)).state?.deferredNotices).toEqual([])
    },
    TIMEOUT
  )

  it(
    'RS-3 idempotent: a second reset of a clean storage changes nothing; a brand-new empty storage resets without throwing',
    async () => {
      const { t, F, file } = await dirtyStorage()
      await resetForkedSessionState(await openNodeSqliteStorage(file))
      const once = await readStorage(file)
      await resetForkedSessionState(await openNodeSqliteStorage(file))
      expect(await readStorage(file)).toEqual(once)
      expect(once.state).toEqual({ currentConversation: F, deferredNotices: [] })

      const empty = t.file('never-used')
      await resetForkedSessionState(await openNodeSqliteStorage(empty))
      const fresh = await readStorage(empty)
      expect(fresh.state?.deferredNotices ?? []).toEqual([])
      expect(fresh.state?.lock).toBeUndefined()
      expect(fresh.state?.driven).toBeUndefined()
    },
    TIMEOUT
  )
})
