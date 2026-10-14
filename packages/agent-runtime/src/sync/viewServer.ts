/**
 * 视图服务端（pi 1.2 / chord2；替换了 phase 3 基于 `RemoteServiceProvider` 的 SyncHub）—— 把会话视图
 * （SessionView）与派生 agent 视图（AgentView）同步给任意多个前端。宿主无关：不碰 Electron / node，链路由
 * 宿主交进来（`accept(link, principal)`）。
 *
 * 结构（一个 chord2 宿主 `main`）：
 *  - **远程类型** `shuvix.session-view` / `shuvix.agent-view`（契约见 `viewContracts.ts`）：每个（输入，主体）一条
 *    记录，工厂很薄 —— 核对主体（`authorize`，不通过 → `forbidden`），然后 `self.get` 共享的 `ViewSource`，把它的
 *    两个状态成员原样交出去。自己没有状态。
 *  - **本地类型** `shuvix.view-source`：**每个目标一条共享记录**（以宿主主体持有）。两个 cell：`view` 与
 *    `availability`。资源 `target` 在激活时解析目标（agent → 根会话，`resolveAgent`）、**先登记钉住、再 peek**
 *    （PIN：peek 刚打开的会话会马上被修剪检查）、算出第一份实现；任务 `lifecycle` 在记录 live 之前把它写进
 *    cell（于是第一份快照就是真的视图，不是空视图），之后一个顺序循环处理该根会话的开 / 关 / 删事件。
 *
 * 实现的换法（远程成员一直是同一个 cell，前端的句柄不断）：
 *  - 激活时：封存 → 空视图（PIN-18，之后不再换）；旧格式 → 冻结的静态视图；否则**只 peek**（从不 open、
 *    从不 resume）—— 没有存储 → 空视图（`source:'none'`，PIN-17/24），有 → 活投影（`acquire()`）。
 *  - 活投影的每个修订经 `cell.replace(ctx, v, { diff: true })` 桥进 cell（`diff: true` 必须：不加的话 chord 只看
 *    一层，每个修订都整份发）。换实现 = 停掉旧的桥、`replace` 成新的当前值（整份）、订上新的之后再还旧租约。
 *  - 会话打开（`onSessionOpened`）：空 / 静态 / 旧格式 → 活投影。
 *  - 会话关闭（非 destroy，PIN-13）：停桥、还租约；cell 里留着最后一个值（它本就是不可变的修订，不必再拷）。
 *    运行状态停在最后投影的样子，不合成 interrupted。
 *  - 存储被销毁（`destroy`，即 host.delete —— 清空走的也是它）：会话目标 → 空视图（会话还在）；派生 agent
 *    目标 → `availability = 'unavailable'`（对话没了），之后不再变。
 *  - **会话被删除**（`deleteSession`，PIN-14）：它的每个目标 `availability = 'unavailable'`、立刻松开钉住；之后
 *    再 get 这条会话 → 「找不到」（`unavailable` + reason `not_found`），直到同一个 id 再被打开。
 *
 * 钉住：有目标记录（含激活途中）的会话不被 LRU 回收（`hasSubscribers` 接宿主的 `isPinned`）；派生 agent 目标
 * 钉住它的根会话（PIN-16）。前端离开（链路断开 / 页面重载）= chord 释放经那条链路的全部持有 → 记录处置 →
 * 钉住松开（PIN-21）。
 */
