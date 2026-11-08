/**
 * 会话 fork · `resetForkedSessionState`（拷贝收尾：新会话的存储第一次被打开之前，清掉属于源会话那一场的
 * 会话级状态）。存储状态由一条真会话造好、关掉之后按路径另开一份原始存储来收尾与读取。
 *
 *   RS-1 锁、driven-run 标记、两条待送达通知、当前对话 F → 收尾之后锁与标记不在、待送达 []、当前对话仍是 F；
 *        对话、条目、任务、AgentStateDoc 原样
 *   RS-2 收尾关掉交给它的存储（之后同一个文件能再开）
 *   RS-3 幂等：已经干净的存储再收尾一次什么都不变；全新的空存储收尾不抛
 *
 * 留下锁（2026-11-06，fork 沿用源会话的 agent）：
 *   RS-D1 `{ keepLock: true, sessionId: 'fork' }`：锁原样留着、driven 标记与待送达通知照样清、当前对话指针不变，
 *         交回 `{ lockKept: true }`；锁住那个对话的 AgentStateDoc.rootSessionId 改成 'fork'，人设不动
 *   RS-D2 `keepLock` 但存储里没有锁 → `{ lockKept: false }`
 *   RS-D3 不给选项 → 锁删掉、`{ lockKept: false }`，rootSessionId 不动
 *
 * 目标（docs/goal-mode-design.md §8：fork 出来的会话不该和源会话同时朝同一个目标改同一份东西）：
 *   FK-1 源会话进行中的目标：拷贝里置为暂停 `forked`，累计这一段时长、去掉 activeSince，别的（id、原文、轮数、基线、
 *        上次结论）原样；源会话的存储不动
 *   FK-2 不在进行中的（暂停 budget、已达成）原样；源会话没有目标 → 拷贝里读出来也没有目标
 */
import { createSession } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { GoalRecord } from '@shuvix/chat-protocol/types/goal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { goalRecordOf, updateGoal } from '../../goal/goalStore'
import { backgroundContext as BG } from '../context'
import { GoalDoc, SessionStateDoc } from '../docs'
import type { DrivenSettledEvent } from '../durableSession'
import { resetForkedSessionState } from '../sessionFork'
import { answer } from './support/faux'
import { copyStorageFile, readStorage } from './support/fork'
import { makeHost, registerHostCleanup, type TestHost } from './support/host'
import { forkedId, rollbackBase } from './support/rollback'
import { parseLockRecord } from '../lock'
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

  it(
    "RS-D1 keepLock + sessionId: the lock stays, the driven marker and notices go, the pointer stays on F, { lockKept: true }; the locked conversation's rootSessionId becomes 'fork', the persona is untouched",
    async () => {
      const { F, file } = await dirtyStorage()
      const before = await readStorage(file)
      const lockedOn = parseLockRecord(before.state?.lock)?.conversationId
      expect(lockedOn).toBe(F)
      expect(before.agentStates[F]?.rootSessionId).toBe('s1')

      const result = await resetForkedSessionState(await openNodeSqliteStorage(file), {
        keepLock: true,
        sessionId: 'fork'
      })
      expect(result).toEqual({ lockKept: true })

      const after = await readStorage(file)
      expect(after.state).toEqual({
        currentConversation: F,
        deferredNotices: [],
        lock: before.state?.lock
      })
      expect(after.state).not.toHaveProperty('driven')
      expect(after.agentStates[F]).toEqual({ ...before.agentStates[F], rootSessionId: 'fork' })
      expect(after.agentStates[F]?.persona).toBe(before.agentStates[F]?.persona)
      // 别的对话（根）的 AgentStateDoc 不动
      for (const [id, state] of Object.entries(before.agentStates)) {
        if (Number(id) !== F) expect(after.agentStates[Number(id)]).toEqual(state)
      }
      expect(after.conversations).toEqual(before.conversations)
      expect(after.entries).toEqual(before.entries)
      expect(after.tasks).toEqual(before.tasks)
    },
    TIMEOUT
  )

  it(
    'RS-D2 keepLock on a storage without a lock answers { lockKept: false }',
    async () => {
      const { t, file } = await dirtyStorage()
      await resetForkedSessionState(await openNodeSqliteStorage(file))
      expect(
        await resetForkedSessionState(await openNodeSqliteStorage(file), {
          keepLock: true,
          sessionId: 'fork'
        })
      ).toEqual({ lockKept: false })
      const empty = t.file('never-used')
      expect(
        await resetForkedSessionState(await openNodeSqliteStorage(empty), { keepLock: true })
      ).toEqual({ lockKept: false })
    },
    TIMEOUT
  )

  it(
    'RS-D3 no options: the lock is deleted, { lockKept: false }, rootSessionId untouched',
    async () => {
      const { F, file } = await dirtyStorage()
      const before = await readStorage(file)
      expect(await resetForkedSessionState(await openNodeSqliteStorage(file))).toEqual({
        lockKept: false
      })
      const after = await readStorage(file)
      expect(after.state).not.toHaveProperty('lock')
      expect(after.agentStates[F]?.rootSessionId).toBe('s1')
      expect(after.agentStates).toEqual(before.agentStates)
    },
    TIMEOUT
  )
})

