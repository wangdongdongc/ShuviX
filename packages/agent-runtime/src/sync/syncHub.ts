/**
 * SyncHub（phase 3，P3-04）—— 把会话视图（SessionView）与派生 agent 视图（AgentView）经 chord 的远程
 * 服务同步给任意多个前端（客户端）。宿主无关、浏览器安全：不碰 Electron / node，传输由宿主注入。
 *
 * 结构：
 *  - **每个目标一个 `RemoteServiceProvider`**（`{kind:'session'}` / `{kind:'agent'}`），单例服务
 *    `shuvix.chat.view`。keyed 服务的一个订阅会覆盖全部实例，等于把每条打开的会话推给每个前端，所以不用。
 *  - **每个（客户端，目标）一个 `RemoteServiceEndpoint`**，每个订阅一个 chord 状态编码器；帧是
 *    `{target, subscriptionId, update}`，经 `transport.send(clientId, frame)` 发出。
 *  - **先快照、后更新（PIN-11）**：端点在订阅调用里同步激活，回复却要晚一个微任务才交出去；这期间的
 *    更新先按订阅缓存，快照编码完、回复交出之后（下一个宏任务）再按序冲出去。前端仍须在 `activate`
 *    之前缓存帧（IPC 的回复与推送互不保序）。
 *  - **publish 从不抛（PIN-12）**：编码与发送的同步异常、异步拒绝一律记日志、客户端保留；反复失败
 *    由传输自己经 `onClientGone` 了结。这条线的另一头是投影的 `state.change`，抛出去就进了会话。
 *
 * 实现的换法（服务形状不变，前端门面一直是同一个对象）：
 *  - 订阅时：封存 → 空视图（PIN-18，之后不再换）；旧格式 → 冻结的静态视图；否则 **只 peek**（从不 open、
 *    从不 resume）—— 没有存储 → 空视图（`source:'none'`，PIN-17/24），有 → 活投影（`acquire()`）。
 *  - 会话打开（`onSessionOpened`）：空 / 静态 / 旧格式 → `replace` 成活投影。
 *  - 会话关闭（`onSessionClosed`，非 destroy，PIN-13）：活投影 → `replace` 成最后一个值的静态拷贝；
 *    运行状态停在最后投影的样子，不合成 interrupted。
 *  - 存储被销毁（`onSessionClosed(…, 'destroy')`，即 host.delete —— 清空走的也是它）：会话目标 →
 *    `replace` 成空视图（会话本身还在，下一次发送会重新建存储）；派生 agent 目标 → 撤下（对话没了）。
 *  - **会话被删除**（`deleteSession`，PIN-14）：`withdraw`（前端收到 `unavailable`），然后丢掉该目标的
 *    provider 与端点，`hasSubscribers` 立刻为 false；之后再订阅这条会话 → `service_not_found`。
 *
 * 钉住：有订阅（含订阅途中）的会话不被 LRU 回收（`hasSubscribers` 接宿主的 `isPinned`）；派生 agent
 * 目标钉住它的根会话（PIN-16）。客户端离开（`onClientGone`，PIN-21）：它的端点全部释放、订阅全部关掉、
 * 钉住随之松开；同一个 id 之后再来就是全新的客户端。慢客户端：`resync` 在**同一个** subscriptionId 上
 * 发一帧 `{type:'reset', snapshot}`（PIN-15），chord 前端自己会重新定基线。
 */
