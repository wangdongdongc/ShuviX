/**
 * Chrome 桥服务 —— 桌面这一端。本地组件（`cli.js native-host`，Chrome 为扩展拉起）连到这里。
 *
 * 传输：POSIX 是 `~/.shuvix/chrome-bridge.sock`（0600），Windows 是 named pipe；一行一条 JSON。
 * 与 `cliServer` 不同，这里是**长连接、双向**：桌面向扩展要浏览器操作，扩展（侧边栏）向桌面
 * 调对话接口，事件两个方向都走。所以不复用 cliServer 那个一问一答就关的服务。
 *
 * 鉴权：本地组件的第一行是 `{auth: token}`，token 就是 `~/.shuvix/cli-token`（cliServer 每次启动
 * 生成、0600）。通过回 `{auth:'ok'}`，否则断开。之后才是桥消息（见 chat-protocol/chromeBridge）。
 *
 * 一条连接 = 一个浏览器 profile（扩展的 installId）。扩展先说 `hello`，协议版本对得上才算就绪；
 * 同一个 installId 再连上来（本地组件重启），旧连接让位。
 */
import { createServer, type Server, type Socket } from 'net'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { timingSafeEqual } from 'crypto'
import { v4 as uuid } from 'uuid'
import {
  BRIDGE_ERROR_PROTOCOL_MISMATCH,
  BridgeChunkAssembler,
  CHROME_BRIDGE_PROTOCOL,
  isBridgeMessage,
  splitBridgeMessage,
  type BridgeHello,
  type BridgeMessage,
  type BrowserOpMap,
  type BrowserOpName,
  type ChromeBrowserConnection,
  type DesktopEventMap
} from '@shuvix/chat-protocol/chromeBridge'
import { createLogger } from '../../logger'

const log = createLogger('ChromeBridge')

/** 浏览器操作的默认超时。CDP 命令偶尔很慢（大页面截图、awaitPromise 的 evaluate），宁宽勿紧 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** 连接断开时，挂着的请求统一以这句失败 */
export const CHROME_DISCONNECTED_ERROR = 'Chrome is no longer connected to ShuviX.'

/** 一个已就绪的浏览器（给设置页 / 状态展示） */
export interface ChromeBrowserInfo {
  installId: string
  runId: string
  browser: string
  extensionVersion: string
  connectedAt: number
}

/** 连接状态快照（设置页用）：mismatch = 扩展与桌面的协议版本对不上 */
export type ChromeConnectionStatus = ChromeBrowserConnection

/** 上层（Chrome 前端）挂进来的处理器 */
export interface ChromeBridgeHandlers {
  /** 扩展发来的请求（侧边栏的对话接口）；回结果或抛错（错误文本原样回给扩展） */
  onRequest?: (conn: BridgeConnection, method: string, params: unknown) => Promise<unknown>
  /** 扩展发来的事件（浏览器事件）；桥模块自己先消费 debugger / tabs 类，再转给这里 */
  onEvent?: (conn: BridgeConnection, name: string, params: unknown) => void
  /** 握手通过 */
  onReady?: (conn: BridgeConnection, hello: BridgeHello) => void
  /** 连接断开（就绪过的才会回调） */
  onClose?: (conn: BridgeConnection) => void
}

type ConnState = 'authing' | 'awaiting-hello' | 'ready' | 'mismatch' | 'closed'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 一条来自本地组件的连接（= 一个浏览器 profile） */
export class BridgeConnection {
  readonly id = uuid()
  private state: ConnState = 'authing'
  private hello: BridgeHello | null = null
  private helloProtocol = 0
  private connectedAt = 0
  private seq = 0
  private rest = ''
  private readonly pending = new Map<string, PendingRequest>()
  private readonly assembler = new BridgeChunkAssembler()

