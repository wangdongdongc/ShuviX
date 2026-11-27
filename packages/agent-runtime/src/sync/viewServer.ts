/**
 * 视图服务端（Chord 1.6.1 / v2）—— 把会话视图（SessionView）与派生 agent 视图（AgentView）同步给任意多个前端。
 * 宿主无关：不碰 Electron / node，链路由宿主交进来（`accept(link, principal)`）。
 *
 * 结构（一个 chord v2 宿主，地址 `VIEW_SERVER_ADDRESS`）：
 *  - **远程类型** `shuvix.session-view` / `shuvix.agent-view`（契约见 `viewContracts.ts`）：每个（参数，主体）一条
 *    对象，工厂很薄 —— 核对主体（`authorize`，不通过 → `forbidden`），通过 `self.open` 共享底层的 `TargetRuntime`
 *    （按目标引用计数，先钉住再 peek），再通过 `self.follow` 把 `view` 与 `availability` 两个状态成员原样交出去。
 *  - **共享目标运行时** `TargetRuntime`：**每个目标一个共享实例**（不按主体重复 peek / 重复借投影租约）。
 *    激活时解析目标（agent → 根会话，`resolveAgent`）、**先登记钉住、再 peek**（PIN：peek 刚打开的会话会马上被
 *    修剪检查）、算出第一份实现并装上，于是 `self.follow` 挂上那一刻的第一份快照就是真的视图，不是空视图；之后一个
 *    顺序事件队列处理该根会话的开 / 关 / 删事件。
 *
 * 实现的换法（远程成员一直是同一个 follow 源，前端的引用不断）：
 *  - 激活时：封存 → 空视图（PIN-18，之后不再换）；旧格式 → 冻结的静态视图；否则**只 peek**（从不 open、
 *    从不 resume）—— 没有存储 → 空视图（`source:'none'`，PIN-17/24），有 → 活投影（`acquire()`）。
 *  - 活投影的每个修订把精确操作流 `ops`（缺省时 `diffRevisions`）直接推给所有 `view` 观察者。换实现 = 停掉旧的桥、
 *    整份替换 `[['r', next]]`、订上新的之后再还旧租约。
 *  - 会话打开（`onSessionOpened`）：空 / 静态 / 旧格式 → 活投影。
 *  - 会话关闭（非 destroy，PIN-13）：停桥、还租约；保留最后一个值。运行状态停在最后投影的样子，不合成 interrupted。
 *  - 存储被销毁（`destroy`，即 host.delete —— 清空走的也是它）：会话目标 → 空视图（会话还在）；派生 agent
 *    目标 → `availability = 'unavailable'`（对话没了），之后不再变。
 *  - **会话被删除**（`deleteSession`，PIN-14）：它的每个目标 `availability = 'unavailable'`、立刻松开钉住；之后
 *    再 get 这条会话 → 「找不到」（`unavailable` + `details.reason = 'not_found'`），直到同一个 id 再被打开。
 *
 * 钉住：有目标运行时（含激活途中）的会话不被 LRU 回收（`hasSubscribers` 接宿主的 `isPinned`）；派生 agent 目标
 * 钉住它的根会话（PIN-16）。前端离开（链路断开 / 页面重载）= chord 释放经那条链路的全部持有 → 对象关闭 →
 * 共享引用归零 → 钉住松开（PIN-21）。
 */
