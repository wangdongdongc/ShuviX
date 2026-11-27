/**
 * 视图同步的前端客户端（Chord 1.6.1 / v2；公开接口不变）—— 在渠道的链路（`SessionChannelApi.sync`，一个
 * {@link SyncLinkChannel}）上跑一个 chord v2 **客户端宿主**，每个**目标**（一条会话 / 一个派生 agent）一个
 * chord 持有引用（`shuvix.session-view` / `shuvix.agent-view`，契约在 agent-runtime 的 `sync/viewContracts`），
 * 交出那份视图的完整值。
 *
 *  - **状态**：引用 `loading` → `loading`；`live` 且 `availability === 'available'` → `live`；
 *    `availability === 'unavailable'` → `unavailable`（值清空）；第一次就没活成（`failed` / `ended`）→ `error` + 码
 *    （chord 的码；「找不到」映射成 chat-protocol 的 `SYNC_NOT_FOUND`），**不重试**；活过之后被强制拿走（`ended`）
 *    → `unavailable`。
 *  - **永不交出过时的值**：链路断开重连时引用回到 `loading`、值清空；重新持有之后服务端的快照到了才再交值。
 *  - **链路**：每条链路一个新 id（`<idPrefix>.<序号>`），帧带着它走 —— 旧链路迟到的帧落不进新链路。链路不是
 *    客户端自己关的（服务端关了、传输断了、心跳超时）→ 立刻换一条新链路（chord 的引用在新链路上自动重新持有），
 *    新链路先攒着帧，等退避时间到、传输 up 了再发（于是新的 hold 永远有上游）。
 *  - `resetAll()`：现在就换一条新链路（旧的发 `bye`，服务端随之放掉它的持有）。
 *
 * 目标按引用计数共享（同一目标的多个使用方共用一个引用）；最后一个使用方离开才放手（`release`）。
 *
 * 浏览器安全：只引 chord 根入口 / `/context`、agent-runtime 的 `sync/viewContracts`、chat-protocol
 * （守护用例 `__tests__/browserSafe.test.ts`）。
 */
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context'
import {
  AgentViewContract,
  createHost,
  FrameLink,
  isChordError,
  isNotFoundError,
  SessionViewContract,
  VIEW_LINK_CODEC,
  type Frame,
  type Held,
  type Host,
  type HostError,
  type RefState,
  type ViewAvailability
} from '@shuvix/agent-runtime/sync/viewContracts'
import {
  SYNC_NOT_FOUND,
  syncTargetKey,
  type JsonValue,
  type SyncLinkChannel,
  type SyncTarget
} from '@shuvix/chat-protocol/sync'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

/** 一个目标的绑定此刻的状态 */
export type ViewBindingStatus = 'loading' | 'live' | 'unavailable' | 'error'

export interface ViewBindingState {
  readonly status: ViewBindingStatus
  /** `error` 时服务端给的错误码（`not_found` / `forbidden` …）；没有码 → undefined */
  readonly code?: string
}

/** 交给使用方的一次变化：一份完整的新值（快照 / 更新），或状态变了 */
export type ViewEvent<V> =
  | { readonly kind: 'value'; readonly value: V; readonly delivery: 'hydrate' | 'update' }
  | { readonly kind: 'status'; readonly state: ViewBindingState }

/** 一个使用方对一个目标的持有 */
export interface ViewSubscription<V> {
  readonly target: SyncTarget
  /** 此刻的状态 */
  state(): ViewBindingState
  /** 此刻的值（还没到 / 不可用 → undefined） */
  value(): V | undefined
  /** 订阅变化（不补发已有的值 —— 先读 `value()`）；返回退订 */
  subscribe(listener: (event: ViewEvent<V>) => void): () => void
  /** 放手（幂等）；最后一个使用方放手时放掉引用 —— 那一次返回 true */
  release(): boolean
}

export interface SyncClientLogger {
  warn(message: string): void
}

export interface SyncClientOptions {
  readonly channel: SyncLinkChannel
  readonly logger?: SyncClientLogger
  /**
   * 链路 id 的前缀：同一条渠道上的几个客户端（Chrome 一条连接上的几个侧边栏、e2e 探针）各给一个，链路 id
   * 就不会撞。缺省 = 每个客户端一个随机前缀
   */
  readonly idPrefix?: string
  /** 非自愿断开之后第一次重连等多久（毫秒，之后翻倍，上限 5 秒）；缺省 250 */
  readonly reconnectDelayMs?: number
}

