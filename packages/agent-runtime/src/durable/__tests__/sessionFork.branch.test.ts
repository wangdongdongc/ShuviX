/**
 * 会话 fork · `branchAt`（「从这条回复分支」，在新会话那份拷贝上；`branchPoint` 的分支点 = 目标助手消息连同
 * 紧跟其后的那串工具结果）。这里直接在一条会话上调它 —— 拷贝与源会话的往返在 sessionFork.roundtrip.test.ts。
 *
 *   BA-1  U1 A1 U2 A2 U3 A3（已锁）：branchAt(A1) → 新对话 F（parent {根, A1}，与指针同一次发布）；视图 [U1, A1]、
 *         id 不变；旧对话六条都在；空闲、队列为空；下一次发送只带 U1 A1 U4
 *   BA-2  U1 → A（两个工具调用）→ TR1 TR2 → A′：branchAt(A) → fork 有 U1 A TR1 TR2、没有 A′；工具块回填了结果
 *         （没有挂起的工具进度）、空闲、不算中断；下一次发送带着两个结果
 *   BA-3  目标就是当前对话的最新条目 → 原样答当前对话，没有发布、对话数不变、锁不动
 *   BA-4  用户 / 工具结果 / 通知 / 压缩条目 → invalid_target，没有发布，指针与锁不变
 *   BA-5  99999 / 0 / -1 / 1.5 / NaN / 只在被放弃的旧分支上的助手条目 → not_found，没有发布
 *   BA-6  派生 agent 子对话里的助手条目 → not_found；在派发它的根助手消息上分支照样带上它的工具结果
 *   BA-7  工具结果之后放下的 steer：fork 停在 steer 之前，没有队列
 *   BA-8  一条助手消息带 40 个工具调用 → 40 个结果都在 fork 上（跨过 32 条一页的翻页）
 *   BA-9  句柄已关 → {ok:false, reason:'closed'}，从不抛、从不重开
 *   BA-10 branchAt 之后关了再开：指针仍是 F、视图相同
 */
