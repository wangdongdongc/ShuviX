/**
 * P4-09b · `reconcile` 按引用跳过（`prev`）与逐帧代价的护栏。
 *
 *   RI-01 同一引用的子树：不发操作、一次都不读（记录代理 + 一碰就抛的毒代理）
 *   RI-02 共享数组里换掉的那个元素照样更新，别的元素不碰
 *   RI-03 删掉的键照样删（顶层与换掉的子对象里）
 *   RI-04 追加 / 截断 / 中段按身份替换：操作与旧路径逐条相同
 *   RI-05 capabilities / source / run / live 换成别的形状（null ↔ 对象、数组 ↔ 对象）：照旧路径
 *   RI-06 没给 prev：与旧路径完全相同
 *   PG-01..03 性能护栏（不看时钟）：300 与 1200 条消息的会话，流式一帧 / 追加一条 / 工具结果回填，碰草稿的
 *         次数完全相同，且 memo 只新建变了的那一条
 */
import {
  copyJson,
  replicatedState,
  type JsonValue,
  type MutableReplicatedState
} from '@earendil-works/chord'
import type { EntryRecord, InboxState, LiveState } from '@earendil-works/pi-durable'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { ProjectionMemo, projectSessionView } from '../project'
import { reconcile } from '../reconcile'
import { legacyReconcile, recordingDraft, revisionsOf, touchedUnder } from './sharingSupport'
import { A, META, R, U, call, text } from './support'

type View = Record<string, unknown>

const copy = <T>(value: T): T => copyJson(value as unknown as JsonValue) as unknown as T

function message(id: number, content: string): ChatMessage {
  return {
    id: String(id),
    sessionId: 's',
    role: 'assistant',
    type: 'message',
    blocks: [{ type: 'text', text: content }],
    content,
    model: 'm',
    createdAt: id,
    metadata: { usage: { input: 1, output: 1, total: 2 } }
  }
}

function baseView(messages: number): View {
  return {
    v: 1,
    sessionId: 's',
    source: 'durable',
    capabilities: { send: true, rollback: true, continue: true },
    conversationId: 1,
    messages: Array.from({ length: messages }, (_, index) => message(index + 1, `m${index + 1}`)),
    live: null,
    toolRuns: {},
    run: { state: 'idle' },
    queue: [],
    asks: [],
    context: { usedTokens: 10 }
  }
}

/** 一处只要被碰（读、枚举、写）就抛的对象 */
function poisoned<T extends object>(value: T): T {
  const boom = (): never => {
    throw new Error('poisoned subtree was traversed')
  }
  return new Proxy(value, {
    get: boom,
    set: boom,
    has: boom,
    ownKeys: boom,
    getOwnPropertyDescriptor: boom,
    deleteProperty: boom
  })
}

interface Applied {
  readonly ops: unknown[][]
  readonly log: string[]
  readonly value: unknown
}

/** 新路径：状态从 `prev` 的拷贝起步（草稿 ≡ prev），带着 prev 对齐，记下草稿访问与操作 */
function applyWithPrev(prev: View, next: View, initial: View = copy(prev)): Applied {
  const state = replicatedState(initial)
  const revisions = revisionsOf(state)
  const log: string[] = []
  state.change(BG, (draft) => reconcile(recordingDraft(draft, log), next, prev))
  revisions.stop()
  return { ops: revisions.revisions.map((ops) => [...ops]), log, value: state.value }
}

/** 旧路径（预言） */
function applyLegacy(prev: View, next: View): Applied {
  const state = replicatedState(copy(prev))
  const revisions = revisionsOf(state)
  const log: string[] = []
  state.change(BG, (draft) => legacyReconcile(recordingDraft(draft, log), next))
  revisions.stop()
  return { ops: revisions.revisions.map((ops) => [...ops]), log, value: state.value }
}

function expectSameAsLegacy(prev: View, next: View): Applied {
  const optimized = applyWithPrev(prev, next)
  const legacy = applyLegacy(prev, next)
  expect(optimized.value).toStrictEqual(next)
  expect(legacy.value).toStrictEqual(next)
  expect(optimized.ops).toEqual(legacy.ops)
  return optimized
}