export interface SyncClient {
  /** 持有一个目标（引用计数）：第一次持有时建引用 */
  acquire<V extends SessionView | AgentView>(target: SyncTarget): ViewSubscription<V>
  /**
   * 现在就换一条新链路（连接重来过、服务端换了一个进程，PIN-10）：每个引用在新链路上重新持有、拿一份新快照；
   * 期间状态回到 loading
   */
  resetAll(): void
  /** 丢掉一切（放掉每个引用、关掉链路与客户端宿主） */
  dispose(): void
}

type ViewHandle = Held<typeof SessionViewContract> | Held<typeof AgentViewContract>

interface TargetBinding {
  readonly key: string
  readonly target: SyncTarget
  refs: number
  readonly listeners: Set<(event: ViewEvent<SessionView | AgentView>) => void>
  state: ViewBindingState
  /** 交给使用方的值（只在可用且快照到了之后才有） */
  value: SessionView | AgentView | undefined
  readonly handle: ViewHandle
  readonly cancelWatches: () => void
  /** 当前引用是否处于 live */
  refLive: boolean
  /** 这一次持有里服务端的视图值（快照到了才有） */
  view: SessionView | AgentView | undefined
  /** 这一次持有里服务端的可用性（快照到了才有） */
  availability: ViewAvailability | undefined
  /** 引用活过（之后的 ended / failed = 被拿走，不是订阅失败） */
  everLive: boolean
  disposed: boolean
}

const SERVER_PRINCIPAL = { kind: 'server' } as const

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

/** chord 错误 → 绑定的码：「找不到」映射成 `SYNC_NOT_FOUND`，其余用 chord 的码 */
function codeOf(error: unknown): string | undefined {
  if (isNotFoundError(error)) return SYNC_NOT_FOUND
  if (isChordError(error)) return error.code
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

const LOADING: ViewBindingState = { status: 'loading' }
const LIVE: ViewBindingState = { status: 'live' }
const UNAVAILABLE: ViewBindingState = { status: 'unavailable' }

const MAX_RECONNECT_DELAY_MS = 5_000

/** chord 的 `bye` 帧（链路被对端关掉） */
function isByeFrame(frame: unknown): boolean {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    !Array.isArray(frame) &&
    (frame as { t?: unknown }).t === 'bye'
  )
}

/**
 * 渠道上的一条链路：发帧前先攒着（等到退避时间到、传输 up），收帧只认自己的 id，传输 down 即结束
 */
class ChannelLink extends FrameLink {
  /** 客户端自己换掉它（resetAll / dispose）：结束时不触发重连 */
  intended = false

  constructor(channel: SyncLinkChannel, id: string, delayMs: number, onFirstFrame: () => void) {
    let outbox: Frame[] | undefined = []
    let waiting = delayMs > 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const stops: (() => void)[] = []
    /** 构造完才接上（`super` 之前不能碰 `this`）：flush 发帧时传输抛错 → 结束这条链路 */
    const onTransportError: { end?: () => void } = {}
    const flush = (): void => {
      if (outbox === undefined || waiting || channel.isUp?.() === false) return
      const pending = outbox
      outbox = undefined
      try {
        for (const frame of pending) channel.send(id, frame as unknown as JsonValue)
      } catch {
        // 与 FrameLink.send 一样：传输抛错 = 传输断了（不从退避定时器 / onUp 回调里漏出去）
        onTransportError.end?.()
      }
    }
    super(
      (frame) => {
        if (outbox !== undefined) outbox.push(frame)
        else channel.send(id, frame as unknown as JsonValue)
      },
      () => {
        outbox = undefined
        if (timer !== undefined) clearTimeout(timer)
        for (const stop of stops.splice(0)) stop()
      }
    )
    onTransportError.end = () => this.ended('transport error')
    let first = true
    stops.push(
      channel.onFrame((link, frame) => {
        if (link !== id) return
        // 退避只在服务端真的应答了才复位：一个 `bye`（服务端拒收 / 已关停）不算，不然被拒的链路每 250ms 重连一次
        if (first && !isByeFrame(frame)) {
          first = false
          onFirstFrame()
        }
        this.deliver(frame)
      })
    )
    if (channel.onDown)
      stops.push(channel.onDown((reason) => this.ended(`transport down: ${reason}`)))
    if (channel.onUp) stops.push(channel.onUp(flush))
    if (waiting) {
      timer = setTimeout(() => {
        waiting = false
        timer = undefined
        flush()
      }, delayMs)
    }
    flush()
  }
}