import {
  copyJson,
  createRemoteServiceEndpoint,
  createServiceStateEncoder,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  decodeServiceControlCall,
  parseServiceCall,
  RemoteServiceError,
  RemoteServiceProvider,
  replicatedState,
  type JsonValue,
  type RemoteServiceEndpoint,
  type ReplicatedState,
  type ServiceCall,
  type ServiceProviderUpdate,
  type ServiceStateEncoder,
  type ServiceSubscriptionSnapshot,
  type ServiceUpdatePublisher,
  type WireServiceProviderUpdate
} from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  CHAT_VIEW_SERVICE_ID,
  isSyncTarget,
  syncTargetKey,
  type SyncFrame,
  type SyncTarget
} from '@shuvix/chat-protocol/sync'
import {
  emptySessionView,
  type AgentView,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import type { RuntimeLogger } from '../types'
import {
  chatViewService,
  legacySessionView,
  staticViewState,
  type LegacyTranscript,
  type SyncView
} from './services'

// ─── 接缝（P3-03 / 宿主提供） ─────────────────────────────

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

/** hub 需要的会话能力（DurableSession 在 P3-03 之后满足它，或由宿主包一层） */
export interface SyncSession {
  readonly sessionId: string
  /** 根对话的 SessionProjector（同一会话共享一个实例） */
  projector(): Promise<ViewProjector<SessionView>>
  /** 某个派生 agent 的 AgentProjector；不认识 → undefined */
  agentProjector(agent: SyncAgentRef): Promise<ViewProjector<AgentView> | undefined>
}

/** 会话关闭的原因：`destroy` = 存储被删（host.delete）；其余（remove / LRU / closeAll …）= 只是关了 */
export type SyncSessionClosedReason = 'remove' | 'invalidate' | 'destroy'

/** hub 需要的会话宿主能力（SessionHost 在 P3-03 加上开 / 关钩子之后，由宿主接成这个形状） */
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

/** 发给某个客户端的一帧（`update` 是 chord 状态编码器的输出） */
export type SyncWireFrame = SyncFrame<WireServiceProviderUpdate>

/** 服务端传输：按客户端发帧，并在客户端离开时回调（IPC：webContents destroyed；Chrome：连接断开） */
export interface SyncServerTransport {
  send(clientId: string, frame: SyncWireFrame): void | Promise<void>
  /** 登记某客户端的离开回调；可返回注销函数 */
  onClientGone(clientId: string, callback: () => void): (() => void) | void
}

export interface SyncHubDeps {
  readonly host: SyncHubHost
  readonly transport: SyncServerTransport
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
  readonly logger?: RuntimeLogger
}

export interface SyncHub {
  /**
   * 客户端的一次服务调用（`$chord.service` 控制调用：catalogue / subscribe / unsubscribe，或成员调用）。
   * subscribe 的回复是编码后的快照（`WireServiceSubscriptionSnapshot`）。
   */
  invoke(clientId: string, target: unknown, call: unknown): Promise<JsonValue | undefined>
  /** 这条会话此刻有没有订阅（含订阅途中、含它派生 agent 的订阅）—— 接宿主的 `isPinned` */
  hasSubscribers(sessionId: string): boolean
  /**
   * 慢客户端重定基线（PIN-15）：在同一个 subscriptionId 上发一帧 `reset`（完整快照，编码器重置）。
   * 订阅不存在 / 快照还没交出 → false。
   */
  resync(clientId: string, subscriptionId: string): Promise<boolean>
  /** 会话本身被删除（侧栏删除，不是清空）：撤下它的全部目标，之后的订阅以 service_not_found 拒绝 */
  deleteSession(sessionId: string): void
  /** 关掉一切：每个 provider 释放（前端收到 unavailable），之后的调用一律拒绝 */
  dispose(): void
}

// ─── 内部状态 ─────────────────────────────────────────────

type EntryMode = 'init' | 'live' | 'static' | 'none' | 'legacy' | 'sealed'

/** 一次换装的内容：哪种视图、哪个状态、（活投影）租约与会话 */
interface ViewImpl {
  readonly mode: Exclude<EntryMode, 'init'>
  readonly state: ReplicatedState<SyncView>
  readonly lease?: ViewLease<SyncView>
  readonly session?: SyncSession
}

interface TargetEntry {
  readonly key: string
  readonly target: SyncTarget
  /** 会话目标 = 会话 id；agent 目标在解析之后才知道 */
  rootSessionId: string | undefined
  agent: SyncAgentRef | undefined
  readonly provider: RemoteServiceProvider
  mode: EntryMode
  lease: ViewLease<SyncView> | undefined
  session: SyncSession | undefined
  /** 每次开始一次换装就 +1；异步换装在每个 await 之后核对，过期就丢掉结果 */
  generation: number
  /** 首装途中报过打开的会话（首装算出的不是它的活投影 → 重算） */
  openedDuringInit: SyncSession | undefined
  ready: Promise<void>
  readonly records: Set<SubscriptionRecord>
  readonly endpoints: Map<string, RemoteServiceEndpoint>
  dropped: boolean
}

interface SubscriptionRecord {
  readonly clientId: string
  readonly subscriptionId: string
  readonly entry: TargetEntry
  readonly encoder: ServiceStateEncoder
  /** pending：快照还没编码（更新先缓存）；flushing：快照已交出、缓存待冲；open：直接发 */
  phase: 'pending' | 'flushing' | 'open'
  readonly pending: ServiceProviderUpdate[]
  closed: boolean
}

interface ClientState {
  readonly id: string
  readonly records: Map<string, SubscriptionRecord>
  unregisterGone: (() => void) | undefined
}

const noopLogger: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} }
const BG = BACKGROUND_CONTEXT

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notFound(message: string): RemoteServiceError {
  return new RemoteServiceError('service_not_found', message)
}