import {
  broken,
  ChordError,
  createHost,
  defineFacet,
  forbidden,
  type FollowObserver,
  type Host,
  type HostError,
  type Link,
  type Principal
} from '@earendil-works/chord'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { diffRevisions, type Op } from '@earendil-works/chord/delta'
import type { JsonValue } from '@earendil-works/chord/json'
import { syncTargetKey, type SyncTarget } from '@shuvix/chat-protocol/sync'
import {
  emptySessionView,
  type AgentView,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import type { RuntimeLogger } from '../types'
import type { ReplicatedState } from './replicatedState'
import { legacySessionView, type LegacyTranscript, type SyncView } from './services'
import {
  AgentViewContract,
  notFoundError,
  SessionViewContract,
  VIEW_LINK_CODEC,
  VIEW_SERVER_ADDRESS,
  type ViewAvailability
} from './viewContracts'

// ─── 接缝（宿主提供；与 phase 3 的 SyncHub 相同） ─────────

/** 一次 `acquire()` 的租约：共享的复制状态 + 释放（最后一个释放时投影器停止并保留最后的值） */
export interface ViewLease<V> {
  readonly state: ReplicatedState<V>
  release(): void
}

/** 一个已挂载完成的投影器（`projector()` 在显示解析完成后才交出，PIN-01） */
export interface ViewProjector<V> {
  acquire(): ViewLease<V>
}

/** 一个派生 agent：它的 id 与它的对话 */
export interface SyncAgentRef {
  readonly agentId: string
  readonly conversationId: number
}

/** 服务端需要的会话能力（DurableSession 满足它） */
export interface SyncSession {
  readonly sessionId: string
  /** 根对话的 SessionProjector（同一会话共享一个实例） */
  projector(): Promise<ViewProjector<SessionView>>
  /** 某个派生 agent 的 AgentProjector；不认识 → undefined */
  agentProjector(agent: SyncAgentRef): Promise<ViewProjector<AgentView> | undefined>
}

/** 会话关闭的原因：`destroy` = 存储被删（host.delete）；其余（remove / LRU / closeAll …）= 只是关了 */
export type SyncSessionClosedReason = 'remove' | 'invalidate' | 'destroy'

/** 服务端需要的会话宿主能力（桌面把 SessionHost 接成这个形状） */
export interface SyncHubHost {
  /** closeAll 之后为 true：不再打开任何会话 */
  readonly sealed: boolean
  /** 打开已存在的会话；存储不存在 / 已封存 → undefined（从不创建、从不 resume） */
  peek(sessionId: string): Promise<SyncSession | undefined>
  /** 每次真正打开一条会话（open 或 peek）之后；返回注销函数 */
  onSessionOpened(listener: (session: SyncSession) => void): () => void
  /** 每次会话关闭完成之后（显式 / LRU / closeAll / 删除）；返回注销函数 */
  onSessionClosed(
    listener: (sessionId: string, reason: SyncSessionClosedReason) => void
  ): () => void
}

/**
 * 链路的主体（接受链路的宿主盖的章，客户端自己说了不算）：桌面窗口 `{kind:'window', webContentsId}`，Chrome
 * 侧边栏 `{kind:'chrome', installId, runId, connId, tabId}`。
 */
export interface ViewPrincipal {
  readonly kind: string
  readonly [key: string]: unknown
}

export interface ViewServerHeartbeat {
  readonly ping?: number
  readonly close?: number
}

export interface ViewServerDeps {
  readonly host: SyncHubHost
  /** 旧格式会话的冻结投影；不是旧格式会话 → undefined / null */
  readonly legacyView?: (
    sessionId: string
  ) => LegacyTranscript | null | undefined | Promise<LegacyTranscript | null | undefined>
  /** 派生 agent → 它的根会话与对话；不认识 → undefined */
  readonly resolveAgent?: (
    agentId: string
  ) =>
    | { sessionId: string; conversationId: number }
    | undefined
    | Promise<{ sessionId: string; conversationId: number } | undefined>
  /**
   * 这个主体能不能看这个目标（同步或异步）；false → `forbidden`。缺省 = 都能看。宿主自己（进程内的 get）不经它。
   * 异步的判定与目标的激活并行进行：不通过时对象失败，视图一帧都不会发给这个主体。
   */
  readonly authorize?: (principal: ViewPrincipal, target: SyncTarget) => boolean | Promise<boolean>
  readonly logger?: RuntimeLogger
  /** 链路心跳选项（缺省 chord 的 15s / 30s；测试调小） */
  readonly heartbeat?: ViewServerHeartbeat
}

export interface ViewServer {
  /** chord 宿主（地址 `VIEW_SERVER_ADDRESS`）—— 进程内也可以直接 `get` 契约（测试） */
  readonly host: Host
  /** 接受一条前端的链路（主体由调用方盖章） */
  accept(link: Link, principal: ViewPrincipal): void
  /** 这条会话此刻有没有人看着（含激活途中、含它派生 agent 的目标）—— 接宿主的 `isPinned` */
  hasSubscribers(sessionId: string): boolean
  /** 会话本身被删除（侧栏删除，不是清空）：它的目标全部 unavailable，之后再 get → 找不到 */
  deleteSession(sessionId: string): void
  /** 关掉一切（对象强制结束 → 前端的引用 ended，链路关掉） */
  dispose(): Promise<void>
}

// ─── 内部 ─────────────────────────────────────────────

const HOST_PRINCIPAL: Principal = { kind: 'host' }

type Mode = 'live' | 'static' | 'none' | 'legacy' | 'sealed' | 'gone'

/** 一次换装的内容：哪种视图、它此刻的值、（活投影）租约与会话 */
interface ViewImpl {
  readonly mode: Exclude<Mode, 'gone'>
  readonly value: SyncView
  readonly lease?: ViewLease<SyncView>
  readonly session?: SyncSession
}

type TargetEvent =
  | { readonly type: 'opened'; readonly session: SyncSession }
  | { readonly type: 'closed'; readonly reason: SyncSessionClosedReason }
  | { readonly type: 'deleted' }

/** 激活时最多重算几次（途中有开 / 关事件就丢掉结果重算；再多就照收、交给循环处理） */
const MAX_INIT_ATTEMPTS = 5

const noopLogger: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} }

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const he = error as HostError
    if ('error' in he && he.error !== undefined) return `${he.kind}: ${errorText(he.error)}`
    if ('failure' in he && he.failure !== undefined) {
      return `${he.kind}: ${errorText(he.failure.error)}`
    }
    return he.kind
  }
  return String(error)
}

