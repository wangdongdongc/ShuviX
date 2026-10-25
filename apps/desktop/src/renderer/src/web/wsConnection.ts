/**
 * web 客户端的 WebSocket 连接（server mode phase C，docs/server/phase-bc-network-and-web.md §C）—— 浏览器里的
 * `window.api` 经它到主进程的网络服务，线协议见 `shared/networkEnvelope.ts`。它交出两样东西：
 *
 *  - `transport`（`ApiTransport`，交给 `buildApi`）：
 *    - `invoke`：连着 → 发 `{t:'invoke'}`、等结果；**第一次连上之前**的调用先排着（页面启动时的初始化不能因为
 *      socket 还在握手就失败），连上后按顺序发出；**断过之后**、重连成功之前的调用当场以 `Error('disconnected')`
 *      拒绝；已经发出、还没等到结果的调用在连接断开时同样拒绝（不挂着）。
 *    - 本地实现的通道（`localInvoke`：`app:open-settings` / `app:open-external` 在新标签页里开）不走网络；
 *      只有桌面应用能用的通道（`desktopOnly`）当场拒绝（`code: 'desktop_only'`）并回调 `onDesktopOnly`
 *      让页面给一条看得见的提示 —— 不悄悄假装成功。
 *    - `send`：连着就发，断着就丢。
 *    - `on`：推送的监听器跨重连一直挂着（推送是服务端发起的），只收载荷。
 *  - `sync`（`SyncLinkChannel`，视图同步）：帧走 `{t:'sync'}`；`isUp` = socket 开着；`onUp` 每次连上都回调
 *    （第一次也算 —— 之前建的链路在等它发帧）；`onDown` 只在开着的连接断掉时回调（链路随之结束、由视图客户端重连）。
 *
 * **重连**：断了就按退避重连（500ms 起，翻倍，封顶 5s；连上一次就复位）。重连成功后给 `app:event` 的监听器补发一组
 * 「请重拉」的信号事件（会话列表、设置、提供商 …）：断着的那段时间里错过的变化就此补上。
 *
 * 不碰 `window` / 全局 `WebSocket`：都由调用方交进来（单测给假的）。
 */
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { JsonValue, SyncLinkChannel } from '@shuvix/chat-protocol/sync'
import type { ApiTransport } from '../../../shared/buildApi'
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage
} from '../../../shared/networkEnvelope'

/** 连接的状态：第一次在连 / 连着 / 断过、在重连 / 已关掉（`dispose`，不再重连） */
export type WsState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/** 连接要的那一点 WebSocket（浏览器的 WebSocket 满足它；单测给假的） */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}

/** WebSocket 的 OPEN（readyState） */
const WS_OPEN = 1

export interface WsTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface WsConnectionOptions {
  /** `ws://<host>/ws` */
  readonly url: string
  /** 建一个 socket（缺省：全局 WebSocket） */
  readonly createSocket?: (url: string) => WebSocketLike
  /** 本地实现的请求通道：通道 → 实现（返回值 / Promise 就是调用的结果） */
  readonly localInvoke?: Readonly<Record<string, (...args: unknown[]) => unknown>>
  /** 只有桌面应用能用的请求通道（本地当场拒绝） */
  readonly desktopOnly?: ReadonlySet<string>
  /** 一次桌面专属通道的调用被拒了（页面据此给提示） */
  readonly onDesktopOnly?: (channel: string) => void
  /** 重连成功后补发给 `app:event` 监听器的信号事件 */
  readonly resyncEvents?: readonly AppEvent[]
  /** 退避的起点 / 上限（毫秒） */
  readonly minDelayMs?: number
  readonly maxDelayMs?: number
  readonly timers?: WsTimers
}

export interface WsConnection {
  readonly transport: ApiTransport
  readonly sync: SyncLinkChannel
  /** 此刻的状态 */
  state(): WsState
  /** 订阅状态变化；返回注销 */
  onState(callback: (state: WsState) => void): () => void
  /** 关掉、不再重连（在途的调用拒绝） */
  dispose(): void
}

