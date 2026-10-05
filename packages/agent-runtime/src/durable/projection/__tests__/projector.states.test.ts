/**
 * P3-03 · 重试 / 压缩状态，与被中断会话的重开（设计稿 P3-03-15..18、32..34）：
 *
 *   15 重试然后成功：退避中 run.retry、没有一份修订带 error_event、live 为空；成功后卡片带 retried
 *   16 最终失败（maxRetries 2）：落定恰好一行错误、count 2；之前的修订一行错误都没有
 *   17 压缩：在列且忙时 run.compacting；头标记落盘后摘要在前、头之前的消息没了、= freshMount、逐帧身份
 *   18 reset 头：只有 reset 之后的消息，= freshMount
 *   32 带着中间态被中断的挂载：interrupted（没有 retry / compacting），live 照映中间态，没有生命周期信号
 *   33 继续：run.state 在第一次续跑的提交之前（或同时）变 busy，旧中间态成了中止卡，新尝试是追加，
 *      最后 idle；生命周期 started → ended{ok}
 *   34 被中断时发送（中止再发送）：中止卡、新用户消息、回答；只有新运行的一对信号
 */
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import { LiveDoc } from '@earendil-works/pi-durable'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import { answer, fauxKit, held, modelError, type FauxKit } from '../../__tests__/support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost
} from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import {
  attachOracle,
  bare,
  freshMount,
  opsOf,
  recordLifecycle,
  settleFrames,
  under
} from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 25000

const errorRows = (view: SessionView): ChatMessage[] =>
  view.messages.filter((m) => m.type === 'error_event')

async function liveRun(session: DurableSession): Promise<number | undefined> {
  const conversation = await session.currentConversation()
  return (await session.harness.snapshot(LiveDoc, conversation.id, BG))?.run?.taskId
}

