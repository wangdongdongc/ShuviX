/**
 * P3-10a · 回退 fork：fork 点、提交与指针（设计稿 P3-10a-01..09）。
 *
 * 基础场景：根上 U1 A1 U2 A2 U3 A3，锁在 faux-1 上，`today` 没注入；`r = await session.rollbackTo(id, opts)`。
 *
 *   01 keep:false：fork 在 A1 上（parent {1, A1}，ownerless）；指针指过去；视图 [U1, A1]，id 不变
 *   02 keep:true：fork 在 U2 上；视图 [U1, A1, U2]；空闲，不起 run
 *   03 没有前缀（目标 U1）：新对话（没有 parent，ownerless）；messages [] / usedTokens null
 *   04 非消息条目也能是 fork 点：日期通知（PIN-24，见下）；压缩摘要 C（视图第一条是摘要）
 *   05 fork 点只看当前对话看得见的历史：中间有派发轮（子对话条目 id 交错）→ fork 在 A2；
 *      keep:true 落在工具结果之后插进来的 steer 上 → fork 在它上面，视图空闲、没有工具进度、队列为空
 *   06 一个提交：建 F 与指针在同一次发布里，谁也不单独出现；那次发布没有条目、没有别的文档
 *   07 指针移动、其余字段不动（lock 由销毁清掉）；关了再开：指针仍是 F、视图相同
 *   08 前缀 id 不变、显示侧车（内联 Token）保留，重开后也是
 *   09 旧分支留在存储里、视图里看不见；从 F 再回退 → F2（parent F，共 3 个对话）；回退到 F 继承的前缀也行
 *
 * PIN-24 / F5 的偏差：设计稿说「日期通知写在第一条输入之前」，但 `maybeAnnounceDate` 在对话还没有条目时只
 * 记日期、不写通知 —— 日期通知前面总有别的条目。用例 04 因此在日期通知之前放一条上一天的后台通知 N0：
 * 回退到 U1 时 fork 点是日期通知 D，视图是 [N0, D]（全是通知），当天的下一次发送不再告知日期。
 */
