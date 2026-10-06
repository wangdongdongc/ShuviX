/**
 * 视图同步的前端客户端（phase 3，P3-08；plan §C「Client」）—— 把渠道的 `sync`（`SessionChannelApi.sync`：
 * `invoke(target, call)` + `onFrame(cb)`）接成 chord 的 `RemoteServiceTransport`，每个**目标**（一条会话 /
 * 一个派生 agent）一个 chord 绑定，交出那份复制状态（`shuvix.chat.view` 服务的 `view`）的完整值。
 *
 * 线上的几条纪律（与 agent-runtime 的参考客户端 `sync/__tests__/support/client.ts` 同一套）：
 *  - **先登记订阅、再发调用**：服务端可能在回复之前就开始推这个订阅的帧（P3-04 PIN-11）—— 早到的帧不能
 *    当成孤儿；
 *  - **每个订阅一个解码器**（`createServiceStateDecoder`）：路径字典按订阅独立，两个目标的帧互不串；
 *  - **`activate()` 之前到的帧先缓存**，激活时按序交给 chord（快照先于每一条更新）；
 *  - 孤儿帧 / 退订之后迟到的帧：丢掉，不抛、不写；
 *  - 失败的调用以带 `.code` 的 Error 拒绝（渠道的信封，P3-05 PIN-01）：订阅失败 → 绑定报 `error` + code，
 *    **不重试**；
 *  - 帧断档 / 解码失败（PIN-15）：丢掉这个绑定、重订一次（每次事故一次，记一条警告，不做退避循环）。
 *
 * 目标按引用计数共享（同一目标的多个使用方共用一个绑定、一个订阅）；最后一个使用方离开才退订。
 * `onFrame` 在第一个绑定出现时登记、最后一个绑定离开时注销。
 *
 * 浏览器安全：只引 chord 根入口与 `/context`、chat-protocol（P3-08-11）。
 */
import {
  createRemoteServiceBinding,
  createServiceStateDecoder,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  defineService,
  parseWireServiceProviderUpdate,
  parseWireServiceSubscriptionSnapshot,
  type JsonValue,
  type RemoteServiceBinding,
  type RemoteServiceTransport,
  type ReplicatedState,
  type ServiceProviderUpdate,
  type ServiceStateDecoder,
  type WireServiceProviderUpdate
} from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  CHAT_VIEW_SERVICE_ID,
  syncTargetKey,
  type SyncChannel,
  type SyncFrame,
  type SyncTarget
} from '@shuvix/chat-protocol/sync'
import type { AgentView, SessionView } from '@shuvix/chat-protocol/types/sessionView'

/** 视图服务在前端的身份：与服务端同一个 id */
const ChatView = defineService<{ readonly view: ReplicatedState<SessionView | AgentView> }>(
  CHAT_VIEW_SERVICE_ID
)

/** 一个目标的绑定此刻的状态 */
export type ViewBindingStatus = 'loading' | 'live' | 'unavailable' | 'error'

export interface ViewBindingState {
  readonly status: ViewBindingStatus
  /** `error` 时服务端给的错误码（`service_not_found` …）；没有码 → undefined */
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
  /** 放手（幂等）；最后一个使用方放手时退订 —— 那一次返回 true */
  release(): boolean
}

export interface SyncClientLogger {
  warn(message: string): void
}

export interface SyncClientOptions {
  readonly channel: SyncChannel
  readonly logger?: SyncClientLogger
  /**
   * 订阅 id 的前缀：同一条连接上的几个客户端（Chrome 一条连接上的几个侧边栏，P3-09-12）各给一个，订阅 id
   * 就不会撞。缺省 = 每个客户端一个随机前缀
   */
  readonly idPrefix?: string
}

export interface SyncClient {
  /** 持有一个目标（引用计数）：第一次持有时建绑定、订阅 */
  acquire<V extends SessionView | AgentView>(target: SyncTarget): ViewSubscription<V>
  /**
   * 连接重来过（渠道断开又连上、服务端换了一个进程，PIN-10）：丢掉每个绑定（不发退订 —— 旧的那一端已经
   * 不在了）、重新订阅还有人持有的目标
   */
  resetAll(): void
  /** 丢掉一切（退订每个绑定、注销帧监听） */
  dispose(): void
}

interface SubscriptionState {
  readonly binding: TargetBinding
  readonly generation: number
  readonly decoder: ServiceStateDecoder
  listener: ((update: ServiceProviderUpdate) => void) | undefined
  readonly buffer: SyncFrame<WireServiceProviderUpdate>[]
  active: boolean
  /** 不再发退订（连接已经不在了） */
  silent: boolean
}

