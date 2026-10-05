/**
 * P3-03 · SessionProjector 的挂载（设计稿 P3-03-01..05，加修订版的 P3-03-50 / 51）：
 *
 *   01 空会话的视图恰好是什么
 *   02 在已有转写上挂载 = 纯投影（显示侧车解析、payload 不进任何 content）
 *   03 第一份可见的值就是完整的（PIN-01：projector() 解析完显示侧车才落定）
 *   04 挂载只读：零发布、不续跑、宿主不再收到运行状态
 *   05 挂在 fork 指针上：fork 的 id、前缀消息沿用根的 id
 *   50 watch 帧处理器里，这一帧的那次发布的旁路状态（显示侧车 / submission）已经记下
 *   51 与提交赛跑的挂载：发送在挂载之前 / 之后 0、1、2 个微任务开始，结果都 = freshMount
 */
import {
  InboxDoc,
  LiveDoc,
  type ConversationId,
  type EntryRecord,
  type InboxState,
  type LiveState
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { SessionStateDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { recordPublications } from '../../__tests__/support/commits'
import { crashWith } from '../../__tests__/support/crash'
import { answer, callTool, stalled } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import { resolveDisplayItems } from '../display'
import { projectSessionView } from '../project'
import {
  expectJson,
  freshMount,
  opsOf,
  projectorHostOf,
  readTool,
  settleFrames,
  SpyProjector
} from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 20000

type Tokens = Record<string, { type: string; id: string; displayText: string; payload: string }>
const K1: Tokens = { k1: { type: 'cmd', id: 'deploy', displayText: '/deploy', payload: 'PAYLOAD-K1' } }
const D1 = { content: 'run {{shuvixInlineToken:k1}} please', tokens: K1 }

async function entriesOf(session: DurableSession): Promise<EntryRecord[]> {
  return allEntries(await session.currentConversation())
}

describe('P3-03 · mount', () => {
  it('P3-03-01 empty session: exactly the empty durable view', async () => {
    const t = await makeHost({ ephemeral: ['s1'] })
    const session = await t.open('s1')
    const proj = await session.projector()
    const h = proj.acquire()
    expect(h.state.value).toStrictEqual({
      v: 1,
      sessionId: 's1',
      source: 'durable',
      capabilities: { send: true, rollback: true, continue: true },
      conversationId: 1,
      messages: [],
      live: null,
      toolRuns: {},
      run: { state: 'idle' },
      queue: [],
      asks: [],
      context: { usedTokens: null }
    })
    expectJson(h.state.value)
    h.release()
  })

  it(
    'P3-03-02 mount over an existing transcript = the pure projection; D1 content and tokens; no payload in any content',
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

      const proj = await session.projector()
      const h = proj.acquire()
      const conversation = await session.currentConversation()
      const state = await conversation.viewState(BG)
      const { entries, docs } = state.value
      state.dispose()
      const display = await resolveDisplayItems(session.harness, conversation.id, entries)
      const expected = projectSessionView(
        { sessionId: 's1', conversationId: conversation.id },
        entries,
        docs['pi.live'] as LiveState | undefined,
        docs['pi.inbox'] as InboxState | undefined,
        display,
        [],
        'idle'
      )
      expect(h.state.value).toStrictEqual(expected)
      const user = h.state.value.messages[0]!
      expect(user.content).toBe(D1.content)
      expect(user.metadata).toStrictEqual({ inlineTokens: K1 })
      for (const message of h.state.value.messages) {
        expect(message.content).not.toContain('PAYLOAD-K1')
      }
      expect(h.state.value.messages.map((m) => m.content)).toEqual([
        D1.content,
        'A1',
        'read it',
        '',
        'A2',
        'a notice'
      ])
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-03 the first observable value is complete (PIN-01): the snapshot already carries D1, no revision shows the model text',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('run PAYLOAD-K1 please', { display: D1 })).toEqual({})
      const proj = await session.projector()
      const h = proj.acquire()
      const ops = opsOf(h.state)
      expect(ops.snapshot.value.messages[0]!.content).toBe(D1.content)
      await settleFrames()
      for (const revision of ops.revisions) {
        expect(JSON.stringify(revision.value)).not.toContain('PAYLOAD-K1')
      }
      expect(ops.revisions).toEqual([])
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-04 mount is read-only: zero publications, still interrupted, no resume, no new run-state report',
    async () => {
      const { t } = await crashWith()
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)
      const reports = t.states.length
      const recorder = recordPublications(session.harness)
      const proj = await session.projector()
      const h = proj.acquire()
      await settleFrames()
      expect(recorder.publications).toEqual([])
      expect(session.isInterrupted()).toBe(true)
      expect(session.runState).toBe('interrupted')
      expect(h.state.value.run).toStrictEqual({ state: 'interrupted' })
      expect(t.states.length).toBe(reports)
      recorder.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-05 mount on a fork pointer: the fork id, U1 A1 with the root ids, U2 A2 absent',
    async () => {
      const first = await makeHost()
      const original = await first.open()
      first.kit.queue(answer('A1'), answer('A2'))
      expect(await original.submitUser('U1')).toEqual({})
      expect(await original.submitUser('U2')).toEqual({})
      const entries = await entriesOf(original)
      const [u1, a1] = entries
      const forkId = await original.harness.commit(async (tx) => {
        const fork = await tx.forkConversation(1 as ConversationId, a1!.id, {
          ownership: { kind: 'ownerless' }
        })
        ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
        return fork.id
      }, BG)
      const t = await first.restart()
      const session = await t.open()
      const proj = await session.projector()
      const h = proj.acquire()
      expect(h.state.value.conversationId).toBe(forkId)
      expect(h.state.value.messages.map((m) => [m.id, m.content])).toEqual([
        [String(u1!.id), 'U1'],
        [String(a1!.id), 'A1']
      ])
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-50 inside the watch handler the frame holds the publication’s entries and its side-channel display/submission state is recorded',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      const host = projectorHostOf(session)
      const seen: { entries: number; userDisplayed: boolean; lastId: number | undefined }[] = []
      const projector = new SpyProjector(host, (frame, view) => {
        const user = view.messages.find((m) => m.role === 'user')
        seen.push({
          entries: frame.entries.length,
          userDisplayed: user === undefined || user.content === D1.content,
          lastId: frame.entries.at(-1)?.id
        })
      })
      await projector.start()
      const publishedIds: number[][] = []
      const stop = session.harness.subscribeCommits((publication) => {
        const ids = publication.changes.flatMap((change) =>
          change.type === 'entry' && change.value.conversationId === 1 ? [change.value.id] : []
        )
        if (ids.length > 0) publishedIds.push(ids)
      })
      t.kit.queue(answer('A1'))
      expect(await session.submitUser('run PAYLOAD-K1 please', { display: D1 })).toEqual({})
      await settleFrames()
      stop()
      // 每一帧里，这一帧之前（含）所有发布的条目都在；用户消息一出现就已经是显示侧车的内容
      expect(seen.every((frame) => frame.userDisplayed)).toBe(true)
      const lastIds = new Set(seen.map((frame) => frame.lastId))
      for (const ids of publishedIds) expect(lastIds.has(ids.at(-1))).toBe(true)
      projector.dispose()
    },
    TIMEOUT
  )

  describe('P3-03-51 a mount that races commits', () => {
    for (const offset of [-2, -1, 0, 1, 2]) {
      it(
        `the send starts ${offset < 0 ? `${-offset} microtasks before` : `${offset} microtasks after`} projector(): the value equals freshMount, every entry present, the user message carries D`,
        async () => {
          const t = await makeHost({ ephemeral: ['s1'] })
          const session = await t.open('s1')
          await primeRoot(session)
          const stall = stalled()
          t.kit.queue(stall.step)
          let sending: Promise<unknown> | undefined
          const send = (): void => {
            sending = session.submitUser('run PAYLOAD-K1 please', { display: D1 })
          }
          const tick = async (n: number): Promise<void> => {
            for (let index = 0; index < n; index++) await Promise.resolve()
          }
          let mounting: Promise<unknown>
          if (offset < 0) {
            send()
            await tick(-offset)
            mounting = session.projector()
          } else {
            mounting = session.projector()
            await tick(offset)
            send()
          }
          const proj = (await mounting) as Awaited<ReturnType<DurableSession['projector']>>
          const h = proj.acquire()
          await withTimeout(stall.reached, 5000, 'request reached')
          await waitFor(
            async () =>
              (await session.harness.snapshot(LiveDoc, 1 as ConversationId, BG))?.run !==
              undefined,
            3000,
            'run started'
          )
          await settleFrames()
          expect(h.state.value).toStrictEqual(await freshMount(session))
          const users = h.state.value.messages.filter((m) => m.role === 'user')
          expect(users.map((m) => m.content)).toEqual([D1.content])
          const entries = await entriesOf(session)
          for (const entry of entries.filter((e) => e.kind === 'pi.user')) {
            expect(h.state.value.messages.some((m) => m.id === String(entry.id))).toBe(true)
          }
          expect(
            (await session.harness.snapshot(InboxDoc, 1 as ConversationId, BG))?.items ?? []
          ).toEqual([])
          await session.abort()
          await sending
          h.release()
        },
        TIMEOUT
      )
    }
  })
})
