/**
 * P3-07 · `DurableSession.viewSnapshot()`（PIN-13 / PIN-14）—— `message.list`、artifact 等只读读取的来源。
 * 桌面 `messageService.listBySession` 原样交回它的 `messages`，所以这里的「列表」就是
 * `viewSnapshot().messages`；桌面那一层（peek、从不 open、旧格式、网关 / 门面）在
 * apps/desktop 的 projectionReads.test.ts。
 *
 *   02 基本一致：显示侧车 D1、一轮工具、一条通知 → = freshMount；id 是 String(entryId)；payload 不出现
 *   03 压缩：摘要在前（去掉包装）、头之前的 id 没了、= freshMount
 *   04 重试折叠：退避中没有 error_event；成功后卡片带 retried{count:1}；最终失败恰一行 count 2；每一刻 = freshMount
 *   05 流式中间态不进列表；被中断重开：旧中间态不在列表里、isInterrupted 不变、读列表零发布
 *   06 fork 指针：[U1, A1]、沿用根的 id，U2 / A2 不在
 *   07 读你所写：submitUser 落定之后立刻读 —— 有投影挂着 / 没有都含最终回答、= freshMount
 *   07 投影跟上了 → 交回投影的值本身（同一引用）；没跟上 → 现投影一次（深相等、不是同一个对象）
 *   08 读列表不挂载：不调 projector()、不留提交监听；之后挂载的第一份值的 messages = 列表
 *   09 关掉的句柄 → SessionClosedError；host.close 之后 peek 重开，列表与关之前相同、什么都不续跑
 *   10 临时会话从内存给出投影（没有盘上的文件）
 */
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import { LiveDoc, type ConversationId } from '@earendil-works/pi-durable'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { SessionStateDoc } from '../../docs'
import { SessionClosedError, type DurableSession } from '../../durableSession'
import { recordPublications } from '../../__tests__/support/commits'
import {
  answer,
  callTool,
  fauxKit,
  held,
  modelError,
  type FauxKit
} from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import { SessionProjectorImpl } from '../sessionProjector'
import { freshMount, liveCommit, readTool, settleFrames } from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 25000

type Tokens = Record<string, { type: string; id: string; displayText: string; payload: string }>
const K1: Tokens = {
  k1: { type: 'cmd', id: 'deploy', displayText: '/deploy', payload: 'PAYLOAD-K1' }
}
const D1 = { content: 'run {{shuvixInlineToken:k1}} please', tokens: K1 }

const list = async (session: DurableSession): Promise<ChatMessage[]> =>
  (await session.viewSnapshot()).messages

const errorRows = (messages: readonly ChatMessage[]): ChatMessage[] =>
  messages.filter((m) => m.type === 'error_event')

/** 列表 = 一个新挂载此刻的 messages（两边都在同一刻读） */
async function expectParity(session: DurableSession): Promise<ChatMessage[]> {
  const messages = await list(session)
  expect(messages).toStrictEqual((await freshMount(session)).messages)
  return messages
}