let clientCount = 0

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const channel = options.channel
  const logger = options.logger ?? { warn: (message) => console.warn(message) }
  const prefix = options.idPrefix ?? `c${++clientCount}.${Math.random().toString(36).slice(2, 8)}`
  const baseDelay = options.reconnectDelayMs ?? 250
  const host: Host = createHost({
    onError: (error) => logger.warn(`[sync] ${errorText(error)}`)
  })
  void host.load([], BACKGROUND_CONTEXT).catch(() => undefined)
  const bindings = new Map<string, TargetBinding>()
  let link: ChannelLink | undefined
  let linkSeq = 0
  let nextDelay = baseDelay
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  /** 正在建的绑定数（`host.hold` 里链路就可能断：那时绑定还没进表，也得重连） */
  let creating = 0
  let disposed = false

  // ─── 链路 ─────────────────────────────────

  function connect(delayMs: number): void {
    const id = `${prefix}.${++linkSeq}`
    const next = new ChannelLink(channel, id, delayMs, () => {
      nextDelay = baseDelay
    })
    link = next
    host.connect(next, { principal: SERVER_PRINCIPAL, codec: VIEW_LINK_CODEC }, BACKGROUND_CONTEXT)
    // 在 host.connect 之后登记：chord 自己的关闭处理先跑（引用先回到 loading），这里再换新链路（它们在新链路上重新持有）
    next.onClose((reason) => {
      if (disposed || link !== next) return
      // 链路断了：已终结/失败的引用立刻落定，其余活着的绑定同步切回 loading（不留过时的值）
      for (const binding of bindings.values()) {
        if (binding.disposed) continue
        const current = binding.handle.state.value
        if (current.kind === 'ended' || current.kind === 'failed') {
          onRefState(binding, current)
        } else if (binding.state.status === 'live') {
          binding.refLive = false
          binding.view = undefined
          binding.availability = undefined
          binding.value = undefined
          setState(binding, LOADING)
        }
      }
      if (next.intended) return
      // 没人持有任何目标：不必重连，下一次 acquire 再开一条
      if (bindings.size === 0 && creating === 0) {
        link = undefined
        return
      }
      const wait = nextDelay
      nextDelay = Math.min(nextDelay * 2, MAX_RECONNECT_DELAY_MS)
      logger.warn(`[sync] link ${id} closed (${reason}); reconnecting`)
      connect(wait)
    })
  }

  function ensureConnected(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    if (link === undefined) connect(0)
  }

  /**
   * 最后一个绑定走了：下一个宏任务里还是没有绑定就关掉链路（服务端这头什么都不留）。延到宏任务是为了切会话时
   * （React 先跑旧 effect 的清理、再跑新 effect）不白白关了又开
   */
  function scheduleIdleClose(): void {
    if (bindings.size > 0 || idleTimer !== undefined || link === undefined) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (bindings.size > 0 || disposed) return
      const current = link
      link = undefined
      if (current !== undefined) {
        current.intended = true
        current.close('idle')
      }
    }, 0)
  }

  // ─── 状态通知 ─────────────────────────────

  function emit(binding: TargetBinding, event: ViewEvent<SessionView | AgentView>): void {
    for (const listener of [...binding.listeners]) {
      try {
        listener(event)
      } catch (error) {
        logger.warn(`[sync] view listener failed for ${binding.key}: ${errorText(error)}`)
      }
    }
  }

  function setState(binding: TargetBinding, state: ViewBindingState): void {
    if (binding.state.status === state.status && binding.state.code === state.code) return
    binding.state = state
    emit(binding, { kind: 'status', state })
  }

  /** 视图与可用性都到了、可用：交值（并报 live） */
  function publish(binding: TargetBinding, delivery: 'hydrate' | 'update'): void {
    if (binding.disposed || !binding.refLive || binding.availability !== 'available') return
    const value = binding.view
    if (value === undefined) return
    binding.value = value
    setState(binding, LIVE)
    emit(binding, { kind: 'value', value, delivery })
  }

  // ─── 绑定 ─────────────────────────────────

  function onViewValue(
    binding: TargetBinding,
    value: unknown,
    delivery: 'hydrate' | 'update'
  ): void {
    if (binding.disposed || !binding.refLive || value === undefined) return
    const next = value as SessionView | AgentView
    if (next === binding.view && binding.value !== undefined) return
    binding.view = next
    publish(binding, binding.value === undefined ? 'hydrate' : delivery)
  }

  function onAvailabilityValue(binding: TargetBinding, value: unknown): void {
    if (binding.disposed || !binding.refLive || value === undefined) return
    const next = value as ViewAvailability
    const previous = binding.availability
    binding.availability = next
    if (next === 'unavailable') {
      binding.value = undefined
      setState(binding, UNAVAILABLE)
      return
    }
    if (previous !== 'available') publish(binding, 'hydrate')
  }

  function onRefState(binding: TargetBinding, refState: RefState): void {
    if (binding.disposed) return
    switch (refState.kind) {
      case 'live': {
        binding.everLive = true
        binding.refLive = true
        // 引用 live 时两个状态成员都已水合：同步读出当前值并发布（首帧或重连后的新快照）
        let viewValue: unknown
        let availValue: unknown
        try {
          viewValue = binding.handle.view.value
          availValue = binding.handle.availability.value
        } catch {
          return
        }
        binding.view = viewValue as SessionView | AgentView
        binding.availability = availValue as ViewAvailability
        if (binding.availability === 'unavailable') {
          binding.value = undefined
          setState(binding, UNAVAILABLE)
        } else {
          publish(binding, 'hydrate')
        }
        return
      }
      case 'loading':
        // 链路断了、正在新链路上重新持有：之前的值作废，等新的快照
        binding.refLive = false
        binding.view = undefined
        binding.availability = undefined
        binding.value = undefined
        setState(binding, LOADING)
        return
      case 'failed': {
        binding.refLive = false
        binding.view = undefined
        binding.availability = undefined
        binding.value = undefined
        if (binding.everLive) {
          setState(binding, UNAVAILABLE)
          return
        }
        const code = codeOf(refState.cause.error)
        setState(binding, code === undefined ? { status: 'error' } : { status: 'error', code })
        return
      }
      case 'ended': {
        binding.refLive = false
        binding.view = undefined
        binding.availability = undefined
        binding.value = undefined
        if (binding.everLive) {
          setState(binding, UNAVAILABLE)
          return
        }
        const code = codeOf(refState.error)
        setState(binding, code === undefined ? { status: 'error' } : { status: 'error', code })
        return
      }
    }
  }

  function createBinding(key: string, target: SyncTarget): TargetBinding {
    ensureConnected()
    const handle: ViewHandle =
      target.kind === 'session'
        ? host.hold(SessionViewContract, { sessionId: target.sessionId }, BACKGROUND_CONTEXT)
        : host.hold(AgentViewContract, { agentId: target.agentId }, BACKGROUND_CONTEXT)
    const { context: watchCtx, cancel: cancelWatches } = withCancel(BACKGROUND_CONTEXT)
    const binding: TargetBinding = {
      key,
      target:
        target.kind === 'session'
          ? { kind: 'session', sessionId: target.sessionId }
          : { kind: 'agent', agentId: target.agentId },
      refs: 0,
      listeners: new Set(),
      state: LOADING,
      value: undefined,
      handle,
      cancelWatches,
      refLive: false,
      view: undefined,
      availability: undefined,
      everLive: false,
      disposed: false
    }

    // 跟踪引用生命周期（loading / live / failed / ended）
    void handle.state
      .watch(watchCtx)
      .then((watch) => {
        if (binding.disposed) {
          void watch.stop()
          return
        }
        if (watch.value.kind !== 'loading') onRefState(binding, watch.value)
        watch.start(async (call) => {
          if (call.kind === 'value') onRefState(binding, call.value)
        })
      })
      .catch(() => undefined)

    // 跟踪 view 状态成员的变化（增量与整份替换）
    void handle.view
      .watch(watchCtx)
      .then((watch) => {
        if (binding.disposed) {
          void watch.stop()
          return
        }
        watch.start(async (call) => {
          if (call.kind === 'value') {
            const isReset = call.ops.length === 1 && call.ops[0]?.[0] === 'r'
            onViewValue(binding, call.value, isReset ? 'hydrate' : 'update')
          }
        })
      })
      .catch(() => undefined)

    // 跟踪 availability 状态成员的变化
    void handle.availability
      .watch(watchCtx)
      .then((watch) => {
        if (binding.disposed) {
          void watch.stop()
          return
        }
        watch.start(async (call) => {
          if (call.kind === 'value') onAvailabilityValue(binding, call.value)
        })
      })
      .catch(() => undefined)

    const initialState = handle.state.value
    if (initialState.kind !== 'loading') onRefState(binding, initialState)
    return binding
  }

  function releaseBinding(binding: TargetBinding): void {
    binding.disposed = true
    bindings.delete(binding.key)
    binding.cancelWatches()
    binding.listeners.clear()
    try {
      binding.handle.release()
    } catch (error) {
      logger.warn(`[sync] release ${binding.key} failed: ${errorText(error)}`)
    }
    scheduleIdleClose()
  }

  return {
    acquire<V extends SessionView | AgentView>(target: SyncTarget): ViewSubscription<V> {
      if (disposed) throw new Error('sync client is disposed')
      const key = syncTargetKey(target)
      let binding = bindings.get(key)
      if (binding === undefined) {
        creating += 1
        try {
          binding = createBinding(key, target)
        } finally {
          creating -= 1
        }
        bindings.set(key, binding)
      }
      const held = binding
      held.refs += 1
      let released = false
      const own = new Set<(event: ViewEvent<SessionView | AgentView>) => void>()
      return {
        target: held.target,
        state: () => held.state,
        value: () => held.value as V | undefined,
        subscribe: (listener) => {
          const entry = listener as (event: ViewEvent<SessionView | AgentView>) => void
          // 同一个函数订两次 = 两份（各自的退订只摘自己那份）
          const wrapped = (event: ViewEvent<SessionView | AgentView>): void => entry(event)
          own.add(wrapped)
          held.listeners.add(wrapped)
          return () => {
            own.delete(wrapped)
            held.listeners.delete(wrapped)
          }
        },
        release: () => {
          if (released) return false
          released = true
          for (const listener of own) held.listeners.delete(listener)
          own.clear()
          held.refs -= 1
          if (held.refs > 0 || held.disposed) return false
          releaseBinding(held)
          return true
        }
      }
    },

    resetAll(): void {
      if (disposed || link === undefined) return
      const previous = link
      link = undefined
      previous.intended = true
      previous.close('reset')
      nextDelay = baseDelay
      connect(0)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const binding of [...bindings.values()]) releaseBinding(binding)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = undefined
      const current = link
      link = undefined
      if (current !== undefined) {
        current.intended = true
        current.close('client disposed')
      }
      void host.close(BACKGROUND_CONTEXT).catch((error: unknown) => {
        logger.warn(`[sync] closing the client host failed: ${errorText(error)}`)
      })
    }
  }
}

// ─── 渠道的单例 ─────────────────────────────────────────

const clients = new WeakMap<SyncLinkChannel, SyncClient>()

/**
 * 某条渠道的客户端（每条渠道一个；渠道换了 —— 测试换了注入 —— 就是另一个客户端）。
 *
 * `options` 只在**第一次**为这条渠道建客户端时生效（之后原样交回已建的那个）：宿主要给链路 id 定前缀
 * （Chrome 侧边栏按标签页），就在任何视图 hook 挂载之前先调一次。
 */
export function syncClientFor(
  channel: SyncLinkChannel,
  options: { logger?: SyncClientLogger; idPrefix?: string } = {}
): SyncClient {
  let client = clients.get(channel)
  if (client === undefined) {
    client = createSyncClient({
      channel,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.idPrefix === undefined ? {} : { idPrefix: options.idPrefix })
    })
    clients.set(channel, client)
  }
  return client
}