function emptyAgentView(agentId: string): AgentView {
  return {
    v: 1,
    agentId,
    sessionId: '',
    conversationId: 0,
    messages: [],
    live: null,
    toolRuns: {},
    run: { state: 'idle' },
    context: { usedTokens: null }
  }
}

/** 共享的目标记录（按目标键一份，多个主体共用） */
interface SharedTarget {
  readonly runtime: TargetRuntime
  readonly controller: AbortController
  ready: Promise<void>
  refs: number
}

/** 服务端各目标共用的那一点 */
interface ServerCore {
  readonly deps: ViewServerDeps
  readonly logger: RuntimeLogger
  readonly runtimes: Set<TargetRuntime>
  readonly sources: Map<string, SharedTarget>
  /** 根会话 → 钉住它的目标数 */
  readonly pins: Map<string, number>
  /** 删掉的会话（PIN-14）：再 get → 找不到；同一个 id 再被打开时撤销 */
  readonly deleted: Set<string>
}

/** 一个目标的共享运行时：解析、钉住、实现、事件循环、向所有跟随的成员推值与增量 */
class TargetRuntime {
  readonly key: string
  rootSessionId: string | undefined
  agent: SyncAgentRef | undefined
  mode: Mode | 'init' = 'init'
  lease: ViewLease<SyncView> | undefined
  session: SyncSession | undefined
  view: SyncView
  availability: ViewAvailability = 'available'
  readonly #viewObservers = new Set<FollowObserver<unknown>>()
  readonly #availabilityObservers = new Set<FollowObserver<unknown>>()
  #queue: TargetEvent[] = []
  #draining = false
  #pinned = false
  /** 删掉了（标记同步落下：钉住立刻松开，激活途中则失败） */
  #deleted = false
  #closed = false
  #stopBridge: (() => void) | undefined

  constructor(
    private readonly core: ServerCore,
    readonly target: SyncTarget
  ) {
    this.key = syncTargetKey(target)
    this.view =
      target.kind === 'session'
        ? emptySessionView(target.sessionId)
        : emptyAgentView(target.agentId)
  }

  attachView(observer: FollowObserver<unknown>): { readonly value: unknown; detach(): void } {
    this.#viewObservers.add(observer)
    return {
      value: this.view,
      detach: () => {
        this.#viewObservers.delete(observer)
      }
    }
  }

  attachAvailability(observer: FollowObserver<unknown>): {
    readonly value: ViewAvailability
    detach(): void
  } {
    this.#availabilityObservers.add(observer)
    return {
      value: this.availability,
      detach: () => {
        this.#availabilityObservers.delete(observer)
      }
    }
  }

  // ─── 激活 ───────────────────────────────────────────

