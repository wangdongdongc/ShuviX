/**
 * 压缩前的历史（只读回看）：`DurableSession.compactedMessages(压缩摘要 id)` 与它背后的 `compactedSegment`
 * （CLAUDE.md「Context management」里「Compacted history is readable by scrolling up」那一句是契约）。
 *
 *   R-1 一次压缩：那一段 = 压缩之前视图里 id < H.head 的消息，最旧在前，形状与当时视图里的一样；不以摘要开头
 *   R-2 与当前视图不重叠；[那一段, 当前视图] 按次序 = 压缩之前的整份列表（外加摘要）
 *   R-3 两次压缩接成链：seg(H2) 以 H1 的摘要开头；seg(H1) 是最旧那一段、不以摘要开头；三份之间没有重复 id
 *   R-4 H2 保留的窗口伸过了 H1（H1.head ≤ H2.head < H1.id）：仍然没有重复、仍然接得上
 *   R-5 reset：reset 之前的东西不出现；那一段不以摘要开头；拿 reset 条目的 id 来要 → []
 *   R-6 回退分支：隐藏的旧分支里的条目从不出现
 *   R-7 认不出的 id → []，不抛
 *   R-8 跨一次回退 fork 的链：fork 里再压缩，那一段以 fork 之前那次压缩的摘要开头，再往上也取得到
 *   R-9 显示侧车（内联 Token）在那一段里与压缩之前视图里的一样
 *   R-11 只读：不发布任何提交、runState 不变、不挂投影
 *   R-12 关掉的句柄 → SessionClosedError
 *
 * 压缩用手动的 `conversation.compact`（自动压缩关着，keepRecentTokens 很小：只留最后一大段）；
 * 「伸过上一次压缩」的形状用 `appendEntries` 直接写一条压缩头（真压缩里切点由 pi 选，测试里摆不出来）。
 */
