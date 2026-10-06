/**
 * P4-09b · 等价性质：结构共享（`ProjectionMemo`）+ 按引用跳过的对齐（`reconcile(draft, next, prev)`），与
 * 「每帧重新投影 + 旧的整棵对齐」（预言，`legacyReconcile`）逐帧相同。
 *
 * 每一帧同时走两条路：
 *  - 新路径：同一份 memo 投影（输出递归冻结 —— memo 交出去过的对象之后被改动就会抛错），带上一帧的视图
 *    当 `prev` 对齐进一份 chord 状态；
 *  - 旧路径：不带 memo 重新投影，旧 reconcile 对齐进另一份状态。
 * 断言：memo 投影 = 新鲜投影（深相等）、视图里没有一个对象出现两次、两份状态都 = 新鲜投影、两条路这一帧
 * 发出的操作逐条相同（所以不会更多）。
 *
 *   SP-01 录好的会话（SessionView）：流式文字、工具调用 → 运行 → 结果回填前一张卡、新消息、询问挂起 / 答复、
 *         排队（含内联 Token）、显示侧车（值相等的重新解析 / 真改了）、重试折叠（实时卡带提示 → 落盘）、
 *         错误行之后被折叠掉（中段消失）、run.retry / compacting / interrupted、空卡、压缩头换前缀、
 *         重新挂载（条目全是新对象）、对话 id / 会话 id 变化、诊断与落盘、toolCallId 重用、图片
 *   SP-02 同一份录像走 AgentView
 *   SP-03 随机步骤（120 个种子 × 40 步），SessionView 与 AgentView 一起
 */
import { copyJson, replicatedState, type JsonValue, type MutableReplicatedState } from '@earendil-works/chord'
import type { EntryRecord, InboxState, LiveState } from '@earendil-works/pi-durable'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { AgentView, RunViewState, SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { describe, expect, it } from 'vitest'
import { truncationDiagnostic } from '../../../toolOutput/spill'
import { backgroundContext as BG } from '../../context'
import type { DisplayItem } from '../display'
import {
  ProjectionMemo,
  projectAgentView,
  projectSessionView,
  renderHarnessDiagnostics
} from '../project'
import { reconcile } from '../reconcile'
import { legacyReconcile, revisionsOf, type RevisionLog } from './sharingSupport'
import {
  A,
  C,
  E,
  IMAGE,
  IMAGE_META,
  K1,
  N,
  R,
  U,
  bg,
  call,
  deepFreeze,
  display,
  text,
  thinking,
  wrap
} from './support'

const copy = <T>(value: T): T => copyJson(value as unknown as JsonValue) as unknown as T

// ─────────────────────────── 帧与两条路 ───────────────────────────

interface Frame {
  readonly meta: { readonly sessionId: string; readonly conversationId: number }
  readonly entries: readonly EntryRecord[]
  readonly live: unknown
  readonly inbox: unknown
  readonly display: ReadonlyMap<number, DisplayItem>
  readonly asks: readonly InputRequest[]
  readonly runState: RunViewState
  readonly queueDisplay: ReadonlyMap<number, DisplayItem> | undefined
}

type Projector<V> = (frame: Frame, memo?: ProjectionMemo) => V

// 投影每帧都拿一份新的显示侧车 Map（`displayByEntry` 每次新建），这里照做
const sessionOf: Projector<SessionView> = (frame, memo) =>
  projectSessionView(
    frame.meta,
    frame.entries,
    frame.live as LiveState | undefined,
    frame.inbox as InboxState | undefined,
    new Map(frame.display),
    frame.asks,
    frame.runState,
    frame.queueDisplay === undefined ? undefined : new Map(frame.queueDisplay),
    memo
  )

const agentOf: Projector<AgentView> = (frame, memo) =>
  projectAgentView(
    { agentId: 'a1', sessionId: frame.meta.sessionId, conversationId: frame.meta.conversationId },
    frame.entries,
    frame.live as LiveState | undefined,
    new Map(frame.display),
    frame.runState,
    memo
  )

/** 视图里没有一个对象（含数组）出现两次 —— chord 接管初值要求无别名 */
function expectAliasFree(view: unknown, label: string): void {
  const seen = new Set<object>()
  const walk = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null) return
    if (seen.has(value)) throw new Error(`${label}: object appears twice (at ${path})`)
    seen.add(value)
    for (const [key, child] of Object.entries(value)) walk(child, `${path}/${key}`)
  }
  walk(view, '')
}

