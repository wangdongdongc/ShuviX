/**
 * P2-14 · 转写摘要的真流程（faux 驱动）：真发送、真 ask 工具、真压缩、fork 与当前对话指针、只读。
 *
 *   P2-14-03 显示侧车胜出、payload 永不外泄（真 submitUser + display）
 *   P2-14-06b 重试耗尽的模型错误：存下来的错误尝试一条都不交出
 *   P2-14-09 真 ask 工具端到端：选择 / 其它反馈 / 取消；挂着的卡片不交出、读完之后照样能答
 *   P2-14-10 时间戳：user = 放置时钟，ask 回答 = 提问那条 assistant 的（不是结果的）
 *   P2-14-11a 真压缩：摘要（去壳）排第一，只跟着保留下来的条目
 *   P2-14-14 fork 与指针：继承前缀带着 asOf 的显示侧车；指针坏了退回根并恰好警告一次（R11）
 *   P2-14-15 只读：空闲上锁的会话零发布；被中断的会话照样停着；没锁的会话不建 agent、不送达推迟的通知
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc, type DeferredNotice } from '../docs'
import type { DurableSession } from '../durableSession'
import { readTranscriptDigest, type TranscriptDigestItem } from '../transcriptDigest'
import { recordPublications } from './support/commits'
import { A, AC, U, appendEntries, bg, userDraft } from './support/digest'
import { answer, callTool, modelError, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { allEntries, requestTexts } from './support/transcript'
import { sleep, waitFor, withTimeout } from './support/wait'
import { choose, makeWorld, nextInput, registerWorldCleanup } from './integration/support/world'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 15000
const SID = 'digest'

/** 内联 Token 字典（InlineToken 的形状；不加接口注解好让它当 JSON 用） */
const K1 = {
  k1: { type: 'cmd', id: 'deploy', displayText: '/deploy', payload: 'PAYLOAD-K1' }
}
const DISPLAY_K1 = { content: 'run {{shuvixInlineToken:k1}} please', tokens: K1 }

async function digest(session: DurableSession): Promise<TranscriptDigestItem[]> {
  return (await readTranscriptDigest(session)).items
}

/** 摘要项去掉时间戳（真流程的时钟不在用例手里时比结构） */
function shape(items: readonly TranscriptDigestItem[]): unknown[] {
  return items.map(({ ts: _ts, ...rest }) => rest)
}

const askArgs = (
  question: string
): { question: string; options: { label: string; description: string }[] } => ({
  question,
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: 'second' }
  ]
})

async function deferredNotices(session: DurableSession): Promise<DeferredNotice[]> {
  return [...((await session.harness.snapshot(SessionStateDoc, BG))?.deferredNotices ?? [])]
}