// ─── 目标（FK-1 / FK-2） ─────────────────────────────────

const GOAL: GoalRecord = {
  id: 'g_1',
  objective: 'Make e2e green',
  status: 'active',
  setAt: 1000,
  limits: { costUsd: 5, maxTurns: 50, stallTurns: 3 },
  baselineCostUsd: 0.25,
  turns: 4,
  stalls: 1,
  activeMs: 500,
  activeSince: 1000,
  lastVerdict: { verdict: 'not_met', reason: 'tests fail', at: 1800 }
}

/** 源会话 src 写下目标（undefined = 不写）、关掉，再整拷成 fork；交回两份文件 */
async function goalStorages(goal: GoalRecord | undefined): Promise<{ src: string; fork: string }> {
  const t = await makeHost()
  const session = await t.open('src')
  if (goal !== undefined) await updateGoal(session.harness, () => goal)
  await withTimeout(t.host.close('src'), 5000, 'close src')
  copyStorageFile(t.file('src'), t.file('fork'))
  return { src: t.file('src'), fork: t.file('fork') }
}

async function goalDocOf(file: string): Promise<{ raw: unknown; goal: GoalRecord | undefined }> {
  const session = createSession(await openNodeSqliteStorage(file))
  try {
    const doc = await session.snapshot(GoalDoc, BG)
    return { raw: doc, goal: goalRecordOf(doc?.goal) }
  } finally {
    await session.close(BG)
  }
}

describe('session fork · goals', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it(
    'FK-1 an active goal is paused (forked) in the copy only: activeMs accumulated, activeSince dropped, the rest unchanged',
    async () => {
      const { src, fork } = await goalStorages(GOAL)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(4000)
      await resetForkedSessionState(await openNodeSqliteStorage(fork))
      vi.useRealTimers()

      const { activeSince: _dropped, ...rest } = GOAL
      expect((await goalDocOf(fork)).goal).toStrictEqual({
        ...rest,
        status: 'paused',
        pauseReason: 'forked',
        activeMs: 500 + 3000
      })
      expect((await goalDocOf(src)).goal).toStrictEqual(GOAL)
    },
    TIMEOUT
  )

  it(
    'FK-2 non-active goals are copied unchanged; no goal in the source → no goal in the copy',
    async () => {
      const paused: GoalRecord = {
        ...GOAL,
        status: 'paused',
        pauseReason: 'budget',
        activeSince: undefined
      }
      delete paused.activeSince
      const met: GoalRecord = { ...paused, status: 'met', endedAt: 2000 }
      delete met.pauseReason
      for (const goal of [paused, met]) {
        const { fork } = await goalStorages(goal)
        await resetForkedSessionState(await openNodeSqliteStorage(fork))
        expect((await goalDocOf(fork)).goal).toStrictEqual(goal)
      }

      const { fork } = await goalStorages(undefined)
      await resetForkedSessionState(await openNodeSqliteStorage(fork))
      const read = await goalDocOf(fork)
      expect(read.goal).toBeUndefined()
      // 收尾不往拷贝里写目标（文档要么没有、要么没有 goal 键）
      expect((read.raw as { goal?: unknown } | undefined)?.goal).toBeUndefined()
    },
    TIMEOUT
  )
})