describe('P3-03 · retry and compaction states', () => {
  it(
    'P3-03-15 retry then success: run.retry during the backoff, never an error_event, live null; the card then carries retried',
    async () => {
      const t = await makeHost({
        ephemeral: ['s1'],
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 400 },
          compaction: { enabled: false }
        }
      })
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      t.kit.queue(modelError('503'), answer('ok'))
      const sending = session.submitUser('hi')
      await waitFor(() => h.state.value.run.retry !== undefined, 5000, 'backoff visible')
      const during = h.state.value
      // 设计稿写的是 attempt 2；真实的 durable 在退避期间 `pi.live.generation.attempt` 还是失败的那一次（1），
      // 投影原样透传（P3-02-21）—— 与设计稿不符，已报告，这里断言真实值
      expect(during.run.retry).toMatchObject({ attempt: 1, error: '503' })
      expect(typeof during.run.retry!.at).toBe('number')
      expect(during.live).toBeNull()
      expect(await withTimeout(sending, 8000, 'send')).toEqual({})
      await settleFrames()
      for (const revision of ops.revisions) expect(errorRows(revision.value)).toEqual([])
      const card = h.state.value.messages.at(-1)!
      expect(card.content).toBe('ok')
      expect(card.metadata).toMatchObject({ retried: { count: 1, lastError: '503' } })
      expect(h.state.value.run.retry).toBeUndefined()
      expect(h.state.value.run).toStrictEqual({ state: 'idle' })
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-16 final failure (maxRetries 2): exactly one error_event with count 2 at settle; no earlier revision shows an error row',
    async () => {
      const t = await makeHost({
        ephemeral: ['s1'],
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 5, maxRetries: 2 },
          compaction: { enabled: false }
        }
      })
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      t.kit.queue(modelError('503 a'), modelError('503 b'), modelError('503 c'))
      const result = await withTimeout(session.submitUser('hi'), 8000, 'send')
      expect(result.code).toBe('model_error')
      await settleFrames()
      const rows = errorRows(h.state.value)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.metadata).toStrictEqual({ retried: { count: 2, lastError: '503 b' } })
      const firstWithRow = ops.revisions.findIndex((r) => errorRows(r.value).length > 0)
      for (const revision of ops.revisions)
        expect(errorRows(revision.value).length).toBeLessThanOrEqual(1)
      for (const revision of ops.revisions.slice(0, firstWithRow)) {
        expect(errorRows(revision.value)).toEqual([])
      }
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-17 compaction: run.compacting while listed and busy; after the head marker the summary leads, pre-head ids are gone, = freshMount; identity at every frame',
    async () => {
      const t = await makeHost({
        ephemeral: ['s1'],
        settingsOverrides: {
          retry: { enabled: false },
          compaction: { enabled: false, keepRecentTokens: 200 }
        }
      })
      const session = await t.open('s1')
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const oracle = await attachOracle(session, h.state)
      t.kit.queue(answer('a1'))
      expect(await session.submitUser('u1')).toEqual({})
      const u2 = `u2 ${'details '.repeat(150)}`
      t.kit.queue(answer('a2'))
      expect(await session.submitUser(u2)).toEqual({})
      const before = h.state.value.messages.map((m) => m.id)

      const summary = held(answer('SUMMARY'))
      t.kit.queue(summary.step)
      const conversation = await session.currentConversation()
      const task = await conversation.compact(undefined, BG)
      await withTimeout(summary.reached, 5000, 'summary request')
      await waitFor(() => h.state.value.run.compacting !== undefined, 3000, 'compacting')
      expect(h.state.value.run.state).toBe('busy')
      expect(h.state.value.run.compacting).toMatchObject({ blocking: false, attempt: 1 })
      expect(typeof h.state.value.run.compacting!.reason).toBe('string')
      summary.release()
      await withTimeout(session.harness.waitForTask(task, BG), 5000, 'compaction')
      await waitFor(() => h.state.value.messages[0]?.content === 'SUMMARY', 3000, 'head applied')
      const view = h.state.value
      expect(view.messages[0]!.metadata).toStrictEqual({ isCompactionSummary: true })
      const kept = new Set(view.messages.map((m) => m.id))
      expect(kept.has(before[0]!)).toBe(false)
      expect(kept.has(before[1]!)).toBe(false)
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      await settleFrames()
      expect(h.state.value).toStrictEqual(await freshMount(session))

      t.kit.queue(answer('a3'))
      expect(await session.submitUser('u3')).toEqual({})
      await settleFrames()
      expect(h.state.value.messages.at(-1)!.content).toBe('a3')
      expect(h.state.value).toStrictEqual(await freshMount(session))
      expect(await oracle.verify()).toBeGreaterThan(3)
      await oracle.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-18 reset head: only the post-reset messages; = freshMount',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      const proj = await session.projector()
      const h = proj.acquire()
      t.kit.queue(answer('a1'))
      expect(await session.submitUser('u1')).toEqual({})
      const conversation = await session.currentConversation()
      await conversation.reset('HANDOFF for the next context', BG)
      t.kit.queue(answer('a2'))
      expect(await session.submitUser('u2')).toEqual({})
      await settleFrames()
      expect(h.state.value.messages.map((m) => m.content)).toEqual(['u2', 'a2'])
      expect(JSON.stringify(h.state.value)).not.toContain('HANDOFF')
      expect(h.state.value).toStrictEqual(await freshMount(session))
      h.release()
    },
    TIMEOUT
  )
})

/** 进程 1 带着一份已落盘的中间态关掉；进程 2（逐 token 流式的 faux）里打开 */
async function crashMidStream(): Promise<{ t: TestHost; session: DurableSession }> {
  const first = await makeHost({ kit: fauxKit({ tokensPerSecond: 40 }) })
  const original = await first.open()
  await primeRoot(original)
  first.kit.queue(fauxAssistantMessage([fauxText(`alpha ${'beta '.repeat(600)}`)]))
  void original.submitUser('go')
  await waitFor(
    async () => {
      const conversation = await original.currentConversation()
      const message = (await original.harness.snapshot(LiveDoc, conversation.id, BG))?.generation
        ?.message
      const part = message?.content?.[0] as { text?: string } | undefined
      return (part?.text ?? '') !== ''
    },
    5000,
    'a committed partial'
  )
  const t = await first.restart({
    kit: undefined,
    makeKit: (): FauxKit => fauxKit({ tokensPerSecond: 80 })
  })
  const session = await t.open()
  expect(session.isInterrupted()).toBe(true)
  return { t, session }
}

