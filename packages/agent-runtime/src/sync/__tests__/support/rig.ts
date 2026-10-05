/**
 * SyncHub 用例的服务端一侧：真的会话宿主（`makeHost`）+ 假投影器 + 回环传输。
 *
 * - **假投影器**（P3-03 还在并行实现）：一个真的 chord `replicatedState`，用例自己 `change` 它模拟流式
 *   （`stream.*`）。每个会话实例共享一个（`projector()` 两次同一个），最后一个租约释放或会话关闭时
 *   停用，之后的 `projector()` 给新的 —— 新实例的初值是上一个的最后值（模拟「存储里的内容」），
 *   删除存储时清掉。
 * - **宿主接缝**：`peek` 记调用、交给真宿主；开 / 关钩子由这里补上（P3-03 之前 SessionHost 还没有）：
 *   第一次见到一个会话实例（经 `rig.open` 或 hub 的 peek）就报打开，并把实例的 `close` 包一层，关完报
 *   关闭（显式 / LRU / closeAll / 删除都走 SessionManager → `session.close(reason)`）。
 * - **回环传输**：每个客户端一条 FIFO，每帧 JSON 往返后在微任务里送达；可按客户端丢 state 帧、
 *   同步抛错或异步拒绝。
 */
import { defineService, replicatedState, RemoteServiceProvider } from '@earendil-works/chord'
import type { MutableReplicatedState, ReplicatedState } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Op } from '@earendil-works/chord/delta'
import type { AssistantMessage } from '@shuvix/chat-protocol/types/chatMessage'
import {
  emptySessionView,
  type AgentView,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import type { DurableSession, SessionCloseReason } from '../../../durable/durableSession'
import type { TestHost } from '../../../durable/__tests__/support/host'
import type { LegacyTranscript, SyncView } from '../../services'
import {
  createSyncHub,
  type SyncAgentRef,
  type SyncHub,
  type SyncHubHost,
  type SyncServerTransport,
  type SyncSession,
  type SyncSessionClosedReason,
  type SyncWireFrame,
  type ViewLease,
  type ViewProjector
} from '../../syncHub'

export const BG = BACKGROUND_CONTEXT

export function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等 hub 冲完缓存（宏任务）、回环送达（微任务） */
export async function settle(): Promise<void> {
  for (let index = 0; index < 4; index++) await sleep(0)
}

// ─── 假投影器 ──────────────────────────────────────────

export class FakeProjector<V extends object> implements ViewProjector<V> {
  readonly state: MutableReplicatedState<V>
  refs = 0
  acquires = 0
  disposed = false

  constructor(
    initial: V,
    private readonly onDispose: (last: V) => void
  ) {
    this.state = replicatedState(initial)
  }

  acquire(): ViewLease<V> {
    if (this.disposed) throw new Error('acquire on a disposed projector')
    this.refs++
    this.acquires++
    let released = false
    return {
      state: this.state,
      release: () => {
        if (released) return
        released = true
        if (--this.refs === 0) this.dispose()
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.onDispose(this.state.value)
  }
}

/** durable 会话的初值（P3-03-01 的空会话形状） */
export function durableView(sessionId: string): SessionView {
  return {
    ...emptySessionView(sessionId),
    source: 'durable',
    capabilities: { send: true, rollback: true, continue: true },
    conversationId: 1
  }
}

export function agentView(agentId: string, sessionId: string, conversationId: number): AgentView {
  return {
    v: 1,
    agentId,
    sessionId,
    conversationId,
    messages: [],
    live: null,
    toolRuns: {},
    run: { state: 'busy' },
    context: { usedTokens: null }
  }
}

// ─── 模拟流式（像真投影器那样逐字段写：增长的字符串 → append op） ─────

type ViewWithLive = SessionView | AgentView

function assistant(sessionId: string, id: string, text: string): AssistantMessage {
  return {
    id,
    sessionId,
    role: 'assistant',
    type: 'message',
    content: text,
    model: 'faux-1',
    createdAt: 1,
    blocks: [{ type: 'text', text }],
    metadata: null
  }
}

export const stream = {
  start<V extends ViewWithLive>(state: MutableReplicatedState<V>, taskId = 't1'): void {
    state.change(BG, (draft) => {
      const view = draft as unknown as ViewWithLive
      view.run = { state: 'busy' }
      view.live = { id: `live:${taskId}`, message: assistant(view.sessionId, `live:${taskId}`, '') }
    })
  },
  append<V extends ViewWithLive>(state: MutableReplicatedState<V>, text: string): void {
    state.change(BG, (draft) => {
      const live = (draft as unknown as ViewWithLive).live!
      live.message.content += text
      const block = live.message.blocks[0] as { type: 'text'; text: string }
      block.text += text
    })
  },
  commit<V extends ViewWithLive>(state: MutableReplicatedState<V>, entryId: number): void {
    state.change(BG, (draft) => {
      const view = draft as unknown as ViewWithLive
      const text = view.live?.message.content ?? ''
      view.messages.push(assistant(view.sessionId, String(entryId), text))
      view.live = null
      view.run = { state: 'idle' }
    })
  },
  /** 一轮完整的回答：开卡、逐段追加、落盘 */
  answer<V extends ViewWithLive>(
    state: MutableReplicatedState<V>,
    parts: readonly string[],
    entryId: number
  ): void {
    stream.start(state, `t${entryId}`)
    for (const part of parts) stream.append(state, part)
    stream.commit(state, entryId)
  }
}

/** 只读 op 通道（设计稿的 `opsOf`）：一次性 provider 订阅同一个状态，逐条记 `{sequence, ops}` */
export function opsOf(state: ReplicatedState<unknown>): { sequence: number; ops: Op[] }[] {
  const service = defineService<{ view: ReplicatedState<unknown> }>('t')
  const provider = new RemoteServiceProvider([service])
  provider.provide(service, { view: state } as never)
  const recorded: { sequence: number; ops: Op[] }[] = []
  const subscription = provider.subscribe('t', 'singleton', (update) => {
    if (update.type === 'state') recorded.push({ sequence: update.sequence, ops: [...update.ops] })
  })
  subscription.activate()
  return recorded
}

/** 状态此刻的序号（一次性 provider 快照里的 sequence） */
export function sequenceOf(state: ReplicatedState<unknown>): number {
  const service = defineService<{ view: ReplicatedState<unknown> }>('t')
  const provider = new RemoteServiceProvider([service])
  provider.provide(service, { view: state } as never)
  const subscription = provider.subscribe('t', 'singleton', () => {})
  const member = subscription.snapshot.instances[0]!.members[0]!
  provider.dispose()
  return member.kind === 'state' ? member.sequence : -1
}

// ─── 回环传输 ──────────────────────────────────────────

export interface SentFrame {
  readonly clientId: string
  readonly frame: SyncWireFrame
}

export class LoopbackTransport implements SyncServerTransport {
  readonly sent: SentFrame[] = []
  readonly dropped: SentFrame[] = []
  /** 接下来丢掉这么多个 state 帧（按客户端） */
  readonly dropState = new Map<string, number>()
  /** 对这些客户端同步抛错 */
  readonly throwFor = new Set<string>()
  /** 对这些客户端返回被拒绝的 promise（帧照样送达） */
  readonly rejectFor = new Set<string>()
  readonly #receivers = new Map<string, (frame: SyncWireFrame) => void>()
  readonly #gone = new Map<string, Set<() => void>>()

  send(clientId: string, frame: SyncWireFrame): void | Promise<void> {
    if (this.throwFor.has(clientId)) throw new Error(`send failed for ${clientId}`)
    const copy = json(frame)
    const entry = { clientId, frame: copy }
    const drop = this.dropState.get(clientId) ?? 0
    if (drop > 0 && copy.update.type === 'state') {
      this.dropState.set(clientId, drop - 1)
      this.dropped.push(entry)
      return
    }
    this.sent.push(entry)
    queueMicrotask(() => this.#receivers.get(clientId)?.(json(copy)))
    if (this.rejectFor.has(clientId))
      return Promise.reject(new Error(`async send failed for ${clientId}`))
  }

  onClientGone(clientId: string, callback: () => void): () => void {
    let callbacks = this.#gone.get(clientId)
    if (callbacks === undefined) {
      callbacks = new Set()
      this.#gone.set(clientId, callbacks)
    }
    callbacks.add(callback)
    return () => {
      callbacks.delete(callback)
    }
  }

  /** 客户端离开（IPC：webContents destroyed） */
  gone(clientId: string): void {
    for (const callback of [...(this.#gone.get(clientId) ?? [])]) callback()
  }

  goneListeners(clientId?: string): number {
    if (clientId !== undefined) return this.#gone.get(clientId)?.size ?? 0
    let total = 0
    for (const callbacks of this.#gone.values()) total += callbacks.size
    return total
  }

  attach(clientId: string, receiver: (frame: SyncWireFrame) => void): void {
    this.#receivers.set(clientId, receiver)
  }

  sentTo(clientId: string): SyncWireFrame[] {
    return this.sent.filter((entry) => entry.clientId === clientId).map((entry) => entry.frame)
  }
}

// ─── 装配 ──────────────────────────────────────────────

/** 先于宿主建好的钉住接线（`makeHost({ isPinned: pins.isPinned })`），hub 建好后再挂上 */
export interface PinRef {
  readonly isPinned: (sessionId: string) => boolean
  hub: SyncHub | undefined
}

export function pinRef(): PinRef {
  const ref: PinRef = {
    isPinned: (sessionId) => ref.hub?.hasSubscribers(sessionId) ?? false,
    hub: undefined
  }
  return ref
}

export interface RigOptions {
  readonly pins?: PinRef
  readonly legacy?: (sessionId: string) => LegacyTranscript | undefined
  /** 派生 agent → 根会话与对话（resolveAgent 接缝） */
  readonly agents?: Map<string, { sessionId: string; conversationId: number }>
}

export interface Rig {
  readonly t: TestHost
  readonly hub: SyncHub
  readonly transport: LoopbackTransport
  /** `peek:<id>`、`projector:<id>`、`agentProjector:<agentId>` */
  readonly calls: string[]
  /** hub 的 warn / error 日志 */
  readonly logs: string[]
  /** 打开并报打开钩子（第一次见到这个实例时） */
  open(sessionId: string): Promise<DurableSession>
  /** 某会话当前（未停用）的根投影器 */
  projectorOf(sessionId: string): FakeProjector<SessionView> | undefined
  /** 打开 / 拿到某会话的根投影器（同 `session.projector()`） */
  projector(sessionId: string): Promise<FakeProjector<SessionView>>
  agentProjectorOf(agentId: string): FakeProjector<AgentView> | undefined
  /** 宿主钩子上此刻登记的监听器数 */
  hookListeners(): number
  /** hub 调 `projector()` 时的回调（P3-04-12 在那一刻挂发布记录器） */
  onProjector: ((session: DurableSession) => void) | undefined
}

export function makeRig(t: TestHost, options: RigOptions = {}): Rig {
  const calls: string[] = []
  const logs: string[] = []
  const openedListeners = new Set<(session: SyncSession) => void>()
  const closedListeners = new Set<(sessionId: string, reason: SyncSessionClosedReason) => void>()
  const seen = new WeakSet<DurableSession>()
  const adapters = new WeakMap<DurableSession, SyncSession>()
  /** 会话实例 → 当前根投影器 / 派生 agent 投影器 */
  const roots = new WeakMap<DurableSession, FakeProjector<SessionView>>()
  const agentProjectors = new WeakMap<DurableSession, Map<string, FakeProjector<AgentView>>>()
  /** 「存储里的内容」：投影器停用时的最后值，下一个实例的初值 */
  const content = new Map<string, SessionView>()
  const agentContent = new Map<string, AgentView>()
  const transport = new LoopbackTransport()

  const rootOf = (session: DurableSession): FakeProjector<SessionView> => {
    const current = roots.get(session)
    if (current !== undefined && !current.disposed) return current
    const projector = new FakeProjector<SessionView>(
      content.get(session.sessionId) ?? durableView(session.sessionId),
      (last) => {
        if (!session.closed || !destroyed.has(session)) content.set(session.sessionId, last)
      }
    )
    roots.set(session, projector)
    return projector
  }
  const destroyed = new WeakSet<DurableSession>()

  const agentOf = (session: DurableSession, agent: SyncAgentRef): FakeProjector<AgentView> => {
    let map = agentProjectors.get(session)
    if (map === undefined) {
      map = new Map()
      agentProjectors.set(session, map)
    }
    const current = map.get(agent.agentId)
    if (current !== undefined && !current.disposed) return current
    const projector = new FakeProjector<AgentView>(
      agentContent.get(agent.agentId) ??
        agentView(agent.agentId, session.sessionId, agent.conversationId),
      (last) => agentContent.set(agent.agentId, last)
    )
    map.set(agent.agentId, projector)
    return projector
  }

  const adapt = (session: DurableSession): SyncSession => {
    let adapter = adapters.get(session)
    if (adapter !== undefined) return adapter
    adapter = {
      sessionId: session.sessionId,
      projector: async () => {
        calls.push(`projector:${session.sessionId}`)
        rig.onProjector?.(session)
        await Promise.resolve()
        return rootOf(session)
      },
      agentProjector: async (agent) => {
        calls.push(`agentProjector:${agent.agentId}`)
        await Promise.resolve()
        if (options.agents?.get(agent.agentId) === undefined) return undefined
        return agentOf(session, agent)
      }
    }
    adapters.set(session, adapter)
    return adapter
  }

  const track = (session: DurableSession): SyncSession => {
    const adapter = adapt(session)
    if (seen.has(session)) return adapter
    seen.add(session)
    // 实现类的 close（SessionManager 关会话时调它）；DurableSession 接口不暴露
    const closable = session as unknown as { close(reason?: SessionCloseReason): Promise<void> }
    const close = closable.close.bind(session)
    closable.close = async (reason) => {
      await close(reason)
      if (reason === 'destroy') {
        destroyed.add(session)
        content.delete(session.sessionId)
      }
      // 会话关闭停用它的投影器（P3-03-47）
      roots.get(session)?.dispose()
      for (const projector of agentProjectors.get(session)?.values() ?? []) projector.dispose()
      for (const listener of [...closedListeners]) {
        listener(session.sessionId, (reason ?? 'remove') as SyncSessionClosedReason)
      }
    }
    for (const listener of [...openedListeners]) listener(adapter)
    return adapter
  }

  const host: SyncHubHost = {
    get sealed() {
      return t.host.sealed
    },
    peek: async (sessionId) => {
      calls.push(`peek:${sessionId}`)
      const session = await t.host.peek(sessionId)
      return session === undefined ? undefined : track(session)
    },
    onSessionOpened: (listener) => {
      openedListeners.add(listener)
      return () => openedListeners.delete(listener)
    },
    onSessionClosed: (listener) => {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    }
  }

  const hub = createSyncHub({
    host,
    transport,
    ...(options.legacy === undefined ? {} : { legacyView: options.legacy }),
    resolveAgent: (agentId) => options.agents?.get(agentId),
    logger: {
      info: () => {},
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message)
    }
  })
  if (options.pins !== undefined) options.pins.hub = hub

  const rig: Rig = {
    t,
    hub,
    transport,
    calls,
    logs,
    onProjector: undefined,
    open: async (sessionId) => {
      const session = await t.host.open(sessionId)
      track(session)
      return session
    },
    projectorOf: (sessionId) => {
      const session = t.host.get(sessionId)
      if (session === undefined) return undefined
      const projector = roots.get(session)
      return projector === undefined || projector.disposed ? undefined : projector
    },
    projector: async (sessionId) => {
      const session = await rig.open(sessionId)
      return rootOf(session)
    },
    agentProjectorOf: (agentId) => {
      const ref = options.agents?.get(agentId)
      const session = ref === undefined ? undefined : t.host.get(ref.sessionId)
      const projector =
        session === undefined ? undefined : agentProjectors.get(session)?.get(agentId)
      return projector === undefined || projector.disposed ? undefined : projector
    },
    hookListeners: () => openedListeners.size + closedListeners.size
  }
  return rig
}

export type { SyncView }