describe('P4-09b · reconcile with prev: identity skip', () => {
  it('RI-01 a subtree shared by reference: no op and no traversal (recording proxy and a poisoned subtree)', () => {
    const prev = baseView(5)
    const next = { ...prev, run: { state: 'busy' } }
    const applied = applyWithPrev(prev, next)
    expect(touchedUnder(applied.log, 'messages')).toEqual([])
    expect(touchedUnder(applied.log, 'capabilities')).toEqual([])
    expect(applied.ops).toEqual([[['s', ['run', 'state'], 'busy']]])
    expect(applied.value).toStrictEqual(next)

    // 毒代理：共享的 messages 被读一次就抛 —— 新路径一次都不碰；旧路径非碰不可
    const plain = baseView(5)
    const shared = poisoned(plain.messages as ChatMessage[])
    const poisonedPrev = { ...plain, messages: shared }
    const poisonedNext = { ...plain, messages: shared, run: { state: 'busy' } }
    const survived = applyWithPrev(poisonedPrev, poisonedNext, copy(plain))
    expect(survived.ops).toEqual([[['s', ['run', 'state'], 'busy']]])
    expect((survived.value as View).messages).toStrictEqual(plain.messages)
    expect(() => applyLegacy(copy(plain), poisonedNext)).toThrow(/poisoned/)

    // 整份视图同一个引用：一个槽都不碰、没有修订
    const same = applyWithPrev(prev, prev)
    expect(same.ops).toEqual([])
    expect(same.log).toEqual([])
  })

  it('RI-02 a changed element inside a shared array is still updated; its siblings are not touched', () => {
    const prev = baseView(5)
    const messages = [...(prev.messages as ChatMessage[])]
    const changed = message(3, 'm3 and more')
    messages[2] = changed
    const next = { ...prev, messages }
    const applied = expectSameAsLegacy(prev, next)
    expect(applied.ops).toEqual([
      [
        ['a', ['messages', 2, 'content'], ' and more'],
        ['a', ['messages', 2, 'blocks', 0, 'text'], ' and more']
      ]
    ])
    for (const index of [0, 1, 3, 4]) {
      expect(touchedUnder(applied.log, `messages/${index}`), `message ${index}`).toEqual([])
    }
    expect(touchedUnder(applied.log, 'messages/2').length).toBeGreaterThan(0)
  })

  it('RI-03 deleted keys are still removed (top level and inside a replaced child)', () => {
    const prev = {
      ...baseView(3),
      extra: { stale: true },
      run: { state: 'busy', retry: { attempt: 1, at: 5, error: 'e' } }
    }
    const messages = [...(prev.messages as ChatMessage[])]
    const withRetried = {
      ...message(2, 'm2'),
      metadata: { retried: { count: 1, lastError: 'x' } }
    } as ChatMessage
    const prevWithRetried = { ...prev, messages: [messages[0], withRetried, messages[2]] }
    const next: View = { ...prevWithRetried, run: { state: 'idle' }, messages: [...messages] }
    delete next.extra
    const applied = expectSameAsLegacy(prevWithRetried, next)
    const ops = applied.ops.flat()
    expect(ops).toContainEqual(['d', ['extra']])
    expect(ops).toContainEqual(['d', ['run', 'retry']])
    expect(ops).toContainEqual(['d', ['messages', 1, 'metadata', 'retried']])
    expect(applied.value).not.toHaveProperty('extra')
    expect(touchedUnder(applied.log, 'messages/0')).toEqual([])
    expect(touchedUnder(applied.log, 'messages/2')).toEqual([])
  })

  it('RI-04 append, truncate and a keyed mid-array replacement emit exactly the legacy ops', () => {
    const prev = baseView(6)
    const list = prev.messages as ChatMessage[]
    // 追加
    const appended = expectSameAsLegacy(prev, { ...prev, messages: [...list, message(7, 'm7')] })
    expect(appended.ops).toEqual([[['p', ['messages'], 6, 0, [message(7, 'm7')]]]])
    expect(touchedUnder(appended.log, 'messages/0')).toEqual([])
    // 截断
    expectSameAsLegacy(prev, { ...prev, messages: list.slice(0, 4) })
    // 中段换身份（一条错误行被折叠掉、后面接上新卡）
    expectSameAsLegacy(prev, {
      ...prev,
      messages: [...list.slice(0, 3), message(9, 'm9'), ...list.slice(4)]
    })
    // 压缩头换掉前缀
    expectSameAsLegacy(prev, { ...prev, messages: [message(100, 'summary'), ...list.slice(4)] })
    // 清空
    expectSameAsLegacy(prev, { ...prev, messages: [] })
    // 没有身份的数组（块）：按下标
    const card = list[0]! as ChatMessage & { blocks: unknown[] }
    const grown = { ...card, blocks: [...card.blocks, { type: 'text', text: 'b' }] }
    expectSameAsLegacy(prev, { ...prev, messages: [grown, ...list.slice(1)] })
  })

  it('RI-05 slots that change shape (null <-> object, array <-> object) and capabilities / source / run follow the legacy path', () => {
    const prev = baseView(2)
    const live = {
      id: 'live:1',
      message: message(99, 'stream'),
      argsText: { c1: '{"pa' }
    }
    const withLive = { ...prev, live }
    expectSameAsLegacy(prev, withLive)
    expectSameAsLegacy(withLive, prev)
    const { argsText: _dropped, ...withoutArgs } = live
    expectSameAsLegacy(withLive, { ...withLive, live: withoutArgs })
    expectSameAsLegacy(prev, {
      ...prev,
      capabilities: { send: false, rollback: false, continue: false },
      source: 'legacy',
      conversationId: null
    })
    expectSameAsLegacy(prev, {
      ...prev,
      run: { state: 'busy', compacting: { reason: 'r', blocking: true, attempt: 1 } }
    })
    // prev 与 next 在同一个槽上种类不同（数组 → 对象、对象 → 数组）
    expectSameAsLegacy({ ...prev, toolRuns: [] }, prev)
    expectSameAsLegacy(prev, { ...prev, queue: {} })
  })

  it('RI-06 without prev the output is exactly the legacy one', () => {
    const prev = baseView(4)
    const list = prev.messages as ChatMessage[]
    const next = { ...prev, messages: [list[0], message(2, 'm2!'), ...list.slice(2)] }
    const state = replicatedState(copy(prev))
    const legacy = replicatedState(copy(prev))
    const a = revisionsOf(state)
    const b = revisionsOf(legacy)
    state.change(BG, (draft) => reconcile(draft, next))
    legacy.change(BG, (draft) => legacyReconcile(draft, next))
    expect(state.value).toStrictEqual(next)
    expect(a.revisions).toEqual(b.revisions)
    a.stop()
    b.stop()
  })
})

