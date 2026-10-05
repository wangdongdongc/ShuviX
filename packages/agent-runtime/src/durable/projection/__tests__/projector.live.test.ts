/**
 * P3-03 · 实时流式 → 追加操作，与工具轮（设计稿 P3-03-06..14）：
 *
 *   06 文字流式：第一份中间态一条 `s` 设上 live，之后每一份恰好两条 `a`（块文字与 content）
 *   07 思考 + 文字混排：思考增长是 `a`，新的文字块一条 `p`
 *   08 工具参数流式：`argsText` 是 `a`，partialJson 不出现，参数变化在 args 之下
 *   09 最终消息落盘：同一次修订里 messages 追加一条、live 清空；前面的消息不动
 *   10 什么都没改的发布（pi.usage / pi.provider / AgentStateDoc / SessionStateDoc.driven）：没有修订
 *   11 空闲发送：受理那一帧就有用户消息（id = 条目 id），busy，落定后 [user, assistant] 闲；逐帧身份
 *   12 工具状态与回填：status 是 `s` 到那个字段，输出是 `a`，结果回填在块之下，轮结束 toolRuns 清空
 *   13 并行调用 + harness 段剥离：两块都回填，c2 没有 `<harness>`、带 spill.path；= freshMount
 *   14 一轮运行里两个工具轮：两张卡都回填，第二轮的 toolRuns 不带 c1；逐帧身份
 *
 * 06 / 07 / 08 直接写 `pi.live`（精确控制每一份中间态）；06b、09、11..14 走真流程（faux）。
 */
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import {
  ProviderDoc,
  UsageDoc,
  type ConversationId,
  type LiveState
} from '@earendil-works/pi-durable'
import type { Op } from '@earendil-works/chord/delta'
import type { AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { AgentStateDoc, SessionStateDoc } from '../../docs'
import { answer, callTool, callTools, fauxKit } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { allEntries } from '../../__tests__/support/transcript'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import {
  attachOracle,
  freshMount,
  liveCommit,
  opsOf,
  readTool,
  settleFrames,
  SPILL_PATH,
  spillTool,
  streamTool,
  under
} from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 20000

type Content = NonNullable<LiveState['generation']>['message'] extends infer M
  ? M extends { content: infer C }
    ? C
    : never
  : never

/** 一份节流中间态（形状同 pi.live.generation.message） */
function partial(content: unknown[]): NonNullable<LiveState['generation']>['message'] {
  return {
    role: 'assistant',
    content: content as Content,
    api: 'faux',
    provider: 'faux',
    model: 'faux-1',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: 5
  } as never
}

async function setPartial(
  session: Parameters<typeof liveCommit>[0],
  content: unknown[]
): Promise<void> {
  await liveCommit(session, (live) => {
    live.run = { taskId: 7 as never, inputs: [] }
    live.generation = { attempt: 1, message: partial(content) }
  })
}

const text = (value: string): unknown => ({ type: 'text', text: value })
const thinking = (value: string): unknown => ({ type: 'thinking', thinking: value })

async function open(options: Parameters<typeof makeHost>[0] = {}) {
  const t = await makeHost({ ephemeral: ['s1'], ...options })
  const session = await t.open('s1')
  const proj = await session.projector()
  const h = proj.acquire()
  return { t, session, proj, h }
}

const sortOps = (ops: readonly Op[]): string[] => ops.map((op) => JSON.stringify(op)).sort()

describe('P3-03 · live streaming → append ops', () => {
  it('P3-03-06 text streaming: one set of live, then exactly two append ops per partial', async () => {
    const { session, h } = await open()
    const ops = opsOf(h.state)
    await setPartial(session, [text('He')])
    await settleFrames()
    expect(ops.revisions).toHaveLength(1)
    expect(ops.revisions[0]!.ops).toEqual([['s', ['live'], h.state.value.live]])
    for (const [from, to] of [
      ['He', 'Hello'],
      ['Hello', 'Hello wor'],
      ['Hello wor', 'Hello world']
    ] as const) {
      const before = ops.revisions.length
      await setPartial(session, [text(to)])
      await settleFrames()
      expect(ops.revisions).toHaveLength(before + 1)
      const suffix = to.slice(from.length)
      expect(sortOps(ops.revisions.at(-1)!.ops)).toEqual(
        sortOps([
          ['a', ['live', 'message', 'blocks', 0, 'text'], suffix],
          ['a', ['live', 'message', 'content'], suffix]
        ])
      )
    }
    for (const { op } of ops.allOps().slice(1)) {
      expect(op[0] === 's' && under(op, 'live') && (op[1] as unknown[]).length === 1).toBe(false)
      expect(op[0]).not.toBe('r')
      expect(under(op, 'messages')).toBe(false)
    }
    expect(h.state.value.live!.message.content).toBe('Hello world')
    ops.replay()
    ops.stop()
    h.release()
  })

  it(
    'P3-03-06b real faux streaming: after the live card starts, every streaming revision is append-only under live',
    async () => {
      const { t, session, h } = await open({ kit: fauxKit({ tokensPerSecond: 60 }) })
      await primeRoot(session)
      const ops = opsOf(h.state)
      t.kit.queue(fauxAssistantMessage([fauxText(`alpha ${'beta '.repeat(60)}`)]))
      expect(await withTimeout(session.submitUser('go'), 15000, 'send')).toEqual({})
      await settleFrames()
      const liveStart = ops.revisions.findIndex((revision) =>
        revision.ops.some((op) => op[0] === 's' && opPathEq(op, ['live']) && op[2] !== null)
      )
      const liveEnd = ops.revisions.findIndex(
        (revision) => revision.ops.some((op) => op[0] === 's' && opPathEq(op, ['live']) && op[2] === null)
      )
      expect(liveStart).toBeGreaterThanOrEqual(0)
      expect(liveEnd).toBeGreaterThan(liveStart + 1)
      const streaming = ops.revisions.slice(liveStart + 1, liveEnd)
      expect(streaming.length).toBeGreaterThan(1)
      for (const revision of streaming) {
        for (const op of revision.ops) {
          if (under(op, 'live')) expect(['a', 't']).toContain(op[0])
        }
      }
      ops.replay()
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it('P3-03-07 thinking and mixed blocks: thinking grows by append, the text block arrives as one splice', async () => {
    const { session, h } = await open()
    const ops = opsOf(h.state)
    await setPartial(session, [thinking('pl')])
    await setPartial(session, [thinking('plan')])
    await settleFrames()
    expect(ops.revisions.at(-1)!.ops).toEqual([
      ['a', ['live', 'message', 'blocks', 0, 'text'], 'an']
    ])
    await setPartial(session, [thinking('plan'), text('a')])
    await settleFrames()
    const added = ops.revisions.at(-1)!.ops
    const splice = added.filter((op) => under(op, 'live', 'message', 'blocks'))
    expect(splice).toEqual([
      ['p', ['live', 'message', 'blocks'], 1, 0, [{ type: 'text', text: 'a' }]]
    ])
    await setPartial(session, [thinking('plan'), text('ab')])
    await settleFrames()
    const later = ops.allOps().filter(({ index }) => index >= ops.revisions.length - 2)
    for (const { op } of later) {
      expect(under(op, 'live', 'message', 'blocks', 0)).toBe(false)
    }
    expect(h.state.value.live!.message.blocks).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'ab' }
    ])
    ops.replay()
    ops.stop()
    h.release()
  })

  it('P3-03-08 tool-call argument streaming: argsText appends, no partialJson anywhere, args change below args', async () => {
    const { session, h } = await open()
    const ops = opsOf(h.state)
    const call = (args: object, partialJson: string): unknown => ({
      type: 'toolCall',
      id: 'c1',
      name: 'write',
      arguments: args,
      partialJson
    })
    await setPartial(session, [call({}, '{"pa')])
    await setPartial(session, [call({ path: 'x' }, '{"path":"x')])
    await setPartial(session, [call({ path: 'xy' }, '{"path":"xy')])
    await settleFrames()
    expect(ops.revisions).toHaveLength(3)
    const later = ops.allOps().filter(({ index }) => index > 0)
    expect(later.some(({ op }) => op[0] === 'a' && opPathEq(op, ['live', 'argsText', 'c1']))).toBe(
      true
    )
    for (const { op } of ops.allOps()) {
      expect(JSON.stringify(op)).not.toContain('partialJson')
    }
    for (const { op } of later) {
      if (op[0] === 'a' && opPathEq(op, ['live', 'argsText', 'c1'])) continue
      expect(under(op, 'live', 'message', 'blocks', 0, 'args')).toBe(true)
    }
    expect(h.state.value.live!.argsText).toEqual({ c1: '{"path":"xy' })
    expect(h.state.value.live!.message.blocks[0]).toMatchObject({ args: { path: 'xy' } })
    ops.replay()
    ops.stop()
    h.release()
  })

  it(
    'P3-03-09 commit of the final message: one revision appends the message and clears live; earlier messages untouched',
    async () => {
      const { t, session, h } = await open({ kit: fauxKit({ tokensPerSecond: 60 }) })
      await primeRoot(session)
      const ops = opsOf(h.state)
      t.kit.queue(fauxAssistantMessage([fauxText(`alpha ${'beta '.repeat(40)}`)]))
      expect(await withTimeout(session.submitUser('go'), 15000, 'send')).toEqual({})
      await settleFrames()
      const index = ops.revisions.findIndex((revision) =>
        revision.ops.some((op) => op[0] === 's' && opPathEq(op, ['live']) && op[2] === null)
      )
      expect(index).toBeGreaterThan(0)
      const revision = ops.revisions[index]!
      const n = revision.value.messages.length - 1
      expect(revision.ops).toContainEqual(['s', ['live'], null])
      expect(
        revision.ops.some(
          (op) =>
            (op[0] === 'p' && opPathEq(op, ['messages']) && op[2] === n && op[3] === 0) ||
            (op[0] === 's' && opPathEq(op, ['messages', n]))
        )
      ).toBe(true)
      for (const op of revision.ops) {
        const path = op[0] === 'r' ? [] : (op[1] as unknown[])
        if (path[0] === 'messages' && typeof path[1] === 'number') expect(path[1]).toBe(n)
      }
      const entries = await allEntries(await session.currentConversation())
      expect(revision.value.messages[n]!.id).toBe(String(entries.at(-1)!.id))
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it('P3-03-10 publications that change nothing: no new revision', async () => {
    const { session, h } = await open()
    await primeRoot(session)
    await settleFrames()
    const ops = opsOf(h.state)
    const id = 1 as ConversationId
    await session.harness.commit(async (tx) => {
      const usage = (await tx.doc(UsageDoc, id)) as unknown as Record<string, unknown>
      usage.touched = 1
    }, BG)
    await session.harness.commit(async (tx) => {
      const provider = (await tx.doc(ProviderDoc, id)) as unknown as Record<string, unknown>
      provider.touched = 1
    }, BG)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(AgentStateDoc, id)).lastAnnouncedDate = '2026-10-05'
    }, BG)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).driven = {
        requestId: 'r',
        parentId: 'p',
        background: false,
        conversationId: id
      }
    }, BG)
    await settleFrames()
    expect(ops.revisions).toEqual([])
    ops.stop()
    h.release()
  })

  it(
    'P3-03-11 idle send: the admission revision appends the user message, busy by the next revision, settles idle; identity at every frame',
    async () => {
      const { t, session, h } = await open()
      await primeRoot(session)
      const oracle = await attachOracle(session, h.state)
      const ops = opsOf(h.state)
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('hi')).toEqual({})
      await settleFrames()
      const entries = await allEntries(await session.currentConversation())
      const user = entries.find((entry) => entry.kind === 'pi.user')!
      const first = ops.revisions.findIndex((revision) =>
        revision.value.messages.some((m) => m.id === String(user.id))
      )
      expect(first).toBeGreaterThanOrEqual(0)
      const busyAt = ops.revisions.findIndex((revision) => revision.value.run.state === 'busy')
      expect(busyAt).toBeGreaterThanOrEqual(0)
      expect(busyAt).toBeLessThanOrEqual(first + 1)
      expect(h.state.value.messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'hi'],
        ['assistant', 'ok']
      ])
      expect(h.state.value.run).toStrictEqual({ state: 'idle' })
      expect(h.state.value.live).toBeNull()
      expect(h.state.value.toolRuns).toEqual({})
      expect(await oracle.verify()).toBeGreaterThan(1)
      await oracle.stop()
      ops.stop()
      h.release()
    },
    TIMEOUT
  )
})

