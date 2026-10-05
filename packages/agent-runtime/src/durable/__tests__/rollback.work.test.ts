/**
 * P3-10a · 回退时在跑 / 排队 / 子 agent / 被中断（设计稿 P3-10a-13..18）：
 *
 *   13 忙：原来的 submitUser 落定不挂住；旧分支上留一条 stopReason 'aborted' 的助手条目，fork 里没有；
 *      runState idle；挂起的询问取消（asks []）；生命周期：旧 run 的 ended{aborted}，之后没有 started
 *   14 旧分支上排着的 followUp：它的提交落定且从没被放下；不在 F 上；view.queue []
 *   15 派生的子 agent 一并中止：前台的（流式中途）与后台的（锚名下）任务都终结且带中止标记；AgentStateDoc
 *      记录留着，F 上不重建任何子 agent；子 agent 视图 idle，会话 idle
 *   16 被中断（PIN-26）：runState idle、isInterrupted false，onRunStateChange 报 idle 恰好一次；被中断的
 *      任务终结；下一次发送在 F 上跑，没有对根的「先中止再发送」
 *   17 没锁也停（PIN-21）：锁重建失败的被中断会话（K12）照样中止、idle、没有 agent_closing；没锁、空闲、
 *      只有通知的会话照样 fork，没有 agent_closing、没有 onLockChange
 *   18 通知落在 fork 上（PIN-23）：被中断会话的推迟通知 N1、合并窗口里的通知 N2 —— 都不落在被放弃的分支上，
 *      各自在 F 上恰好一条（下一次发送之后也是）
 *
 * 18 的说明：设计稿把 N1（推迟，要求被中断）与 N2（合并窗口，要求空闲且允许自动续跑）放在同一个会话里，
 * 这两个前提互斥（被中断时 `notify` 直接写 / 推迟）。这里拆成两个场景各验一次。
 */
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import { LiveDoc, ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, SessionStateDoc } from '../docs'
import {
  freshAgentMount,
  recordLifecycle,
  settleFrames
} from '../projection/__tests__/projectorSupport'
import { crashWith } from './support/crash'
import { answer, callTool, fauxKit, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import {
  contents,
  entriesOf,
  forkedId,
  noticeTexts,
  rollbackBase,
  threeTurns,
  viewOf,
  type BaseIds
} from './support/rollback'
import {
  callAgent,
  firstChild,
  hostD,
  queueRouted,
  seedAgent,
  startRun,
  taskRecord,
  tasksOf
} from './support/spawn'
import { askingTool } from './support/tools'
import { allEntries, transcript } from './support/transcript'
import { sleep, waitFor, withTimeout } from './support/wait'
import type { DurableSession } from '../durableSession'

registerHostCleanup()

const TIMEOUT = 20000

async function allTerminal(session: DurableSession, conversationId: number): Promise<boolean> {
  const tasks = await tasksOf(session, conversationId as ConversationId)
  return tasks.length > 0 && tasks.every((task) => task.state.status === 'terminal')
}

describe('P3-10a · busy, queued, children and interrupted', () => {
  it(
    'P3-10a-13a busy (stalled stream): submitUser settles, the old branch keeps an aborted assistant entry the fork excludes; idle; ended{aborted} and no started',
    async () => {
      const { t, session, ids } = await rollbackBase({ kit: fauxKit({ tokensPerSecond: 40 }) })
      const proj = await session.projector()
      const h = proj.acquire()
      const lc = recordLifecycle(proj)
      t.kit.queue(fauxAssistantMessage([fauxText(`alpha ${'beta '.repeat(600)}`)]))
      const sending = session.submitUser('U4')
      // 流到一半：一份已提交的部分输出（中止时它成为 stopReason 'aborted' 的助手条目）
      await waitFor(
        async () => {
          const message = (await session.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, BG))
            ?.generation?.message
          const part = message?.content?.[0] as { text?: string } | undefined
          return (part?.text ?? '') !== ''
        },
        5000,
        'a committed partial'
      )
      await waitFor(() => lc.signals.length === 1, 3000, 'started')
      const F = forkedId(await withTimeout(session.rollbackTo(ids.u2), 5000, 'rollbackTo'))
      expect(await withTimeout(sending, 3000, 'original submitUser')).toEqual({})
      const old = await entriesOf(session, ROOT_CONVERSATION_ID)
      const last = old.at(-1)!
      expect(last.kind).toBe('pi.assistant')
      expect(last.model?.[0]).toMatchObject({ role: 'assistant', stopReason: 'aborted' })
      const view = await viewOf(session)
      expect(view.conversationId).toBe(F)
      expect(contents(view)).toEqual(['U1', 'A1'])
      expect(view.messages.map((m) => m.id)).not.toContain(String(last.id))
      expect(session.runState).toBe('idle')
      expect(view.run.state).toBe('idle')
      await waitFor(() => h.state.value.conversationId === F, 3000, 'remounted')
      await settleFrames()
      expect(lc.signals.map((signal) => signal.kind)).toEqual(['started', 'ended'])
      expect(lc.signals[1]).toMatchObject({
        kind: 'ended',
        conversationId: ROOT_CONVERSATION_ID,
        reason: 'aborted'
      })
      lc.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-10a-13b busy with a pending ask: the ask is cancelled (asks []) and the run settles',
    async () => {
      let current: DurableSession | undefined
      const t = await makeHost({ tools: [askingTool('askme', () => current!)] })
      const session = (current = await t.open('s1'))
      await primeRoot(session)
      const ids: BaseIds = await threeTurns(session, t)
      t.kit.queue(callTool('askme'))
      const sending = session.submitUser('U4')
      await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
      expect(session.runState).toBe('busy')
      forkedId(await withTimeout(session.rollbackTo(ids.u2), 5000, 'rollbackTo'))
      expect(await withTimeout(sending, 3000, 'original submitUser')).toEqual({})
      expect(session.pendingInputs()).toEqual([])
      expect((await viewOf(session)).asks).toEqual([])
      expect(session.runState).toBe('idle')
    },
    TIMEOUT
  )

  it(
    'P3-10a-14 a followUp queued on the old branch settles without being placed; it is not on F; view.queue []',
    async () => {
      const { t, session, ids } = await rollbackBase()
      const stall = stalled()
      t.kit.queue(stall.step)
      const sending = session.submitUser('U4')
      await stall.reached
      const queued = await session.followUp('q')
      expect(queued.error).toBeUndefined()
      const F = forkedId(await withTimeout(session.rollbackTo(ids.u2), 5000, 'rollbackTo'))
      expect(await withTimeout(sending, 3000, 'original submitUser')).toEqual({})
      const submission = await session.harness.submission(queued.submissionId!, BG)
      const record = await withTimeout(submission!.wait(BG), 3000, 'queued settles')
      expect(record.status).toBe('unanswered')
      expect(record.entry).toBeUndefined()
      expect(await transcript((await session.harness.conversation(F, BG))!)).not.toContain(
        'pi.user:q'
      )
      expect((await viewOf(session)).queue).toEqual([])
    },
    TIMEOUT
  )

  it(
    'P3-10a-15 spawned children are aborted: a foreground child mid-stream and a background child end terminal with abortRequested; records remain; nothing restored on F; idle views',
    async () => {
      const d = await hostD()
      const ids = await threeTurns(d.session, d.t)
      const background = await seedAgent(d.session, { settle: true })
      const B = background.conversationId
      const fg = stalled()
      const bg = stalled()
      queueRouted(d.t.kit, {
        go: [callAgent('explore', 'find X')],
        'find X': [fg.step],
        bg: [bg.step]
      })
      const sending = d.session.submitUser('go')
      await fg.reached
      const C = await firstChild(d.session)
      void startRun(d.session, B, 'bg')
      await bg.reached
      const agentC = d.session.agentIdentity(C)!.callerId!
      expect(d.session.runState).toBe('busy')

      forkedId(await withTimeout(d.session.rollbackTo(ids.u2), 5000, 'rollbackTo'))
      expect(await withTimeout(sending, 3000, 'original submitUser')).toEqual({})
      for (const child of [C, B]) {
        await waitFor(() => allTerminal(d.session, child), 3000, `child ${child} terminal`)
        const last = (await tasksOf(d.session, child)).at(-1)!
        const record = (await taskRecord(d.session, last.id))!
        expect(record.state.status).toBe('terminal')
        expect(record.abortRequested).toBe(true)
        expect((await d.session.harness.snapshot(AgentStateDoc, child, BG))?.agentId).toBeDefined()
      }
      const installed = d.t
        .registryOf('s1')!
        .snapshot()
        .installed()
        .map((extension) => extension.name)
        .filter((name) => name.startsWith('shuvix.agent.'))
      expect(installed).toEqual([])
      expect((await d.session.harness.inspect(BG)).tasks).toEqual([])
      expect((await freshAgentMount(d.session, agentC, C)).run.state).toBe('idle')
      expect((await freshAgentMount(d.session, background.record.agentId!, B)).run.state).toBe(
        'idle'
      )
      expect(d.session.runState).toBe('idle')
    },
    TIMEOUT
  )

  it(
    'P3-10a-16 interrupted (PIN-26): ends idle, isInterrupted false, idle reported once; the interrupted task is terminal; the next send runs on F with no abort-then-send',
    async () => {
      let ids: BaseIds | undefined
      let aborts = 0
      const crashed = await crashWith({
        before: async (session, first) => {
          ids = await threeTurns(session, first)
        },
        restart: { beforeAbort: () => void aborts++ }
      })
      const { t } = crashed
      const session = await t.open('s1')
      expect(session.isInterrupted()).toBe(true)
      expect(session.lock).toBeDefined()
      const states = t.statesOf('s1').length

      const F = forkedId(await withTimeout(session.rollbackTo(ids!.u2), 5000, 'rollbackTo'))
      await sleep(20)
      expect(session.runState).toBe('idle')
      expect(session.isInterrupted()).toBe(false)
      const reported = t.statesOf('s1').slice(states)
      expect(reported.filter((state) => state === 'idle')).toHaveLength(1)
      expect(reported.at(-1)).toBe('idle')
      expect(await allTerminal(session, ROOT_CONVERSATION_ID)).toBe(true)
      expect((await tasksOf(session, ROOT_CONVERSATION_ID)).at(-1)!.state).toMatchObject({
        outcome: { status: 'aborted' }
      })

      const abortsAfterRollback = aborts
      t.kit.queue(answer('again-answer'))
      expect(await withTimeout(session.submitUser('again'), 5000, 'send on F')).toEqual({})
      expect(aborts).toBe(abortsAfterRollback)
      expect((await session.currentConversation()).id).toBe(F)
      expect(contents(await viewOf(session))).toEqual(['U1', 'A1', 'again', 'again-answer'])
    },
    TIMEOUT
  )

  it(
    'P3-10a-17a unlocked with work (PIN-21): an interrupted session whose lock restore failed (K12) is still aborted, ends idle, no agent_closing',
    async () => {
      let ids: BaseIds | undefined
      const crashed = await crashWith({
        before: async (session, first) => {
          ids = await threeTurns(session, first)
        }
      })
      const { t } = crashed
      t.toolHost.failRebuild = new Error('skill folder gone')
      const session = await t.open('s1')
      expect(session.lock).toBeUndefined()
      expect(session.isInterrupted()).toBe(true)

      forkedId(await withTimeout(session.rollbackTo(ids!.u2), 5000, 'rollbackTo'))
      expect(session.runState).toBe('idle')
      expect(session.isInterrupted()).toBe(false)
      expect(await allTerminal(session, ROOT_CONVERSATION_ID)).toBe(true)
      expect(t.broadcastsOf('agent_closing')).toEqual([])
    },
    TIMEOUT
  )

  it('P3-10a-17b unlocked, idle, holding only notices: the fork happens with no agent_closing and no onLockChange', async () => {
    const { t, session, ids } = await rollbackBase()
    expect((await session.writeNotice({ text: 'N', kind: 'background' })).status).toBe('submitted')
    await session.destroyAgent()
    expect(session.lock).toBeUndefined()
    const closing = t.broadcastsOf('agent_closing').length
    const mirror = t.mirror.length
    const F = forkedId(await session.rollbackTo(ids.u2))
    expect((await session.currentConversation()).id).toBe(F)
    expect(t.broadcastsOf('agent_closing').length).toBe(closing)
    expect(t.mirror.length).toBe(mirror)
  })

  it(
    'P3-10a-18a an interrupted session’s deferred notice lands on F exactly once, never on the abandoned branch',
    async () => {
      let ids: BaseIds | undefined
      const crashed = await crashWith({
        before: async (session, first) => {
          ids = await threeTurns(session, first)
        }
      })
      const { t } = crashed
      const session = await t.open('s1')
      expect(session.isInterrupted()).toBe(true)
      await session.notify('N1', { requestId: 'n1' })
      expect(
        (await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices.map(
          (notice) => notice.requestId
        )
      ).toEqual(['n1'])

      const F = forkedId(await withTimeout(session.rollbackTo(ids!.u2), 5000, 'rollbackTo'))
      expect(noticeTexts(await entriesOf(session, ROOT_CONVERSATION_ID))).toEqual([])
      expect(noticeTexts(await entriesOf(session, F))).toEqual(['N1'])
      expect((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])

      t.kit.queue(answer('next-answer'))
      expect(await withTimeout(session.submitUser('next'), 5000, 'send on F')).toEqual({})
      expect(noticeTexts(await entriesOf(session, F))).toEqual(['N1'])
      expect(noticeTexts(await entriesOf(session, ROOT_CONVERSATION_ID))).toEqual([])
    },
    TIMEOUT
  )

  it('P3-10a-18b a merge-window notice is written on F exactly once (no auto-resume run), never on the abandoned branch', async () => {
    const { t, session, ids } = await rollbackBase({ noticeCoalesceMs: 60_000 })
    await session.notify('N2', { requestId: 'n2' })
    // 在合并窗口里：还没落条目、没起 run
    expect(noticeTexts(await allEntries(await session.currentConversation()))).toEqual([])
    const calls = t.kit.callCount

    const F = forkedId(await session.rollbackTo(ids.u2))
    expect(noticeTexts(await entriesOf(session, F))).toEqual(['N2'])
    expect(noticeTexts(await entriesOf(session, ROOT_CONVERSATION_ID))).toEqual([])
    await sleep(30)
    expect(t.kit.callCount).toBe(calls)

    t.kit.queue(answer('next-answer'))
    expect(await session.submitUser('next')).toEqual({})
    expect(noticeTexts(await entriesOf(session, F))).toEqual(['N2'])
  })
})