interface TargetBinding {
  readonly key: string
  readonly target: SyncTarget
  refs: number
  listeners: Set<(event: ViewEvent<SessionView | AgentView>) => void>
  state: ViewBindingState
  value: SessionView | AgentView | undefined
  /** 当前这一代的 chord 绑定（重订 / 重置时换代） */
  generation: number
  chord: RemoteServiceBinding | undefined
  stopValue: (() => void) | undefined
  /** 这一代的订阅（关的时候按它决定发不发退订） */
  subscriptions: Set<SubscriptionState>
  /** 这一代的订阅失败过（失败报给 chord 的 onError 时据此不算成事故） */
  failed: boolean
  /** 这一代已经因事故在重订（之后同一代的错误都算同一次事故） */
  recovering: boolean
  disposed: boolean
}

function json<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

const LOADING: ViewBindingState = { status: 'loading' }
const LIVE: ViewBindingState = { status: 'live' }
const UNAVAILABLE: ViewBindingState = { status: 'unavailable' }

let clientCount = 0

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const channel = options.channel
  const logger = options.logger ?? { warn: (message) => console.warn(message) }
  const prefix = options.idPrefix ?? `c${++clientCount}.${Math.random().toString(36).slice(2, 8)}`
  let nextSubscription = 0
  const bindings = new Map<string, TargetBinding>()
  const subscriptions = new Map<string, SubscriptionState>()
  let stopFrames: (() => void) | undefined
  let disposed = false

  // ─── 帧 ─────────────────────────────────

  function ensureFrames(): void {
    if (stopFrames !== undefined) return
    stopFrames = channel.onFrame((frame) => receive(frame as SyncFrame<WireServiceProviderUpdate>))
  }

  function maybeStopFrames(): void {
    if (bindings.size > 0 || stopFrames === undefined) return
    const stop = stopFrames
    stopFrames = undefined
    stop()
  }

  function receive(frame: SyncFrame<WireServiceProviderUpdate>): void {
    const state = subscriptions.get(frame?.subscriptionId)
    // 孤儿 / 退订之后迟到的帧：丢掉（P3-08-03）
    if (state === undefined) return
    if (!state.active) {
      state.buffer.push(frame)
      return
    }
    deliver(state, frame)
  }

  function deliver(state: SubscriptionState, frame: SyncFrame<WireServiceProviderUpdate>): void {
    let update: ServiceProviderUpdate
    try {
      update = state.decoder.decodeUpdate(parseWireServiceProviderUpdate(frame.update))
    } catch (error) {
      incident(state.binding, state.generation, error)
      return
    }
    state.listener?.(update)
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

  // ─── 绑定 ─────────────────────────────────

  function transportFor(binding: TargetBinding, generation: number): RemoteServiceTransport {
    const target = binding.target
    return {
      invoke: async (call) =>
        json(await channel.invoke(json(target), json(call) as unknown as JsonValue)) as
          | JsonValue
          | undefined,
      subscribe: async (serviceId, mode, listener) => {
        const subscriptionId = `${prefix}#${++nextSubscription}`
        const state: SubscriptionState = {
          binding,
          generation,
          decoder: createServiceStateDecoder(),
          listener: undefined,
          buffer: [],
          active: false,
          silent: false
        }
        // 先登记、再发调用：早于回复到达的帧照样归它（P3-08-01）
        subscriptions.set(subscriptionId, state)
        binding.subscriptions.add(state)
        let reply: JsonValue | undefined
        try {
          reply = await channel.invoke(
            json(target),
            json(
              createServiceSubscribeCall(subscriptionId, serviceId, mode)
            ) as unknown as JsonValue
          )
        } catch (error) {
          subscriptions.delete(subscriptionId)
          binding.subscriptions.delete(state)
          if (binding.generation === generation && !binding.disposed) {
            binding.failed = true
            // 订阅失败不重试（P3-08-04）：报给使用方，带着服务端的码
            const code = codeOf(error)
            setState(binding, code === undefined ? { status: 'error' } : { status: 'error', code })
          }
          throw error
        }
        const snapshot = state.decoder.decodeSnapshot(
          parseWireServiceSubscriptionSnapshot(json(reply))
        )
        state.listener = (update) => {
          if (update.type === 'unavailable') {
            // 目标被收回（会话删了，PIN-14）：值清空、报不可用；之后的 replaced 会把它带回来
            listener(update, BACKGROUND_CONTEXT)
            if (binding.generation === generation) {
              binding.value = undefined
              setState(binding, UNAVAILABLE)
            }
            return
          }
          listener(update, BACKGROUND_CONTEXT)
        }
        return {
          snapshot,
          activate: () => {
            state.active = true
            for (const frame of state.buffer.splice(0)) deliver(state, frame)
          },
          close: async () => {
            subscriptions.delete(subscriptionId)
            binding.subscriptions.delete(state)
            if (state.silent) return
            try {
              await channel.invoke(
                json(target),
                json(createServiceUnsubscribeCall(subscriptionId)) as unknown as JsonValue
              )
            } catch (error) {
              logger.warn(`[sync] unsubscribe ${subscriptionId} failed: ${errorText(error)}`)
            }
          }
        }
      }
    }
  }

  function start(binding: TargetBinding): void {
    const generation = ++binding.generation
    binding.failed = false
    binding.recovering = false
    const chord = createRemoteServiceBinding({
      services: [ChatView],
      transport: transportFor(binding, generation),
      onError: (error) => {
        // 订阅失败已经报过（不重试）；其余（断档、解码失败、坏帧）= 一次事故
        if (binding.generation !== generation || binding.failed) return
        incident(binding, generation, error)
      }
    })
    binding.chord = chord
    const facade = chord.use(ChatView)
    binding.stopValue = facade.view.subscribe((value, _context, delivery) => {
      if (binding.generation !== generation || binding.disposed) return
      binding.value = value
      setState(binding, LIVE)
      emit(binding, { kind: 'value', value, delivery: delivery.kind })
    })
  }

  /** 停掉这一代（`silent` = 不发退订） */
  function stop(binding: TargetBinding, silent: boolean): void {
    binding.stopValue?.()
    binding.stopValue = undefined
    if (silent) {
      for (const state of binding.subscriptions) {
        state.silent = true
      }
    }
    // 这一代的订阅先从帧表里摘掉：之后到的帧都是迟到的
    for (const state of binding.subscriptions) {
      for (const [id, entry] of subscriptions) if (entry === state) subscriptions.delete(id)
    }
    const chord = binding.chord
    binding.chord = undefined
    if (chord !== undefined) {
      void chord.dispose(BACKGROUND_CONTEXT).catch((error: unknown) => {
        logger.warn(`[sync] dispose ${binding.key} failed: ${errorText(error)}`)
      })
    }
  }

  /** 断档 / 解码失败（PIN-15）：丢掉这一代、重订一次 */
  function incident(binding: TargetBinding, generation: number, error: unknown): void {
    if (binding.generation !== generation || binding.recovering || binding.disposed) return
    binding.recovering = true
    logger.warn(`[sync] ${binding.key}: resubscribing after a stream error: ${errorText(error)}`)
    stop(binding, false)
    start(binding)
  }

  function releaseBinding(binding: TargetBinding): void {
    binding.disposed = true
    bindings.delete(binding.key)
    stop(binding, false)
    binding.listeners.clear()
    maybeStopFrames()
  }

  return {
    acquire<V extends SessionView | AgentView>(target: SyncTarget): ViewSubscription<V> {
      if (disposed) throw new Error('sync client is disposed')
      const key = syncTargetKey(target)
      let binding = bindings.get(key)
      if (binding === undefined) {
        binding = {
          key,
          target: json(target),
          refs: 0,
          listeners: new Set(),
          state: LOADING,
          value: undefined,
          generation: 0,
          chord: undefined,
          stopValue: undefined,
          subscriptions: new Set(),
          failed: false,
          recovering: false,
          disposed: false
        }
        bindings.set(key, binding)
        ensureFrames()
        start(binding)
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
      for (const binding of [...bindings.values()]) {
        stop(binding, true)
        binding.value = undefined
        setState(binding, LOADING)
        start(binding)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const binding of [...bindings.values()]) releaseBinding(binding)
      maybeStopFrames()
    }
  }
}

// ─── 渠道的单例 ─────────────────────────────────────────

const clients = new WeakMap<SyncChannel, SyncClient>()

/**
 * 某条渠道的客户端（每条渠道一个；渠道换了 —— 测试换了注入 —— 就是另一个客户端）。
 *
 * `options` 只在**第一次**为这条渠道建客户端时生效（之后原样交回已建的那个）：宿主要给订阅 id 定前缀
 * （Chrome 侧边栏按标签页，P3-09-12），就在任何视图 hook 挂载之前先调一次。
 */
export function syncClientFor(
  channel: SyncChannel,
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
