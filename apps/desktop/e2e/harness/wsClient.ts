/**
 * 网络访问的 Node 侧 WebSocket 客户端 —— spec 进程（node）直接连实例的 `ws://127.0.0.1:<port>/ws`，不经任何页面。
 * 无头实例没有窗口，web 客户端也无处可开：调通道、订视图都靠它（`launchApp({ headless: true })` 用它关掉
 * 自动审查，`specs/startup/headless` 用它断言）。
 *
 * 线协议与 `src/shared/networkEnvelope.ts` 一致（按值钉住，不引产品代码）：
 *   发 `{t:'invoke', id, channel, args, u?}` · `{t:'sync', link, frame}`
 *   收 `{t:'result', id, ok, value? | error}` · `{t:'push', channel, args}` · `{t:'sync', link, frame}`
 *
 * 浏览器自己会带 `Origin`；Node 22 的全局 WebSocket 不带，服务端那道门要求 `Origin === http://<Host>` ——
 * 所以这里显式给（`origin: null` = 不带，测门用）。零依赖：Node 22 全局 WebSocket（undici，接受 `headers`）。
 */

/** 结果帧（原样） */
export interface WsResultFrame {
  t: 'result'
  id: number
  ok: boolean
  value?: unknown
  error?: { message: string; code?: string }
}

/** invoke 失败（`ok:false`）：带服务端给的 code */
export class WsInvokeError extends Error {
  readonly code?: string
  constructor(channel: string, error: { message: string; code?: string } | undefined) {
    super(`${channel}: ${error?.message ?? 'failed'}${error?.code ? ` (${error.code})` : ''}`)
    this.code = error?.code
  }
}

export interface WsClient {
  /** 调一条通道；`ok:false` → 抛 `WsInvokeError`（带 code） */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** 调一条通道，回原样的结果帧（不抛） */
  invokeRaw(channel: string, args?: unknown[]): Promise<WsResultFrame>
  /** 发一帧视图同步（`{t:'sync', link, frame}`） */
  sendSync(link: string, frame: unknown): void
  /** 收视图同步帧（返回取消函数） */
  onSync(listener: (link: string, frame: unknown) => void): () => void
  /** 收推送（返回取消函数） */
  onPush(listener: (channel: string, args: unknown[]) => void): () => void
  /** 连接是否还开着 */
  isOpen(): boolean
  /** 等连接关掉（服务端断开 / 自己关），回关闭码 */
  closed(): Promise<number>
  close(): void
}

export interface WsConnectOptions {
  /** 连去的地址（缺省 127.0.0.1） */
  host?: string
  /** `Origin` 头；缺省 `http://<host>:<port>`；`null` = 不带 */
  origin?: string | null
  /** 单次 invoke 的上限（缺省 15s） */
  timeoutMs?: number
}

/** 线上的位置参数：undefined 的位置记进 `u`（与 networkEnvelope.packArgs 同规矩） */
function packArgs(args: readonly unknown[]): { args: unknown[]; u?: number[] } {
  const u: number[] = []
  const out = args.map((arg, i) => {
    if (arg === undefined) {
      u.push(i)
      return null
    }
    return arg
  })
  return u.length > 0 ? { args: out, u } : { args: out }
}

/** 连上实例的网络访问；握手被拒（门没过）或连不上 → 抛 */
export function connectWs(port: number, opts: WsConnectOptions = {}): Promise<WsClient> {
  const host = opts.host ?? '127.0.0.1'
  const origin = opts.origin === undefined ? `http://${host}:${port}` : opts.origin
  const timeoutMs = opts.timeoutMs ?? 15_000
  const headers: Record<string, string> = {}
  if (origin !== null) headers.Origin = origin
  // Node 22 的全局 WebSocket 是 undici 的实现：第二个参数接受 `{ headers }`（非标准扩展，类型里没有）
  const Ctor = WebSocket as unknown as new (url: string, init: unknown) => WebSocket
  const socket = new Ctor(`ws://${host}:${port}/ws`, { headers })

  let nextId = 1
  const pending = new Map<number, (frame: WsResultFrame) => void>()
  const syncListeners = new Set<(link: string, frame: unknown) => void>()
  const pushListeners = new Set<(channel: string, args: unknown[]) => void>()
  let open = false
  let closeCode: number | undefined
  const closeWaiters: Array<(code: number) => void> = []

  socket.addEventListener('message', (event) => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(String(event.data)) as Record<string, unknown>
    } catch {
      return
    }
    if (message.t === 'result' && typeof message.id === 'number') {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve?.(message as unknown as WsResultFrame)
    } else if (message.t === 'sync' && typeof message.link === 'string') {
      for (const listener of syncListeners) listener(message.link, message.frame)
    } else if (message.t === 'push' && typeof message.channel === 'string') {
      const args = Array.isArray(message.args) ? message.args : []
      for (const listener of pushListeners) listener(message.channel, args)
    }
  })

  socket.addEventListener('close', (event) => {
    open = false
    closeCode = event.code
    for (const resolve of pending.values()) {
      resolve({
        t: 'result',
        id: -1,
        ok: false,
        error: { message: 'disconnected', code: 'disconnected' }
      })
    }
    pending.clear()
    for (const waiter of closeWaiters.splice(0)) waiter(event.code)
  })

  const client: WsClient = {
    invokeRaw(channel, args = []) {
      if (!open) {
        return Promise.resolve({
          t: 'result',
          id: -1,
          ok: false,
          error: { message: 'disconnected', code: 'disconnected' }
        })
      }
      const id = nextId++
      return new Promise<WsResultFrame>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({ t: 'result', id, ok: false, error: { message: 'timeout', code: 'timeout' } })
        }, timeoutMs)
        pending.set(id, (frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
        socket.send(JSON.stringify({ t: 'invoke', id, channel, ...packArgs(args) }))
      })
    },
    async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
      const frame = await client.invokeRaw(channel, args)
      if (!frame.ok) throw new WsInvokeError(channel, frame.error)
      return frame.value as T
    },
    sendSync(link, frame) {
      if (open) socket.send(JSON.stringify({ t: 'sync', link, frame }))
    },
    onSync(listener) {
      syncListeners.add(listener)
      return () => syncListeners.delete(listener)
    },
    onPush(listener) {
      pushListeners.add(listener)
      return () => pushListeners.delete(listener)
    },
    isOpen: () => open,
    closed: () =>
      closeCode !== undefined
        ? Promise.resolve(closeCode)
        : new Promise<number>((resolve) => closeWaiters.push(resolve)),
    close() {
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
    }
  }

  return new Promise<WsClient>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`websocket to 127.0.0.1:${port} did not open within ${timeoutMs}ms`))
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
    }, timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      open = true
      resolve(client)
    })
    socket.addEventListener('error', () => {
      if (open) return
      clearTimeout(timer)
      reject(new Error(`websocket to ${host}:${port} failed (refused by the server's guards?)`))
    })
  })
}