describe('P3-03 · tool rounds', () => {
  it(
    'P3-03-12 status and fill: status sets at the field, output appends, the result fills below the block, toolRuns empty after',
    async () => {
      const { t, session, h } = await open({ tools: [streamTool(['l1\n', 'l2\n', 'l3\n'], 160)] })
      await primeRoot(session)
      const ops = opsOf(h.state)
      t.kit.queue(callTool('bash', { command: 'x' }, 'c1'), answer('done'))
      expect(await withTimeout(session.submitUser('run it'), 15000, 'send')).toEqual({})
      await settleFrames()
      const statuses: string[] = []
      for (const revision of ops.revisions) {
        const status = revision.value.toolRuns.c1?.status
        if (status !== undefined && statuses.at(-1) !== status) statuses.push(status)
      }
      expect(statuses).toContain('running')
      expect(statuses.at(-1)).toBe('done')
      const all = ops.allOps().map(({ op }) => op)
      // 出现之后的状态转变都是 `s` 到 status 这个字段
      const statusOps = all.filter((op) => under(op, 'toolRuns', 'c1', 'status'))
      expect(statusOps.length).toBeGreaterThan(0)
      for (const op of statusOps) expect(op[0]).toBe('s')
      // 输出增长：第一段（设上这个键）之后是 `a`；调用结束时这个键随槽位一起去掉（`d`）
      const outputOps = all.filter((op) => under(op, 'toolRuns', 'c1', 'output'))
      expect(outputOps.filter((op) => op[0] === 'a').length).toBeGreaterThan(0)
      for (const op of outputOps.slice(1)) expect(['a', 'd']).toContain(op[0])
      // 回填在块之下，不是整条消息
      const card = h.state.value.messages.findIndex((m) => m.type === 'message' && m.content === '')
      expect(card).toBeGreaterThanOrEqual(0)
      const fill = all.filter((op) => under(op, 'messages', card))
      expect(fill.length).toBeGreaterThan(0)
      for (const op of fill) expect(under(op, 'messages', card, 'blocks', 0)).toBe(true)
      const block = (h.state.value.messages[card] as AssistantMessage).blocks[0]
      expect(block).toMatchObject({ type: 'tool', toolCallId: 'c1', result: 'ok' })
      expect(h.state.value.toolRuns).toEqual({})
      ops.replay()
      ops.stop()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-13 parallel calls and the harness strip: both filled in order, c2 has no <harness> and carries spill.path; = freshMount',
    async () => {
      const { t, session, h } = await open({ tools: [readTool(), spillTool()] })
      await primeRoot(session)
      t.kit.queue(
        callTools([
          ['read', { path: 'a' }, 'c1'],
          ['dump', {}, 'c2']
        ]),
        answer('done')
      )
      expect(await withTimeout(session.submitUser('both'), 15000, 'send')).toEqual({})
      await settleFrames()
      const card = h.state.value.messages.find(
        (m) => m.type === 'message' && m.blocks.some((b) => b.type === 'tool')
      ) as AssistantMessage
      const [b1, b2] = card.blocks
      expect(b1).toMatchObject({ toolCallId: 'c1', result: 'read a' })
      expect(b2).toMatchObject({ toolCallId: 'c2', result: 'preview', spill: { path: SPILL_PATH } })
      expect(JSON.stringify(b2)).not.toContain('<harness>')
      expect(h.state.value).toStrictEqual(await freshMount(session))
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-14 two tool rounds in one run: two cards filled, round 2 toolRuns without c1; identity at every frame',
    async () => {
      const { t, session, h } = await open({ tools: [streamTool(['x\n'], 120), readTool()] })
      await primeRoot(session)
      const oracle = await attachOracle(session, h.state)
      const ops = opsOf(h.state)
      t.kit.queue(
        callTool('bash', { command: 'one' }, 'c1'),
        callTool('read', { path: 'b' }, 'c2'),
        answer('done')
      )
      expect(await withTimeout(session.submitUser('two rounds'), 15000, 'send')).toEqual({})
      await settleFrames()
      for (const revision of ops.revisions) {
        if (revision.value.toolRuns.c2 !== undefined) {
          expect(revision.value.toolRuns.c1).toBeUndefined()
        }
      }
      expect(ops.revisions.some((r) => r.value.toolRuns.c2 !== undefined)).toBe(true)
      const cards = h.state.value.messages.filter(
        (m) => m.type === 'message' && m.blocks.some((b) => b.type === 'tool')
      ) as AssistantMessage[]
      expect(cards).toHaveLength(2)
      expect(cards[0]!.blocks[0]).toMatchObject({ toolCallId: 'c1', result: 'ok' })
      expect(cards[1]!.blocks[0]).toMatchObject({ toolCallId: 'c2', result: 'read b' })
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      expect(await oracle.verify()).toBeGreaterThan(2)
      await oracle.stop()
      ops.stop()
      h.release()
    },
    TIMEOUT
  )
})

function opPathEq(op: Op, path: readonly (string | number)[]): boolean {
  if (op[0] === 'r') return path.length === 0
  const actual = op[1] as readonly (string | number)[]
  return actual.length === path.length && actual.every((segment, i) => segment === path[i])
}