/** 目标的规范拷贝（线上来的对象可能带多余的键） */
function normalizeTarget(target: SyncTarget): SyncTarget {
  return target.kind === 'session'
    ? { kind: 'session', sessionId: target.sessionId }
    : { kind: 'agent', agentId: target.agentId }
}

/** 只用来回答目录与成员调用的探针：形状与真目标完全一样，不碰任何会话 */
function createProbeEndpoint(): RemoteServiceEndpoint {
  const provider = new RemoteServiceProvider([chatViewService])
  provider.provide(chatViewService, {
    view: replicatedState<SyncView>(emptySessionView('probe'))
  })
  return createRemoteServiceEndpoint(provider)
}

export function createSyncHub(deps: SyncHubDeps): SyncHub {
  return new SyncHubImpl(deps)
}

class SyncHubImpl implements SyncHub {
  readonly #host: SyncHubHost
  readonly #transport: SyncServerTransport
  readonly #deps: SyncHubDeps
  readonly #logger: RuntimeLogger
  readonly #entries = new Map<string, TargetEntry>()
  readonly #clients = new Map<string, ClientState>()
  /** 删掉的会话（PIN-14）：再订阅 → service_not_found；同一个 id 再被打开时撤销 */
  readonly #deleted = new Set<string>()
  readonly #unhook: (() => void)[] = []
  readonly #probe = createProbeEndpoint()
  #disposed = false