// ─────────────────────────── 性能护栏（数次数，不看时钟） ───────────────────────────

const RESULT = [text('export const x = 1\n'.repeat(20))]

/** `turns` 轮历史：user → assistant（文字 + 一次工具调用）→ 结果 → 最终回答，每轮 3 条消息 */
function history(turns: number): EntryRecord[] {
  const entries: EntryRecord[] = []
  let id = 1
  for (let turn = 1; turn <= turns; turn++) {
    entries.push(U(id++, `turn ${turn}`))
    entries.push(
      A(id++, [text(`reading ${turn}`), call('read', { path: `f${turn}` }, `c${turn}`)], 0, {
        task: turn,
        stopReason: 'toolUse'
      })
    )
    entries.push(R(id++, `c${turn}`, RESULT))
    entries.push(A(id++, [text(`answer ${turn}`)], 0, { task: turn }))
  }
  return entries
}

interface FrameInputs {
  readonly entries: readonly EntryRecord[]
  readonly live?: unknown
  readonly runState?: 'idle' | 'busy'
}

/** 记录里的消息下标换成 `#`：两种长度的会话之间只比形状（碰了哪些槽、几次） */
const shape = (log: readonly string[]): string[] =>
  log.map((line) => line.replace(/messages\/\d+/g, 'messages/#'))

/** 一个长期投影的最小复刻：memo + 状态 + 上一次写进去的视图 */
class Driver {
  readonly memo = new ProjectionMemo()
  readonly state: MutableReplicatedState<SessionView>
  private prev: SessionView

  constructor(frame: FrameInputs) {
    this.prev = this.project(frame)
    this.state = replicatedState(copy(this.prev))
  }

  project(frame: FrameInputs): SessionView {
    return projectSessionView(
      META,
      frame.entries,
      frame.live as LiveState | undefined,
      { items: [] } as unknown as InboxState,
      new Map(),
      [],
      frame.runState ?? 'idle',
      undefined,
      this.memo
    )
  }