  async open(signal: AbortSignal): Promise<void> {
    this.core.runtimes.add(this)
    const target = this.target
    if (target.kind === 'session') {
      this.rootSessionId = target.sessionId
      if (this.core.deleted.has(target.sessionId)) {
        throw notFoundError(`Session ${target.sessionId} was deleted`)
      }
      // 先钉住再 peek：peek 刚打开的会话会马上被修剪检查
      this.#pin()
    } else {
      const resolved = await this.core.deps.resolveAgent?.(target.agentId)
      if (resolved === undefined) throw notFoundError(`Unknown agent ${target.agentId}`)
      this.rootSessionId = resolved.sessionId
      this.agent = { agentId: target.agentId, conversationId: resolved.conversationId }
      if (this.core.deleted.has(resolved.sessionId)) {
        throw notFoundError(`Session ${resolved.sessionId} was deleted`)
      }
      this.#pin()
    }
    for (let attempt = 1; ; attempt++) {
      this.#queue.length = 0
      const impl = await this.#compute()
      if (this.#deleted) {
        this.#release(impl.lease)
        throw notFoundError(`Session ${this.rootSessionId} was deleted`)
      }
      if (signal.aborted || this.#closed) {
        this.#release(impl.lease)
        throw new ChordError({ code: 'aborted', message: `${this.key} abandoned` })
      }
      // 途中有开 / 关（generation 变了），或报打开的会话不是算出来的那个（peek 早于它的存储出生）→ 重算。
      // 自己的 peek 打开会话时钩子也会报，那时算出的正是它，不必重算
      const relevant = this.#queue.filter(
        (event) => !(event.type === 'opened' && event.session === impl.session)
      )
      if (relevant.length === 0 || attempt >= MAX_INIT_ATTEMPTS) {
        this.#queue = relevant
        this.#install(impl)
        if (this.#queue.length > 0) void this.#drainQueue()
        return
      }
      this.#release(impl.lease)
    }
  }