/** 两条路并排：新路径（memo + prev）与旧路径（新鲜投影 + 旧 reconcile） */
class Pair<V extends object> {
  private readonly memo = new ProjectionMemo()
  private readonly optimized: MutableReplicatedState<V>
  private readonly legacy: MutableReplicatedState<V>
  private readonly optimizedOps: RevisionLog
  private readonly legacyOps: RevisionLog
  private prev: V
  frames = 0
  opsBytes = { optimized: 0, legacy: 0 }

  constructor(
    private readonly project: Projector<V>,
    first: Frame
  ) {
    this.prev = deepFreeze(project(first, this.memo))
    expect(this.prev).toStrictEqual(project(first))
    this.optimized = replicatedState(copy(this.prev))
    this.legacy = replicatedState(copy(this.prev))
    this.optimizedOps = revisionsOf(this.optimized)
    this.legacyOps = revisionsOf(this.legacy)
  }

  step(frame: Frame, label: string): void {
    const next = deepFreeze(this.project(frame, this.memo))
    const fresh = this.project(frame)
    expect(next, `${label}: memo projection = fresh projection`).toStrictEqual(fresh)
    expectAliasFree(next, label)
    const optimizedBefore = this.optimizedOps.revisions.length
    const legacyBefore = this.legacyOps.revisions.length
    const prev = this.prev
    this.optimized.change(BG, (draft) => reconcile(draft, next, prev))
    this.legacy.change(BG, (draft) => legacyReconcile(draft, fresh))
    expect(this.optimized.value, `${label}: optimized state`).toStrictEqual(fresh)
    expect(this.legacy.value, `${label}: legacy state`).toStrictEqual(fresh)
    const optimizedOps = this.optimizedOps.revisions.slice(optimizedBefore)
    const legacyOps = this.legacyOps.revisions.slice(legacyBefore)
    expect(optimizedOps, `${label}: ops`).toEqual(legacyOps)
    this.opsBytes.optimized += JSON.stringify(optimizedOps).length
    this.opsBytes.legacy += JSON.stringify(legacyOps).length
    this.prev = next
    this.frames++
  }

  stop(): void {
    this.optimizedOps.stop()
    this.legacyOps.stop()
  }
}

// ─────────────────────────── 世界（输入的不可变替身） ───────────────────────────

type Live = Record<string, unknown> | undefined

/** 输入的持有者：每次改动都换新的数组 / 对象（同 durable 视图挂载的结构共享），从不原地改 */
class World {
  meta = { sessionId: 's', conversationId: 1 }
  entries: readonly EntryRecord[] = []
  live: Live
  inbox: { items: unknown[] } = { items: [] }
  display: ReadonlyMap<number, DisplayItem> = new Map()
  asks: readonly InputRequest[] = []
  runState: RunViewState = 'idle'
  queueDisplay: ReadonlyMap<number, DisplayItem> | undefined

  append(...entries: EntryRecord[]): void {
    this.entries = [...this.entries, ...entries]
  }

  /** 压缩头（同 pi-durable `advance`）：头放最前，保留 id ≥ head 的非头条目 */
  compact(entry: EntryRecord): void {
    const target = (entry as { head?: number }).head!
    let kept = this.entries.findIndex(
      (candidate) => (candidate as { head?: number }).head === undefined && candidate.id >= target
    )
    if (kept < 0) kept = this.entries.length
    this.entries = [entry, ...this.entries.slice(kept)]
  }