import {
  ChordError,
  cell,
  createHost,
  forbidden,
  hostPrincipal,
  local,
  resource,
  type BehaviorOf,
  type Cell,
  type Ctx,
  type Host,
  type Link,
  type LinkOptions,
  type Principal,
  type ReplicatedState,
  type Self
} from '@earendil-works/chord'
import { Type } from 'typebox'
import { syncTargetKey, type SyncTarget } from '@shuvix/chat-protocol/sync'
import {
  emptySessionView,
  type AgentView,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import type { RuntimeLogger } from '../types'
import { legacySessionView, type LegacyTranscript, type SyncView } from './services'
import {
  AgentViewContract,
  AvailabilitySchema,
  notFoundError,
  SessionViewContract,
  VIEW_SERVER_HOST,
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
   * 异步的判定与目标的激活并行进行：不通过时记录失败，视图一帧都不会发给这个主体。
   */
  readonly authorize?: (principal: ViewPrincipal, target: SyncTarget) => boolean | Promise<boolean>
  readonly logger?: RuntimeLogger
  /** 接受的链路的 ping 选项（缺省 chord 的 15s / 45s；测试调小） */
  readonly linkOptions?: LinkOptions
}

export interface ViewServer {
  /** chord 宿主（名字 `main`）—— 进程内也可以直接 `get` 契约（测试） */
  readonly host: Host
  /** 接受一条前端的链路（主体由调用方盖章） */
  accept(link: Link, principal: ViewPrincipal): void
  /** 这条会话此刻有没有人看着（含激活途中、含它派生 agent 的目标）—— 接宿主的 `isPinned` */
  hasSubscribers(sessionId: string): boolean
  /** 会话本身被删除（侧栏删除，不是清空）：它的目标全部 unavailable，之后再 get → 找不到 */
  deleteSession(sessionId: string): void
  /** 关掉一切（记录强制处置 → 前端的句柄 gone，链路关掉） */
  dispose(): Promise<void>
}

// ─── 内部 ─────────────────────────────────────────────

/** 每个目标一条共享记录（宿主主体） */
const ViewSourceContract = local('shuvix.view-source', {
  version: 1,
  input: Type.Object({
    kind: Type.Union([Type.Literal('session'), Type.Literal('agent')]),
    id: Type.String({ minLength: 1 })
  }),
  members: { view: Type.Unknown(), availability: AvailabilitySchema }
})

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

interface SourceCells {
  readonly view: Cell<unknown>
  readonly availability: Cell<ViewAvailability>
}

/** 激活时最多重算几次（途中有开 / 关事件就丢掉结果重算；再多就照收、交给循环处理） */
const MAX_INIT_ATTEMPTS = 5

const noopLogger: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** 服务端各目标共用的那一点 */
interface ServerCore {
  readonly deps: ViewServerDeps
  readonly logger: RuntimeLogger
  readonly runtimes: Set<TargetRuntime>
  /** 根会话 → 钉住它的目标数 */
  readonly pins: Map<string, number>
  /** 删掉的会话（PIN-14）：再 get → 找不到；同一个 id 再被打开时撤销 */
  readonly deleted: Set<string>
}

/** 一个目标（`ViewSource` 记录的资源值）：解析、钉住、实现、事件循环 */
class TargetRuntime {
  readonly key: string
  rootSessionId: string | undefined
  agent: SyncAgentRef | undefined
  mode: Mode | 'init' = 'init'
  lease: ViewLease<SyncView> | undefined
  session: SyncSession | undefined
  /** 激活算出的第一份实现，`run` 装上 */
  #initial: ViewImpl | undefined
  #queue: TargetEvent[] = []
  #wake: (() => void) | undefined
  #pinned = false
  /** 删掉了（标记同步落下：钉住立刻松开，激活途中则失败） */
  #deleted = false
  #closed = false
  #stopBridge: (() => void) | undefined
  #ctx: Ctx | undefined

  constructor(
    private readonly core: ServerCore,
    readonly target: SyncTarget,
    private readonly cells: SourceCells
  ) {
    this.key = syncTargetKey(target)
  }

  // ─── 激活（资源 open） ─────────────────────────────

  async open(signal: AbortSignal): Promise<void> {
    this.core.runtimes.add(this)
    const target = this.target
    if (target.kind === 'session') {
      this.rootSessionId = target.sessionId
      // 工厂核对过之后、资源打开之前也可能被删：这里再核对一次（与 agent 目标一样）
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
        throw new ChordError('aborted', `${this.key} abandoned`)
      }
      // 途中有开 / 关（generation 变了），或报打开的会话不是算出来的那个（peek 早于它的存储出生）→ 重算。
      // 自己的 peek 打开会话时钩子也会报，那时算出的正是它，不必重算
      const relevant = this.#queue.filter(
        (event) => !(event.type === 'opened' && event.session === impl.session)
      )
      if (relevant.length === 0 || attempt >= MAX_INIT_ATTEMPTS) {
        this.#queue = relevant
        this.#initial = impl
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

  // ─── 生命周期（任务） ──────────────────────────────

  /**
   * 记录的任务：同步装上第一份实现（记录 live 之前，所以第一份快照就是它），之后顺序处理事件，直到记录被处置
   */
  async run(ctx: Ctx): Promise<void> {
    this.#ctx = ctx
    try {
      const initial = this.#initial
      this.#initial = undefined
      if (initial !== undefined) this.#install(initial)
      while (!ctx.signal.aborted && !this.#closed) {
        const event = this.#queue.shift()
        if (event === undefined) {
          await this.#nextEvent(ctx.signal)
          continue
        }
        try {
          await this.#handle(event, ctx)
        } catch (error) {
          this.core.logger.warn(
            `view server: ${this.key} ${event.type} failed: ${errorText(error)}`
          )
        }
      }
    } finally {
      this.#stop()
      this.#ctx = undefined
    }
  }

  #nextEvent(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.#wake = undefined
        signal.removeEventListener('abort', done)
        resolve()
      }
      this.#wake = done
      signal.addEventListener('abort', done, { once: true })
    })
  }

  push(event: TargetEvent): void {
    if (this.#closed) return
    this.#queue.push(event)
    this.#wake?.()
  }

  async #handle(event: TargetEvent, ctx: Ctx): Promise<void> {
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
        // 等的途中被处置 / 删掉了：不再去借租约
        if (ctx.signal.aborted || this.#closed || this.#isGone()) return
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
        // 关了：停桥、还租约，cell 里留着最后一个值（PIN-13），前端的句柄不断
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
    this.#write((ctx) => this.cells.view.replace(ctx, impl.value))
    const lease = impl.lease
    if (lease !== undefined) {
      this.#stopBridge = lease.state.subscribe((value) => {
        if (this.lease !== lease || value === undefined || value === this.cells.view.value) return
        this.#write((ctx) => this.cells.view.replace(ctx, value, { diff: true }))
      })
    }
    if (previous !== undefined && previous !== impl.lease) this.#release(previous)
  }

  /** 活投影最后的值还没桥过来（不该发生 —— 桥是同步的）：补一次 */
  #syncLast(): void {
    const value = this.lease?.state.value
    if (value !== undefined && value !== this.cells.view.value) {
      this.#write((ctx) => this.cells.view.replace(ctx, value, { diff: true }))
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
    this.#write((ctx) => this.cells.availability.replace(ctx, 'unavailable'))
  }

  /** 复活（删掉之后同一个 id 又被打开）：重新钉住、标回 available；视图由紧接着的 `opened` 装上 */
  #revive(): void {
    this.#deleted = false
    this.mode = 'none'
    this.#pin()
    this.#write((ctx) => this.cells.availability.replace(ctx, 'available'))
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

  #write(run: (ctx: Ctx) => void): void {
    const ctx = this.#ctx
    if (ctx === undefined || ctx.signal.aborted) return
    try {
      run(ctx)
    } catch (error) {
      this.core.logger.error(`view server: write failed ${this.key}: ${errorText(error)}`)
    }
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

  /** 会话被删（同步）：钉住立刻松开；cell 的改写交给循环 */
  markDeleted(): void {
    this.#deleted = true
    this.#unpin()
    this.push({ type: 'deleted' })
  }

  /** 资源关闭（记录处置）/ 激活失败：钉住、监听、租约一并放掉 */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.core.runtimes.delete(this)
    this.#unpin()
    this.#stop()
    this.#queue.length = 0
    this.#wake?.()
    const initial = this.#initial
    this.#initial = undefined
    this.#release(initial?.lease)
  }
}