  async #compute(): Promise<ViewImpl> {
    const { host, legacyView } = this.core.deps
    const target = this.target
    if (target.kind === 'session') {
      const sessionId = target.sessionId
      // 封存（退出路径上）：什么都不打开，给一份不会再换的空视图（PIN-18）
      if (host.sealed) return { mode: 'sealed', value: emptySessionView(sessionId) }
      const legacy = await legacyView?.(sessionId)
      if (legacy !== undefined && legacy !== null) {
        return { mode: 'legacy', value: legacySessionView(sessionId, legacy) }
      }
      const session = await host.peek(sessionId)
      if (session === undefined) {
        return { mode: host.sealed ? 'sealed' : 'none', value: emptySessionView(sessionId) }
      }
      return this.#liveImpl((await session.projector()).acquire(), session)
    }
    const rootSessionId = this.rootSessionId!
    const session = await host.peek(rootSessionId)
    if (session === undefined) {
      throw notFoundError(`Agent ${target.agentId}: session is not available`)
    }
    const projector = await session.agentProjector(this.agent!)
    if (projector === undefined) throw notFoundError(`Unknown agent ${target.agentId}`)
    return this.#liveImpl(projector.acquire(), session)
  }

  #liveImpl(
    acquired: ViewLease<SessionView> | ViewLease<AgentView>,
    session: SyncSession
  ): ViewImpl {
    const lease = acquired as unknown as ViewLease<SyncView>
    return { mode: 'live', value: lease.state.value ?? this.#empty(), lease, session }
  }

  #empty(): SyncView {
    return this.target.kind === 'session'
      ? emptySessionView(this.target.sessionId)
      : emptyAgentView(this.target.agentId)
  }

  // ─── 事件循环 ──────────────────────────────────────

  push(event: TargetEvent): void {
    if (this.#closed) return
    this.#queue.push(event)
    // 激活期间事件留在队列里由 open() 核对 / 重算；装好第一份实现后再顺序处理
    if (this.mode !== 'init') void this.#drainQueue()
  }

  async #drainQueue(): Promise<void> {
    if (this.#draining || this.#closed) return
    this.#draining = true
    try {
      while (!this.#closed) {
        const event = this.#queue.shift()
        if (event === undefined) break
        try {
          await this.#handle(event)
        } catch (error) {
          this.core.logger.warn(
            `view server: ${this.key} ${event.type} failed: ${errorText(error)}`
          )
        }
      }
    } finally {
      this.#draining = false
    }
  }

  async #handle(event: TargetEvent): Promise<void> {
    // 删掉的会话目标在同一个 id 再被打开时复活（记录是共享的：旧持有者还没放手时，新的订阅拿到的也是这一条）；
    // 其余终态（销毁的 agent 目标）不再变
    if (this.mode === 'gone') {
      if (event.type !== 'opened' || this.target.kind !== 'session') return
      this.#revive()
    }
    switch (event.type) {
      case 'deleted':
        this.#gone()
        return
      case 'opened': {
        if (this.mode === 'sealed') return
        if (this.mode === 'live' && this.session === event.session) return
        const projector =
          this.agent === undefined
            ? await event.session.projector()
            : await event.session.agentProjector(this.agent)
        if (this.#closed || this.#isGone()) return
        // 派生 agent 在重开的会话里不认识了：保持静态的最后一个值
        if (projector === undefined) return
        this.#install(this.#liveImpl(projector.acquire(), event.session))
        return
      }
      case 'closed': {
        if (this.mode === 'sealed') return
        if (event.reason === 'destroy') {
          if (this.target.kind === 'agent') {
            this.#gone()
            this.#unpin()
          } else {
            this.#install({ mode: 'none', value: emptySessionView(this.target.sessionId) })
          }
          return
        }
        if (this.mode !== 'live') return
        // 关了：停桥、还租约，保留最后一个值（PIN-13），前端的引用不断
        this.#syncLast()
        this.#stop()
        this.mode = 'static'
        return
      }
    }
  }

  // ─── 换装 ─────────────────────────────────────────

  /** 装上新实现：整份换值，订上新的租约，之后再还旧的 */
  #install(impl: ViewImpl): void {
    const previous = this.lease
    this.#stopBridge?.()
    this.#stopBridge = undefined
    this.mode = impl.mode
    this.lease = impl.lease
    this.session = impl.session
    const initialValue = impl.lease?.state.value ?? impl.value
    this.#setView(initialValue, [['r', initialValue as unknown as JsonValue]])
    const lease = impl.lease
    if (lease !== undefined) {
      this.#stopBridge = lease.state.subscribe((value, _ctx, delivery) => {
        if (this.#closed || this.lease !== lease || value === undefined || value === this.view) {
          return
        }
        const ops: readonly Op[] =
          delivery?.ops !== undefined && delivery.ops.length > 0
            ? delivery.ops
            : diffRevisions(this.view as unknown as JsonValue, value as unknown as JsonValue)
        this.#setView(value, ops)
      })
    }
    if (previous !== undefined && previous !== impl.lease) this.#release(previous)
  }

  /** 活投影最后的值还没桥过来（不该发生 —— 桥是同步的）：补一次 */
  #syncLast(): void {
    const value = this.lease?.state.value
    if (value !== undefined && value !== this.view) {
      const ops = diffRevisions(this.view as unknown as JsonValue, value as unknown as JsonValue)
      this.#setView(value, ops)
    }
  }

  #setView(next: SyncView, ops: readonly Op[]): void {
    this.view = next
    if (ops.length === 0) return
    for (const observer of [...this.#viewObservers]) {
      try {
        observer.advance({ kind: 'value', value: next, ops, retired: false }, BACKGROUND_CONTEXT)
      } catch (error) {
        this.core.logger.error(`view server: write failed ${this.key}: ${errorText(error)}`)
      }
    }
  }

  #setAvailability(next: ViewAvailability): void {
    if (this.availability === next) return
    this.availability = next
    const ops: readonly Op[] = [['r', next]]
    for (const observer of [...this.#availabilityObservers]) {
      try {
        observer.advance({ kind: 'value', value: next, ops, retired: false }, BACKGROUND_CONTEXT)
      } catch (error) {
        this.core.logger.error(`view server: write failed ${this.key}: ${errorText(error)}`)
      }
    }
  }

  /** 已是终态（await 之后重读，不让类型收窄挡住） */
  #isGone(): boolean {
    return this.mode === 'gone'
  }

  /** 终态：unavailable，不再变 */
  #gone(): void {
    this.#stop()
    this.mode = 'gone'
    this.#setAvailability('unavailable')
  }

  /** 复活（删掉之后同一个 id 又被打开）：重新钉住、标回 available；视图由紧接着的 `opened` 装上 */
  #revive(): void {
    this.#deleted = false
    this.mode = 'none'
    this.#pin()
    this.#setAvailability('available')
  }

  /** 停桥、还租约 */
  #stop(): void {
    this.#stopBridge?.()
    this.#stopBridge = undefined
    const lease = this.lease
    this.lease = undefined
    this.session = undefined
    this.#release(lease)
  }

  #release(lease: ViewLease<SyncView> | undefined): void {
    if (lease === undefined) return
    try {
      lease.release()
    } catch (error) {
      this.core.logger.warn(`view server: projector release failed: ${errorText(error)}`)
    }
  }

  // ─── 钉住 / 删除 / 处置 ────────────────────────────

  #pin(): void {
    if (this.#pinned || this.#closed || this.#deleted) return
    const root = this.rootSessionId
    if (root === undefined) return
    this.#pinned = true
    this.core.pins.set(root, (this.core.pins.get(root) ?? 0) + 1)
  }

  #unpin(): void {
    if (!this.#pinned) return
    this.#pinned = false
    const root = this.rootSessionId!
    const count = (this.core.pins.get(root) ?? 1) - 1
    if (count > 0) this.core.pins.set(root, count)
    else this.core.pins.delete(root)
  }

  /** 会话被删（同步）：钉住立刻松开；availability 改写交给队列 */
  markDeleted(): void {
    this.#deleted = true
    this.#unpin()
    this.push({ type: 'deleted' })
  }

  /** 关闭（最后一个引用释放 / 激活失败）：钉住、监听、租约一并放掉 */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.core.runtimes.delete(this)
    this.#unpin()
    this.#stop()
    this.#queue.length = 0
    this.#viewObservers.clear()
    this.#availabilityObservers.clear()
  }
}