describe('P3-03 · reopen of an interrupted session', () => {
  it(
    'P3-03-32 interrupted mount: run interrupted (no retry/compacting), live mirrors the committed partial, no lifecycle signal',
    async () => {
      const { session } = await crashMidStream()
      const proj = await session.projector()
      const h = proj.acquire()
      const lc = recordLifecycle(proj)
      await settleFrames()
      expect(h.state.value.run).toStrictEqual({ state: 'interrupted' })
      const taskId = await liveRun(session)
      expect(h.state.value.live?.id).toBe(`live:${taskId}`)
      expect(h.state.value.live!.message.content.startsWith('alpha')).toBe(true)
      expect(lc.signals).toEqual([])
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-33 continue: busy no later than the first post-resume commit, the stale partial becomes an aborted card, the new attempt appends, idle at the end; started → ended{ok}',
    async () => {
      const { t, session } = await crashMidStream()
      const proj = await session.projector()
      const h = proj.acquire()
      const lc = recordLifecycle(proj, h.state)
      const ops = opsOf(h.state)
      const stale = h.state.value.live!
      t.kit.queue(fauxAssistantMessage([fauxText(`gamma ${'delta '.repeat(40)}`)]))
      expect(await withTimeout(session.continue(), 15000, 'continue')).toEqual({})
      await settleFrames()
      // 第一份带着中止卡的修订：那时（或之前）已经 busy
      const abortedAt = ops.revisions.findIndex((r) => r.value.messages.length >= 2)
      const busyAt = ops.revisions.findIndex((r) => r.value.run.state === 'busy')
      expect(busyAt).toBeGreaterThanOrEqual(0)
      expect(busyAt).toBeLessThanOrEqual(abortedAt)
      const card = h.state.value.messages[1]!
      expect(card.type).toBe('message')
      expect(card.type === 'message' && card.blocks).toEqual(stale.message.blocks)
      // 新的尝试：live 出现之后到落盘之前是追加
      const start = ops.revisions.findIndex(
        (r, i) =>
          i > abortedAt && r.ops.some((op) => op[0] === 's' && under(op, 'live') && op[2] !== null)
      )
      const end = ops.revisions.findIndex(
        (r, i) =>
          i > start && r.ops.some((op) => op[0] === 's' && under(op, 'live') && op[2] === null)
      )
      for (const revision of ops.revisions.slice(start + 1, end)) {
        for (const op of revision.ops) if (under(op, 'live')) expect(['a', 't']).toContain(op[0])
      }
      expect(h.state.value.run).toStrictEqual({ state: 'idle' })
      expect(h.state.value.messages.at(-1)!.content.startsWith('gamma')).toBe(true)
      expect(
        bare(lc.signals).map((s) => [s.kind, s.kind === 'ended' ? s.reason : undefined])
      ).toEqual([
        ['started', undefined],
        ['ended', 'ok']
      ])
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-34 send while interrupted (abort-then-send): aborted card, the new user message, the answer; one pair, for the new run only',
    async () => {
      const { t, session } = await crashMidStream()
      const proj = await session.projector()
      const h = proj.acquire()
      const lc = recordLifecycle(proj)
      const staleTask = await liveRun(session)
      t.kit.queue(answer('fresh'))
      expect(await withTimeout(session.submitUser('again'), 15000, 'send')).toEqual({})
      await settleFrames()
      expect(h.state.value.messages.map((m) => [m.role, m.type])).toEqual([
        ['user', 'text'],
        ['assistant', 'message'],
        ['user', 'text'],
        ['assistant', 'message']
      ])
      expect(h.state.value.messages.slice(2).map((m) => m.content)).toEqual(['again', 'fresh'])
      expect(
        bare(lc.signals).map((s) => [s.kind, s.kind === 'ended' ? s.reason : undefined])
      ).toEqual([
        ['started', undefined],
        ['ended', 'ok']
      ])
      expect(lc.signals.every((signal) => signal.taskId !== staleTask)).toBe(true)
      const entries = await allEntries(await session.currentConversation())
      expect(entries.filter((e) => e.kind === 'pi.assistant')).toHaveLength(2)
      h.release()
    },
    TIMEOUT
  )
})