describe('P3-07 · viewSnapshot parity', () => {
  it(
    'P3-07-02 basic parity: D1 send + tool round + notice → = freshMount; ids are String(entryId); D1 content and tokens, no payload; the notice and the filled tool block',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'], tools: [readTool()] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('run PAYLOAD-K1 please', { display: D1 })).toEqual({})
      t.kit.queue(callTool('read', { path: 'x' }, 'c1'), answer('A2'))
      expect(await session.submitUser('read it')).toEqual({})
      expect(
        (await session.writeNotice({ text: 'a notice', kind: 'background', requestId: 'n1' }))
          .status
      ).toBe('submitted')

      const view = await session.viewSnapshot()
      expect(view).toStrictEqual(await freshMount(session))
      const messages = view.messages
      const entries = await allEntries(await session.currentConversation())
      const shown = entries
        .filter((e) => ['pi.user', 'pi.assistant', 'shuvix.notice'].includes(e.kind))
        .map((e) => String(e.id))
      expect(messages.map((m) => m.id)).toEqual(shown)
      expect(messages[0]!.content).toBe(D1.content)
      expect(messages[0]!.metadata).toStrictEqual({ inlineTokens: K1 })
      for (const message of messages) expect(message.content).not.toContain('PAYLOAD-K1')
      expect(messages.at(-1)!.metadata).toStrictEqual({ isSystemNotice: true })
      const tool = messages
        .flatMap((m) => (m.role === 'assistant' && m.type === 'message' ? m.blocks : []))
        .find((b) => b.type === 'tool')
      expect(tool).toMatchObject({ type: 'tool', toolCallId: 'c1', result: 'read x' })
    },
    TIMEOUT
  )

  it(
    'P3-07-03 compaction: the summary leads (wrapper stripped), pre-head ids are gone, = freshMount',
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
      t.kit.queue(answer('a1'))
      expect(await session.submitUser('u1')).toEqual({})
      t.kit.queue(answer('a2'))
      expect(await session.submitUser(`u2 ${'details '.repeat(150)}`)).toEqual({})
      const before = (await list(session)).map((m) => m.id)

      t.kit.queue(answer('SUMMARY'))
      const conversation = await session.currentConversation()
      const task = await conversation.compact(undefined, BG)
      await withTimeout(session.harness.waitForTask(task, BG), 5000, 'compaction')
      await waitFor(async () => (await list(session))[0]?.content === 'SUMMARY', 3000, 'head')
      await waitFor(() => session.runState === 'idle', 3000, 'idle')

      const messages = await expectParity(session)
      expect(messages[0]!.metadata).toStrictEqual({ isCompactionSummary: true })
      expect(messages[0]!.content).toBe('SUMMARY')
      const kept = new Set(messages.map((m) => m.id))
      expect(kept.has(before[0]!)).toBe(false)
      expect(kept.has(before[1]!)).toBe(false)
    },
    TIMEOUT
  )

  it(
    'P3-07-04 retry folding: no error_event during the backoff; retried{count:1} after success; = freshMount at each point',
    async () => {
      const t = await makeHost({
        ephemeral: ['s1'],
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 5 },
          compaction: { enabled: false }
        }
      })
      const session = await t.open('s1')
      await primeRoot(session)
      const second = held(answer('ok'))
      t.kit.queue(modelError('503'), second.step)
      const sending = session.submitUser('hi')
      await withTimeout(second.reached, 5000, 'the retried request')
      const during = await expectParity(session)
      expect(errorRows(during)).toEqual([])
      second.release()
      expect(await withTimeout(sending, 8000, 'send')).toEqual({})
      const after = await expectParity(session)
      expect(errorRows(after)).toEqual([])
      expect(after.at(-1)!.content).toBe('ok')
      expect(after.at(-1)!.metadata).toMatchObject({ retried: { count: 1, lastError: '503' } })
    },
    TIMEOUT
  )

  it(
    'P3-07-04 final failure (maxRetries 2): exactly one error_event with retried.count 2; = freshMount',
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
      t.kit.queue(modelError('503 a'), modelError('503 b'), modelError('503 c'))
      expect((await withTimeout(session.submitUser('hi'), 8000, 'send')).code).toBe('model_error')
      const rows = errorRows(await expectParity(session))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.metadata).toStrictEqual({ retried: { count: 2, lastError: '503 b' } })
    },
    TIMEOUT
  )

  it(
    'P3-07-05 the live partial is excluded: while the partial is "Hel" no message represents it; = freshMount',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('U1')).toEqual({})
      const settled = await list(session)
      await liveCommit(session, (live) => {
        live.run = { taskId: 7 as never, inputs: [] }
        live.generation = {
          attempt: 1,
          message: fauxAssistantMessage([fauxText('Hel')]) as never
        }
      })
      const view = await session.viewSnapshot()
      expect(view.live?.message.content).toBe('Hel')
      expect(view.messages).toStrictEqual(settled)
      expect(view.messages.some((m) => m.content.includes('Hel'))).toBe(false)
      await expectParity(session)
    },
    TIMEOUT
  )

  it(
    'P3-07-05 interrupted reopen: the stale partial is absent, isInterrupted stays true, reading the list publishes nothing',
    async () => {
      const first = await makeHost({ kit: fauxKit({ tokensPerSecond: 40 }) })
      const original = await first.open()
      await primeRoot(original)
      first.kit.queue(fauxAssistantMessage([fauxText(`alpha ${'beta '.repeat(600)}`)]))
      void original.submitUser('go')
      await waitFor(
        async () => {
          const conversation = await original.currentConversation()
          const message = (await original.harness.snapshot(LiveDoc, conversation.id, BG))
            ?.generation?.message
          return ((message?.content?.[0] as { text?: string } | undefined)?.text ?? '') !== ''
        },
        5000,
        'a committed partial'
      )
      const t = await first.restart({ kit: undefined, makeKit: (): FauxKit => fauxKit() })
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)
      const recorder = recordPublications(session.harness)
      const view = await session.viewSnapshot()
      expect(view.run.state).toBe('interrupted')
      expect(view.live?.message.content.startsWith('alpha')).toBe(true)
      expect(view.messages.map((m) => m.content)).toEqual(['go'])
      expect(view.messages).toStrictEqual((await freshMount(session)).messages)
      await settleFrames()
      expect(recorder.publications).toEqual([])
      expect(session.isInterrupted()).toBe(true)
      recorder.stop()
    },
    TIMEOUT
  )

  it(
    'P3-07-06 fork pointer: [U1, A1] with the root ids; U2 and A2 are absent',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'), answer('A2'))
      expect(await session.submitUser('U1')).toEqual({})
      expect(await session.submitUser('U2')).toEqual({})
      const [u1, a1] = await allEntries(await session.currentConversation())
      await session.harness.commit(async (tx) => {
        const fork = await tx.forkConversation(1 as ConversationId, a1!.id, {
          ownership: { kind: 'ownerless' }
        })
        ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
      }, BG)
      const messages = await expectParity(session)
      expect(messages.map((m) => [m.id, m.content])).toEqual([
        [String(u1!.id), 'U1'],
        [String(a1!.id), 'A1']
      ])
    },
    TIMEOUT
  )
})