interface SharedTargetLease {
  readonly runtime: TargetRuntime
  release(): void
}

/** 借用共享目标（引用计数）：同一目标多个主体共用一次 peek 与一条投影租约 */
async function acquireSharedTarget(
  core: ServerCore,
  target: SyncTarget,
  ctx: Context
): Promise<SharedTargetLease> {
  const key = syncTargetKey(target)
  let shared = core.sources.get(key)
  if (shared === undefined) {
    const runtime = new TargetRuntime(core, target)
    const controller = new AbortController()
    const entry: SharedTarget = {
      runtime,
      controller,
      refs: 0,
      ready: Promise.resolve()
    }
    const ready = runtime.open(controller.signal).catch((error: unknown) => {
      if (core.sources.get(key) === entry) core.sources.delete(key)
      runtime.close()
      throw error
    })
    // 避免共享激活失败在无人等待时触发未处理拒绝
    ready.catch(() => undefined)
    entry.ready = ready
    shared = entry
    core.sources.set(key, shared)
  }
  const owned = shared
  owned.refs += 1
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    owned.refs -= 1
    if (owned.refs === 0) {
      if (core.sources.get(key) === owned) core.sources.delete(key)
      owned.controller.abort()
      owned.runtime.close()
    }
  }
  const signal = ctx.abortSignal
  try {
    if (signal?.aborted) {
      throw new ChordError({ code: 'aborted', message: `${key} abandoned` })
    }
    if (signal === undefined) {
      await owned.ready
    } else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new ChordError({ code: 'aborted', message: `${key} abandoned` }))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        owned.ready.then(
          () => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          }
        )
      })
    }
  } catch (error) {
    release()
    throw broken(error)
  }
  return { runtime: owned.runtime, release }
}

// ─── 服务端 ─────────────────────────────────────────────

