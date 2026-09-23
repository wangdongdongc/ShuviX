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
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { timingSafeEqual } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { v4 as uuid } from 'uuid'
import {
  BRIDGE_ERROR_ALREADY_CONNECTED,
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

/** 连上来之后多久内得说出正确的 token —— 过时不候（本地组件连上就发，正常是毫秒级） */
const AUTH_TIMEOUT_MS = 10_000

/** 顶替一条已有连接之前，探活等它多久（本地一问一答，2 秒足够） */
const TAKEOVER_PING_TIMEOUT_MS = 2_000

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

/**
 * `refused` 与 `closed` 的差别是有意的：被拒之后 socket 还要走完它自己的 close 事件，
 * 那一下才是登记表里摘掉它的时机（`onClosed` 遇到 `closed` 直接返回）。
 */
type ConnState = 'authing' | 'awaiting-hello' | 'ready' | 'mismatch' | 'refused' | 'closed'

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
  /**
   * 按字节流解码：一个多字节字符（中文、emoji）被拆在两次 `data` 之间时，前半截留在解码器里等
   * 后半截。逐块 `toString('utf8')` 会把两半各自换成 U+FFFD，而 JSON 照样能解析 —— 内容被悄悄
   * 改坏，谁也发现不了。
   */
  private readonly decoder = new StringDecoder('utf8')
  private readonly pending = new Map<string, PendingRequest>()
  private readonly assembler = new BridgeChunkAssembler((reason) =>
    log.warn(`dropped an incomplete chunk group: ${reason}`)
  )
  private authTimer: ReturnType<typeof setTimeout> | null

  constructor(
    private readonly socket: Socket,
    private readonly owner: ChromeBridgeServer
  ) {
    socket.on('data', (chunk: Buffer | string) => this.onData(chunk))
    socket.on('error', (err) => log.warn(`connection error: ${err.message}`))
    socket.on('close', () => this.onClosed())
    this.authTimer = setTimeout(() => {
      if (this.state !== 'authing') return
      log.warn('dropped a connection that did not authenticate in time')
      this.socket.destroy()
    }, AUTH_TIMEOUT_MS)
    this.authTimer.unref?.()
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

  private onData(chunk: Buffer | string): void {
    if (this.state === 'closed') return
    this.rest += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const lines = this.rest.split('\n')
    this.rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        if (this.state === 'authing') {
          // 第一行就不是 JSON：不是本地组件，不陪它等
          log.warn('rejected a connection whose first line is not JSON')
          this.socket.destroy()
          return
        }
        log.warn('dropped a malformed line from the native host')
        continue
      }
      if (this.state === 'authing') {
        this.onAuth(parsed)
        if (this.state === 'authing') return // 被拒：socket 已销毁，余下的行不再处理
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
    this.clearAuthTimer()
    this.state = 'awaiting-hello'
    this.socket.write(JSON.stringify({ auth: 'ok' }) + '\n')
  }

  private onMessage(message: BridgeMessage): void {
    switch (message.type) {
      case 'hello':
        // 一条连接只握一次手：再来一个 hello（尤其换了 installId）会让登记表里留下一条
        // 指向这条连接的旧记录
        if (this.state !== 'awaiting-hello') {
          log.warn('ignored a second hello on the same connection')
          return
        }
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
    // 同一个 installId 已有连接时要先探活，所以「就绪还是被拒」由 owner 决定（见 claim）
    void this.owner.claim(this)
  }

  /** @internal claim 放行：登记为就绪并回 welcome */
  markReady(): BridgeHello | undefined {
    if (this.state !== 'awaiting-hello' || !this.hello) return undefined
    this.state = 'ready'
    this.send({ type: 'welcome', protocol: CHROME_BRIDGE_PROTOCOL, ok: true })
    log.info(`ready: ${this.hello.browser} (install ${this.hello.installId.slice(0, 8)})`)
    return this.hello
  }

  /** @internal claim 拒绝：说清理由再收线（对面据此显示，不会当成「桌面没开」一直重试） */
  refuse(error: string): void {
    this.send({ type: 'welcome', protocol: CHROME_BRIDGE_PROTOCOL, ok: false, error })
    this.state = 'refused'
    this.socket.end()
  }

  /** @internal welcome 已经发出去了，收线（等它自己 close，登记表在那时摘） */
  endAfterWelcome(): void {
    this.state = 'refused'
    this.socket.end()
  }

  /** @internal 探活：只走协议层的 ping，不碰浏览器（`alive` 是「socket 还没关」，这里问的是「还答不答话」） */
  async respondsToPing(): Promise<boolean> {
    if (!this.ready) return false
    return this.request('bridge.ping', {}, { timeoutMs: TAKEOVER_PING_TIMEOUT_MS }).then(
      () => true,
      () => false
    )
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

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer)
    this.authTimer = null
  }

  private onClosed(): void {
    if (this.state === 'closed') return
    const wasReady = this.state === 'ready'
    this.state = 'closed'
    this.clearAuthTimer()
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
  private addressFile = ''
  private getToken: () => string = () => ''
  handlers: ChromeBridgeHandlers = {}
  /** 本模块内部先消费浏览器事件（CDP 状态），再交给上层 */
  private readonly internalEventHandlers = new Set<
    (conn: BridgeConnection, name: string, params: unknown) => void
  >()
  private readonly internalCloseHandlers = new Set<(conn: BridgeConnection) => void>()
  private readonly internalReadyHandlers = new Set<(conn: BridgeConnection) => void>()
  /** 全部活着的连接（含还没鉴权 / 还没握手的）—— stop 时一并关掉 */
  private readonly connections = new Set<BridgeConnection>()
  /** 握手过（ready / mismatch）的连接，按 installId */
  private readonly byInstall = new Map<string, BridgeConnection>()
  /** 正在处理的 claim（按 installId 串行，见 claim） */
  private readonly claiming = new Map<string, Promise<void>>()
  private readonly changeListeners = new Set<() => void>()

  async start(opts: {
    socketPath: string
    getToken: () => string
    /** 实际地址写到这里，本地组件每次重连现读（Windows 的管道名每次启动都不一样，见协议包） */
    addressFile?: string
  }): Promise<void> {
    if (this.server) return
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
    const server = createServer((socket) => {
      this.connections.add(new BridgeConnection(socket, this))
    })
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
    // 监听成功之后才认领这两个路径：listen 失败（端口/管道被占）的那个实例不能在自己
    // stop 的时候把**在用的那一份**地址文件删掉
    this.socketPath = opts.socketPath
    this.addressFile = opts.addressFile ?? ''
    if (this.addressFile) {
      try {
        mkdirSync(dirname(this.addressFile), { recursive: true })
        writeFileSync(this.addressFile, opts.socketPath, 'utf-8')
        if (!isPipe) chmodSync(this.addressFile, 0o600)
      } catch (err) {
        log.warn(`write address file failed: ${(err as Error).message}`)
      }
    }
    log.info(`listening at ${opts.socketPath}`)
  }

  stop(): void {
    for (const conn of [...this.connections]) conn.close()
    this.connections.clear()
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
    if (this.addressFile && existsSync(this.addressFile)) {
      try {
        unlinkSync(this.addressFile)
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

  /** 本模块内的消费者订阅握手就绪（先于上层的 onReady） */
  onConnectionReady(fn: (conn: BridgeConnection) => void): () => void {
    this.internalReadyHandlers.add(fn)
    return () => this.internalReadyHandlers.delete(fn)
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
  async claim(conn: BridgeConnection): Promise<void> {
    const installId = conn.info?.installId
    if (!installId) return
    const inflight = this.claiming.get(installId)
    const previous = this.byInstall.get(installId)
    // 没人占着、也没有别的 claim 在跑：当场就绪。这条路必须是**同步**的 —— 握手那一下就该
    // 有一条就绪的连接，插一个微任务进去，紧跟着 hello 的第一条请求就会撞上「还没就绪」
    if (!inflight && !(previous && previous !== conn && previous.ready)) {
      this.accept(conn, installId)
      return
    }
    // 有争用：按 installId 串起来。两条新连接同时来、旧的又不答话时，两条都会等满超时、
    // 都以为自己接手了 —— 结果一条「就绪」却没登记，什么都收不到
    const run = (inflight ?? Promise.resolve()).then(() => this.settleClaim(conn, installId))
    const settled = run.catch(() => undefined)
    this.claiming.set(installId, settled)
    void settled.then(() => {
      if (this.claiming.get(installId) === settled) this.claiming.delete(installId)
    })
    await run
  }

  /** 争用时的裁决：旧的还答话就拒绝新的，不答话才让位 */
  private async settleClaim(conn: BridgeConnection, installId: string): Promise<void> {
    if (!conn.alive) return
    const previous = this.byInstall.get(installId)
    if (previous && previous !== conn && previous.ready) {
      // 顶替不能是静默的：拿到 token 的本地进程报一个在用的 installId，否则就能把真浏览器
      // 挤下线、接手它那些标签页会话
      if (await previous.respondsToPing()) {
        log.warn(
          `refused a second connection for install ${installId.slice(0, 8)}: the first one is still answering`
        )
        conn.refuse(BRIDGE_ERROR_ALREADY_CONNECTED)
        return
      }
      log.info(`replacing a connection that stopped answering (install ${installId.slice(0, 8)})`)
      previous.close()
    }
    this.accept(conn, installId)
  }

  /** 登记为就绪并回 welcome（两条路径共用） */
  private accept(conn: BridgeConnection, installId: string): void {
    if (!conn.alive) return
    const hello = conn.markReady()
    if (!hello) return // 这期间它自己断了
    this.byInstall.set(installId, conn)
    this.notifyChange()
    this.announceReady(conn, hello)
  }

  /**
   * @internal 协议版本对不上的连接也登记（设置页要显示「请更新扩展」），但不算就绪。
   *
   * 这个 installId 上已经有一条**活着**的连接时不登记：登记表一个 installId 只有一格，
   * 顶掉真在用的那条去显示一条版本不符的，是本末倒置 —— 那条说完自己的 welcome 就收线。
   */
  adopt(conn: BridgeConnection): void {
    const installId = conn.info?.installId
    if (!installId) return
    const previous = this.byInstall.get(installId)
    if (previous && previous !== conn && previous.ready) {
      conn.endAfterWelcome()
      return
    }
    if (previous && previous !== conn) previous.close()
    this.byInstall.set(installId, conn)
    this.notifyChange()
  }

  /** @internal 握手就绪：模块内的消费者先知道（CDP 记账要在任何请求之前归零），再是上层 */
  announceReady(conn: BridgeConnection, hello: BridgeHello): void {
    for (const fn of this.internalReadyHandlers) {
      try {
        fn(conn)
      } catch (err) {
        log.warn(`ready handler failed: ${(err as Error).message}`)
      }
    }
    this.handlers.onReady?.(conn, hello)
  }

  /** @internal 连接断开 */
  release(conn: BridgeConnection, wasReady: boolean): void {
    this.connections.delete(conn)
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
