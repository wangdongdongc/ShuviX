/**
 * P3-03 · 投影器里的输入来源（`metadata.origin`，2026-10-21）：投影器跟踪每个对话的 `SourceDoc`（旁路记下变化、
 * 挂载时读快照），按 requestId 落到用户条目上 —— 与显示侧车同一套落点（当前对话的 submission，或活上下文里的
 * 祖先对话）。
 *
 *   56 挂载：只带来源（没有显示侧车）的发送，第一份值里就有来源；之后零修订；= freshMount（钉住挂载时按
 *      requestId 查 submission 用的是显示侧车与来源的并集）
 *   57 实时：先挂上再发送 —— 用户消息第一次出现的那份修订就带着来源；逐帧身份预言；= freshMount = 重开
 *   58 排队：followUp / steer 带来源排在队里时，队列项的形状不变（不带来源）；离开队列的那份修订里消息带着来源；
 *      挂载时已经排着队的同样
 *   59 fork：回退之后换挂载，前缀里的来源经祖先对话解析照旧、被回退掉的那条不在；fork 上新发的带来源；
 *      = freshMount = 重开；直接 fork + 指针（P3-03-28 那样）前缀消息原样（含来源）
 *   60 认不出的来源：界面当作没有（不带 origin 键），读者失败闭合（`readInputSources` → 空 sessionId 的父会话）
 *      —— 刻意的不一致；挂载之前、之后写的都一样
 *   61 一次性投影（没有投影挂着时的 `viewSnapshot`）：带来源，= freshMount
 *   62 触发器替 bot 发的（`kind: 'trigger'`，2026-10-24）：投影成 `metadata.origin = {kind, trigger, sourceId, bot}`；
 *      缺 bot 的触发器项认不出 → 不带 origin（读者照样失败闭合）
 */