// ─── 服务端 ─────────────────────────────────────────────

export function createViewServer(deps: ViewServerDeps): ViewServer {
  const logger = deps.logger ?? noopLogger
  const core: ServerCore = {
    deps,
    logger,
    runtimes: new Set(),
    pins: new Map(),
    deleted: new Set()
  }
  const host = createHost({
    name: VIEW_SERVER_HOST,
    onError: (error) => logger.warn(`view server: ${errorText(error)}`)
  })

  /** 主体核对：同步的当场判；异步的作为一个资源与激活并行等（不通过 → 记录失败） */
  function gate(principal: Principal, target: SyncTarget, self: Self): void {
    const authorize = deps.authorize
    if (authorize === undefined || principal === hostPrincipal) return
    const refuse = (): ChordError =>
      forbidden(`${syncTargetKey(target)} is not visible to this client`)
    let verdict: boolean | Promise<boolean>
    try {
      verdict = authorize(principal as ViewPrincipal, target)
    } catch {
      // 判定本身抛错也按不让看（与异步判定拒绝同一个口径）
      throw refuse()
    }
    if (verdict === true) return
    if (verdict === false) throw refuse()
    verdict.catch(() => undefined)
    self.resources({
      grant: resource({
        rev: 1,
        open: async () => {
          // 判定本身抛错 / 拒绝也按不让看（不把底下的错误透给客户端）
          const allowed = await verdict.catch(() => false)
          if (!allowed) throw refuse()
          return true
        }
      })
    })
  }

  host.serve(ViewSourceContract, ({ kind, id }, _principal, self) => {
    const target: SyncTarget =
      kind === 'session' ? { kind, sessionId: id } : { kind: 'agent', agentId: id }
    const initial: SyncView = kind === 'session' ? emptySessionView(id) : emptyAgentView(id)
    const cells = self.state({
      view: cell(Type.Unknown(), initial as unknown),
      availability: cell(AvailabilitySchema, 'available' as ViewAvailability)
    })
    const res = self.resources({
      target: resource({
        rev: 1,
        open: async ({ signal }) => {
          const runtime = new TargetRuntime(core, target, cells)
          try {
            await runtime.open(signal)
          } catch (error) {
            runtime.close()
            throw error
          }
          return runtime
        },
        close: (runtime) => runtime.close()
      })
    })
    self.tasks({ lifecycle: (ctx) => res.target.value.run(ctx) })
    return { view: cells.view, availability: cells.availability }
  })

  host.serve(SessionViewContract, ({ sessionId }, principal, self) => {
    const target: SyncTarget = { kind: 'session', sessionId }
    // 先核对主体再说删没删：不让看的客户端分不出「删了」与「不归你」
    gate(principal, target, self)
    if (core.deleted.has(sessionId)) throw notFoundError(`Session ${sessionId} was deleted`)
    const source = self.get(ViewSourceContract, { kind: 'session', id: sessionId })
    // 视图成员是 ViewSource 的状态成员（类型上与松 schema 对不上，只在这里断言）
    return {
      kind: 'owner',
      view: source.view,
      availability: source.availability
    } as unknown as BehaviorOf<typeof SessionViewContract>
  })

  host.serve(AgentViewContract, ({ agentId }, principal, self) => {
    const target: SyncTarget = { kind: 'agent', agentId }
    gate(principal, target, self)
    const source = self.get(ViewSourceContract, { kind: 'agent', id: agentId })
    return {
      kind: 'owner',
      view: source.view,
      availability: source.availability
    } as unknown as BehaviorOf<typeof AgentViewContract>
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
        link.close('view server disposed')
        return
      }
      host.accept(link, { ...deps.linkOptions, principal, kind: 'client' })
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
      await host.close()
    }
  }
}