import { CompactionEntry, type EntryId } from '@earendil-works/pi-durable'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { compactedSegment } from '../compactedHistory'
import { SessionClosedError, type DurableSession } from '../durableSession'
import { settleFrames } from '../projection/__tests__/projectorSupport'
import { recordPublications } from './support/commits'
import { appendEntries, compactionDraft } from './support/digest'
import { answer } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { forkedId, rollbackBase } from './support/rollback'
import { allEntries } from './support/transcript'
import { waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 25000
const SETTINGS = {
  retry: { enabled: false },
  compaction: { enabled: false, keepRecentTokens: 200 }
} as const

const big = (tag: string): string => `${tag} ${'details '.repeat(150)}`

const list = async (session: DurableSession): Promise<ChatMessage[]> =>
  (await session.viewSnapshot()).messages
const ids = (messages: readonly ChatMessage[]): string[] => messages.map((m) => m.id)
const isSummary = (message: ChatMessage | undefined): boolean =>
  (message?.metadata as { isCompactionSummary?: boolean } | null | undefined)
    ?.isCompactionSummary === true

async function send(
  t: TestHost,
  session: DurableSession,
  text: string,
  reply: string
): Promise<void> {
  t.kit.queue(answer(reply))
  expect(await session.submitUser(text)).toEqual({})
}

/** 手动压缩一次，等摘要成了视图第一条；交回这次压缩的头标记（最新的那条） */
async function compact(
  t: TestHost,
  session: DurableSession,
  summary: string
): Promise<{ id: number; head: number }> {
  t.kit.queue(answer(summary))
  const conversation = await session.currentConversation()
  const task = await conversation.compact(undefined, BG)
  await withTimeout(session.harness.waitForTask(task, BG), 5000, `compaction ${summary}`)
  await waitFor(async () => (await list(session))[0]?.content === summary, 3000, summary)
  await waitFor(() => session.runState === 'idle', 3000, 'idle')
  const markers = (await allEntries(await session.currentConversation())).filter(
    (e) => e.kind === CompactionEntry.kind
  )
  const marker = markers.at(-1)!
  return { id: marker.id as number, head: marker.head as number }
}

/** u1 a1 · u1b a1b · u2(大) a2 */
async function threeTurns(t: TestHost, session: DurableSession): Promise<void> {
  await send(t, session, 'u1', 'a1')
  await send(t, session, 'u1b', 'a1b')
  await send(t, session, big('u2'), 'a2')
}

async function openSession(
  options: { ephemeral?: boolean } = {}
): Promise<{ t: TestHost; session: DurableSession }> {
  const t = await makeHost({
    ...(options.ephemeral ? { ephemeral: ['s1'] } : {}),
    settingsOverrides: SETTINGS
  })
  const session = await t.open('s1')
  await primeRoot(session)
  return { t, session }
}

describe('compactedMessages · one compaction', () => {
  for (const ephemeral of [false, true]) {
    it(
      `R-1/R-2 (${ephemeral ? 'in memory' : 'SQLite file'}) the segment is exactly the pre-compaction messages before H.head, oldest first, same shape; no overlap with the current view`,
      async () => {
        const { t, session } = await openSession({ ephemeral })
        await threeTurns(t, session)
        const before = await list(session)
        expect(before.map((m) => m.content.split(' ')[0])).toEqual([
          'u1',
          'a1',
          'u1b',
          'a1b',
          'u2',
          'a2'
        ])

        const H = await compact(t, session, 'SUMMARY')
        const current = await list(session)
        expect(current[0]!.id).toBe(String(H.id))

        const segment = await session.compactedMessages(String(H.id))
        const expected = before.filter((m) => Number(m.id) < H.head)
        expect(expected.length).toBeGreaterThan(0)
        expect(segment).toStrictEqual(expected)
        expect(isSummary(segment[0])).toBe(false)
        // 升序（条目 id 就是消息 id）
        const numeric = segment.map((m) => Number(m.id))
        expect(numeric).toEqual([...numeric].sort((a, b) => a - b))

        // R-2：不重叠；接起来 = 压缩之前的整份列表 + 摘要
        const currentIds = new Set(ids(current))
        expect(segment.some((m) => currentIds.has(m.id))).toBe(false)
        const union = [...segment, ...current]
        expect(ids(union.filter((m) => !isSummary(m)))).toEqual(ids(before))
        expect(union.filter(isSummary).map((m) => m.id)).toEqual([String(H.id)])
      },
      TIMEOUT
    )
  }

  it(
    'R-9 display sidecars (inline tokens) in the compacted stretch are the same as the pre-compaction view showed them',
    async () => {
      const { t, session } = await openSession()
      const tokens = {
        k1: { type: 'cmd', id: 'deploy', displayText: '/deploy', payload: 'PAYLOAD-K1' }
      }
      t.kit.queue(answer('a1'))
      expect(
        await session.submitUser('run PAYLOAD-K1 please', {
          display: { content: 'run {{shuvixInlineToken:k1}} please', tokens }
        })
      ).toEqual({})
      await send(t, session, big('u2'), 'a2')
      const before = await list(session)
      expect(before[0]!.metadata).toStrictEqual({ inlineTokens: tokens })

      const H = await compact(t, session, 'SUMMARY')
      const segment = await session.compactedMessages(String(H.id))
      expect(segment[0]).toStrictEqual(before[0])
      expect(segment[0]!.content).toBe('run {{shuvixInlineToken:k1}} please')
      for (const message of segment) expect(message.content).not.toContain('PAYLOAD-K1')
    },
    TIMEOUT
  )

  it(
    'R-11 read-only: no commit is published, runState stays idle, no projector is mounted',
    async () => {
      const { t, session } = await openSession()
      await threeTurns(t, session)
      const H = await compact(t, session, 'SUMMARY')
      await settleFrames()
      const recorder = recordPublications(session.harness)
      const projector = vi.spyOn(session, 'projector')
      const segment = await session.compactedMessages(String(H.id))
      expect(segment.length).toBeGreaterThan(0)
      await session.compactedMessages('abc')
      await settleFrames()
      expect(recorder.publications).toEqual([])
      expect(projector).not.toHaveBeenCalled()
      expect(session.runState).toBe('idle')
      recorder.stop()
      projector.mockRestore()
    },
    TIMEOUT
  )
})

describe('compactedMessages · chains', () => {
  it(
    'R-3 two compactions chain: seg(H2) starts with the H1 summary, seg(H1) is the oldest stretch, no id appears twice',
    async () => {
      const { t, session } = await openSession()
      await threeTurns(t, session)
      const full: ChatMessage[] = await list(session)
      const H1 = await compact(t, session, 'SUMMARY-1')
      await send(t, session, big('u3'), 'a3')
      full.push(...(await list(session)).slice(-2))
      const H2 = await compact(t, session, 'SUMMARY-2')
      const current = await list(session)
      expect(current[0]!.id).toBe(String(H2.id))

      const seg2 = await session.compactedMessages(String(H2.id))
      expect(seg2[0]!.id).toBe(String(H1.id))
      expect(seg2[0]!.metadata).toStrictEqual({ isCompactionSummary: true })
      expect(seg2[0]!.content).toBe('SUMMARY-1')

      const seg1 = await session.compactedMessages(seg2[0]!.id)
      expect(isSummary(seg1[0])).toBe(false)
      expect(seg1.map((m) => m.content)).toEqual(['u1', 'a1', 'u1b', 'a1b'])

      const all = [...seg1, ...seg2, ...current]
      expect(new Set(ids(all)).size).toBe(all.length)
      // 去掉两条摘要，正是两次压缩之前说过的全部
      expect(ids(all.filter((m) => !isSummary(m)))).toEqual(ids(full))
    },
    TIMEOUT
  )

  it(
    'R-4 a keep window reaching back across the older compaction (H1.head <= H2.head < H1.id): no duplicate, the chain still reaches the oldest stretch',
    async () => {
      const { t, session } = await openSession()
      await threeTurns(t, session)
      const H1 = await compact(t, session, 'SUMMARY-1')
      await send(t, session, 'u3', 'a3')
      const entries = await allEntries(await session.currentConversation())
      // H1 保留的是 u2 a2：H2 从 a2 起留（在 H1 之前）
      const a2 = entries.find((e) => e.kind === 'pi.assistant' && (e.id as number) > H1.head)!
      expect(a2.id as number).toBeLessThan(H1.id)
      const [h2] = await appendEntries(session, [
        compactionDraft(a2.id as EntryId, 'SUMMARY-2', Date.now())
      ])
      const current = await list(session)
      expect(current[0]!.id).toBe(String(h2!.id))

      const seg2 = await session.compactedMessages(String(h2!.id))
      expect(seg2[0]!.id).toBe(String(H1.id))
      const seg1 = await session.compactedMessages(seg2[0]!.id)
      expect(seg1.map((m) => m.content)).toEqual(['u1', 'a1', 'u1b', 'a1b'])

      const all = [...seg1, ...seg2, ...current]
      expect(new Set(ids(all)).size).toBe(all.length)
      const contents = all.filter((m) => !isSummary(m)).map((m) => m.content.split(' ')[0])
      expect(contents).toEqual(['u1', 'a1', 'u1b', 'a1b', 'u2', 'a2', 'u3', 'a3'])
    },
    TIMEOUT
  )

  it(
    'R-5 a reset ends the chain: nothing before the reset appears, the segment does not start with a summary; the reset entry id → []',
    async () => {
      const { t, session } = await openSession()
      await send(t, session, 'old-u', 'old-a')
      const conversation = await session.currentConversation()
      await conversation.reset('HANDOFF-TEXT', BG)
      await threeTurns(t, session)
      const H = await compact(t, session, 'SUMMARY')

      const segment = await session.compactedMessages(String(H.id))
      expect(segment.map((m) => m.content)).toEqual(['u1', 'a1', 'u1b', 'a1b'])
      expect(isSummary(segment[0])).toBe(false)
      expect(JSON.stringify(segment)).not.toContain('old-')
      expect(JSON.stringify(segment)).not.toContain('HANDOFF-TEXT')

      const reset = (await allEntries(conversation)).find((e) => e.kind === 'pi.reset')!
      expect(await session.compactedMessages(String(reset.id))).toEqual([])
    },
    TIMEOUT
  )

  it(
    'R-6 a hidden rollback branch never appears in the compacted stretch',
    async () => {
      const { t, session, ids: base } = await rollbackBase({ settingsOverrides: SETTINGS })
      forkedId(await session.rollbackTo(base.u2))
      await send(t, session, 'v1', 'b1')
      await send(t, session, big('v2'), 'b2')
      const H = await compact(t, session, 'SUMMARY')

      const segment = await session.compactedMessages(String(H.id))
      expect(segment.map((m) => m.content)).toEqual(['U1', 'A1', 'v1', 'b1'])
      const hidden = [base.u2, base.a2, base.u3, base.a3].map(String)
      expect(segment.some((m) => hidden.includes(m.id))).toBe(false)
    },
    TIMEOUT
  )

  it(
    'R-8 the chain crosses a rollback fork: compacted in the root, forked after it, compacted again in the fork',
    async () => {
      const { t, session } = await openSession()
      await threeTurns(t, session)
      const H1 = await compact(t, session, 'SUMMARY-1')
      await send(t, session, 'u3', 'a3')
      await send(t, session, 'u4', 'a4')
      const u4 = (await list(session)).find((m) => m.content === 'u4')!
      forkedId(await session.rollbackTo(Number(u4.id)))
      await send(t, session, big('w1'), 'x1')
      const H2 = await compact(t, session, 'SUMMARY-2')

      const seg2 = await session.compactedMessages(String(H2.id))
      expect(seg2[0]!.id).toBe(String(H1.id))
      expect(seg2.slice(1).map((m) => m.content.split(' ')[0])).toEqual(['u2', 'a2', 'u3', 'a3'])
      expect(seg2.some((m) => m.content === 'u4')).toBe(false)
      const seg1 = await session.compactedMessages(String(H1.id))
      expect(seg1.map((m) => m.content)).toEqual(['u1', 'a1', 'u1b', 'a1b'])
      const all = [...seg1, ...seg2, ...(await list(session))]
      expect(new Set(ids(all)).size).toBe(all.length)
    },
    TIMEOUT
  )
})

describe('compactedMessages · ids it does not recognize', () => {
  it(
    'R-7 malformed, non-compaction and out-of-range ids → [] without throwing',
    async () => {
      const { t, session } = await openSession()
      await threeTurns(t, session)
      const H = await compact(t, session, 'SUMMARY')
      const userId = (await list(session)).find((m) => m.role === 'user')!.id
      for (const bad of [
        '0',
        '1',
        '-3',
        'abc',
        '007',
        '',
        ' 5',
        '1.5',
        '99999999999999999999',
        userId,
        String(H.id + 1000)
      ]) {
        expect(await session.compactedMessages(bad), bad).toEqual([])
      }
      // 直接问底层：非安全整数 / ≤1 同样是 []
      const conversation = await session.currentConversation()
      expect(await compactedSegment(conversation, Number.MAX_SAFE_INTEGER + 2)).toEqual([])
      expect(await compactedSegment(conversation, 1)).toEqual([])
    },
    TIMEOUT
  )

  it(
    'R-7 a session that never compacted → []',
    async () => {
      const { t, session } = await openSession()
      await send(t, session, 'u1', 'a1')
      for (const m of await list(session)) expect(await session.compactedMessages(m.id)).toEqual([])
    },
    TIMEOUT
  )

  it(
    'R-12 a closed handle rejects with SessionClosedError',
    async () => {
      const { t, session } = await openSession()
      await threeTurns(t, session)
      const H = await compact(t, session, 'SUMMARY')
      await t.host.close('s1')
      await expect(session.compactedMessages(String(H.id))).rejects.toBeInstanceOf(
        SessionClosedError
      )
    },
    TIMEOUT
  )
})
