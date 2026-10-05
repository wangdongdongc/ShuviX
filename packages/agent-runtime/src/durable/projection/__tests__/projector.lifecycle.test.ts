/**
 * P3-03 · 运行生命周期（设计稿 P3-03-35..40；PIN-04/05/06）：
 *
 *   35 ok：恰好一对 {started, ended ok}，taskId / conversationId / sessionId；started 时已经 busy 或用户消息
 *      已在，ended 时 live 已空、最终消息已在（信号在帧之后的微任务里送出）
 *   36 流式中途中止 → ended aborted
 *   37 退避中中止（没有中止条目，最后一条是 error）→ ended aborted，不是 error（PIN-05）
 *   38 最终失败 → ended error
 *   39 一轮里两个工具轮 + 一次重试 + 中途放下的 steer → 恰好一对 ok
 *   40 (a) 末尾边界放下的 followUp：live.run 一直在 → 一对；消失又出现 → 两对（按提交里观察到的 run 出现
 *          次数）；(b) 空闲压缩、hook agent（辅助）、通知写入 → 没有根信号（hook agent 自己的一对带 agentId，
 *          PIN-20）；(c) 抛错的监听器不影响别的监听器，也不影响会话
 */
import { LiveDoc, type ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import { answer, callTool, held, modelError, stalled } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { hookRec, hostD, seedAgent, startRun, tasksOf } from '../../__tests__/support/spawn'
import { allEntries } from '../../__tests__/support/transcript'
import { sleep, waitFor, withTimeout } from '../../__tests__/support/wait'
import {
  bare,
  type OpenedProjector,
  readTool,
  recordLifecycle,
  settleFrames,
  streamTool
} from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 25000

async function openWith(
  options: Parameters<typeof makeHost>[0] = {}
): Promise<OpenedProjector & { lc: ReturnType<typeof recordLifecycle> }> {
  const t = await makeHost({ ephemeral: ['s1'], ...options })
  const session = await t.open('s1')
  await primeRoot(session)
  const proj = await session.projector()
  const h = proj.acquire()
  const lc = recordLifecycle(proj, h.state)
  return { t, session, proj, h, lc }
}

const kinds = (lc: ReturnType<typeof recordLifecycle>): (string | undefined)[][] =>
  bare(lc.signals).map((s) => [s.kind, s.kind === 'ended' ? s.reason : undefined])

/** 根对话每次发布之后 `pi.live.run` 在不在（只记变化）—— 「run 出现了几次」 */
function runPresence(session: DurableSession): { appearances: () => number; stop: () => void } {
  let present = false
  let count = 0
  const stop = session.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (
        change.type === 'document' &&
        change.conversationId === 1 &&
        change.record.kind === LiveDoc.definition.kind
      ) {
        const now = (change.value as { run?: unknown } | null)?.run !== undefined
        if (now && !present) count++
        present = now
      }
    }
  })
  return { appearances: () => count, stop }
}

describe('P3-03 · lifecycle reasons', () => {
  it('P3-03-35 ok: one pair; busy or user message at started; live null and the final message at ended', async () => {
    const { t, session, h, lc } = await openWith()
    t.kit.queue(answer('final'))
    expect(await session.submitUser('hi')).toEqual({})
    await settleFrames()
    const taskId = (await tasksOf(session, 1 as ConversationId))[0]!.id
    expect(bare(lc.signals)).toEqual([
      { kind: 'started', sessionId: 's1', conversationId: 1, taskId },
      { kind: 'ended', sessionId: 's1', conversationId: 1, taskId, reason: 'ok' }
    ])
    const [started, ended] = lc.signals
    expect(
      started!.view!.run.state === 'busy' || started!.view!.messages.some((m) => m.role === 'user')
    ).toBe(true)
    expect(ended!.view!.live).toBeNull()
    expect(ended!.view!.messages.at(-1)!.content).toBe('final')
    h.release()
  })

  it(
    'P3-03-36 aborted while streaming → ended{aborted}',
    async () => {
      const { t, session, h, lc } = await openWith()
      const stall = stalled()
      t.kit.queue(stall.step)
      const sending = session.submitUser('go')
      await withTimeout(stall.reached, 5000, 'stalled')
      await session.abort()
      await sending
      await settleFrames()
      expect(kinds(lc)).toEqual([
        ['started', undefined],
        ['ended', 'aborted']
      ])
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-37 aborted during the retry backoff (PIN-05): no aborted entry, the last assistant entry is an error → ended{aborted}',
    async () => {
      const { t, session, h, lc } = await openWith({
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 2000 },
          compaction: { enabled: false }
        }
      })
      t.kit.queue(modelError('503 x'))
      const sending = session.submitUser('go')
      await waitFor(() => h.state.value.run.retry !== undefined, 5000, 'backoff')
      await session.abort()
      await sending
      await settleFrames()
      const assistants = (await allEntries(await session.currentConversation())).filter(
        (e) => e.kind === 'pi.assistant'
      )
      expect(assistants.map((e) => (e.model?.[0] as { stopReason?: string }).stopReason)).toEqual([
        'error'
      ])
      expect(kinds(lc)).toEqual([
        ['started', undefined],
        ['ended', 'aborted']
      ])
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-38 final failure → ended{error}',
    async () => {
      const { t, session, h, lc } = await openWith({
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 5, maxRetries: 2 },
          compaction: { enabled: false }
        }
      })
      t.kit.queue(modelError('503 a'), modelError('503 b'), modelError('503 c'))
      expect((await session.submitUser('go')).code).toBe('model_error')
      await settleFrames()
      expect(kinds(lc)).toEqual([
        ['started', undefined],
        ['ended', 'error']
      ])
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-39 one pair per run: two tool rounds, one retry and a mid-run steer give exactly one started and one ended{ok}',
    async () => {
      const gate = held(callTool('read', { path: 'a' }, 'c1'))
      const { t, session, h, lc } = await openWith({
        tools: [readTool(), streamTool(['x\n'], 50)],
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 5 },
          compaction: { enabled: false }
        }
      })
      t.kit.queue(gate.step, modelError('503 once'), callTool('bash', {}, 'c2'), answer('done'))
      const sending = session.submitUser('work')
      await withTimeout(gate.reached, 5000, 'first request')
      await session.steer('also this')
      gate.release()
      expect(await withTimeout(sending, 10000, 'send')).toEqual({})
      await waitFor(() => session.runState === 'idle', 5000, 'idle')
      await settleFrames()
      expect(h.state.value.messages.some((m) => m.content === 'also this')).toBe(true)
      expect(kinds(lc)).toEqual([
        ['started', undefined],
        ['ended', 'ok']
      ])
      h.release()
    },
    TIMEOUT
  )
})