import { Type } from '@earendil-works/pi-ai'
import {
  CompactionEntry,
  defineTool,
  ROOT_CONVERSATION_ID,
  type JsonObject,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { AssistantToolBlock } from '@shuvix/chat-protocol/types/chatMessage'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import type { BranchResult } from '../rollback'
import { answer, callTool, callTools } from './support/faux'
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
import { callAgent, hostD, probeTool } from './support/spawn'
import {
  allEntries,
  midRunDisplayed,
  midRunNoted,
  requestTexts,
  transcript
} from './support/transcript'
import { aborted, deferred, sleep, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000

/** 分支成功 → 新对话 id */
function branchedId(result: BranchResult): number {
  expect(result).toEqual({ ok: true, conversationId: expect.any(Number) })
  if (!result.ok) throw new Error(`branchAt refused: ${result.reason}`)
  return result.conversationId
}

/** 一次被拒的分支：结果、没有发布、锁同一个对象、指针不变、会话状态不变 */
async function expectRefused(
  session: DurableSession,
  target: number,
  reason: 'not_found' | 'invalid_target'
): Promise<void> {
  const lock = session.lock
  const pointer = (await session.currentConversation()).id
  const state = await session.harness.snapshot(SessionStateDoc, BG)
  const recorder = rawPublications(session)
  expect(await session.branchAt(target), `target ${target}`).toEqual({ ok: false, reason })
  recorder.stop()
  expect(recorder.publications, `target ${target}`).toEqual([])
  expect(session.lock).toBe(lock)
  expect((await session.currentConversation()).id).toBe(pointer)
  expect(await session.harness.snapshot(SessionStateDoc, BG)).toEqual(state)
}

/** 视图里某条助手消息的工具块 */
function toolBlocks(view: Awaited<ReturnType<typeof viewOf>>, id: number): AssistantToolBlock[] {
  const message = view.messages.find((candidate) => candidate.id === String(id))
  expect(message?.role, `message ${id}`).toBe('assistant')
  if (message?.role !== 'assistant') return []
  return message.blocks.filter((block): block is AssistantToolBlock => block.type === 'tool')
}

/** U1 → A（一组工具调用）→ 结果 → A′；交回各条目 */
async function toolTurn(
  tools: ToolRegistration[],
  calls: readonly (readonly [string, JsonObject, string])[]
): Promise<{
  t: Awaited<ReturnType<typeof makeHost>>
  session: DurableSession
  u1: number
  a: number
  results: number[]
  final: number
}> {
  const t = await makeHost({ tools })
  const session = await t.open('s1')
  await primeRoot(session)
  t.kit.queue(callTools(calls), answer('A-final'))
  expect(await session.submitUser('U1')).toEqual({})
  const root = await allEntries(await session.currentConversation())
  const u1 = root.find((entry) => entry.kind === 'pi.user')!.id
  const assistants = root.filter((entry) => entry.kind === 'pi.assistant')
  expect(assistants).toHaveLength(2)
  const results = root
    .filter((entry) => entry.kind === 'pi.tool-result')
    .map((entry) => entry.id as number)
  return {
    t,
    session,
    u1,
    a: assistants[0]!.id,
    results,
    final: assistants[1]!.id
  }
}

describe('session fork · branchAt', () => {
  it('BA-1 branchAt(A1): a new conversation F (parent {root, A1}, same publication as the pointer); view [U1, A1] with the same ids; the old conversation keeps all six; idle with an empty queue; the next send carries U1 A1 U4 only', async () => {
    const { t, session, ids } = await rollbackBase()
    const before = await viewOf(session)
    const recorder = rawPublications(session)
    const F = branchedId(await session.branchAt(ids.a1))
    recorder.stop()
    expect(F).not.toBe(ROOT_CONVERSATION_ID)
    expect(await conversationRecord(session, F)).toEqual({
      id: F,
      parent: { conversationId: ROOT_CONVERSATION_ID, at: ids.a1 }
    })
    expect((await session.currentConversation()).id).toBe(F)
    // 建 F 与指针在同一次发布里
    const creating = recorder.publications.filter((p) => createsConversation(p, F))
    expect(creating).toHaveLength(1)
    expect(
      (sessionStateChange(creating[0]!)?.value as { currentConversation?: number } | null)
        ?.currentConversation
    ).toBe(F)

    const view = await viewOf(session)
    expect(view.conversationId).toBe(F)
    expect(messageIds(view)).toEqual([String(ids.u1), String(ids.a1)])
    expect(view.messages).toStrictEqual(before.messages.slice(0, 2))
    expect(view.run.state).toBe('idle')
    expect(view.queue).toEqual([])
    expect(view.live).toBeNull()
    expect(session.isBusy()).toBe(false)
    expect(session.isInterrupted()).toBe(false)

    // 旧对话原样留在存储里
    expect(
      await transcript((await session.harness.conversation(ROOT_CONVERSATION_ID, BG))!)
    ).toEqual([
      'pi.user:U1',
      'pi.assistant:A1',
      'pi.user:U2',
      'pi.assistant:A2',
      'pi.user:U3',
      'pi.assistant:A3'
    ])

    const n = t.kit.requests.length
    t.kit.queue(answer('A4'))
    expect(await session.submitUser('U4')).toEqual({})
    expect(requestTexts(t.kit, n)).toEqual(['user:U1', 'assistant:A1', 'user:U4'])
    expect(contents(await viewOf(session))).toEqual(['U1', 'A1', 'U4', 'A4'])
  })

  it(
    'BA-2 branchAt(A) with two tool calls: the fork has U1, A, TR1, TR2 and not A′; both tool blocks carry their results, no pending tool runs, idle and not interrupted; the next send carries both results',
    async () => {
      const { t, session, u1, a, results, final } = await toolTurn(
        [probeTool('pa'), probeTool('pb')],
        [
          ['pa', {}, 'call-pa'],
          ['pb', {}, 'call-pb']
        ]
      )
      expect(results).toHaveLength(2)
      const F = branchedId(await session.branchAt(a))
      expect((await conversationRecord(session, F))?.parent).toEqual({
        conversationId: ROOT_CONVERSATION_ID,
        at: Math.max(...results)
      })
      const forked = await allEntries(await session.currentConversation())
      const ids = forked.map((entry) => entry.id as number)
      for (const id of [u1, a, ...results]) expect(ids).toContain(id)
      expect(ids).not.toContain(final)
      expect(
        forked.filter((entry) => entry.kind !== 'pi.system').map((entry) => entry.kind)
      ).toEqual(['pi.user', 'pi.assistant', 'pi.tool-result', 'pi.tool-result'])

      const view = await viewOf(session)
      expect(view.messages.at(-1)!.id).toBe(String(a))
      const blocks = toolBlocks(view, a)
      expect(blocks.map((block) => block.toolCallId)).toEqual(['call-pa', 'call-pb'])
      expect(blocks[0]!.result).toEqual(expect.stringContaining('pa done'))
      expect(blocks[1]!.result).toEqual(expect.stringContaining('pb done'))
      for (const block of blocks) expect(block.isError ?? false).toBe(false)
      expect(view.toolRuns).toEqual({})
      expect(view.live).toBeNull()
      expect(view.run.state).toBe('idle')
      expect(session.isBusy()).toBe(false)
      expect(session.isInterrupted()).toBe(false)

      const n = t.kit.requests.length
      t.kit.queue(answer('A4'))
      expect(await session.submitUser('U4')).toEqual({})
      const sent = requestTexts(t.kit, n)
      expect(sent[0]).toBe('user:U1')
      expect(sent.at(-1)).toBe('user:U4')
      const toolResults = t.kit.requests[n]!.messages.filter(
        (message) => message.role === 'toolResult'
      )
      expect(toolResults.map((message) => message.toolCallId)).toEqual(['call-pa', 'call-pb'])
      expect(sent.some((line) => line.includes('A-final'))).toBe(false)
    },
    TIMEOUT
  )

  it('BA-3 the target is already the latest entry: answers the current conversation, no publication, the conversation count and the lock are unchanged', async () => {
    const { session, ids } = await rollbackBase()
    const lock = session.lock
    expect(lock).toBeDefined()
    const recorder = rawPublications(session)
    expect(await session.branchAt(ids.a3)).toEqual({
      ok: true,
      conversationId: ROOT_CONVERSATION_ID
    })
    recorder.stop()
    expect(recorder.publications).toEqual([])
    expect(await conversationCount(session)).toBe(1)
    expect(session.lock).toBe(lock)
    expect((await session.currentConversation()).id).toBe(ROOT_CONVERSATION_ID)
    expect(contents(await viewOf(session))).toEqual(['U1', 'A1', 'U2', 'A2', 'U3', 'A3'])
  })

  it(
    'BA-4 a user entry, a tool result, a notice and a compaction entry are invalid targets: no publication, pointer and lock unchanged',
    async () => {
      const t = await makeHost({ tools: [probeTool()] })
      const session = await t.open('s1')
      await primeRoot(session)
      t.kit.queue(answer('A1'), callTool('probe'), answer('A2'))
      expect(await session.submitUser('U1')).toEqual({})
      expect(await session.submitUser('U2')).toEqual({})
      expect((await session.writeNotice({ text: 'N', kind: 'background' })).status).toBe(
        'submitted'
      )
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
      const root = await allEntries(await session.currentConversation())
      const user = root.find((entry) => entry.kind === 'pi.user')!
      const toolResult = root.find((entry) => entry.kind === 'pi.tool-result')!
      const notice = root.find((entry) => entry.kind === 'shuvix.notice')!

      await expectRefused(session, user.id, 'invalid_target')
      await expectRefused(session, toolResult.id, 'invalid_target')
      await expectRefused(session, notice.id, 'invalid_target')
      await expectRefused(session, compaction.id, 'invalid_target')
      expect(await conversationCount(session)).toBe(1)
    },
    TIMEOUT
  )

  it('BA-5 ids that are not entries of the current conversation are not_found: 99999, 0, -1, 1.5, NaN, and an assistant entry only on an abandoned branch', async () => {
    const { session, ids } = await rollbackBase()
    for (const target of [99_999, 0, -1, 1.5, Number.NaN]) {
      await expectRefused(session, target, 'not_found')
    }
    // 回退之后 A3 只在被放弃的旧分支上
    const F = forkedId(await session.rollbackTo(ids.u3))
    expect((await session.currentConversation()).id).toBe(F)
    await expectRefused(session, ids.a3, 'not_found')
    expect(await conversationCount(session)).toBe(2)
  })

  it(
    'BA-6 an assistant entry of a spawned agent’s child conversation is not_found; branching at the root assistant that dispatched it keeps its tool result',
    async () => {
      const d = await hostD()
      d.t.kit.queue(answer('A1'))
      expect(await d.session.submitUser('U1')).toEqual({})
      d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('A2'))
      expect(await d.session.submitUser('U2')).toEqual({})
      const C = d.outcomes[0]!.conversationId!
      const childAssistant = (await entriesOf(d.session, C)).find(
        (entry) => entry.kind === 'pi.assistant'
      )!
      expect(childAssistant).toBeDefined()
      await expectRefused(d.session, childAssistant.id, 'not_found')

      const root = await allEntries(await d.session.currentConversation())
      const dispatching = root.find(
        (entry) =>
          entry.kind === 'pi.assistant' &&
          entry.model?.[0]?.role === 'assistant' &&
          entry.model[0].content.some((part) => part.type === 'toolCall')
      )!
      const toolResult = root.find((entry) => entry.kind === 'pi.tool-result')!
      expect(toolResult.id).toBeGreaterThan(dispatching.id)
      // 子对话的条目 id 交错在派发与结果之间
      expect(childAssistant.id).toBeGreaterThan(dispatching.id)
      expect(childAssistant.id).toBeLessThan(toolResult.id)

      const F = branchedId(await d.session.branchAt(dispatching.id))
      expect((await conversationRecord(d.session, F))?.parent?.at).toBe(toolResult.id)
      expect((await transcript(await d.session.currentConversation())).slice(-2)).toEqual([
        'pi.assistant:[tool:agent]',
        expect.stringMatching(/^pi\.tool-result:/)
      ])
      const view = await viewOf(d.session)
      expect(view.messages.at(-1)!.id).toBe(String(dispatching.id))
      expect(toolBlocks(view, dispatching.id)[0]!.result).toEqual(expect.any(String))
      expect(view.toolRuns).toEqual({})
    },
    TIMEOUT
  )

  it(
    'BA-7 a steer placed after the tool results: the fork stops before the steer; no queue',
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
          return { output: [{ type: 'text', text: 'waited' }] }
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
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      const root = await allEntries(await session.currentConversation())
      const call = root.find((entry) => entry.kind === 'pi.assistant')!
      const toolResult = root.find((entry) => entry.kind === 'pi.tool-result')!
      const steered = root.find(
        (entry) =>
          entry.kind === 'pi.user' &&
          entry.model?.[0]?.role === 'user' &&
          entry.model[0].content === midRunNoted('S')
      )!
      expect(steered.id).toBeGreaterThan(toolResult.id)

      const F = branchedId(await session.branchAt(call.id))
      expect((await conversationRecord(session, F))?.parent?.at).toBe(toolResult.id)
      const view = await viewOf(session)
      expect(messageIds(view)).not.toContain(String(steered.id))
      expect(contents(view)).not.toContain(midRunDisplayed('S'))
      expect(view.messages.at(-1)!.id).toBe(String(call.id))
      expect(view.queue).toEqual([])
      expect(view.live).toBeNull()
      expect(view.toolRuns).toEqual({})
      expect(view.run.state).toBe('idle')
    },
    TIMEOUT
  )

  it(
    'BA-8 an assistant with 40 tool calls: all 40 results stay on the fork',
    async () => {
      const calls = Array.from(
        { length: 40 },
        (_, index) => ['probe', {}, `call-${index}`] as const
      )
      const { session, a, results, final } = await toolTurn([probeTool()], calls)
      expect(results).toHaveLength(40)
      const F = branchedId(await session.branchAt(a))
      expect((await conversationRecord(session, F))?.parent?.at).toBe(Math.max(...results))
      const forked = (await allEntries(await session.currentConversation())).map(
        (entry) => entry.id as number
      )
      for (const id of results) expect(forked).toContain(id)
      expect(forked).not.toContain(final)
      const blocks = toolBlocks(await viewOf(session), a)
      expect(blocks).toHaveLength(40)
      for (const block of blocks)
        expect(block.result).toEqual(expect.stringContaining('probe done'))
    },
    TIMEOUT
  )

  it('BA-9 a closed handle: a closed refusal, never a throw or a reopen', async () => {
    const { t, session, ids } = await rollbackBase()
    await t.host.close('s1')
    const opens = t.events.filter((event) => event === 'open:s1').length
    expect(await session.branchAt(ids.a1)).toEqual({ ok: false, reason: 'closed' })
    expect(await session.branchAt(99_999)).toEqual({ ok: false, reason: 'closed' })
    expect(t.events.filter((event) => event === 'open:s1').length).toBe(opens)
    expect(t.host.get('s1')).toBeUndefined()
    expect(session.closed).toBe(true)
  })

  it(
    'BA-10 close and reopen after branchAt: the pointer is still F and the view is the same',
    async () => {
      const { t, session, ids } = await rollbackBase()
      const F = branchedId(await session.branchAt(ids.a1))
      const view = await viewOf(session)
      await t.host.close('s1')
      const reopened = await t.open('s1')
      expect((await reopened.currentConversation()).id).toBe(F)
      expect(await viewOf(reopened)).toStrictEqual(view)
      await sleep(20)
      expect(contents(await viewOf(reopened))).toEqual(['U1', 'A1'])
    },
    TIMEOUT
  )
})