export function createViewServer(deps: ViewServerDeps): ViewServer {
  const logger = deps.logger ?? noopLogger
  const core: ServerCore = {
    deps,
    logger,
    runtimes: new Set(),
    sources: new Map(),
    pins: new Map(),
    deleted: new Set()
  }
  const host = createHost({
    address: VIEW_SERVER_ADDRESS,
    principal: HOST_PRINCIPAL,
    revokedBy: () => ['disposed'],
    ...(deps.heartbeat === undefined ? {} : { heartbeat: deps.heartbeat }),
    onError: (error) => logger.warn(`view server: ${errorText(error)}`)
  })

  /** 主体核对：同步的当场判（false / 抛错 → 直接抛 forbidden）；异步的返回 Promise 与激活并行等 */
  function startGate(principal: Principal, target: SyncTarget): Promise<boolean> | undefined {
    const authorize = deps.authorize
    if (authorize === undefined || principal === HOST_PRINCIPAL) return undefined
    const refuse = (): ChordError =>
      forbidden(`${syncTargetKey(target)} is not visible to this client`)
    let verdict: boolean | Promise<boolean>
    try {
      verdict = authorize(principal as ViewPrincipal, target)
    } catch {
      throw refuse()
    }
    if (verdict === true) return undefined
    if (verdict === false) throw refuse()
    // 异步判定：抛错也按拒绝，并吞掉裸拒绝
    return verdict.catch(() => false)
  }

  const facet = defineFacet((fHost) => {
    const serveTarget = (
      target: SyncTarget,
      principal: Principal,
      self: Parameters<Parameters<typeof fHost.serve<typeof SessionViewContract>>[1]>[2]
    ): {
      readonly view: ReturnType<typeof self.follow<unknown>>
      readonly availability: ReturnType<typeof self.follow<ViewAvailability>>
    } => {
      const authPromise = startGate(principal, target)
      // 同步允许（或免检）且会话已删：当场拒掉；异步判定时留给 open 并行等，保证不让看的客户端拿到 forbidden 而不是 not_found
      if (
        authPromise === undefined &&
        target.kind === 'session' &&
        core.deleted.has(target.sessionId)
      ) {
        throw notFoundError(`Session ${target.sessionId} was deleted`)
      }
      const refuse = (): ChordError =>
        forbidden(`${syncTargetKey(target)} is not visible to this client`)
      const targetNative = self.open(
        async (ctx) => {
          const leasePromise = acquireSharedTarget(core, target, ctx)
          if (authPromise === undefined) return leasePromise
          // 并行等认证与目标激活；一旦认证拒绝立刻放掉目标租约并报 forbidden
          const allowed = await authPromise
          if (!allowed) {
            void leasePromise.then(
              (lease) => lease.release(),
              () => undefined
            )
            throw broken(refuse())
          }
          return leasePromise
        },
        (lease) => lease.release()
      )
      const view = self.follow<unknown>(async (observer) =>
        targetNative.value.runtime.attachView(observer)
      )
      const availability = self.follow<ViewAvailability>(async (observer) =>
        targetNative.value.runtime.attachAvailability(observer)
      )
      return { view, availability }
    }

    fHost.serve(SessionViewContract, ({ sessionId }, principal, self) => {
      const members = serveTarget({ kind: 'session', sessionId }, principal, self)
      return {
        variant: 'owner',
        members: members as unknown as {
          view: typeof members.view
          availability: typeof members.availability
        }
      } as never
    })

    fHost.serve(AgentViewContract, ({ agentId }, principal, self) => {
      const members = serveTarget({ kind: 'agent', agentId }, principal, self)
      return {
        variant: 'owner',
        members: members as unknown as {
          view: typeof members.view
          availability: typeof members.availability
        }
      } as never
    })
  })

  // 同步发布（没有空参数 local 类型，load 在微任务里落定，但 #published 当场为 true）
  void host.load([{ name: 'shuvix-view-server', facet }], BACKGROUND_CONTEXT).catch((error) => {
    logger.error(`view server: load failed: ${errorText(error)}`)
  })

  const forRoot = (sessionId: string, run: (runtime: TargetRuntime) => void): void => {
    for (const runtime of [...core.runtimes]) {
      if (runtime.rootSessionId !== sessionId) continue
      try {
        run(runtime)
      } catch (error) {
        logger.error(`view server: ${runtime.key} failed: ${errorText(error)}`)
      }
    }
  }

  const unhook = [
    deps.host.onSessionOpened((session) => {
      core.deleted.delete(session.sessionId)
      forRoot(session.sessionId, (runtime) => runtime.push({ type: 'opened', session }))
    }),
    deps.host.onSessionClosed((sessionId, reason) =>
      forRoot(sessionId, (runtime) => runtime.push({ type: 'closed', reason }))
    )
  ]
  let disposed = false

  return {
    host,
    accept(link, principal) {
      if (disposed) {
        ;(link as { close(reason?: string): void }).close('view server disposed')
        return
      }
      host.accept(
        link,
        { principal: principal as Principal, codec: VIEW_LINK_CODEC },
        BACKGROUND_CONTEXT
      )
    },
    hasSubscribers: (sessionId) => (core.pins.get(sessionId) ?? 0) > 0,
    deleteSession(sessionId) {
      if (disposed) return
      core.deleted.add(sessionId)
      forRoot(sessionId, (runtime) => runtime.markDeleted())
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const stop of unhook.splice(0)) {
        try {
          stop()
        } catch (error) {
          logger.warn(`view server: unhook failed: ${errorText(error)}`)
        }
      }
      // 先撤掉所有远程主体（对端收到 gone），再关闭宿主
      host.revoke('disposed', BACKGROUND_CONTEXT)
      await host.close(BACKGROUND_CONTEXT)
    }
  }
}