describe('P3-07 · read-your-writes and the projector (PIN-13 / PIN-14)', () => {
  it(
    'P3-07-07 read-your-writes: right after submitUser resolves the list has the final answer and = freshMount, with a mounted projector and without one',
    async () => {
      const t = await makeHost({ ephemeral: ['s1', 's2'] })
      const mounted = await t.open('s1')
      const proj = await mounted.projector()
      const h = proj.acquire()
      t.kit.queue(answer('FINAL-1'))
      expect(await mounted.submitUser('x')).toEqual({})
      const withProjector = await list(mounted)
      expect(withProjector.at(-1)!.content).toBe('FINAL-1')
      expect(withProjector).toStrictEqual((await freshMount(mounted)).messages)
      h.release()

      const bare = await t.open('s2')
      t.kit.queue(answer('FINAL-2'))
      expect(await bare.submitUser('y')).toEqual({})
      const without = await list(bare)
      expect(without.at(-1)!.content).toBe('FINAL-2')
      expect(without).toStrictEqual((await freshMount(bare)).messages)
    },
    TIMEOUT
  )

  it(
    'P3-07-07 a caught-up projector hands back its own value; a lagging one is bypassed for a fresh projection',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('U1')).toEqual({})
      const proj = (await session.projector()) as SessionProjectorImpl
      const h = proj.acquire()
      await settleFrames()
      expect(await session.viewSnapshot()).toBe(proj.value)

      // 没跟上（换一帧 / 有待做的刷新 / 运行状态还没修订）→ 现投影一次，结果与投影的值深相等
      const lagging = vi.spyOn(proj, 'snapshotIfCurrent').mockReturnValue(undefined)
      const fresh = await session.viewSnapshot()
      expect(fresh).not.toBe(proj.value)
      expect(fresh).toStrictEqual(proj.value)
      lagging.mockRestore()

      // 视图挂载的值换过了（新的一帧）→ 旧的那一帧不算跟上
      const conversation = await session.currentConversation()
      const state = await conversation.viewState(BG)
      const frame = state.value
      state.dispose()
      expect(proj.snapshotIfCurrent(conversation.id, frame)).toBe(proj.value)
      expect(proj.snapshotIfCurrent(conversation.id, { ...frame })).toBeUndefined()
      expect(proj.snapshotIfCurrent((conversation.id + 1) as ConversationId, frame)).toBeUndefined()
      h.release()
      expect(proj.snapshotIfCurrent(conversation.id, frame)).toBeUndefined()
    },
    TIMEOUT
  )

  it(
    'P3-07-08 the list mounts nothing: projector() is never called, no commit listener is left; a later mount starts from the same messages',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'], tools: [readTool()] })
      const session = await t.open('s1')
      t.kit.queue(callTool('read', { path: 'q' }, 'c1'), answer('A1'))
      expect(await session.submitUser('U1')).toEqual({})
      const projector = vi.spyOn(session, 'projector')
      const unsubscribes: Array<ReturnType<typeof vi.fn>> = []
      const original = session.harness.subscribeCommits.bind(session.harness)
      const subscribe = vi
        .spyOn(session.harness, 'subscribeCommits')
        .mockImplementation((listener) => {
          const unsubscribe = vi.fn(original(listener))
          unsubscribes.push(unsubscribe)
          return unsubscribe
        })
      const listed = await list(session)
      expect(projector).not.toHaveBeenCalled()
      expect(unsubscribes.every((unsubscribe) => unsubscribe.mock.calls.length > 0)).toBe(true)
      expect((session as unknown as { projectorEntry: unknown }).projectorEntry).toBeUndefined()
      subscribe.mockRestore()
      projector.mockRestore()

      const proj = await session.projector()
      const h = proj.acquire()
      expect(h.state.value.messages).toStrictEqual(listed)
      h.release()
    },
    TIMEOUT
  )
})