import { Type } from '@earendil-works/pi-ai'
import {
  CompactionEntry,
  defineTool,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import { opPath } from '../projection/__tests__/projectorSupport'
import { answer, callTool } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import {
  contents,
  conversationCount,
  conversationRecord,
  createsConversation,
  entriesOf,
  forkedId,
  messageIds,
  rawPublications,
  rollbackBase,
  sessionStateChange,
  viewOf
} from './support/rollback'
import { callAgent, hostD } from './support/spawn'
import { allEntries, transcript } from './support/transcript'
import { aborted, deferred, sleep } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000

describe('P3-10a · fork point', () => {
  it('P3-10a-01 keep:false forks at the entry before the target: parent {1, A1}, ownerless, pointer moved, view [U1, A1] with the same ids', async () => {
    const { session, ids } = await rollbackBase()
    const before = await viewOf(session)
    const F = forkedId(await session.rollbackTo(ids.u2))
    expect(await conversationRecord(session, F)).toEqual({
      id: F,
      parent: { conversationId: ROOT_CONVERSATION_ID, at: ids.a1 }
    })
    expect((await session.currentConversation()).id).toBe(F)
    const view = await viewOf(session)
    expect(view.conversationId).toBe(F)
    expect(messageIds(view)).toEqual([String(ids.u1), String(ids.a1)])
    expect(view.messages).toStrictEqual(before.messages.slice(0, 2))
  })

  it('P3-10a-02 keep:true forks at the target itself: view [U1, A1, U2]; idle, no run starts', async () => {
    const { t, session, ids } = await rollbackBase()
    const calls = t.kit.callCount
    const F = forkedId(await session.rollbackTo(ids.u2, { keep: true }))
    expect((await conversationRecord(session, F))?.parent).toEqual({
      conversationId: ROOT_CONVERSATION_ID,
      at: ids.u2
    })
    const view = await viewOf(session)
    expect(messageIds(view)).toEqual([String(ids.u1), String(ids.a1), String(ids.u2)])
    expect(contents(view)).toEqual(['U1', 'A1', 'U2'])
    expect(session.runState).toBe('idle')
    expect(view.run.state).toBe('idle')
    await sleep(30)
    expect(t.kit.callCount).toBe(calls)
    expect((await session.harness.inspect(BG)).tasks).toEqual([])
  })

  it('P3-10a-03 no prefix (target U1): a new conversation with no parent and no owner; messages [] and usedTokens null', async () => {
    const { session, ids } = await rollbackBase()
    const F = forkedId(await session.rollbackTo(ids.u1))
    expect(await conversationRecord(session, F)).toEqual({ id: F })
    expect((await session.currentConversation()).id).toBe(F)
    const view = await viewOf(session)
    expect(view.conversationId).toBe(F)
    expect(view.messages).toEqual([])
    expect(view.context.usedTokens).toBeNull()
  })

  it('P3-10a-04a a date notice before U1 is the fork point (PIN-24): the view keeps the notices; the next send that day adds no second date notice', async () => {
    let day = '2026-10-04'
    const t = await makeHost({ today: () => day })
    const session = await t.open('s1')
    await primeRoot(session)
    // 上一天：一条后台通知（对话从此有条目；日期通知只在有条目的对话里写）
    expect((await session.writeNotice({ text: 'N0', kind: 'background' })).status).toBe(
      'submitted'
    )
    day = '2026-10-05'
    t.kit.queue(answer('A1'))
    expect(await session.submitUser('U1')).toEqual({})
    const root = await allEntries(await session.currentConversation())
    expect(root.map((entry) => entry.kind)).toEqual([
      'shuvix.notice',
      'shuvix.notice',
      'pi.user',
      'pi.assistant'
    ])
    const [n0, date, u1] = root
    expect(date!.data).toMatchObject({ kind: 'date', date: '2026-10-05' })

    const F = forkedId(await session.rollbackTo(u1!.id))
    expect((await conversationRecord(session, F))?.parent).toEqual({
      conversationId: ROOT_CONVERSATION_ID,
      at: date!.id
    })
    const view = await viewOf(session)
    expect(messageIds(view)).toEqual([String(n0!.id), String(date!.id)])

    t.kit.queue(answer('A2'))
    expect(await session.submitUser('again')).toEqual({})
    const onFork = await allEntries(await session.currentConversation())
    expect(onFork.filter((entry) => entry.data?.kind === 'date')).toHaveLength(1)
    expect(await transcript(await session.currentConversation())).toEqual([
      'shuvix.notice:N0',
      expect.stringContaining('shuvix.notice:<date-change>Today is 2026-10-05'),
      'pi.user:again',
      'pi.assistant:A2'
    ])
  })

  it('P3-10a-04b the first user entry after compaction head C: the fork is at C and messages[0] is the compaction summary', async () => {
    const t = await makeHost()
    const session = await t.open('s1')
    await primeRoot(session)
    t.kit.queue(answer('A1'), answer('A2'))
    expect(await session.submitUser('U1')).toEqual({})
    expect(await session.submitUser('U2')).toEqual({})
    const compaction = await session.harness.commit(
      (tx) =>
        tx.appendEntry(CompactionEntry, ROOT_CONVERSATION_ID, {
          model: [
            {
              role: 'user',
              content:
                'The conversation history before this point was compacted into the following summary:\n\n<summary>\nSUMMARY\n</summary>',
              timestamp: Date.now()
            }
          ],
          head: 'self',
          data: { reason: 'manual' }
        }),
      BG
    )
    t.kit.queue(answer('A3'))
    expect(await session.submitUser('U3')).toEqual({})
    const u3 = (await allEntries(await session.currentConversation())).find(
      (entry) => entry.kind === 'pi.user' && entry.id > compaction.id
    )!
    const F = forkedId(await session.rollbackTo(u3.id))
    expect((await conversationRecord(session, F))?.parent?.at).toBe(compaction.id)
    const view = await viewOf(session)
    expect(messageIds(view)).toEqual([String(compaction.id)])
    expect(view.messages[0]!.metadata).toStrictEqual({ isCompactionSummary: true })
    expect(view.messages[0]!.content).toContain('SUMMARY')
  })

  it(
    'P3-10a-05a a dispatch round between U2 and A2 (child entries interleaved by id): rollbackTo(U3) forks at A2, never at a child entry',
    async () => {
      const d = await hostD()
      d.t.kit.queue(answer('A1'))
      expect(await d.session.submitUser('U1')).toEqual({})
      d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('A2'))
      expect(await d.session.submitUser('U2')).toEqual({})
      d.t.kit.queue(answer('A3'))
      expect(await d.session.submitUser('U3')).toEqual({})
      const C = d.outcomes[0]!.conversationId!
      const root = await allEntries(await d.session.currentConversation())
      const users = root.filter((entry) => entry.kind === 'pi.user')
      const u2 = users[1]!
      const u3 = users[2]!
      const a2 = root.filter((entry) => entry.id < u3.id).at(-1)!
      expect(a2.kind).toBe('pi.assistant')
      const childIds = (await entriesOf(d.session, C)).map((entry) => entry.id as number)
      expect(childIds.length).toBeGreaterThan(0)
      // 交错：子对话的条目落在 U2 与 A2 之间
      for (const id of childIds) {
        expect(id).toBeGreaterThan(u2.id)
        expect(id).toBeLessThan(a2.id)
      }
      const F = forkedId(await d.session.rollbackTo(u3.id))
      const at = (await conversationRecord(d.session, F))?.parent?.at
      expect(at).toBe(a2.id)
      expect(childIds).not.toContain(at)
    },
    TIMEOUT
  )

  it(
    'P3-10a-05b keep:true on a steered user entry placed after a tool result: the fork is at it; live null, toolRuns {}, queue [], idle',
    async () => {
      const gate = deferred()
      const started = deferred()
      const waitTool = defineTool({
        name: 'wait',
        description: 'wait: waits for the test',
        parameters: Type.Object({}),
        execute: async (_args, _api, context) => {
          started.resolve()
          await Promise.race([gate.promise, aborted(context.abortSignal!)])
          return { content: [{ type: 'text', text: 'waited' }] }
        }
      })
      const t = await makeHost({ tools: [waitTool] })
      const session = await t.open('s1')
      await primeRoot(session)
      t.kit.queue(callTool('wait'), answer('final'))
      const sending = session.submitUser('go')
      await started.promise
      expect((await session.steer('S')).error).toBeUndefined()
      gate.resolve()
      expect(await sending).toEqual({})
      const root = await allEntries(await session.currentConversation())
      const toolResult = root.find((entry) => entry.kind === 'pi.tool-result')!
      const steered = root.find(
        (entry) =>
          entry.kind === 'pi.user' &&
          entry.model?.[0]?.role === 'user' &&
          entry.model[0].content === 'S'
      )!
      expect(steered.id).toBeGreaterThan(toolResult.id)

      const F = forkedId(await session.rollbackTo(steered.id, { keep: true }))
      expect((await conversationRecord(session, F))?.parent?.at).toBe(steered.id)
      const view = await viewOf(session)
      expect(view.messages.at(-1)!.id).toBe(String(steered.id))
      expect(view.live).toBeNull()
      expect(view.toolRuns).toEqual({})
      expect(view.queue).toEqual([])
      expect(view.run.state).toBe('idle')
      expect(session.isBusy()).toBe(false)
      expect(session.isInterrupted()).toBe(false)
      expect(await session.harness.snapshot(LiveDoc, F, BG)).toEqual({})
      expect((await session.harness.snapshot(InboxDoc, F, BG))?.items).toEqual([])
    },
    TIMEOUT
  )
})