describe('P3-03-40 continuations and runs that are not runs', () => {
  it(
    '(a) a followUp placed at the final boundary: one pair per appearance of live.run, balanced',
    async () => {
      const { t, session, h, lc } = await openWith()
      const presence = runPresence(session)
      const run = held(answer('a1'))
      t.kit.queue(run.step, answer('a2'))
      const sending = session.submitUser('go')
      await withTimeout(run.reached, 5000, 'first request')
      await session.followUp('then this')
      run.release()
      await sending
      await waitFor(
        () => session.runState === 'idle' && h.state.value.messages.length === 4,
        8000,
        'both turns'
      )
      await settleFrames()
      presence.stop()
      const pairs = presence.appearances()
      expect(pairs).toBeGreaterThanOrEqual(1)
      const signals = bare(lc.signals)
      expect(signals.filter((s) => s.kind === 'started')).toHaveLength(pairs)
      expect(signals.filter((s) => s.kind === 'ended')).toHaveLength(pairs)
      for (let index = 0; index < signals.length; index += 2) {
        expect(signals[index]!.kind).toBe('started')
        expect(signals[index + 1]).toMatchObject({ kind: 'ended', reason: 'ok' })
      }
      h.release()
    },
    TIMEOUT
  )

  it(
    '(b) idle compaction and a notice write give no lifecycle signal',
    async () => {
      const { t, session, h, lc } = await openWith({
        settingsOverrides: {
          retry: { enabled: false },
          compaction: { enabled: false, keepRecentTokens: 200 }
        }
      })
      t.kit.queue(answer('a1'), answer('a2'))
      expect(await session.submitUser('u1')).toEqual({})
      expect(await session.submitUser(`u2 ${'details '.repeat(150)}`)).toEqual({})
      await settleFrames()
      const before = lc.signals.length
      t.kit.queue(answer('SUMMARY'))
      const conversation = await session.currentConversation()
      await withTimeout(
        session.harness.waitForTask(await conversation.compact(undefined, BG), BG),
        5000,
        'compaction'
      )
      expect((await session.writeNotice({ text: 'n', kind: 'background' })).status).toBe(
        'submitted'
      )
      await settleFrames()
      expect(lc.signals.length).toBe(before)
      h.release()
    },
    TIMEOUT
  )

  it(
    '(b) a hook agent (auxiliary) run gives no root signal; its own pair carries agentId (PIN-20)',
    async () => {
      const d = await hostD()
      const proj = await d.session.projector()
      const h = proj.acquire()
      const lc = recordLifecycle(proj)
      const seeded = await seedAgent(d.session, { record: hookRec() })
      d.t.kit.queue(answer('{"title":"t"}'))
      const submission = await startRun(d.session, seeded.conversationId, 'title please')
      await withTimeout(submission.wait(BG), 5000, 'hook run')
      await settleFrames()
      expect(lc.signals.filter((s) => s.agentId === undefined)).toEqual([])
      expect(bare(lc.signals).map((s) => [s.kind, s.agentId, s.conversationId])).toEqual([
        ['started', 'sub-h1', seeded.conversationId],
        ['ended', 'sub-h1', seeded.conversationId]
      ])
      h.release()
    },
    TIMEOUT
  )

  it('(c) a throwing lifecycle listener affects neither other listeners nor the session', async () => {
    const { t, session, proj, h, lc } = await openWith()
    proj.onRunLifecycle(() => {
      throw new Error('lifecycle boom')
    })
    const after = recordLifecycle(proj)
    t.kit.queue(answer('one'), answer('two'))
    expect(await session.submitUser('first')).toEqual({})
    expect(await session.submitUser('second')).toEqual({})
    await sleep(10)
    expect(lc.signals).toHaveLength(4)
    expect(after.signals).toHaveLength(4)
    expect(t.warnings.some((w) => w.includes('lifecycle boom'))).toBe(true)
    expect(session.runState).toBe('idle')
    h.release()
  })
})