describe('P2-14 · transcript digest over real flows', () => {
  it('P2-14-03 the display sidecar wins and the payload never leaks (real submitUser)', async () => {
    const t = await makeHost({ ephemeral: [SID] })
    const session = await t.open(SID)
    t.kit.queue(answer('A1'))
    expect(await session.submitUser('run PAYLOAD-K1 please', { display: DISPLAY_K1 })).toEqual({})
    t.kit.queue(answer('A2'))
    expect(await session.submitUser('plain second')).toEqual({})

    const items = await digest(session)
    expect(items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual([
      'run {{shuvixInlineToken:k1}} please',
      'plain second'
    ])
    expect(shape(items)).toEqual([
      { kind: 'user', text: 'run {{shuvixInlineToken:k1}} please' },
      { kind: 'assistant', text: 'A1' },
      { kind: 'user', text: 'plain second' },
      { kind: 'assistant', text: 'A2' }
    ])
    expect(JSON.stringify(items)).not.toContain('PAYLOAD-K1')
    // 对照：模型那一侧看到的正是展开后的全文
    expect(requestTexts(t.kit, 0).join('\n')).toContain('PAYLOAD-K1')
  })

  it(
    'P2-14-06b a model error that exhausts retries: only the human words, the stored error attempts are invisible',
    async () => {
      const t = await makeHost({
        ephemeral: [SID],
        settingsOverrides: {
          retry: { baseDelayMs: 5, maxRetries: 2 },
          compaction: { enabled: false }
        }
      })
      const session = await t.open(SID)
      await primeRoot(session)
      t.kit.queue(modelError('503 boom'), modelError('503 boom'), modelError('503 boom'))
      expect(await withTimeout(session.submitUser('hi'), 5000, 'send')).toEqual({
        error: '503 boom',
        code: 'model_error'
      })
      const errors = (await allEntries(await session.currentConversation())).filter((entry) => {
        const message = entry.model?.[0]
        return message?.role === 'assistant' && message.stopReason === 'error'
      })
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(shape(await digest(session))).toEqual([{ kind: 'user', text: 'hi' }])
    },
    TIMEOUT
  )

  it(
    'P2-14-09 the real ask tool end to end: choice and other-feedback answers, a pending card gives nothing and stays answerable, a cancelled ask gives nothing',
    async () => {
      const world = await makeWorld({ tools: ['ask'], overlay: [] })
      const session = await world.open()
      world.chat(
        callTool('ask', askArgs('Q1'), 'a1'),
        callTool('ask', askArgs('Q2'), 'a2'),
        callTool('ask', askArgs('Q3'), 'a3'),
        answer('done')
      )
      const sending = session.submitUser('ask me')
      await nextInput(world, 'a1')
      choose(world, 'a1', ['A'])
      await nextInput(world, 'a2')
      expect(session.respondToInput('a2', { kind: 'other', text: 'neither' })).toBe(true)
      await nextInput(world, 'a3')

      // 第三张卡挂着：读摘要不交出它，读完之后照样能答
      const pending = await digest(session)
      expect(pending.filter((item) => item.kind === 'ask').map((item) => item.question)).toEqual([
        'Q1',
        'Q2'
      ])
      expect(session.pendingInputCount).toBe(1)
      expect(session.respondToInput('a3', { kind: 'cancel', reason: 'aborted' })).toBe(true)
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})

      const items = await digest(session)
      expect(items.filter((item) => item.kind === 'ask')).toEqual([
        expect.objectContaining({ question: 'Q1', answer: 'User selected: A' }),
        expect.objectContaining({
          question: 'Q2',
          answer: 'User did not select any option and responded with feedback instead:\nneither'
        })
      ])
      expect(shape(items).at(-1)).toEqual({ kind: 'assistant', text: 'done' })
    },
    TIMEOUT
  )

  it(
    'P2-14-10 timestamps: the user item carries the placement clock, the answer carries its assistant’s timestamp, not the result’s',
    async () => {
      const W_NOW = Date.parse('2026-10-04T12:00:00.000Z')
      let now = W_NOW
      const world = await makeWorld({ tools: ['ask'], overlay: [], host: { now: () => now } })
      const session = await world.open()
      world.chat(
        fauxAssistantMessage([fauxToolCall('ask', askArgs('When?'), { id: 'c-t' })], {
          stopReason: 'toolUse',
          timestamp: W_NOW + 500
        }),
        fauxAssistantMessage('ok', { timestamp: W_NOW + 700 })
      )
      const sending = session.submitUser('timed')
      await nextInput(world, 'c-t')
      now = W_NOW + 9000
      choose(world, 'c-t', ['B'])
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})

      const result = (await allEntries(await session.currentConversation())).find(
        (entry) => entry.kind === 'pi.tool-result'
      )
      expect(result?.model?.[0]?.role === 'toolResult' && result.model[0].timestamp).toBe(
        W_NOW + 9000
      )
      expect(await digest(session)).toEqual([
        U(W_NOW, 'timed'),
        A(W_NOW + 500, ''),
        { kind: 'ask', ts: W_NOW + 500, question: 'When?', answer: 'User selected: B' },
        A(W_NOW + 700, 'ok')
      ])
    },
    TIMEOUT
  )

  it(
    'P2-14-11a real compaction: the unwrapped summary comes first, then only the kept entries',
    async () => {
      const world = await makeWorld({
        settings: {
          retry: { enabled: false },
          compaction: { enabled: false, keepRecentTokens: 200 }
        },
        tools: ['ask'],
        overlay: []
      })
      const session = await world.open()
      world.chat(answer('a1'))
      expect(await session.submitUser('u1')).toEqual({})
      world.chat(callTool('ask', askArgs('Turn two?'), 'c-2'), answer('a2'))
      const second = session.submitUser('u2')
      await nextInput(world, 'c-2')
      choose(world, 'c-2', ['A'])
      expect(await withTimeout(second, 5000, 'u2')).toEqual({})
      // u3 alone outweighs keepRecentTokens: the cut lands on it
      const u3 = `u3 ${'details '.repeat(150)}`
      world.chat(answer('a3'))
      expect(await session.submitUser(u3)).toEqual({})
      expect(
        shape(await digest(session)).filter((item) => (item as { kind: string }).kind === 'ask')
      ).toHaveLength(1)

      world.model.summary(answer('SUMMARY-TEXT'))
      const conversation = await session.currentConversation()
      const task = await conversation.compact(undefined, BG)
      await withTimeout(session.harness.waitForTask(task, BG), 5000, 'compaction')
      const compaction = (await allEntries(conversation)).find(
        (entry) => entry.kind === 'pi.compaction'
      )
      expect(compaction).toBeDefined()

      const items = await digest(session)
      expect(items[0]).toEqual(AC(items[0]!.ts, 'SUMMARY-TEXT'))
      expect(shape(items.slice(1))).toEqual([
        { kind: 'user', text: u3 },
        { kind: 'assistant', text: 'a3' }
      ])
      const serialized = JSON.stringify(items)
      expect(serialized).not.toContain('"u1"')
      expect(serialized).not.toContain('Turn two?')
    },
    TIMEOUT
  )

  it('P2-14-14 forks and the pointer: the fork inherits the asOf sidecar; a dangling pointer reads the root and warns once (R11)', async () => {
    const t = await makeHost({ ephemeral: [SID] })
    const session = await t.open(SID)
    t.kit.queue(answer('A1'))
    expect(
      await session.submitUser('d1 PAYLOAD-K1', {
        display: { content: 'd1 {{shuvixInlineToken:k1}}', tokens: K1 }
      })
    ).toEqual({})
    t.kit.queue(answer('A2'))
    expect(await session.submitUser('u2')).toEqual({})
    const root = await session.currentConversation()
    const rootItems = await digest(session)
    expect(shape(rootItems)).toEqual([
      { kind: 'user', text: 'd1 {{shuvixInlineToken:k1}}' },
      { kind: 'assistant', text: 'A1' },
      { kind: 'user', text: 'u2' },
      { kind: 'assistant', text: 'A2' }
    ])

    const a1 = (await allEntries(root)).find(
      (entry: EntryRecord) =>
        entry.kind === 'pi.assistant' &&
        entry.model?.[0]?.role === 'assistant' &&
        entry.model[0].content.some((part) => part.type === 'text' && part.text === 'A1')
    )!
    const fork = await root.fork(a1.id, { ownership: { kind: 'ownerless' } }, BG)
    await appendEntries(session, [userDraft('u3', 99)], fork.id)
    const point = async (pointer: ConversationId): Promise<void> => {
      await session.harness.commit(async (tx) => {
        ;(await tx.doc(SessionStateDoc)).currentConversation = pointer
      }, BG)
    }
    await point(fork.id)
    expect(shape(await digest(session))).toEqual([
      { kind: 'user', text: 'd1 {{shuvixInlineToken:k1}}' },
      { kind: 'assistant', text: 'A1' },
      { kind: 'user', text: 'u3' }
    ])

    await point(9999 as ConversationId)
    // 指针一变，会话自己会在微任务里校验一次（也警告一次）—— 等它过去再数这一次读
    await sleep(20)
    const before = t.warnings.length
    expect(await digest(session)).toEqual(rootItems)
    const raised = t.warnings.slice(before)
    expect(raised).toHaveLength(1)
    expect(raised[0]).toContain('does not exist')
  })

  describe('P2-14-15 read-only', () => {
    it('(a) an idle locked session: zero publications around the read, runState stays idle', async () => {
      const t = await makeHost({ ephemeral: [SID] })
      const session = await t.open(SID)
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('run PAYLOAD-K1 please', { display: DISPLAY_K1 })).toEqual({})
      expect(session.lock).toBeDefined()
      const recorder = recordPublications(session.harness)
      expect(shape(await digest(session))).toEqual([
        { kind: 'user', text: DISPLAY_K1.content },
        { kind: 'assistant', text: 'A1' }
      ])
      await sleep(20)
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(session.runState).toBe('idle')
    })

    it(
      '(b) an interrupted session stays interrupted: no request, no task change, no publication',
      async () => {
        const first = await makeHost()
        const crashed = await first.open()
        await primeRoot(crashed)
        const stall = stalled()
        first.kit.queue(stall.step)
        void crashed.submitUser('hello PAYLOAD-K1', { display: DISPLAY_K1 })
        await stall.reached
        const t = await first.restart()
        const session = await t.open()
        expect(session.isInterrupted()).toBe(true)
        expect((await session.harness.inspect(BG)).scheduling).toBe('paused')

        const recorder = recordPublications(session.harness)
        expect(shape(await digest(session))).toEqual([{ kind: 'user', text: DISPLAY_K1.content }])
        await sleep(100)
        recorder.stop()
        expect(recorder.publications).toEqual([])
        expect(session.isInterrupted()).toBe(true)
        expect(session.runState).toBe('interrupted')
        expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
        expect(t.kit.callCount).toBe(0)
      },
      TIMEOUT
    )

    it('(c) an unlocked session with a deferred notice and a new day: no agent, no seam call, the notice stays deferred, nothing written', async () => {
      let day = '2026-10-04'
      const t = await makeHost({ ephemeral: [SID], today: () => day })
      const session = await t.open(SID)
      await appendEntries(session, [userDraft('typed by hand', 1)])
      await session.harness.commit(async (tx) => {
        ;(await tx.doc(SessionStateDoc)).deferredNotices.push({
          requestId: 'n1',
          text: bg('t1', 'done'),
          kind: 'background'
        })
      }, BG)
      day = '2026-10-05'
      const notices = await deferredNotices(session)
      const calls = {
        builtin: t.toolHost.builtinCalls.length,
        resolve: t.toolHost.resolveCalls.length,
        rebuild: t.toolHost.rebuildCalls.length
      }
      const recorder = recordPublications(session.harness)

      expect(await digest(session)).toEqual([U(1, 'typed by hand')])
      await sleep(20)
      recorder.stop()
      expect(recorder.publications).toEqual([])
      expect(session.lock).toBeUndefined()
      expect(t.configCalls).toEqual([])
      expect({
        builtin: t.toolHost.builtinCalls.length,
        resolve: t.toolHost.resolveCalls.length,
        rebuild: t.toolHost.rebuildCalls.length
      }).toEqual(calls)
      expect(await deferredNotices(session)).toEqual(notices)
      const written = (await allEntries(await session.currentConversation())).map((e) => e.kind)
      expect(written).not.toContain('shuvix.notice')
      await waitFor(() => session.runState === 'idle', 500, 'still idle')
    })
  })
})
