/**
 * P3-02 · 纯投影喂真流程（faux 驱动）：输入一律取自 `conversation.viewState()`（条目 + pi.live + pi.inbox）
 * 加 `resolveDisplayItems` —— 正是 P3-03 的 SessionProjector 要喂给它的那几样。
 *
 *   P3-02-04 共享的显示侧车解析（形状判别、各种落不到条目的情形；与搬家前的判据一致）
 *   P3-02-05 内联 Token 穿过 fork
 *   P3-02-08 真通知：空闲自动续跑 / 不许续跑时写下 / 被中断时推迟、abort 送达
 *   P3-02-23 最终失败：重试耗尽恰好一行错误，带次数；不可重试的单个错误不带
 *   P3-02-25 被中断的运行（退避中关掉）：折叠、Continue 之后带提示、中断时发送
 *   P3-02-29 带着中间态被中断：live 照映中间态；Continue 之后变成中止条目
 *   P3-02-31 真压缩：头之前的条目不在，两次压缩只剩最新摘要，摘要不带 usage / retried
 *   P3-02-33 真 reset：只有 reset 之后的条目，交接文本不渲染
 *   P3-02-40 队列的一生：两条用户输入进队列（写入不算），边界放下之后成为消息，id 是落下的条目 id
 *   P3-02-55 `renderHarnessDiagnostics` 与 pi 的 `renderDiagnostics` 逐字节一致
 *   P3-02-56 身份冒烟：发布时的投影 = 重开之后的投影（终态，与带中间态的那一刻）
 */