import type { ConversationId, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { DisplayDoc, SessionStateDoc, SourceDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { readInputSources } from '../../inputSource'
import { userDraft } from '../../__tests__/support/digest'
import { answer, held } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { forkedId } from '../../__tests__/support/rollback'
import { allEntries, messageText } from '../../__tests__/support/transcript'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import {
  attachOracle,
  freshMount,
  opsOf,
  reopenMount,
  settleFrames,
  withoutAsks,
  type Revision
} from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 25000

const LOCAL = { kind: 'local' } as const
const REMOTE = {
  kind: 'remote',
  clientId: 'ws:4',
  address: '192.168.1.20',
  userAgent: 'UA'
} as const
const CHROME = { kind: 'chrome', installId: 'inst-1' } as const
const TELEGRAM = { kind: 'telegram', botId: 'b1', userId: 'u1', chatId: 'c1' } as const
const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
const TRIGGER = {
  kind: 'trigger',
  trigger: 'timer.fired',
  sourceId: 'timer:builtin:minute',
  bot: 'daily'
} as const
/** 读者对认不出的来源的失败闭合 */
const UNRECOGNIZED = { kind: 'parent-session', sessionId: '' }

const K1 = { k1: { type: 'cmd', id: 'deploy', displayText: '/deploy', payload: 'PAYLOAD-K1' } }
const D1 = { content: 'run {{shuvixInlineToken:k1}} please', tokens: K1 }

const originOf = (message: SessionView['messages'][number] | undefined): unknown =>
  (message?.metadata as { origin?: unknown } | null | undefined)?.origin

/** 视图里人能看见的用户消息（不含系统通知）：[正文, 来源] */
function userOrigins(view: SessionView): [string, unknown][] {
  return view.messages
    .filter(
      (message) =>
        message.role === 'user' &&
        (message.metadata as { isSystemNotice?: boolean } | null)?.isSystemNotice !== true
    )
    .map((message) => [message.content, originOf(message)])
}

/** 第一份含正文为 `content` 的用户消息的修订 */
function firstWith(
  revisions: readonly Revision<SessionView>[],
  content: string
): SessionView['messages'][number] | undefined {
  for (const revision of revisions) {
    const found = revision.value.messages.find((m) => m.role === 'user' && m.content === content)
    if (found !== undefined) return found
  }
  return undefined
}

async function userEntry(session: DurableSession, text: string): Promise<EntryRecord> {
  const found = (await allEntries(await session.currentConversation())).filter(
    (entry) => entry.kind === 'pi.user' && messageText(entry.model?.[0]) === text
  )
  expect(found, `user entry ${text}`).toHaveLength(1)
  return found[0]!
}

/**
 * 往当前对话手写（一个提交，同 durable 放下一条输入：条目与带着它的 submission 一起发布）：SourceDoc 项 + user
 * 条目 + 放下的 submission。交回 requestId → 条目
 */
async function writeSourced(
  session: DurableSession,
  rows: { requestId: string; text: string; item: unknown }[]
): Promise<Map<string, EntryRecord>> {
  const conversation = await session.currentConversation()
  const records = await session.harness.commit(async (tx) => {
    const doc = await tx.doc(SourceDoc, conversation.id)
    for (const { requestId, item } of rows) doc.items[requestId] = item as JsonObject
    const appended: EntryRecord[] = []
    for (const { requestId, text } of rows) {
      const entry = await tx.appendEntry(conversation.id, userDraft(text, 1))
      await tx.createSubmission({
        conversationId: conversation.id,
        requestId,
        type: 'input',
        status: 'placed',
        entry: entry.id
      })
      appended.push(entry)
    }
    return appended
  }, BG)
  return new Map(rows.map(({ requestId }, index) => [requestId, records[index]!]))
}

describe('P3-03 · input origins', () => {
  it(
    'P3-03-56 mount: source-only sends (no DisplayDoc at all) already carry their origins in the first value; zero revisions after settling; = freshMount',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'), answer('A2'), answer('A3'))
      expect(await session.submitUser('U1', { source: LOCAL })).toEqual({})
      expect(await session.submitUser('U2', { source: PARENT })).toEqual({})
      expect(await session.submitUser('U3')).toEqual({})
      // 只有来源、没有显示侧车：挂载时按 requestId 查 submission 不能只看 DisplayDoc 的键
      const displayDoc = await session.harness.snapshot(DisplayDoc, 1 as ConversationId, BG)
      expect(displayDoc?.items ?? {}).toStrictEqual({})
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      expect(userOrigins(ops.snapshot.value)).toStrictEqual([
        ['U1', LOCAL],
        ['U2', PARENT],
        ['U3', undefined]
      ])
      const u3 = ops.snapshot.value.messages.find((m) => m.content === 'U3')!
      expect(u3.metadata).toStrictEqual({})
      await settleFrames()
      expect(ops.revisions).toEqual([])
      expect(h.state.value).toStrictEqual(await freshMount(session))
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-57 live: mounted first, then sends with an origin — the first revision holding each user message already carries it (next to inline tokens); oracle at every frame; = freshMount = reopenMount',
    async () => {
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      const oracle = await attachOracle(session, h.state)
      t.kit.queue(answer('A1'), answer('A2'), answer('A3'))
      expect(await session.submitUser('U1', { source: REMOTE })).toEqual({})
      expect(
        await session.submitUser('run PAYLOAD-K1 please', { display: D1, source: TELEGRAM })
      ).toEqual({})
      expect(await session.submitUser('U3', { source: PARENT })).toEqual({})
      await settleFrames()
      expect(firstWith(ops.revisions, 'U1')!.metadata).toStrictEqual({ origin: REMOTE })
      expect(firstWith(ops.revisions, D1.content)!.metadata).toStrictEqual({
        inlineTokens: K1,
        origin: TELEGRAM
      })
      expect(firstWith(ops.revisions, 'U3')!.metadata).toStrictEqual({ origin: PARENT })
      ops.replay()
      expect(await oracle.verify()).toBeGreaterThan(0)
      await oracle.stop()
      const live = h.state.value
      expect(live).toStrictEqual(await freshMount(session))
      ops.stop()
      h.release()
      const { view } = await reopenMount(t, 's1')
      expect(withoutAsks(view)).toStrictEqual(withoutAsks(live))
      expect(userOrigins(view)).toStrictEqual([
        ['U1', REMOTE],
        [D1.content, TELEGRAM],
        ['U3', PARENT]
      ])
    },
    TIMEOUT
  )

  describe('P3-03-58 queued, then placed', () => {
    /** 一轮扣住的 go（带 LOCAL），followUp a（CHROME）与 steer b（TELEGRAM）排在它后面 */
    async function queuedPair(mountFirst: boolean): Promise<void> {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      let proj = mountFirst ? await session.projector() : undefined
      let h = proj?.acquire()
      let ops = h === undefined ? undefined : opsOf(h.state)
      const run = held(answer('a1'))
      t.kit.queue(run.step, answer('a2'), answer('a3'))
      const sending = session.submitUser('go', { source: LOCAL })
      await withTimeout(run.reached, 5000, 'first request')
      const s1 = (await session.followUp('a', { source: CHROME })).submissionId!
      const s2 = (await session.steer('b', { source: TELEGRAM })).submissionId!
      if (!mountFirst) {
        proj = await session.projector()
        h = proj.acquire()
        ops = opsOf(h.state)
      }
      await settleFrames()
      // 队列项的形状与 P3-03-19 一模一样：来源不进队列
      expect(h!.state.value.queue).toStrictEqual([
        { submissionId: s1, mode: 'followUp', text: 'a', imageCount: 0 },
        { submissionId: s2, mode: 'steer', text: 'b', imageCount: 0 }
      ])
      expect(originOf(h!.state.value.messages.find((m) => m.content === 'go'))).toStrictEqual(LOCAL)
      run.release()
      expect(await withTimeout(sending, 8000, 'send')).toEqual({})
      await waitFor(
        () => session.runState === 'idle' && h!.state.value.queue.length === 0,
        8000,
        'drained'
      )
      await settleFrames()
      const revisions = ops!.revisions
      for (const [submissionId, text, origin] of [
        [s1, 'a', CHROME],
        [s2, 'b', TELEGRAM]
      ] as const) {
        const leaves = revisions.findIndex((r, i) => {
          const before = i === 0 ? ops!.snapshot.value : revisions[i - 1]!.value
          return (
            !r.value.queue.some((q) => q.submissionId === submissionId) &&
            before.queue.some((q) => q.submissionId === submissionId)
          )
        })
        expect(leaves, text).toBeGreaterThanOrEqual(0)
        const message = revisions[leaves]!.value.messages.find((m) => m.content === text)
        expect(message?.metadata, text).toStrictEqual({ origin })
      }
      expect(h!.state.value).toStrictEqual(await freshMount(session))
      ops!.replay()
      ops!.stop()
      h!.release()
    }

    it('mounted before they queue', () => queuedPair(true), TIMEOUT)
    it('mounted while both are already queued', () => queuedPair(false), TIMEOUT)
  })

  it(
    'P3-03-59 rollback fork: after the ["r"] remount U1 / U2 keep their origins through the ancestor conversation, U3 is gone; U4 on the fork carries CHROME; = freshMount = reopenMount',
    async () => {
      const t = await makeHost()
      const session = await t.open('s1')
      await primeRoot(session)
      t.kit.queue(answer('A1'), answer('A2'), answer('A3'), answer('A4'))
      expect(await session.submitUser('U1', { source: LOCAL })).toEqual({})
      expect(await session.submitUser('U2', { source: PARENT })).toEqual({})
      expect(await session.submitUser('U3', { source: REMOTE })).toEqual({})
      const u3 = await userEntry(session, 'U3')
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      const prefix = h.state.value.messages.slice(0, 4)

      const fork = forkedId(await session.rollbackTo(u3.id))
      await waitFor(() => h.state.value.conversationId === fork, 3000, 'remounted')
      await settleFrames()
      expect(ops.revisions.some((r) => r.ops.some((op) => op[0] === 'r'))).toBe(true)
      expect(userOrigins(h.state.value)).toStrictEqual([
        ['U1', LOCAL],
        ['U2', PARENT]
      ])
      expect(h.state.value.messages).toStrictEqual(prefix)
      expect(h.state.value.messages.map((m) => m.id)).not.toContain(String(u3.id))

      expect(await session.submitUser('U4', { source: CHROME })).toEqual({})
      await settleFrames()
      expect(userOrigins(h.state.value)).toStrictEqual([
        ['U1', LOCAL],
        ['U2', PARENT],
        ['U4', CHROME]
      ])
      const live = h.state.value
      expect(live).toStrictEqual(await freshMount(session))
      ops.replay()
      ops.stop()
      h.release()
      const { view } = await reopenMount(t, 's1')
      expect(view.conversationId).toBe(fork)
      expect(withoutAsks(view)).toStrictEqual(withoutAsks(live))
    },
    TIMEOUT
  )

  it(
    'P3-03-59 fork + pointer in one commit (the P3-03-28 shape): one ["r"] revision, the prefix messages strictly equal to before, origins included',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'), answer('A2'))
      expect(await session.submitUser('U1', { source: REMOTE })).toEqual({})
      expect(await session.submitUser('U2', { source: TELEGRAM })).toEqual({})
      const [, a1] = await allEntries(await session.currentConversation())
      const proj = await session.projector()
      const h = proj.acquire()
      const before = h.state.value.messages.slice(0, 2)
      expect(originOf(before[0])).toStrictEqual(REMOTE)
      const ops = opsOf(h.state)
      const forkId = await session.harness.commit(async (tx) => {
        const created = await tx.forkConversation(1 as ConversationId, a1!.id, {
          ownership: { kind: 'ownerless' }
        })
        ;(await tx.doc(SessionStateDoc)).currentConversation = created.id
        return created.id
      }, BG)
      await waitFor(() => h.state.value.conversationId === forkId, 3000, 'remounted')
      await settleFrames()
      expect(ops.revisions).toHaveLength(1)
      expect(ops.revisions[0]!.ops).toEqual([['r', h.state.value]])
      expect(h.state.value.messages).toStrictEqual(before)
      expect(h.state.value).toStrictEqual(await freshMount(session))
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-60 unrecognized items (a newer kind, a malformed remote): no origin in the view, before and after mount, = freshMount — while the readers fail closed on the very same entries (by design)',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      const early = await writeSourced(session, [
        { requestId: 'r-hook', text: 'hook', item: { kind: 'hook', sessionId: 'H' } },
        { requestId: 'r-remote', text: 'bare remote', item: { kind: 'remote' } },
        { requestId: 'r-parent', text: 'parent', item: PARENT }
      ])
      const proj = await session.projector()
      const h = proj.acquire()
      expect(userOrigins(h.state.value)).toStrictEqual([
        ['hook', undefined],
        ['bare remote', undefined],
        ['parent', PARENT]
      ])
      const late = await writeSourced(session, [
        { requestId: 'r-hook-2', text: 'hook later', item: { kind: 'hook', sessionId: 'H' } },
        { requestId: 'r-remote-2', text: 'remote later', item: { kind: 'remote' } },
        { requestId: 'r-local', text: 'local later', item: LOCAL }
      ])
      await waitFor(
        () => h.state.value.messages.some((m) => m.content === 'local later'),
        3000,
        'late entries visible'
      )
      await settleFrames()
      expect(userOrigins(h.state.value)).toStrictEqual([
        ['hook', undefined],
        ['bare remote', undefined],
        ['parent', PARENT],
        ['hook later', undefined],
        ['remote later', undefined],
        ['local later', LOCAL]
      ])
      for (const message of h.state.value.messages) {
        if (originOf(message) === undefined) expect(message.metadata).not.toHaveProperty('origin')
      }
      expect(h.state.value).toStrictEqual(await freshMount(session))

      const id = (rows: Map<string, EntryRecord>, requestId: string): string =>
        String(rows.get(requestId)!.id)
      expect(await readInputSources(session)).toStrictEqual(
        new Map<string, unknown>([
          [id(early, 'r-hook'), UNRECOGNIZED],
          [id(early, 'r-remote'), UNRECOGNIZED],
          [id(early, 'r-parent'), PARENT],
          [id(late, 'r-hook-2'), UNRECOGNIZED],
          [id(late, 'r-remote-2'), UNRECOGNIZED]
        ])
      )
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-61 one-shot projection (viewSnapshot with no projector mounted) carries the origins; = freshMount',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'), answer('A2'), answer('A3'))
      expect(await session.submitUser('U1', { source: LOCAL })).toEqual({})
      expect(
        await session.submitUser('run PAYLOAD-K1 please', { display: D1, source: REMOTE })
      ).toEqual({})
      expect(await session.submitUser('U3', { source: PARENT })).toEqual({})
      const snapshot = await session.viewSnapshot()
      expect(userOrigins(snapshot)).toStrictEqual([
        ['U1', LOCAL],
        [D1.content, REMOTE],
        ['U3', PARENT]
      ])
      expect(snapshot.messages.find((m) => m.content === D1.content)!.metadata).toStrictEqual({
        inlineTokens: K1,
        origin: REMOTE
      })
      expect(snapshot).toStrictEqual(await freshMount(session))
    },
    TIMEOUT
  )

  it(
    'P3-03-62 a trigger source projects to metadata.origin = {kind, trigger, sourceId, bot} on that user message; a trigger item without bot projects no origin (readers fail closed); = freshMount',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'), answer('A2'))
      expect(await session.submitUser('Tick check-in.', { source: TRIGGER })).toEqual({})
      expect(await session.submitUser('typed', { source: LOCAL })).toEqual({})
      const broken = await writeSourced(session, [
        {
          requestId: 'r-no-bot',
          text: 'no bot',
          item: { kind: 'trigger', trigger: 'timer.fired', sourceId: 'timer:builtin:minute' }
        }
      ])

      const proj = await session.projector()
      const h = proj.acquire()
      expect(userOrigins(h.state.value)).toStrictEqual([
        ['Tick check-in.', TRIGGER],
        ['typed', LOCAL],
        ['no bot', undefined]
      ])
      const tick = h.state.value.messages.find((m) => m.content === 'Tick check-in.')!
      expect(tick.metadata).toStrictEqual({ origin: TRIGGER })
      const noBot = h.state.value.messages.find((m) => m.content === 'no bot')!
      expect(noBot.metadata).not.toHaveProperty('origin')
      expect(h.state.value).toStrictEqual(await freshMount(session))

      expect(await readInputSources(session)).toStrictEqual(
        new Map<string, unknown>([
          [String((await userEntry(session, 'Tick check-in.')).id), TRIGGER],
          [String(broken.get('r-no-bot')!.id), UNRECOGNIZED]
        ])
      )
      h.release()
    },
    TIMEOUT
  )
})