  constructor(
    private readonly socket: Socket,
    private readonly owner: ChromeBridgeServer
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (err) => log.warn(`connection error: ${err.message}`))
    socket.on('close', () => this.onClosed())
  }

  get ready(): boolean {
    return this.state === 'ready'
  }

  get alive(): boolean {
    return this.state !== 'closed'
  }

  /** 握手后才有；未就绪回 undefined */
  get info(): ChromeBrowserInfo | undefined {
    if (!this.hello) return undefined
    return {
      installId: this.hello.installId,
      runId: this.hello.runId,
      browser: this.hello.browser,
      extensionVersion: this.hello.extensionVersion,
      connectedAt: this.connectedAt
    }
  }

  status(): ChromeConnectionStatus | undefined {
    const info = this.info
    if (!info || (this.state !== 'ready' && this.state !== 'mismatch')) return undefined
    return { ...info, state: this.state, protocol: this.helloProtocol }
  }

  /** 向扩展要一次浏览器操作 */
  request<M extends BrowserOpName>(
    method: M,
    params: BrowserOpMap[M]['params'],
    opts?: { timeoutMs?: number }
  ): Promise<BrowserOpMap[M]['result']> {
    if (!this.ready) return Promise.reject(new Error(CHROME_DISCONNECTED_ERROR))
    const id = `d${++this.seq}`
    return new Promise((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(`Chrome did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s.`)
        )
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
      this.send({ type: 'request', id, method, params })
    })
  }

  /** 向扩展推一条事件 */
  emit<N extends keyof DesktopEventMap>(name: N, params: DesktopEventMap[N]): void {
    if (!this.ready) return
    this.send({ type: 'event', name, params })
  }

  /** 写一条桥消息；超过原生消息上限的自动分片 */
  send(message: BridgeMessage): void {
    if (this.state === 'closed') return
    const lines = splitBridgeMessage(message, {
      newId: () => `c${++this.seq}`,
      byteLength: (text) => Buffer.byteLength(text, 'utf8')
    })
    for (const line of lines) this.socket.write(line + '\n')
  }

  close(): void {
    this.socket.destroy()
  }

  // ─── 收 ───────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.rest += chunk.toString('utf8')
    const lines = this.rest.split('\n')
    this.rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        log.warn('dropped a malformed line from the native host')
        continue
      }
      if (this.state === 'authing') {
        this.onAuth(parsed)
        continue
      }
      if (isBridgeMessage(parsed)) this.onMessage(parsed)
    }
  }

  private onAuth(line: unknown): void {
    const token = (line as { auth?: unknown })?.auth
    if (typeof token !== 'string' || !this.owner.checkToken(token)) {
      log.warn('rejected a native host with a wrong token')
      this.socket.destroy()
      return
    }
    this.state = 'awaiting-hello'
    this.socket.write(JSON.stringify({ auth: 'ok' }) + '\n')
  }

  private onMessage(message: BridgeMessage): void {
    switch (message.type) {
      case 'hello':
        this.onHello(message)
        return
      case 'chunk': {
        const whole = this.assembler.push(message)
        if (whole) this.onMessage(whole)
        return
      }
      case 'response': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.ok) entry.resolve(message.result)
        else entry.reject(new Error(message.error || 'Chrome reported an error.'))
        return
      }
      case 'request':
        void this.onRequest(message.id, message.method, message.params)
        return
      case 'event':
        if (this.ready) this.owner.dispatchEvent(this, message.name, message.params)
        return
      default:
        return
    }
  }

  private onHello(hello: BridgeHello): void {
    if (
      typeof hello.installId !== 'string' ||
      !hello.installId ||
      typeof hello.runId !== 'string' ||
      !hello.runId
    ) {
      log.warn('ignored a hello without installId / runId')
      return
    }
    this.hello = {
      ...hello,
      openTabIds: Array.isArray(hello.openTabIds)
        ? hello.openTabIds.filter((id) => Number.isInteger(id))
        : []
    }
    this.helloProtocol = typeof hello.protocol === 'number' ? hello.protocol : 0
    this.connectedAt = Date.now()
    if (hello.protocol !== CHROME_BRIDGE_PROTOCOL) {
      this.state = 'mismatch'
      this.send({
        type: 'welcome',
        protocol: CHROME_BRIDGE_PROTOCOL,
        ok: false,
        error: BRIDGE_ERROR_PROTOCOL_MISMATCH
      })
      log.warn(
        `extension ${hello.extensionVersion} speaks protocol ${hello.protocol}, desktop ${CHROME_BRIDGE_PROTOCOL}`
      )
      this.owner.adopt(this)
      return
    }
    this.state = 'ready'
    this.send({ type: 'welcome', protocol: CHROME_BRIDGE_PROTOCOL, ok: true })
    log.info(`ready: ${hello.browser} (install ${hello.installId.slice(0, 8)})`)
    this.owner.adopt(this)
    this.owner.handlers.onReady?.(this, this.hello)
  }

  private async onRequest(id: string, method: string, params: unknown): Promise<void> {
    if (!this.ready) {
      this.send({
        type: 'response',
        id,
        ok: false,
        error: this.state === 'mismatch' ? BRIDGE_ERROR_PROTOCOL_MISMATCH : 'not-ready'
      })
      return
    }
    const handler = this.owner.handlers.onRequest
    if (!handler) {
      this.send({ type: 'response', id, ok: false, error: `Unknown method "${method}".` })
      return
    }
    try {
      const result = await handler(this, method, params)
      this.send({ type: 'response', id, ok: true, result: result ?? null })
    } catch (err) {
      this.send({
        type: 'response',
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private onClosed(): void {
    if (this.state === 'closed') return
    const wasReady = this.state === 'ready'
    this.state = 'closed'
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(CHROME_DISCONNECTED_ERROR))
    }
    this.pending.clear()
    this.assembler.clear()
    this.owner.release(this, wasReady)
  }
}

/** 桥服务：监听、鉴权、连接登记 */
export class ChromeBridgeServer {
  private server: Server | null = null
  private socketPath = ''
  private getToken: () => string = () => ''
  handlers: ChromeBridgeHandlers = {}
  /** 本模块内部先消费浏览器事件（CDP 状态），再交给上层 */
  private readonly internalEventHandlers = new Set<
    (conn: BridgeConnection, name: string, params: unknown) => void
  >()
  private readonly internalCloseHandlers = new Set<(conn: BridgeConnection) => void>()
  /** 握手过（ready / mismatch）的连接，按 installId */
  private readonly byInstall = new Map<string, BridgeConnection>()
  private readonly changeListeners = new Set<() => void>()

  async start(opts: { socketPath: string; getToken: () => string }): Promise<void> {
    if (this.server) return
    this.socketPath = opts.socketPath
    this.getToken = opts.getToken
    const isPipe = process.platform === 'win32'
    if (!isPipe) {
      mkdirSync(dirname(opts.socketPath), { recursive: true })
      if (existsSync(opts.socketPath)) {
        try {
          unlinkSync(opts.socketPath)
        } catch (err) {
          log.warn(`unlink stale socket failed: ${(err as Error).message}`)
        }
      }
    }
    const server = createServer((socket) => new BridgeConnection(socket, this))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    if (!isPipe) {
      try {
        chmodSync(opts.socketPath, 0o600)
      } catch (err) {
        log.warn(`chmod socket failed: ${(err as Error).message}`)
      }
    }
    server.on('error', (err) => log.warn(`server error: ${err.message}`))
    this.server = server
    log.info(`listening at ${opts.socketPath}`)
  }

  stop(): void {
    for (const conn of this.byInstall.values()) conn.close()
    this.byInstall.clear()
    if (this.server) {
      try {
        this.server.close()
      } catch {
        /* 已关 */
      }
      this.server = null
    }
    if (process.platform !== 'win32' && this.socketPath && existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath)
      } catch {
        /* 忽略 */
      }
    }
  }

  setHandlers(handlers: ChromeBridgeHandlers): void {
    this.handlers = handlers
  }

  /** 本模块内的消费者（CDP 状态路由）订阅扩展事件 */
  onExtensionEvent(
    fn: (conn: BridgeConnection, name: string, params: unknown) => void
  ): () => void {
    this.internalEventHandlers.add(fn)
    return () => this.internalEventHandlers.delete(fn)
  }

  /** 本模块内的消费者订阅连接断开 */
  onConnectionClosed(fn: (conn: BridgeConnection) => void): () => void {
    this.internalCloseHandlers.add(fn)
    return () => this.internalCloseHandlers.delete(fn)
  }

  /** 已就绪的连接（按 installId）；没连着 / 协议不符回 undefined */
  connectionFor(installId: string): BridgeConnection | undefined {
    const conn = this.byInstall.get(installId)
    return conn?.ready ? conn : undefined
  }

  /** 全部已就绪的连接 */
  readyConnections(): BridgeConnection[] {
    return [...this.byInstall.values()].filter((c) => c.ready)
  }

  /** 全部已握手的连接状态（设置页） */
  statuses(): ChromeConnectionStatus[] {
    return [...this.byInstall.values()]
      .map((c) => c.status())
      .filter((s): s is ChromeConnectionStatus => !!s)
      .sort((a, b) => b.connectedAt - a.connectedAt)
  }

  get listening(): boolean {
    return !!this.server
  }

  /** 连接集合变化（就绪 / 断开 / 协议不符）时回调 —— 设置页据此刷新 */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  // ─── 连接回调（BridgeConnection 用） ───────────

  /** @internal */
  checkToken(token: string): boolean {
    const expected = this.getToken()
    if (!expected) return false
    const a = Buffer.from(token)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** @internal 握手完成：登记，同一 installId 的旧连接让位 */
  adopt(conn: BridgeConnection): void {
    const installId = conn.info?.installId
    if (!installId) return
    const previous = this.byInstall.get(installId)
    if (previous && previous !== conn) previous.close()
    this.byInstall.set(installId, conn)
    this.notifyChange()
  }

  /** @internal 连接断开 */
  release(conn: BridgeConnection, wasReady: boolean): void {
    const installId = conn.info?.installId
    if (installId && this.byInstall.get(installId) === conn) this.byInstall.delete(installId)
    for (const fn of this.internalCloseHandlers) {
      try {
        fn(conn)
      } catch (err) {
        log.warn(`close handler failed: ${(err as Error).message}`)
      }
    }
    if (wasReady) this.handlers.onClose?.(conn)
    this.notifyChange()
  }

  /** @internal 扩展事件：先模块内，再上层 */
  dispatchEvent(conn: BridgeConnection, name: string, params: unknown): void {
    for (const fn of this.internalEventHandlers) {
      try {
        fn(conn, name, params)
      } catch (err) {
        log.warn(`event handler failed (${name}): ${(err as Error).message}`)
      }
    }
    try {
      this.handlers.onEvent?.(conn, name, params)
    } catch (err) {
      log.warn(`event handler failed (${name}): ${(err as Error).message}`)
    }
  }

  private notifyChange(): void {
    for (const fn of this.changeListeners) {
      try {
        fn()
      } catch {
        /* 监听者自己的问题 */
      }
    }
  }
}

/** 进程单例 */
export const chromeBridge = new ChromeBridgeServer()