  constructor(deps: SyncHubDeps) {
    this.#deps = deps
    this.#host = deps.host
    this.#transport = deps.transport
    this.#logger = deps.logger ?? noopLogger
    this.#unhook.push(
      this.#host.onSessionOpened((session) => this.#guard('onSessionOpened', () => this.#opened(session))),
      this.#host.onSessionClosed((sessionId, reason) =>
        this.#guard('onSessionClosed', () => this.#closed(sessionId, reason))
      )
    )
  }

  // ─── 公开接口 ─────────────────────────────────────────

  async invoke(clientId: string, target: unknown, call: unknown): Promise<JsonValue | undefined> {
    this.#assertActive()
    if (typeof clientId !== 'string' || clientId.length === 0) {
      throw new TypeError('Invalid sync client id')
    }
    if (!isSyncTarget(target)) throw new TypeError('Invalid sync target')
    const parsed = parseServiceCall(call)
    const control = decodeServiceControlCall(parsed)
    if (control?.type === 'subscribe') {
      if (control.serviceId !== CHAT_VIEW_SERVICE_ID) {
        throw new RemoteServiceError(
          'service_not_allowed',
          `Remote service ${control.serviceId} is not allowlisted`
        )
      }
      if (control.mode !== 'singleton') {
        throw new RemoteServiceError(
          'service_mode_mismatch',
          `Remote service ${control.serviceId} is singleton, not ${control.mode}`
        )
      }
      return this.#subscribe(clientId, normalizeTarget(target), control.subscriptionId, parsed)
    }
    if (control?.type === 'unsubscribe') {
      this.#unsubscribe(clientId, control.subscriptionId)
      return undefined
    }
    // 目录与成员调用：服务没有方法成员，答案与目标的状态无关 —— 交给探针，得到 chord 自己的错误
    return this.#probe.invoke(parsed, () => {}, BG)
  }

  hasSubscribers(sessionId: string): boolean {
    for (const entry of this.#entries.values()) {
      if (entry.rootSessionId === sessionId && entry.records.size > 0) return true
    }
    return false
  }

  async resync(clientId: string, subscriptionId: string): Promise<boolean> {
    if (this.#disposed) return false
    const record = this.#clients.get(clientId)?.records.get(subscriptionId)
    if (record === undefined || record.closed || record.phase === 'pending') return false
    const endpoint = record.entry.endpoints.get(clientId)
    if (endpoint === undefined) return false
    // 新快照覆盖此前缓存的一切；之后的更新照常缓存，等 reset 帧发出再冲
    record.phase = 'pending'
    record.pending.length = 0
    const publish = this.#publisher(clientId)
    // 退订与重订在同一个同步段里执行（两者的函数体都在第一个 await 之前跑完）：一条更新也不丢、不重
    const unsubscribed = endpoint.invoke(createServiceUnsubscribeCall(subscriptionId), publish, BG)
    const subscribed = endpoint.invoke(
      createServiceSubscribeCall(subscriptionId, CHAT_VIEW_SERVICE_ID, 'singleton'),
      publish,
      BG
    )
    await unsubscribed.catch(() => undefined)
    let snapshot: ServiceSubscriptionSnapshot
    try {
      snapshot = (await subscribed) as unknown as ServiceSubscriptionSnapshot
    } catch (error) {
      this.#logger.warn(
        `sync hub: resync failed client=${clientId} subscription=${subscriptionId}: ${errorText(error)}`
      )
      this.#closeRecord(record)
      return false
    }
    if (record.closed) return false
    this.#send(record, { type: 'reset', snapshot })
    record.phase = 'flushing'
    this.#flush(record)
    return true
  }

  deleteSession(sessionId: string): void {
    if (this.#disposed) return
    this.#deleted.add(sessionId)
    for (const entry of [...this.#entries.values()]) {
      if (entry.rootSessionId === sessionId) this.#withdraw(entry)
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const unhook of this.#unhook.splice(0)) {
      try {
        unhook()
      } catch (error) {
        this.#logger.warn(`sync hub: unhook failed: ${errorText(error)}`)
      }
    }
    for (const entry of [...this.#entries.values()]) {
      entry.generation++
      for (const record of entry.records) {
        if (record.phase === 'flushing') this.#flush(record)
      }
      // provider 释放时对每个订阅发 unavailable（经各自的编码器发给前端）
      try {
        entry.provider.dispose()
      } catch (error) {
        this.#logger.warn(`sync hub: provider dispose failed ${entry.key}: ${errorText(error)}`)
      }
      this.#drop(entry)
    }
    for (const client of [...this.#clients.values()]) this.#forgetClient(client)
  }

  // ─── 订阅 ─────────────────────────────────────────────

  async #subscribe(
    clientId: string,
    target: SyncTarget,
    subscriptionId: string,
    call: ServiceCall
  ): Promise<JsonValue | undefined> {
    const client = this.#client(clientId)
    if (client.records.has(subscriptionId)) {
      throw new Error('Service subscription ID is already active')
    }
    if (target.kind === 'session' && this.#deleted.has(target.sessionId)) {
      throw notFound(`Session ${target.sessionId} was deleted`)
    }
    const entry = this.#entryFor(target)
    const record: SubscriptionRecord = {
      clientId,
      subscriptionId,
      entry,
      encoder: createServiceStateEncoder(),
      phase: 'pending',
      pending: [],
      closed: false
    }
    // 先登记再等：从这一刻起它就钉住会话（peek 刚打开的会话会马上被修剪检查）
    client.records.set(subscriptionId, record)
    entry.records.add(record)
    try {
      await entry.ready
    } catch (error) {
      this.#closeRecord(record)
      throw error
    }
    if (record.closed || entry.dropped) {
      this.#closeRecord(record)
      throw notFound(`Sync target ${entry.key} is no longer available`)
    }
    const endpoint = this.#endpointFor(entry, clientId)
    let snapshot: ServiceSubscriptionSnapshot
    try {
      snapshot = (await endpoint.invoke(
        call,
        this.#publisher(clientId),
        BG
      )) as unknown as ServiceSubscriptionSnapshot
    } catch (error) {
      this.#closeRecord(record)
      throw error
    }
    if (record.closed) throw notFound(`Sync target ${entry.key} is no longer available`)
    const reply = record.encoder.encodeSnapshot(snapshot)
    // 回复交出之后再冲缓存（PIN-11）：宏任务边界保证调用方先拿到回复
    record.phase = 'flushing'
    setTimeout(() => this.#flush(record), 0)
    return reply as unknown as JsonValue
  }

  #unsubscribe(clientId: string, subscriptionId: string): void {
    // 幂等：服务端已经撤掉（删除 / 客户端离开）的订阅，前端随后的退订不算错
    const record = this.#clients.get(clientId)?.records.get(subscriptionId)
    if (record !== undefined) this.#closeRecord(record)
  }

  #publisher(clientId: string): ServiceUpdatePublisher {
    return (subscriptionId, update) => this.#publish(clientId, subscriptionId, update)
  }

  /** 端点监听器同步调用它；绝不抛（PIN-12） */
  #publish(clientId: string, subscriptionId: string, update: ServiceProviderUpdate): void {
    try {
      const record = this.#clients.get(clientId)?.records.get(subscriptionId)
      if (record === undefined || record.closed) return
      if (record.phase !== 'open') {
        record.pending.push(update)
        return
      }
      this.#send(record, update)
    } catch (error) {
      this.#logger.error(`sync hub: publish failed client=${clientId}: ${errorText(error)}`)
    }
  }

  #flush(record: SubscriptionRecord): void {
    if (record.closed || record.phase !== 'flushing') return
    while (!record.closed) {
      const update = record.pending.shift()
      if (update === undefined) break
      this.#send(record, update)
    }
    record.phase = 'open'
  }

  #send(record: SubscriptionRecord, update: ServiceProviderUpdate): void {
    let encoded: WireServiceProviderUpdate
    try {
      encoded = record.encoder.encodeUpdate(update)
    } catch (error) {
      this.#logger.error(
        `sync hub: encode failed client=${record.clientId} subscription=${record.subscriptionId}: ${errorText(error)}`
      )
      return
    }
    const frame: SyncWireFrame = {
      target: record.entry.target,
      subscriptionId: record.subscriptionId,
      update: encoded
    }
    try {
      const result = this.#transport.send(record.clientId, frame)
      if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
        ;(result as Promise<void>).then(undefined, (error: unknown) =>
          this.#logger.error(`sync hub: send failed client=${record.clientId}: ${errorText(error)}`)
        )
      }
    } catch (error) {
      this.#logger.error(`sync hub: send failed client=${record.clientId}: ${errorText(error)}`)
    }
  }

  #closeRecord(record: SubscriptionRecord): void {
    if (record.closed) return
    record.closed = true
    record.pending.length = 0
    const client = this.#clients.get(record.clientId)
    if (client?.records.get(record.subscriptionId) === record) {
      client.records.delete(record.subscriptionId)
    }
    const entry = record.entry
    entry.records.delete(record)
    const endpoint = entry.endpoints.get(record.clientId)
    if (endpoint !== undefined) {
      const stillUsed = [...entry.records].some((other) => other.clientId === record.clientId)
      if (stillUsed) {
        void endpoint
          .invoke(createServiceUnsubscribeCall(record.subscriptionId), () => {}, BG)
          .catch(() => undefined)
      } else {
        entry.endpoints.delete(record.clientId)
        endpoint.dispose()
      }
    }
    if (entry.records.size === 0) this.#drop(entry)
  }

  // ─── 客户端 ───────────────────────────────────────────

  #client(clientId: string): ClientState {
    let client = this.#clients.get(clientId)
    if (client !== undefined) return client
    const created: ClientState = { id: clientId, records: new Map(), unregisterGone: undefined }
    client = created
    this.#clients.set(clientId, created)
    try {
      const unregister = this.#transport.onClientGone(clientId, () =>
        this.#guard('onClientGone', () => this.#clientGone(created))
      )
      if (typeof unregister === 'function') created.unregisterGone = unregister
    } catch (error) {
      this.#logger.warn(`sync hub: onClientGone failed client=${clientId}: ${errorText(error)}`)
    }
    return client
  }

  /** 客户端离开（PIN-21）：它的订阅全部关掉、端点全部释放、钉住松开；状态不留墓碑 */
  #clientGone(client: ClientState): void {
    if (this.#clients.get(client.id) !== client) return
    this.#forgetClient(client)
  }

  #forgetClient(client: ClientState): void {
    if (this.#clients.get(client.id) === client) this.#clients.delete(client.id)
    const unregister = client.unregisterGone
    client.unregisterGone = undefined
    try {
      unregister?.()
    } catch (error) {
      this.#logger.warn(`sync hub: onClientGone unregister failed: ${errorText(error)}`)
    }
    for (const record of [...client.records.values()]) this.#closeRecord(record)
  }

  // ─── 目标 ─────────────────────────────────────────────

  #entryFor(target: SyncTarget): TargetEntry {
    const key = syncTargetKey(target)
    const existing = this.#entries.get(key)
    if (existing !== undefined && !existing.dropped) return existing
    const entry: TargetEntry = {
      key,
      target,
      rootSessionId: target.kind === 'session' ? target.sessionId : undefined,
      agent: undefined,
      provider: new RemoteServiceProvider([chatViewService]),
      mode: 'init',
      lease: undefined,
      session: undefined,
      generation: 0,
      openedDuringInit: undefined,
      ready: Promise.resolve(),
      records: new Set(),
      endpoints: new Map(),
      dropped: false
    }
    this.#entries.set(key, entry)
    entry.ready = this.#init(entry)
    // 等它的总是至少一个订阅；这里只防「订阅先被关掉、没人等了」时的未处理拒绝
    entry.ready.catch(() => undefined)
    return entry
  }

  #endpointFor(entry: TargetEntry, clientId: string): RemoteServiceEndpoint {
    let endpoint = entry.endpoints.get(clientId)
    if (endpoint === undefined) {
      endpoint = createRemoteServiceEndpoint(entry.provider)
      entry.endpoints.set(clientId, endpoint)
    }
    return endpoint
  }

  /** 首次装上实现；途中有开 / 关钩子（generation 变了）就丢掉结果重算 */
  async #init(entry: TargetEntry): Promise<void> {
    try {
      for (;;) {
        const generation = entry.generation
        entry.openedDuringInit = undefined
        const impl = await this.#compute(entry)
        if (entry.dropped) {
          this.#release(impl.lease)
          throw notFound(`Sync target ${entry.key} is no longer available`)
        }
        // 途中有关闭（generation 变了），或报打开的会话不是算出来的那个（peek 早于它的存储出生）→ 重算。
        // hub 自己的 peek 打开会话时钩子也会报，那时算出的正是它，不必重算
        const opened = entry.openedDuringInit
        entry.openedDuringInit = undefined
        if (
          generation === entry.generation &&
          (opened === undefined || opened === impl.session)
        ) {
          this.#install(entry, impl, 'provide')
          return
        }
        this.#release(impl.lease)
      }
    } catch (error) {
      // 失败的目标不缓存：下一次订阅重试（等它的订阅各自收尾）
      this.#drop(entry)
      throw error
    }
  }

  async #compute(entry: TargetEntry): Promise<ViewImpl> {
    const target = entry.target
    if (target.kind === 'session') {
      const sessionId = target.sessionId
      // 封存（退出路径上）：什么都不打开，给一份不会再换的空视图（PIN-18）
      if (this.#host.sealed) return this.#noneImpl(sessionId, 'sealed')
      const legacy = await this.#deps.legacyView?.(sessionId)
      if (legacy !== undefined && legacy !== null) {
        return { mode: 'legacy', state: staticViewState(legacySessionView(sessionId, legacy)) }
      }
      const session = await this.#host.peek(sessionId)
      if (session === undefined) {
        return this.#noneImpl(sessionId, this.#host.sealed ? 'sealed' : 'none')
      }
      return this.#liveImpl((await session.projector()).acquire(), session)
    }
    const agentId = target.agentId
    const resolved = await this.#deps.resolveAgent?.(agentId)
    if (resolved === undefined) throw notFound(`Unknown agent ${agentId}`)
    entry.rootSessionId = resolved.sessionId
    entry.agent = { agentId, conversationId: resolved.conversationId }
    if (this.#deleted.has(resolved.sessionId)) {
      throw notFound(`Session ${resolved.sessionId} was deleted`)
    }
    const session = await this.#host.peek(resolved.sessionId)
    if (session === undefined) throw notFound(`Agent ${agentId}: session is not available`)
    const projector = await session.agentProjector(entry.agent)
    if (projector === undefined) throw notFound(`Unknown agent ${agentId}`)
    return this.#liveImpl(projector.acquire(), session)
  }

  #liveImpl(acquired: ViewLease<SessionView> | ViewLease<AgentView>, session: SyncSession): ViewImpl {
    const lease = acquired as unknown as ViewLease<SyncView>
    return { mode: 'live', state: lease.state, lease, session }
  }

  #noneImpl(sessionId: string, mode: 'none' | 'sealed'): ViewImpl {
    return { mode, state: staticViewState(emptySessionView(sessionId)) }
  }

  /** 装上新实现（provide 首装 / replace 换装）；旧租约在 provider 摘掉它的监听之后再释放 */
  #install(entry: TargetEntry, impl: ViewImpl, how: 'provide' | 'replace'): void {
    const previous = entry.lease
    entry.mode = impl.mode
    entry.lease = impl.lease
    entry.session = impl.session
    try {
      if (how === 'provide') entry.provider.provide(chatViewService, { view: impl.state })
      else entry.provider.replace(chatViewService, { view: impl.state })
    } catch (error) {
      this.#logger.error(`sync hub: ${how} failed ${entry.key}: ${errorText(error)}`)
    }
    if (previous !== impl.lease) this.#release(previous)
  }

  #release(lease: ViewLease<SyncView> | undefined): void {
    if (lease === undefined) return
    try {
      lease.release()
    } catch (error) {
      this.#logger.warn(`sync hub: projector release failed: ${errorText(error)}`)
    }
  }

  /** 撤下（PIN-14）：withdraw 发 unavailable，然后丢掉 provider 与端点 */
  #withdraw(entry: TargetEntry): void {
    entry.generation++
    for (const record of entry.records) {
      if (record.phase === 'flushing') this.#flush(record)
    }
    if (entry.mode !== 'init') {
      try {
        entry.provider.withdraw(chatViewService)
      } catch (error) {
        this.#logger.warn(`sync hub: withdraw failed ${entry.key}: ${errorText(error)}`)
      }
    }
    for (const record of [...entry.records]) {
      record.closed = true
      record.pending.length = 0
      const client = this.#clients.get(record.clientId)
      if (client?.records.get(record.subscriptionId) === record) {
        client.records.delete(record.subscriptionId)
      }
    }
    entry.records.clear()
    this.#drop(entry)
  }

  /** 丢掉一个目标：端点、provider、租约全部释放 */
  #drop(entry: TargetEntry): void {
    if (entry.dropped) return
    entry.dropped = true
    entry.generation++
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key)
    for (const endpoint of entry.endpoints.values()) endpoint.dispose()
    entry.endpoints.clear()
    try {
      entry.provider.dispose()
    } catch (error) {
      this.#logger.warn(`sync hub: provider dispose failed ${entry.key}: ${errorText(error)}`)
    }
    const lease = entry.lease
    entry.lease = undefined
    entry.session = undefined
    this.#release(lease)
  }

  // ─── 宿主钩子 ─────────────────────────────────────────

  #opened(session: SyncSession): void {
    if (this.#disposed) return
    this.#deleted.delete(session.sessionId)
    for (const entry of [...this.#entries.values()]) {
      if (entry.rootSessionId !== session.sessionId || entry.dropped) continue
      if (entry.mode === 'init') {
        entry.openedDuringInit = session
        continue
      }
      if (entry.mode === 'sealed') continue
      if (entry.mode === 'live' && entry.session === session) continue
      void this.#goLive(entry, session)
    }
  }

  async #goLive(entry: TargetEntry, session: SyncSession): Promise<void> {
    const generation = ++entry.generation
    try {
      const projector =
        entry.agent === undefined
          ? await session.projector()
          : await session.agentProjector(entry.agent)
      if (entry.dropped || generation !== entry.generation) return
      // 派生 agent 在重开的会话里不认识了：保持静态的最后一个值
      if (projector === undefined) return
      this.#install(entry, this.#liveImpl(projector.acquire(), session), 'replace')
    } catch (error) {
      this.#logger.warn(`sync hub: going live failed ${entry.key}: ${errorText(error)}`)
    }
  }

  #closed(sessionId: string, reason: SyncSessionClosedReason): void {
    if (this.#disposed) return
    for (const entry of [...this.#entries.values()]) {
      if (entry.rootSessionId !== sessionId || entry.dropped) continue
      if (entry.mode === 'init') {
        entry.generation++
        continue
      }
      if (entry.mode === 'sealed') continue
      if (reason === 'destroy') {
        if (entry.target.kind === 'agent') {
          this.#withdraw(entry)
        } else {
          entry.generation++
          this.#install(entry, this.#noneImpl(sessionId, 'none'), 'replace')
        }
        continue
      }
      entry.generation++
      if (entry.mode !== 'live') continue
      // 关了：换成最后一个值的静态拷贝（PIN-13），前端门面不断
      const last = entry.lease?.state.value
      const impl: ViewImpl =
        last === undefined
          ? this.#noneImpl(sessionId, 'none')
          : { mode: 'static', state: staticViewState(copyLast(last)) }
      this.#install(entry, impl, 'replace')
    }
  }

  // ─── 杂项 ─────────────────────────────────────────────

  #guard(label: string, run: () => void): void {
    try {
      run()
    } catch (error) {
      this.#logger.error(`sync hub: ${label} failed: ${errorText(error)}`)
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Sync hub is disposed')
  }
}

/** 投影状态的值是不可变的，但仍拷一份：静态视图不和已释放的投影器共享容器 */
function copyLast(value: SyncView): SyncView {
  return copyJson(value as unknown as JsonValue, {
    omitUndefinedProperties: true
  }) as unknown as SyncView
}