describe('P3-07 · closed, reopened and ephemeral sessions', () => {
  it(
    'P3-07-09 a closed handle rejects with SessionClosedError; after host.close a peek reopens it and the list is unchanged, nothing resumed',
    async () => {
      const t = await makeHost()
      const session = await t.open('s1')
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('U1')).toEqual({})
      const before = await list(session)
      await t.host.close('s1')
      await expect(session.viewSnapshot()).rejects.toBeInstanceOf(SessionClosedError)

      const peeked = await t.host.peek('s1')
      expect(peeked).toBeDefined()
      const recorder = recordPublications(peeked!.harness)
      const after = await list(peeked!)
      expect(after).toStrictEqual(before)
      await settleFrames()
      expect(recorder.publications).toEqual([])
      expect(peeked!.runState).toBe('idle')
      recorder.stop()
    },
    TIMEOUT
  )

  it(
    'P3-07-10 an ephemeral session gives its projection from memory, with no file on disk',
    async () => {
      const t = await makeHost({ ephemeral: ['mem'] })
      const session = await t.open('mem')
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('U1')).toEqual({})
      const view: SessionView = await session.viewSnapshot()
      expect(view.messages.map((m) => m.content)).toEqual(['U1', 'A1'])
      expect(view).toStrictEqual(await freshMount(session))
      expect(existsSync(t.file('mem'))).toBe(false)
      expect(t.memory.has('mem')).toBe(true)
    },
    TIMEOUT
  )
})