  /** 一帧：投影 + 带 prev 对齐；返回碰草稿的记录 */
  step(frame: FrameInputs): string[] {
    const next = this.project(frame)
    const prev = this.prev
    const log: string[] = []
    this.state.change(BG, (draft) => reconcile(recordingDraft(draft, log), next, prev))
    this.prev = next
    return log
  }
}

const liveFrame = (taskId: number, value: string): LiveState =>
  ({
    run: { taskId },
    generation: { message: { role: 'assistant', content: [text(value)], timestamp: 0 } }
  }) as unknown as LiveState

interface GuardRun {
  readonly messages: number
  readonly streaming: string[]
  readonly streamingStats: ProjectionMemo['stats']
  readonly append: string[]
  readonly appendStats: ProjectionMemo['stats']
  readonly fill: string[]
  readonly fillStats: ProjectionMemo['stats']
}

function guardRun(turns: number): GuardRun {
  const entries = history(turns)
  const driver = new Driver({ entries })
  const messages = driver.state.value.messages.length
  const task = turns + 1
  // 新的一轮：user 落下，实时卡流式
  const withUser = [...entries, U(10_000, 'next turn')]
  driver.step({ entries: withUser, live: liveFrame(task, 'He'), runState: 'busy' })
  const streaming = driver.step({ entries: withUser, live: liveFrame(task, 'Hello'), runState: 'busy' })
  const streamingStats = driver.memo.stats
  // assistant 带一次工具调用落盘（实时卡清掉）
  const withCall = [
    ...withUser,
    A(10_001, [text('Hello'), call('read', { path: 'g' }, 'cg')], 0, {
      task,
      stopReason: 'toolUse'
    })
  ]
  const append = driver.step({
    entries: withCall,
    live: { run: { taskId: task } },
    runState: 'busy'
  })
  const appendStats = driver.memo.stats
  // 工具结果回填到上一张卡
  const fill = driver.step({
    entries: [...withCall, R(10_002, 'cg', RESULT)],
    live: { run: { taskId: task } },
    runState: 'busy'
  })
  const fillStats = driver.memo.stats
  expect(driver.state.value).toStrictEqual(
    projectSessionView(
      META,
      [...withCall, R(10_002, 'cg', RESULT)],
      { run: { taskId: task } } as unknown as LiveState,
      { items: [] } as unknown as InboxState,
      new Map(),
      [],
      'busy'
    )
  )
  return { messages, streaming, streamingStats, append, appendStats, fill, fillStats }
}

describe('P4-09b · per-frame cost guard (counts, no wall clock)', () => {
  const small = guardRun(100)
  const large = guardRun(400)

  it('PG-00 the two sessions really differ in length (300 vs 1200 messages)', () => {
    expect(small.messages).toBe(300)
    expect(large.messages).toBe(1200)
  })

  it('PG-01 a streaming frame touches the same draft slots at 300 and 1200 messages, none under messages, and reuses the whole history', () => {
    expect(shape(large.streaming)).toEqual(shape(small.streaming))
    expect(touchedUnder(large.streaming, 'messages')).toEqual([])
    expect(large.streaming.length).toBeLessThan(40)
    expect(large.streamingStats).toEqual({ historyReused: true, built: 0, reused: 1201 })
  })

  it('PG-02 appending a message touches the same draft slots at both lengths and builds only the new card', () => {
    expect(shape(large.append)).toEqual(shape(small.append))
    expect(touchedUnder(large.append, 'messages/0')).toEqual([])
    expect(large.appendStats).toEqual({ historyReused: false, built: 1, reused: 1201 })
    expect(small.appendStats).toEqual({ historyReused: false, built: 1, reused: 301 })
  })

  it('PG-03 a tool result filling an earlier card rebuilds just that card and touches the same slots at both lengths', () => {
    expect(shape(large.fill)).toEqual(shape(small.fill))
    expect(large.fillStats).toEqual({ historyReused: false, built: 1, reused: 1201 })
    expect(touchedUnder(large.fill, 'messages/1201').length).toBeGreaterThan(0)
    expect(touchedUnder(small.fill, 'messages/301').length).toBeGreaterThan(0)
    expect(touchedUnder(large.fill, 'messages/0')).toEqual([])
  })
})