  /** 实时文档的一处改动：没改的子树沿用原对象 */
  patchLive(patch: Record<string, unknown>): void {
    const next: Record<string, unknown> = { ...(this.live ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    this.live = next
  }

  generation(content: unknown[], extra: Record<string, unknown> = {}): void {
    const previous = (this.live?.generation ?? {}) as Record<string, unknown>
    this.patchLive({
      generation: {
        ...previous,
        message: { role: 'assistant', content, model: 'm', provider: 'p', timestamp: 5 },
        ...extra
      }
    })
  }

  setDisplay(entryId: number, item: DisplayItem | undefined): void {
    const next = new Map(this.display)
    if (item === undefined) next.delete(entryId)
    else next.set(entryId, item)
    this.display = next
  }

  /** DisplayDoc 又变了一次：旁路把每一份都重新解析成新对象（值不变） */
  reparseDisplay(): void {
    this.display = new Map([...this.display].map(([key, item]) => [key, copy(item)]))
  }

  /** 换挂载 / 重开：条目与文档都是新对象，内容不变 */
  remount(): void {
    this.entries = this.entries.map((entry) => structuredClone(entry))
    this.live = this.live === undefined ? undefined : structuredClone(this.live)
  }

  frame(): Frame {
    return {
      meta: this.meta,
      entries: this.entries,
      live: this.live,
      inbox: this.inbox,
      display: this.display,
      asks: this.asks,
      runState: this.runState,
      queueDisplay: this.queueDisplay
    }
  }
}

const ask = (id: string): InputRequest =>
  ({ id, kind: 'ask', toolName: 'ask', question: `${id}?`, createdAt: 0 }) as unknown as InputRequest

const partialCall = (id: string, partialJson: string, args: Record<string, unknown> = {}) => ({
  type: 'toolCall',
  id,
  name: 'read',
  arguments: args,
  partialJson
})

// ─────────────────────────── SP-01 / SP-02：录好的会话 ───────────────────────────

/** 录好的会话：每一步改世界，然后 `frame(label)` 把这一帧喂给所有的 Pair */
function scriptedSession(frame: (label: string) => void, world: World): void {
  world.append(U(1, 'hello'))
  frame('user message')

  world.runState = 'busy'
  world.live = { run: { taskId: 1 } }
  frame('run starts')
  world.generation([text('Hel')])
  frame('stream 1')
  world.generation([text('Hello')])
  frame('stream 2')
  world.generation([text('Hello, wor')])
  frame('stream 3')
  world.generation([thinking('think'), text('Hello'), partialCall('c1', '{"pa')])
  frame('tool call streams')
  world.generation([thinking('think'), text('Hello'), partialCall('c1', '{"path":"a"}', { path: 'a' })])
  frame('tool call args complete')

  // 实时 → 落盘
  world.append(
    A(2, [thinking('think'), text('Hello'), call('read', { path: 'a' }, 'c1')], 1, {
      task: 1,
      stopReason: 'toolUse'
    })
  )
  world.patchLive({ generation: undefined, tools: [{ callId: 'c1', status: 'pending' }] })
  frame('live -> committed, tool pending')
  world.patchLive({ tools: [{ callId: 'c1', status: 'running', output: 'li' }] })
  frame('tool running')
  world.patchLive({ tools: [{ callId: 'c1', status: 'running', output: 'line1\nline2' }] })
  frame('tool output grows')
  world.patchLive({
    tools: [{ callId: 'c1', status: 'done', output: 'line1\nline2', details: { kind: 'x' } }]
  })
  frame('tool done')
  world.append(R(3, 'c1', [text('file a')], { details: { lines: 2 } }))
  world.patchLive({ tools: undefined })
  frame('result fills the earlier card')

  world.generation([text('Done')])
  frame('second generation')
  world.append(A(4, [text('Done.')], 2, { task: 1 }))
  world.patchLive({ generation: undefined })
  frame('second card committed')
  world.live = undefined
  world.runState = 'idle'
  frame('run ends')

  world.asks = [ask('q1')]
  frame('ask raised')
  world.asks = [ask('q1'), ask('q2')]
  frame('second ask')
  world.asks = [ask('q2')]
  frame('first ask answered')
  world.asks = []
  frame('all answered')

  world.runState = 'busy'
  world.inbox = { items: [{ id: 7, mode: 'steer', content: 'also this' }] }
  frame('queued steer')
  world.inbox = {
    items: [
      { id: 7, mode: 'steer', content: 'also this' },
      { id: 8, mode: 'followUp', content: 'run PAYLOAD-K1' }
    ]
  }
  world.queueDisplay = new Map([[8, display('run {{shuvixInlineToken:k1}}', K1)]])
  frame('queued follow-up with an inline token')
  world.inbox = { items: [{ id: 9, mode: 'write', content: bg('t1', 'done') }] }
  world.queueDisplay = undefined
  frame('queue drained, only a write left')
  world.inbox = { items: [] }
  world.runState = 'idle'
  frame('inbox empty')

  world.append(U(5, 'run PAYLOAD-K1'))
  world.setDisplay(5, display('run {{shuvixInlineToken:k1}}', K1))
  frame('user with a display sidecar')
  world.reparseDisplay()
  frame('sidecar re-parsed (value-equal new objects)')
  world.setDisplay(5, display('ran {{shuvixInlineToken:k1}}', K1))
  frame('sidecar really changed')

  // 重试折叠：实时卡带提示 → 落盘那张卡带提示
  world.runState = 'busy'
  world.live = { run: { taskId: 2 } }
  world.append(E(6, 'overloaded', 2))
  frame('error folded while the run is on its task')
  world.generation([text('Retrying')])
  frame('live card carries the retried hint')
  world.generation([text('Retrying ok')])
  frame('live card streams with the hint')
  world.append(A(7, [text('Retrying ok')], 3, { task: 2 }))
  world.patchLive({ generation: undefined })
  frame('retried card committed')
  world.live = undefined
  world.runState = 'idle'
  world.append(E(8, 'fatal', 3))
  frame('error row (task 3 is not running)')
  world.append(N(9, 'a notice'))
  frame('notice after the error row')
  world.append(A(10, [text('recovered')], 4, { task: 3 }))
  frame('error row folded away from the middle')

  world.runState = 'busy'
  world.live = { run: { taskId: 4 }, generation: { retry: { at: 123, error: 'rate' }, attempt: 2 } }
  frame('run.retry')
  world.patchLive({
    compactions: [{ reason: 'threshold', blocking: true, attempt: 1, retry: { at: 5 } }]
  })
  frame('run.compacting')
  world.runState = 'interrupted'
  frame('interrupted drops the countdowns')
  world.append(A(11, [], 0, { task: 4, stopReason: 'aborted' }))
  world.live = undefined
  world.runState = 'idle'
  frame('aborted empty card leaves no message')

  world.compact(C(12, 7, wrap('summary of the start')))
  frame('compaction head replaces the prefix')
  world.append(U(13, 'after compaction'))
  frame('message after compaction')

  world.remount()
  frame('remount: every entry is a new object')
  world.meta = { ...world.meta, conversationId: 2 }
  frame('conversation id changes')
  world.meta = { ...world.meta, sessionId: 's2' }
  frame('session id changes')

  const diagnostics = [
    truncationDiagnostic({
      text: 'preview',
      truncated: true,
      persisted: true,
      originalLines: 5000,
      originalBytes: 300000,
      header: '[Output truncated]',
      kept: 'middle',
      locator: '/tmp/spill.txt'
    })!
  ]
  world.append(
    A(14, [call('read', { path: 'b' }, 'c2')], 0, { task: 5, stopReason: 'toolUse' }),
    R(15, 'c2', [text('partial'), text(renderHarnessDiagnostics(diagnostics))], {
      isError: true,
      diagnostics
    })
  )
  frame('diagnostics stripped, spill, error result')
  world.append(
    A(16, [call('read', { path: 'c' }, 'c2')], 0, { task: 5, stopReason: 'toolUse' })
  )
  frame('toolCallId reused (pending)')
  world.append(R(17, 'c2', [text('second')]))
  frame('reused id fills the newest block')
  world.append(U(18, [text('look'), IMAGE]), A(19, [text('seen')], 0, { images: [IMAGE_META] }))
  frame('images')
}

describe('P4-09b · structural sharing is equivalent to a fresh projection', () => {
  it('SP-01 scripted session (SessionView): state = fresh projection and ops = legacy ops on every frame', () => {
    const world = new World()
    const pair = new Pair(sessionOf, world.frame())
    scriptedSession((label) => pair.step(world.frame(), label), world)
    expect(pair.frames).toBeGreaterThan(40)
    expect(pair.opsBytes.optimized).toBeLessThanOrEqual(pair.opsBytes.legacy)
    pair.stop()
  })

  it('SP-02 the same script through AgentView', () => {
    const world = new World()
    const pair = new Pair(agentOf, world.frame())
    scriptedSession((label) => pair.step(world.frame(), label), world)
    expect(pair.frames).toBeGreaterThan(40)
    pair.stop()
  })
})

// ─────────────────────────── SP-03：随机步骤 ───────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class RandomWorld extends World {
  private nextId = 1
  private task = 1
  private readonly calls: string[] = []
  private chunk = 0

  constructor(private readonly random: () => number) {
    super()
  }

  private chance(p: number): boolean {
    return this.random() < p
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.random() * list.length)]!
  }

  private id(): number {
    return this.nextId++
  }

  private callId(): string {
    if (this.calls.length > 0 && this.chance(0.15)) return this.pick(this.calls)
    const id = `c${this.nextId}-${this.calls.length}`
    this.calls.push(id)
    return id
  }

  private someTask(): number | undefined {
    if (this.chance(0.15)) return undefined
    return this.pick([this.task, this.task, Math.max(1, this.task - 1)])
  }

  private appendUser(): void {
    const id = this.id()
    const content = this.pick<string | ReturnType<typeof text>[]>([
      `u${id}`,
      [text(`u${id}`), IMAGE],
      bg(`t${id}`, 'done')
    ] as never)
    this.append(U(id, content as never))
  }

  private appendAssistant(): void {
    const blocks: Parameters<typeof A>[1] = []
    const count = Math.floor(this.random() * 4)
    for (let index = 0; index < count; index++) {
      const kind = this.pick(['text', 'thinking', 'call'])
      if (kind === 'text') blocks.push(text(`a${this.nextId}.${index}`))
      else if (kind === 'thinking') blocks.push(thinking(this.chance(0.3) ? '  ' : 'hmm'))
      else blocks.push(call('read', { n: index }, this.callId()))
    }
    const stopReason = this.pick(['stop', 'toolUse', 'error', 'error', 'aborted'] as const)
    this.append(
      A(this.id(), blocks, this.nextId, {
        stopReason,
        ...(stopReason === 'error' && this.chance(0.7) ? { errorMessage: `boom ${this.nextId}` } : {}),
        ...(this.someTask() === undefined ? {} : { task: this.someTask() }),
        ...(this.chance(0.2) ? { usage: null } : {}),
        ...(this.chance(0.1) ? { images: [IMAGE_META] } : {})
      })
    )
  }

  private appendResult(): void {
    const callId = this.calls.length > 0 && this.chance(0.85) ? this.pick(this.calls) : 'orphan'
    const diagnostics = this.chance(0.3) ? [{ severity: 'info' as const, message: 'note' }] : []
    const content =
      diagnostics.length > 0 && this.chance(0.5)
        ? [text(renderHarnessDiagnostics(diagnostics))]
        : [text(`result ${this.nextId}`), ...(diagnostics.length > 0 ? [text(renderHarnessDiagnostics(diagnostics))] : [])]
    this.append(
      R(this.id(), callId, content, {
        diagnostics,
        isError: this.chance(0.2),
        ...(this.chance(0.3) ? { details: { n: this.nextId } } : {})
      })
    )
  }

  private stream(): void {
    if (this.live?.run === undefined) {
      this.task++
      this.live = { run: { taskId: this.task } }
      this.runState = 'busy'
    }
    const generation = this.live?.generation as { message?: { content?: unknown[] } } | undefined
    const content = [...(generation?.message?.content ?? [])]
    const last = content.at(-1) as { type?: string; text?: string } | undefined
    const roll = this.random()
    if (roll < 0.6 && last?.type === 'text') {
      content[content.length - 1] = text(`${last.text}${this.chunk++}`)
    } else if (roll < 0.8) {
      content.push(text(`s${this.chunk++}`))
    } else if (roll < 0.9) {
      content.push(thinking('pondering'))
    } else {
      content.push(partialCall(this.callId(), `{"n":${this.chunk++}`))
    }
    this.generation(content)
  }

  private tools(): void {
    const slots: unknown[] = []
    const count = Math.floor(this.random() * 3)
    for (let index = 0; index < count; index++) {
      slots.push({
        callId: this.calls.length > 0 ? this.pick(this.calls) : `x${index}`,
        status: this.pick(['pending', 'running', 'done', 'bogus']),
        ...(this.chance(0.5) ? { output: `out${this.chunk++}` } : {}),
        ...(this.chance(0.2) ? { details: { d: index } } : {})
      })
    }
    this.patchLive({ tools: slots })
  }

  private liveMisc(): void {
    const roll = this.random()
    if (roll < 0.25) this.patchLive({ generation: undefined })
    else if (roll < 0.45) {
      this.live = undefined
      this.runState = 'idle'
    } else if (roll < 0.6) {
      this.patchLive({
        generation: {
          ...((this.live?.generation as object) ?? {}),
          retry: { at: this.nextId, error: 'rate' },
          attempt: 2
        }
      })
    } else if (roll < 0.75) {
      this.patchLive({
        compactions: [{ reason: 'threshold', blocking: this.chance(0.5), attempt: 1 }]
      })
    } else if (roll < 0.9) {
      this.live = this.live === undefined ? undefined : structuredClone(this.live)
    } else {
      this.patchLive({ run: { taskId: this.someTask() ?? this.task } })
    }
  }

  private displayStep(): void {
    const users = this.entries.filter((entry) => entry.kind === 'pi.user')
    const roll = this.random()
    if (roll < 0.3) this.reparseDisplay()
    else if (users.length > 0 && roll < 0.8) {
      const target = this.pick(users).id
      this.setDisplay(
        target,
        this.pick([
          display('x {{shuvixInlineToken:k1}}', K1),
          display('y {{shuvixInlineToken:k1}}', K1),
          display('plain', {})
        ])
      )
    } else if (users.length > 0) {
      this.setDisplay(this.pick(users).id, undefined)
    }
  }

  private queueStep(): void {
    if (this.inbox.items.length > 0 && this.chance(0.4)) {
      this.inbox = { items: this.inbox.items.slice(1) }
      return
    }
    const id = this.id()
    this.inbox = {
      items: [
        ...this.inbox.items,
        {
          id,
          mode: this.pick(['steer', 'followUp', 'write']),
          content: this.pick([`q${id}`, bg(`t${id}`, 'x'), [text('img'), IMAGE]])
        }
      ]
    }
    if (this.chance(0.3)) {
      this.queueDisplay = new Map([
        ...(this.queueDisplay ?? []),
        [id, display('q {{shuvixInlineToken:k1}}', K1)]
      ])
    }
  }

  step(): void {
    const actions = [
      () => this.appendUser(),
      () => this.appendAssistant(),
      () => this.appendAssistant(),
      () => this.appendResult(),
      () => this.appendResult(),
      () => this.append(N(this.id(), `notice ${this.nextId}`)),
      () => this.stream(),
      () => this.stream(),
      () => this.stream(),
      () => this.tools(),
      () => this.liveMisc(),
      () => {
        this.runState = this.pick(['idle', 'busy', 'interrupted'] as const)
      },
      () => this.displayStep(),
      () => {
        this.asks = this.chance(0.5)
          ? [...this.asks, ask(`r${this.nextId++}`)]
          : this.asks.slice(1)
      },
      () => this.queueStep(),
      () => {
        const heads = this.entries.filter((entry) => (entry as { head?: number }).head === undefined)
        if (heads.length > 2) this.compact(C(this.id(), this.pick(heads).id, wrap(`sum ${this.nextId}`)))
      },
      () => {
        if (this.chance(0.3)) this.remount()
        else this.meta = { ...this.meta, conversationId: this.meta.conversationId + 1 }
      }
    ]
    const count = 1 + Math.floor(this.random() * 2)
    for (let index = 0; index < count; index++) this.pick(actions)()
  }
}

describe('P4-09b · structural sharing under random steps', () => {
  it('SP-03 120 seeds x 40 steps: SessionView and AgentView stay equal to a fresh projection with legacy ops', () => {
    let frames = 0
    for (let seed = 1; seed <= 120; seed++) {
      const world = new RandomWorld(mulberry32(seed))
      const session = new Pair(sessionOf, world.frame())
      const agent = new Pair(agentOf, world.frame())
      for (let step = 1; step <= 40; step++) {
        world.step()
        const frame = world.frame()
        session.step(frame, `seed ${seed} step ${step} (session)`)
        agent.step(frame, `seed ${seed} step ${step} (agent)`)
      }
      frames += session.frames + agent.frames
      session.stop()
      agent.stop()
    }
    expect(frames).toBe(120 * 40 * 2)
  })
})