describe('P3-10a · commit and pointer', () => {
  it('P3-10a-06 one commit: the F conversation and the pointer move share one publication; neither appears alone; no entries, no other documents', async () => {
    const { session, ids } = await rollbackBase()
    const recorder = rawPublications(session)
    const F = forkedId(await session.rollbackTo(ids.u2))
    recorder.stop()
    const creating = recorder.publications.filter((p) => createsConversation(p, F))
    expect(creating).toHaveLength(1)
    const fork = creating[0]!
    expect((sessionStateChange(fork)?.value as { currentConversation?: number } | null)?.currentConversation).toBe(F)
    // 指针第一次指向 F 的那次发布就是建 F 的那次
    const pointing = recorder.publications.filter(
      (p) =>
        (sessionStateChange(p)?.value as { currentConversation?: number } | null | undefined)
          ?.currentConversation === F
    )
    expect(pointing[0]).toBe(fork)
    expect(fork.changes.some((change) => change.type === 'entry')).toBe(false)
    for (const change of fork.changes) {
      if (change.type !== 'document' && change.type !== 'document.copy') continue
      if (change.record.kind === 'shuvix.session-state') continue
      expect(change.conversationId, change.record.kind).toBe(F)
    }
  })

  it(
    'P3-10a-07 only the pointer (and the lock, cleared by the destroy) changes; deferredNotices and driven are not written by the rollback commit; reopen keeps F and the view',
    async () => {
      const { t, session, ids } = await rollbackBase()
      const before = (await session.harness.snapshot(SessionStateDoc, BG))!
      expect(before.lock).toBeDefined()
      const recorder = rawPublications(session)
      const F = forkedId(await session.rollbackTo(ids.u2))
      recorder.stop()
      const after = (await session.harness.snapshot(SessionStateDoc, BG))!
      const { lock: _lock, ...rest } = before
      expect(after).toEqual({ ...rest, currentConversation: F })
      const fork = recorder.publications.find((p) => createsConversation(p, F))!
      const change = sessionStateChange(fork)!
      expect(change.ops.length).toBeGreaterThan(0)
      for (const op of change.ops) expect(opPath(op)[0]).toBe('currentConversation')

      const view = await viewOf(session)
      await t.host.close('s1')
      const reopened = await t.open('s1')
      expect((await reopened.currentConversation()).id).toBe(F)
      expect(await viewOf(reopened)).toStrictEqual(view)
    },
    TIMEOUT
  )

  it(
    'P3-10a-08 prefix ids are identical and an inline-token U1 keeps its display content after the rollback and after a reopen',
    async () => {
      const tokens = {
        k1: { type: 'cmd', id: 'cmd1', displayText: '/cmd1', payload: 'PAYLOAD-K1' }
      }
      const display = { content: 'd1 {{shuvixInlineToken:k1}}', tokens }
      const t = await makeHost()
      const session = await t.open('s1')
      await primeRoot(session)
      t.kit.queue(answer('A1'), answer('A2'))
      expect(await session.submitUser('d1 PAYLOAD-K1', { display })).toEqual({})
      expect(await session.submitUser('U2')).toEqual({})
      const before = await viewOf(session)
      const u2 = before.messages[2]!
      expect(before.messages[0]!.metadata).toEqual({ inlineTokens: tokens })

      forkedId(await session.rollbackTo(Number(u2.id)))
      const view = await viewOf(session)
      expect(view.messages).toStrictEqual(before.messages.slice(0, 2))
      expect(view.messages[0]!.content).toBe(display.content)
      expect(view.messages[0]!.metadata).toEqual({ inlineTokens: tokens })

      await t.host.close('s1')
      const reopened = await t.open('s1')
      expect((await viewOf(reopened)).messages).toStrictEqual(before.messages.slice(0, 2))
    },
    TIMEOUT
  )

  it('P3-10a-09 old branches stay and are hidden; a second rollback from F makes F2 (parent F, 3 conversations); a rollback into F’s inherited prefix works', async () => {
    const { t, session, ids } = await rollbackBase()
    const F = forkedId(await session.rollbackTo(ids.u2))
    expect(await transcript((await session.harness.conversation(ROOT_CONVERSATION_ID, BG))!)).toEqual([
      'pi.user:U1',
      'pi.assistant:A1',
      'pi.user:U2',
      'pi.assistant:A2',
      'pi.user:U3',
      'pi.assistant:A3'
    ])
    const view = await viewOf(session)
    for (const hidden of [ids.u2, ids.a2, ids.u3, ids.a3]) {
      expect(messageIds(view)).not.toContain(String(hidden))
    }

    t.kit.queue(answer('A4'))
    expect(await session.submitUser('U4')).toEqual({})
    const u4 = (await allEntries(await session.currentConversation())).find(
      (entry) => entry.kind === 'pi.user' && entry.id > ids.a3
    )!
    const F2 = forkedId(await session.rollbackTo(u4.id))
    expect((await conversationRecord(session, F2))?.parent).toEqual({
      conversationId: F,
      at: ids.a1
    })
    expect(await conversationCount(session)).toBe(3)
    expect(contents(await viewOf(session))).toEqual(['U1', 'A1'])

    // U1 是 F2 从根继承来的前缀
    const F3 = forkedId(await session.rollbackTo(ids.u1))
    expect(await conversationRecord(session, F3)).toEqual({ id: F3 })
    expect((await session.currentConversation()).id).toBe(F3 as ConversationId)
  })
})