/** 「请重拉」的信号事件：都不带载荷，消费者收到就整个重取 */
export const DEFAULT_RESYNC_EVENTS: readonly AppEvent[] = [
  { type: 'session.listChanged' },
  { type: 'settings.changed' },
  { type: 'providers.changed' },
  { type: 'project.changed' },
  { type: 'bot.changed' },
  { type: 'agent.changed' },
  { type: 'policy.changed' },
  { type: 'hook.changed' },
  { type: 'skill.changed' },
  { type: 'widget.changed' },
  { type: 'knowledge.changed' },
  { type: 'daily.changed' },
  { type: 'tracking.changed' },
  { type: 'trigger.logged' },
  { type: 'artifacts.changed' },
  { type: 'network.changed' }
]

const APP_EVENT_CHANNEL = 'app:event'

/** 一个带 `code` 的错误（与经 IPC 拒绝的调用一样是 Error） */
function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

export function createWsConnection(options: WsConnectionOptions): WsConnection {
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
  const timers: WsTimers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
  const minDelay = options.minDelayMs ?? 500
  const maxDelay = options.maxDelayMs ?? 5000
  const localInvoke = options.localInvoke ?? {}
  const desktopOnly = options.desktopOnly ?? new Set<string>()
  const resyncEvents = options.resyncEvents ?? DEFAULT_RESYNC_EVENTS

  let socket: WebSocketLike | undefined
  let state: WsState = 'connecting'
  let everOpened = false
  let disposed = false
  let delay = minDelay
  let retryTimer: unknown
  let nextId = 1

  /** 已经发出、等结果的调用 */
  const inflight = new Map<number, Pending>()
  /** 第一次连上之前排着的调用 */
  const queued: Array<{ id: number; channel: string; args: unknown[]; pending: Pending }> = []
  const pushListeners = new Map<string, Set<(...payload: unknown[]) => void>>()
  const stateListeners = new Set<(state: WsState) => void>()
  const frameListeners = new Set<(link: string, frame: JsonValue) => void>()
  const downListeners = new Set<(reason: string) => void>()
  const upListeners = new Set<() => void>()

  const isOpen = (): boolean => socket !== undefined && socket.readyState === WS_OPEN

  function emit<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try {
        listener(...args)
      } catch (error) {
        console.error('[web] listener failed', error)
      }
    }
  }

  function setState(next: WsState): void {
    if (state === next) return
    state = next
    emit(stateListeners, next)
  }

  function transmit(message: ClientMessage): void {
    socket!.send(encodeClientMessage(message))
  }

  function onPush(channel: string, args: unknown[]): void {
    const listeners = pushListeners.get(channel)
    if (listeners) emit(listeners, ...args)
  }

  function onMessage(data: unknown): void {
    const message = decodeServerMessage(data)
    if (message === undefined) return
    switch (message.t) {
      case 'result': {
        const pending = inflight.get(message.id)
        if (pending === undefined) return
        inflight.delete(message.id)
        if (message.ok) pending.resolve(message.value)
        else
          pending.reject(codedError(message.error.message, message.error.code ?? 'handler_error'))
        return
      }
      case 'push':
        onPush(message.channel, message.args)
        return
      case 'sync':
        emit(frameListeners, message.link, message.frame as JsonValue)
        return
    }
  }

  function rejectInflight(): void {
    const pending = [...inflight.values()]
    inflight.clear()
    for (const p of pending) p.reject(codedError('disconnected', 'disconnected'))
  }

  function scheduleReconnect(): void {
    if (disposed || retryTimer !== undefined) return
    const wait = delay
    delay = Math.min(delay * 2, maxDelay)
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined
      connect()
    }, wait)
  }

  function connect(): void {
    if (disposed) return
    let current: WebSocketLike
    try {
      current = createSocket(options.url)
    } catch {
      scheduleReconnect()
      return
    }
    socket = current
    let opened = false
    current.onopen = () => {
      if (socket !== current || disposed) return
      opened = true
      delay = minDelay
      const reconnected = everOpened
      everOpened = true
      setState('open')
      for (const item of queued.splice(0)) {
        inflight.set(item.id, item.pending)
        try {
          transmit({ t: 'invoke', id: item.id, channel: item.channel, args: item.args })
        } catch (error) {
          inflight.delete(item.id)
          item.pending.reject(
            error instanceof Error ? error : codedError(String(error), 'disconnected')
          )
        }
      }
      emit(upListeners)
      if (reconnected) {
        for (const event of resyncEvents) onPush(APP_EVENT_CHANNEL, [event])
      }
    }
    current.onmessage = (event) => {
      if (socket === current) onMessage(event.data)
    }
    current.onerror = () => {
      /* close 随后就到 */
    }
    current.onclose = () => {
      if (socket !== current) return
      socket = undefined
      rejectInflight()
      if (opened) emit(downListeners, 'disconnected')
      if (disposed) return
      setState(everOpened ? 'reconnecting' : 'connecting')
      scheduleReconnect()
    }
  }

  const transport: ApiTransport = {
    invoke(channel, ...args) {
      const local = Object.hasOwn(localInvoke, channel) ? localInvoke[channel] : undefined
      if (local !== undefined) {
        return Promise.resolve().then(() => local(...args))
      }
      if (desktopOnly.has(channel)) {
        options.onDesktopOnly?.(channel)
        return Promise.reject(
          codedError(`"${channel}" is only available in the desktop app for now`, 'desktop_only')
        )
      }
      if (disposed) return Promise.reject(codedError('disconnected', 'disconnected'))
      return new Promise((resolve, reject) => {
        const id = nextId++
        const pending: Pending = { resolve, reject }
        if (isOpen()) {
          inflight.set(id, pending)
          try {
            transmit({ t: 'invoke', id, channel, args })
          } catch (error) {
            // 参数编不成 JSON（BigInt / 循环引用）或 socket 刚好断了：这次调用当场失败
            inflight.delete(id)
            reject(error instanceof Error ? error : codedError(String(error), 'disconnected'))
          }
        } else if (!everOpened) {
          queued.push({ id, channel, args, pending })
        } else {
          reject(codedError('disconnected', 'disconnected'))
        }
      })
    },
    send(channel, ...args) {
      if (!isOpen()) return
      try {
        transmit({ t: 'send', channel, args })
      } catch {
        /* 断了：丢掉 */
      }
    },
    on(channel, listener) {
      let listeners = pushListeners.get(channel)
      if (listeners === undefined) {
        listeners = new Set()
        pushListeners.set(channel, listeners)
      }
      const entry = (...payload: unknown[]): void => listener(...payload)
      listeners.add(entry)
      return () => {
        listeners.delete(entry)
      }
    }
  }

  const sync: SyncLinkChannel = {
    send(link, frame) {
      if (!isOpen()) return
      try {
        transmit({ t: 'sync', link, frame })
      } catch {
        /* 断了：链路会经 onDown 结束 */
      }
    },
    onFrame(callback) {
      const entry = (link: string, frame: JsonValue): void => callback(link, frame)
      frameListeners.add(entry)
      return () => {
        frameListeners.delete(entry)
      }
    },
    onDown(callback) {
      const entry = (reason: string): void => callback(reason)
      downListeners.add(entry)
      return () => {
        downListeners.delete(entry)
      }
    },
    onUp(callback) {
      const entry = (): void => callback()
      upListeners.add(entry)
      return () => {
        upListeners.delete(entry)
      }
    },
    isUp: () => isOpen()
  }

  connect()

  return {
    transport,
    sync,
    state: () => state,
    onState(callback) {
      const entry = (next: WsState): void => callback(next)
      stateListeners.add(entry)
      return () => {
        stateListeners.delete(entry)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (retryTimer !== undefined) timers.clearTimeout(retryTimer)
      retryTimer = undefined
      const current = socket
      const wasOpen = isOpen()
      socket = undefined
      rejectInflight()
      // 渠道上的链路都没了（SyncLinkChannel 的 onDown 约定），状态停在 closed
      if (wasOpen) emit(downListeners, 'disposed')
      setState('closed')
      for (const item of queued.splice(0)) {
        item.pending.reject(codedError('disconnected', 'disconnected'))
      }
      try {
        current?.close(1000, 'disposed')
      } catch {
        /* 已经关了 */
      }
    }
  }
}