import { Type, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import {
  InboxDoc,
  LiveDoc,
  defineTool,
  type EntryRecord,
  type InboxState,
  type LiveState,
  type ToolDiagnostic
} from '@earendil-works/pi-durable'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { RunViewState, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { DisplayDoc, SessionStateDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { readTranscriptDigest } from '../../transcriptDigest'
import { appendEntries, compactionDraft, userDraft } from '../../__tests__/support/digest'
import { answer, callTool, fauxKit, held, modelError, stalled } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { sleep, waitFor, withTimeout } from '../../__tests__/support/wait'
import { makeWorld, registerWorldCleanup } from '../../__tests__/integration/support/world'
import { displayContentOf, displayItemOf, resolveDisplayItems } from '../display'
import { projectSessionView, renderHarnessDiagnostics } from '../project'
import { bg, expectJsonView } from './support'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 20000
const SID = 'view'

/** 搬家之前 transcriptDigest 里的判据（逐字抄下，对照用） */
function digestDisplayContentOf(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const { content, tokens } = item as { content?: unknown; tokens?: unknown }
  if (typeof content !== 'string') return undefined
  if (typeof tokens !== 'object' || tokens === null) return undefined
  return content
}

const K = (n: number) => ({
  [`k${n}`]: { type: 'cmd', id: `cmd${n}`, displayText: `/cmd${n}`, payload: `PAYLOAD-K${n}` }
})
const D = (n: number) => ({ content: `d${n} {{shuvixInlineToken:k${n}}}`, tokens: K(n) })

interface ViewOptions {
  display?: boolean
  runState?: RunViewState
}

/** 当前对话的视图：viewState 的条目与文档 + 显示侧车解析，过严格 JSON 检查 */
async function viewOf(session: DurableSession, options: ViewOptions = {}): Promise<SessionView> {
  const conversation = await session.currentConversation()
  const state = await conversation.viewState(BG)
  try {
    const { entries, docs } = state.value
    const display =
      options.display === false
        ? new Map()
        : await resolveDisplayItems(session.harness, conversation.id, entries)
    return expectJsonView(
      projectSessionView(
        { sessionId: session.sessionId, conversationId: conversation.id },
        entries,
        docs['pi.live'] as LiveState | undefined,
        docs['pi.inbox'] as InboxState | undefined,
        display,
        [],
        options.runState ?? session.runState
      )
    )
  } finally {
    state.dispose()
  }
}

const contents = (messages: readonly ChatMessage[]): string[] => messages.map((m) => m.content)

async function errorEntries(session: DurableSession): Promise<EntryRecord[]> {
  return (await allEntries(await session.currentConversation())).filter((entry) => {
    const message = entry.model?.[0]
    return message?.role === 'assistant' && message.stopReason === 'error'
  })
}

async function liveDoc(session: DurableSession): Promise<LiveState | undefined> {
  const conversation = await session.currentConversation()
  return (await session.harness.snapshot(LiveDoc, conversation.id, BG)) as LiveState | undefined
}

describe('P3-02 · projector over real flows', () => {
  it('P3-02-04 the shared display helper: only a well-shaped, placed, in-range item resolves; {content, tokens}; same verdict as before the move', async () => {
    const t = await makeHost({ ephemeral: [SID] })
    const session = await t.open(SID)
    const conversation = await session.currentConversation()
    const tokens = { k: { type: 'cmd', id: 'x', displayText: '/x', payload: 'PAYLOAD' } }
    const items: Record<string, unknown> = {
      rv: { content: 'VALID', tokens },
      rc: { content: 42, tokens },
      rm: { content: 'NO-TOKENS' },
      rn: { content: 'NULL-TOKENS', tokens: null },
      re: { content: 'CUT', tokens },
      ra: { content: 'ORPHAN', tokens },
      rb: { content: 'UNPLACED', tokens }
    }
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(DisplayDoc, conversation.id)
      for (const [requestId, item] of Object.entries(items)) {
        doc.items[requestId] = item as never
      }
    }, BG)
    const [old, v, c, m, n] = await appendEntries(session, [
      userDraft('old', 1),
      userDraft('model-v', 2),
      userDraft('model-c', 3),
      userDraft('model-m', 4),
      userDraft('model-n', 5)
    ])
    await session.harness.commit(async (tx) => {
      const placed = (requestId: string, entry: EntryRecord) =>
        tx.createSubmission({
          conversationId: conversation.id,
          requestId,
          type: 'input',
          status: 'placed',
          entry: entry.id
        })
      await placed('re', old!)
      await placed('rv', v!)
      await placed('rc', c!)
      await placed('rm', m!)
      await placed('rn', n!)
      await tx.createSubmission({
        conversationId: conversation.id,
        requestId: 'rb',
        type: 'input',
        status: 'unanswered',
        reason: 'aborted'
      })
    }, BG)
    await appendEntries(session, [compactionDraft(v!.id, 'S', 6)])

    const state = await conversation.viewState(BG)
    const entries = state.value.entries
    state.dispose()
    const resolved = await resolveDisplayItems(session.harness, conversation.id, entries)
    expect([...resolved.keys()]).toEqual([v!.id])
    expect(resolved.get(v!.id)).toEqual({ content: 'VALID', tokens })
    for (const item of Object.values(items)) {
      expect(displayItemOf(item)?.content).toBe(digestDisplayContentOf(item))
      expect(displayContentOf(item)).toBe(digestDisplayContentOf(item))
    }
    const view = await viewOf(session)
    expect(contents(view.messages)).toEqual(['S', 'VALID', 'model-c', 'model-m', 'model-n'])
  })

  it(
    'P3-02-05 inline tokens through forks: the fork keeps the parent’s ids and sidecars; the abandoned branch is gone; the digest agrees',
    async () => {
      const t = await makeHost({ ephemeral: [SID] })
      const session = await t.open(SID)
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('d1 PAYLOAD-K1', { display: D(1) })).toEqual({})
      t.kit.queue(answer('A2'))
      expect(await session.submitUser('d2 PAYLOAD-K2', { display: D(2) })).toEqual({})
      const root = await session.currentConversation()
      const rootView = await viewOf(session)
      const rootEntries = await allEntries(root)
      const a1 = rootEntries.find(
        (entry) =>
          entry.kind === 'pi.assistant' &&
          entry.model?.[0]?.role === 'assistant' &&
          entry.model[0].content.some((part) => part.type === 'text' && part.text === 'A1')
      )!
      const u1 = rootEntries.find((entry) => entry.kind === 'pi.user')!

      const fork = await root.fork(a1.id, { ownership: { kind: 'ownerless' } }, BG)
      await session.harness.commit(async (tx) => {
        ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
      }, BG)
      await sleep(20)
      await session.destroyAgent()
      t.kit.queue(answer('A3'))
      expect(await session.submitUser('d3 PAYLOAD-K3', { display: D(3) })).toEqual({})
      expect((await session.currentConversation()).id).toBe(fork.id)

      const view = await viewOf(session)
      expect(view.conversationId).toBe(fork.id)
      expect(contents(view.messages)).toEqual([D(1).content, 'A1', D(3).content, 'A3'])
      expect(view.messages[0]!.metadata).toEqual({ inlineTokens: K(1) })
      expect(view.messages[2]!.metadata).toEqual({ inlineTokens: K(3) })
      expect(view.messages[0]!.id).toBe(String(u1.id))
      expect(view.messages[1]!.id).toBe(String(a1.id))
      expect(view.messages.slice(0, 2)).toEqual(rootView.messages.slice(0, 2))
      for (const n of [1, 2, 3]) {
        expect(JSON.stringify(view.messages.map((message) => message.content))).not.toContain(
          `PAYLOAD-K${n}`
        )
      }
      expect(JSON.stringify(view)).not.toContain('d2')
      const digest = await readTranscriptDigest(session)
      expect(digest.items.filter((item) => item.kind === 'user').map((item) => item.text)).toEqual([
        D(1).content,
        D(3).content
      ])
    },
    TIMEOUT
  )

  it(
    'P3-02-08 real notices: an auto-resumed notice-shaped pi.user, a written notice, a deferred notice flushed by abort — all system notices',
    async () => {
      // (1) idle + auto-resume allowed: the notice is admitted as a notice-shaped pi.user
      const allowed = await makeHost({ ephemeral: ['n1'], noticeCoalesceMs: 10 })
      const s1 = await allowed.open('n1')
      await primeRoot(s1)
      allowed.kit.queue(answer('ack'))
      await s1.notify(bg('t1', 'done'))
      await waitFor(async () => (await viewOf(s1)).messages.length === 2, 3000, 'auto-resumed')
      const v1 = await viewOf(s1)
      expect((await allEntries(await s1.currentConversation())).map((e) => e.kind)).toContain(
        'pi.user'
      )

      // (2) idle + not allowed: a shuvix.notice is written
      const denied = await makeHost({
        ephemeral: ['n2'],
        noticeCoalesceMs: 10,
        autoResume: () => 'false'
      })
      const s2 = await denied.open('n2')
      await primeRoot(s2)
      await s2.notify(bg('t2', 'done'))
      await waitFor(async () => (await viewOf(s2)).messages.length === 1, 3000, 'written')
      const v2 = await viewOf(s2)

      // (3) interrupted: deferred, then flushed by abort as a shuvix.notice
      const first = await makeHost()
      const crashed = await first.open()
      await primeRoot(crashed)
      const stall = stalled()
      first.kit.queue(stall.step)
      void crashed.submitUser('hello')
      await stall.reached
      const t = await first.restart()
      const s3 = await t.open()
      expect(s3.isInterrupted()).toBe(true)
      await s3.notify(bg('t3', 'done'))
      await withTimeout(s3.abort(), 5000, 'abort')
      const v3 = await viewOf(s3)
      const kinds = (await allEntries(await s3.currentConversation())).map((e) => e.kind)
      expect(kinds).toContain('shuvix.notice')

      const notices = [
        v1.messages.find((m) => m.content === bg('t1', 'done')),
        v2.messages.find((m) => m.content === bg('t2', 'done')),
        v3.messages.find((m) => m.content === bg('t3', 'done'))
      ]
      for (const notice of notices) {
        expect(notice).toBeDefined()
        expect(notice!.role).toBe('user')
        expect(notice!.metadata).toStrictEqual({ isSystemNotice: true })
      }
      // none of them is a plain user bubble
      for (const view of [v1, v2, v3]) {
        const plain = view.messages.filter(
          (m) =>
            m.role === 'user' &&
            !(m.metadata as { isSystemNotice?: boolean } | null)?.isSystemNotice
        )
        expect(plain.map((m) => m.content)).not.toContain(expect.stringContaining('background-task'))
      }
    },
    TIMEOUT
  )

  it(
    'P3-02-23 final failure: retries exhausted (maxRetries 10) leave one error row with count 10; a non-retryable error has metadata null',
    async () => {
      const t = await makeHost({
        ephemeral: [SID, 'once'],
        settingsOverrides: {
          retry: { enabled: true, baseDelayMs: 1, maxAgentDelayMs: 2 },
          compaction: { enabled: false }
        }
      })
      const session = await t.open(SID)
      await primeRoot(session)
      t.kit.queue(...Array.from({ length: 11 }, (_, i) => modelError(`503 attempt ${i + 1}`)))
      expect(await withTimeout(session.submitUser('hi'), 10000, 'send')).toEqual({
        error: '503 attempt 11',
        code: 'model_error'
      })
      const errors = await errorEntries(session)
      expect(errors).toHaveLength(11)
      const view = await viewOf(session)
      const rows = view.messages.filter((m) => m.type === 'error_event')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: String(errors[10]!.id),
        content: '503 attempt 11',
        metadata: { retried: { count: 10, lastError: '503 attempt 10' } }
      })
      expect(contents(view.messages)).toEqual(['hi', '503 attempt 11'])

      const once = await t.open('once')
      await primeRoot(once)
      t.kit.queue(modelError('400 invalid_request_error: bad schema'))
      await withTimeout(once.submitUser('hi'), 5000, 'send once')
      const single = (await viewOf(once)).messages.filter((m) => m.type === 'error_event')
      expect(single).toHaveLength(1)
      expect(single[0]!.metadata).toBeNull()
    },
    TIMEOUT
  )

  describe('P3-02-25 interrupted runs: the host closes during the backoff after two errors', () => {
    async function interruptedInBackoff(): Promise<{ t: TestHost; session: DurableSession }> {
      const first = await makeHost({
        settingsOverrides: { retry: { enabled: true, baseDelayMs: 300 }, compaction: { enabled: false } }
      })
      const original = await first.open()
      await primeRoot(original)
      first.kit.queue(modelError('503 one'), modelError('503 two'))
      void original.submitUser('hi')
      await waitFor(async () => (await errorEntries(original)).length === 2, 5000, 'two errors')
      const t = await first.restart()
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)
      return { t, session }
    }

    it(
      'reopened without resuming: both errors folded, interrupted with no retry (PIN-06); Continue then success carries count 2',
      async () => {
        const { t, session } = await interruptedInBackoff()
        expect((await liveDoc(session))?.run).toBeDefined()
        const view = await viewOf(session)
        expect(contents(view.messages)).toEqual(['hi'])
        expect(view.run).toStrictEqual({ state: 'interrupted' })
        expect(view.live).toBeNull()

        t.kit.queue(answer('done'))
        expect(await withTimeout(session.continue(), 8000, 'continue')).toEqual({})
        const after = await viewOf(session)
        expect(contents(after.messages)).toEqual(['hi', 'done'])
        expect(after.messages[1]!.metadata).toMatchObject({
          retried: { count: 2, lastError: '503 two' }
        })
      },
      TIMEOUT
    )

    it(
      'sending instead (abort, then send): the last error becomes a row with count 1, then the new message',
      async () => {
        const { t, session } = await interruptedInBackoff()
        t.kit.queue(answer('fresh'))
        expect(await withTimeout(session.submitUser('again'), 8000, 'send')).toEqual({})
        const view = await viewOf(session)
        expect(view.messages.map((m) => [m.type, m.content])).toEqual([
          ['text', 'hi'],
          ['error_event', '503 two'],
          ['text', 'again'],
          ['message', 'fresh']
        ])
        expect(view.messages[1]!.metadata).toStrictEqual({
          retried: { count: 1, lastError: '503 one' }
        })
      },
      TIMEOUT
    )
  })

  it(
    'P3-02-29 interrupted with a committed partial: live mirrors it (PIN-11); after Continue it is an aborted card with the same blocks',
    async () => {
      const first = await makeHost({ kit: fauxKit({ tokensPerSecond: 40 }) })
      const original = await first.open()
      await primeRoot(original)
      first.kit.queue(fauxAssistantMessage([fauxText(`alpha ${'beta '.repeat(600)}`)]))
      void original.submitUser('go')
      await waitFor(
        async () => {
          const message = (await liveDoc(original))?.generation?.message
          return (message?.content?.length ?? 0) > 0 && (message?.content[0] as { text?: string }).text !== ''
        },
        5000,
        'a committed partial'
      )
      const t = await first.restart()
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)

      const view = await viewOf(session)
      expect(view.run.state).toBe('interrupted')
      expect(view.live).not.toBeNull()
      const taskId = (await liveDoc(session))!.run!.taskId
      expect(view.live!.id).toBe(`live:${taskId}`)
      expect(view.live!.message.content.startsWith('alpha')).toBe(true)
      expect(contents(view.messages)).toEqual(['go'])

      const next = held(answer('done'))
      t.kit.queue(next.step)
      const continuing = session.continue()
      await withTimeout(next.reached, 5000, 'next attempt')
      const during = await viewOf(session)
      expect(during.messages.map((m) => m.type)).toEqual(['text', 'message'])
      const aborted = during.messages[1] as Extract<ChatMessage, { type: 'message' }>
      expect(aborted.blocks).toEqual(view.live!.message.blocks)
      expect(during.live).toBeNull()
      next.release()
      expect(await withTimeout(continuing, 5000, 'continue')).toEqual({})
      const final = await viewOf(session)
      expect(contents(final.messages)).toEqual(['go', aborted.content, 'done'])
      expect(final.live).toBeNull()

      // a whitespace-only partial gives no live card
      const live = (await liveDoc(session)) ?? {}
      const blank = projectSessionView(
        { sessionId: 's', conversationId: 1 },
        [],
        {
          ...live,
          run: { taskId, inputs: [] },
          generation: { attempt: 1, message: { role: 'assistant', content: [{ type: 'thinking', thinking: ' \n' }] } }
        } as never,
        undefined,
        new Map(),
        [],
        'interrupted'
      )
      expect(blank.live).toBeNull()
    },
    TIMEOUT
  )

  it(
    'P3-02-31 real compaction: pre-head entries are gone, two compactions leave only the newest summary, the summary carries no usage or retried',
    async () => {
      const world = await makeWorld({
        settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 200 } },
        tools: [],
        overlay: []
      })
      const session = await world.open()
      world.chat(answer('a1'))
      expect(await session.submitUser('u1')).toEqual({})
      const u2 = `u2 ${'details '.repeat(150)}`
      world.chat(answer('a2'))
      expect(await session.submitUser(u2)).toEqual({})

      const conversation = await session.currentConversation()
      world.model.summary(answer('SUMMARY-ONE'))
      await withTimeout(
        session.harness.waitForTask(await conversation.compact(undefined, BG), BG),
        5000,
        'first compaction'
      )
      const once = await viewOf(session)
      expect(contents(once.messages)).toEqual(['SUMMARY-ONE', u2, 'a2'])

      const u3 = `u3 ${'more '.repeat(200)}`
      world.chat(answer('a3'))
      expect(await session.submitUser(u3)).toEqual({})
      world.model.summary(answer('SUMMARY-TWO'))
      await withTimeout(
        session.harness.waitForTask(await conversation.compact(undefined, BG), BG),
        5000,
        'second compaction'
      )
      const twice = await viewOf(session)
      expect(twice.messages[0]!.content).toBe('SUMMARY-TWO')
      expect(contents(twice.messages)).not.toContain('SUMMARY-ONE')
      expect(contents(twice.messages)).not.toContain('u1')
      expect(contents(twice.messages).at(-1)).toBe('a3')
      expect(twice.messages[0]!.metadata).toStrictEqual({ isCompactionSummary: true })
      const compactions = (await allEntries(conversation)).filter((e) => e.kind === 'pi.compaction')
      expect(compactions).toHaveLength(2)
      expect(twice.messages[0]!.id).toBe(String(compactions[1]!.id))
    },
    TIMEOUT
  )

  it(
    'P3-02-33 real reset: only the entries after the reset render; the reset and its handoff text render nothing',
    async () => {
      const t = await makeHost({ ephemeral: [SID] })
      const session = await t.open(SID)
      t.kit.queue(answer('a1'))
      expect(await session.submitUser('u1')).toEqual({})
      const conversation = await session.currentConversation()
      await conversation.reset('HANDOFF-TEXT for the next context', BG)
      t.kit.queue(answer('a2'))
      expect(await session.submitUser('u2')).toEqual({})
      const kinds = (await allEntries(conversation)).map((e) => e.kind)
      expect(kinds).toContain('pi.reset')
      const view = await viewOf(session)
      expect(contents(view.messages)).toEqual(['u2', 'a2'])
      expect(JSON.stringify(view)).not.toContain('HANDOFF-TEXT')
    },
    TIMEOUT
  )

  it(
    'P3-02-40 queue lifecycle: the two user inputs queue (the notice write does not); once placed they are messages with the placed entry ids',
    async () => {
      const t = await makeHost({ ephemeral: [SID] })
      const session = await t.open(SID)
      const run = held(answer('a1'))
      t.kit.queue(run.step, answer('a2'), answer('a3'))
      const sending = session.submitUser('go')
      await withTimeout(run.reached, 5000, 'first request')
      await session.followUp('F later')
      await session.steer('S now')
      await session.writeNotice({ text: bg('n1', 'x'), kind: 'background', requestId: 'n1' })
      const conversation = await session.currentConversation()
      const inbox = await session.harness.snapshot(InboxDoc, conversation.id, BG)
      expect(inbox?.items.map((item) => item.mode)).toEqual(['followUp', 'steer', 'write'])

      const queued = await viewOf(session)
      expect(queued.queue.map(({ mode, text, imageCount }) => ({ mode, text, imageCount }))).toEqual([
        { mode: 'followUp', text: 'F later', imageCount: 0 },
        { mode: 'steer', text: 'S now', imageCount: 0 }
      ])
      expect(queued.queue.map((item) => item.submissionId)).toEqual(
        inbox!.items.slice(0, 2).map((item) => item.id)
      )

      run.release()
      expect(await withTimeout(sending, 8000, 'send')).toEqual({})
      await waitFor(
        async () =>
          session.runState === 'idle' &&
          ((await session.harness.snapshot(InboxDoc, conversation.id, BG))?.items.length ?? 0) === 0,
        8000,
        'queue drained'
      )
      const after = await viewOf(session)
      expect(after.queue).toEqual([])
      const entries = await allEntries(conversation)
      for (const text of ['F later', 'S now']) {
        const entry = entries.find(
          (e) => e.kind === 'pi.user' && e.model?.[0]?.role === 'user' && e.model[0].content === text
        )
        expect(entry, text).toBeDefined()
        const message = after.messages.find((m) => m.content === text)
        expect(message?.id).toBe(String(entry!.id))
        expect(message?.metadata).toStrictEqual({})
      }
    },
    TIMEOUT
  )

  it(
    'P3-02-55 renderHarnessDiagnostics matches pi’s render byte for byte (1, 2 and 3 diagnostics of mixed severity)',
    async () => {
      const sets: ToolDiagnostic[][] = [
        [{ severity: 'info', message: 'one', code: 'a' }],
        [
          { severity: 'warn', message: 'two: with [brackets] and <tags>' },
          { severity: 'error', message: 'multi\nline', code: 'b' }
        ],
        [
          { severity: 'error', message: 'x' },
          { severity: 'info', message: '' },
          { severity: 'warn', message: 'ünïcødé ✓' }
        ]
      ]
      const diag = defineTool({
        name: 'diag',
        description: 'returns diagnostics',
        parameters: Type.Object({ n: Type.Number() }),
        execute: async (args) => ({
          content: [{ type: 'text', text: `out ${(args as { n: number }).n}` }],
          diagnostics: sets[(args as { n: number }).n]!
        })
      })
      const t = await makeHost({ ephemeral: [SID], tools: [diag] })
      const session = await t.open(SID)
      t.kit.queue(
        callTool('diag', { n: 0 }, 'c0'),
        callTool('diag', { n: 1 }, 'c1'),
        callTool('diag', { n: 2 }, 'c2'),
        answer('done')
      )
      expect(await withTimeout(session.submitUser('go'), 8000, 'send')).toEqual({})
      const results = (await allEntries(await session.currentConversation())).filter(
        (e) => e.kind === 'pi.tool-result'
      )
      expect(results).toHaveLength(3)
      results.forEach((entry, n) => {
        const message = entry.model?.[0]
        if (message?.role !== 'toolResult') throw new Error('not a tool result')
        const last = message.content.at(-1)
        expect(last?.type === 'text' && last.text).toBe(renderHarnessDiagnostics(sets[n]!))
        expect((entry.data as { diagnostics: ToolDiagnostic[] }).diagnostics).toEqual(sets[n])
      })
      const view = await viewOf(session)
      const blocks = view.messages.flatMap((m) =>
        m.type === 'message' ? m.blocks.filter((b) => b.type === 'tool') : []
      )
      expect(blocks.map((b) => b.type === 'tool' && b.result)).toEqual(['out 0', 'out 1', 'out 2'])
    },
    TIMEOUT
  )

  describe('P3-02-56 identity smoke check: a publication’s projection equals a reopened host’s', () => {
    /**
     * 每个已提交的视图修订（`conversation.watch()`：逐帧、按序、异步交付）投影一次。注意不是在
     * `subscribeCommits` 里读 `viewState().value` —— 那个值在微任务里才推进，同步读到的是上一个修订。
     */
    async function recordProjections(
      session: DurableSession,
      runState: RunViewState
    ): Promise<{ views: SessionView[]; stop: () => Promise<unknown> }> {
      const conversation = await session.currentConversation()
      const watch = await conversation.watch(BG)
      const views: SessionView[] = []
      watch.start(async (value) => {
        views.push(
          projectSessionView(
            { sessionId: session.sessionId, conversationId: conversation.id },
            value.entries,
            value.docs['pi.live'] as LiveState | undefined,
            value.docs['pi.inbox'] as InboxState | undefined,
            new Map(),
            [],
            runState
          )
        )
      })
      return { views, stop: () => watch.stop() }
    }

    it(
      'the final publication of a run with a tool round equals a fresh mount on a reopened host',
      async () => {
        const echo = defineTool({
          name: 'echo',
          description: 'echo',
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: 'echoed' }] })
        })
        const first = await makeHost({ tools: [echo] })
        const session = await first.open()
        await primeRoot(session)
        const recorder = await recordProjections(session, 'idle')
        first.kit.queue(callTool('echo', {}, 'e1'), answer('finished'))
        expect(await withTimeout(session.submitUser('go'), 8000, 'send')).toEqual({})
        await sleep(50)
        await recorder.stop()
        expect(recorder.views.length).toBeGreaterThan(2)
        const last = recorder.views.at(-1)!
        expect(contents(last.messages)).toEqual(['go', '', 'finished'])

        const t = await first.restart()
        const reopened = await t.open()
        expect(await viewOf(reopened, { display: false, runState: 'idle' })).toEqual(last)
      },
      TIMEOUT
    )

    it(
      'the last mid-stream publication (with a partial) equals the reopened, interrupted host’s view',
      async () => {
        const first = await makeHost({ kit: fauxKit({ tokensPerSecond: 40 }) })
        const session = await first.open()
        await primeRoot(session)
        const recorder = await recordProjections(session, 'busy')
        first.kit.queue(fauxAssistantMessage([fauxText(`gamma ${'delta '.repeat(600)}`)]))
        void session.submitUser('go')
        await waitFor(
          () => recorder.views.some((view) => view.live !== null && view.live.message.content.length > 0),
          5000,
          'a publication with a partial'
        )
        // keep recording through the close: the last publication before it is the one to match
        const t = await first.restart()
        await recorder.stop()
        const last = recorder.views.at(-1)!
        expect(last.live).not.toBeNull()
        const reopened = await t.open()
        expect(reopened.isInterrupted()).toBe(true)
        expect(await viewOf(reopened, { display: false, runState: 'busy' })).toEqual(last)
      },
      TIMEOUT
    )
  })
})
