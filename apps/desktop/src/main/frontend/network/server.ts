/**
 * 网络服务本体（server mode phase B，docs/server/phase-bc-network-and-web.md §B2）—— 只在用户打开「网络访问」时存在：
 *
 *  - `node:http` 监听 `0.0.0.0:<端口>`：静态路由给 web 客户端（`staticFiles.ts`）；`/ws` 上用 `ws` 升级成 WebSocket；
 *  - **每个请求与每次升级都过三道门**（`guards.ts`）：对端地址必须私有（否则 403）、Host 必须是 IP 字面量或 localhost
 *    带我们的端口（否则 421）、升级的 Origin 必须恰是 `http://<Host>`（否则 403）。这不是认证（这一轮没有）；
 *  - 一条 WebSocket = 一个网络客户端（`ws:<n>`）：消息按 `networkEnvelope` 解码，`invoke` / `send` 交分发器
 *    （注册表里的同一份定义），`sync` 交视图同步链路表；推送经网络传输（`transport.ts`）回到这条连接；
 *  - 心跳（ping / pong）认出睡死的连接；发送缓冲积压过多的慢客户端直接断开（不让主进程的内存替它攒着）；
 *  - `stop()`：每条连接以 1001 关掉、HTTP 服务关掉（连同还开着的 keep-alive 连接）。
 *
 * 连接建出来 / 关掉时回调服务（`index.ts`：注册 / 注销聊天前端、发 `network.changed`）。
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  decodeClientMessage,
  encodeServerMessage,
  malformedInvokeId,
  NETWORK_WS_PATH,
  type ServerMessage
} from '../../../shared/networkEnvelope'
import type { ClientContext, NetworkClientRef } from '../../ipc/registry'
import type { NetworkDispatcher } from './dispatch'
import { displayPeerAddress, isAllowedHost, isAllowedOrigin, isPrivatePeerAddress } from './guards'
import type { NetworkLinkHub } from './networkLinks'
import { mimeTypeOf, resolveStaticRequest } from './staticFiles'
import { fileRouteOf, serveFileRoute, type FileRouteDeps } from './fileRoutes'
import { proxyWidgetRequest, type WidgetProxyDeps } from './widgetProxy'
import { NETWORK_WIDGET_PREFIX } from '../../../shared/networkRoutes'
import type { NetworkConnection, NetworkTransport } from './transport'

/** 一条消息的上限（附图的提示词会有几 MB） */
export const MAX_NETWORK_MESSAGE_BYTES = 64 * 1024 * 1024

/** 发送缓冲积压超过它就断开那个客户端 */
export const MAX_NETWORK_BUFFERED_BYTES = 64 * 1024 * 1024

/** 同时连着的客户端上限 */
export const MAX_NETWORK_CLIENTS = 32

/** 心跳间隔：一个间隔里没回 pong 的连接下一拍断开 */
export const NETWORK_HEARTBEAT_MS = 30_000

/** stop 时等关闭握手的上限，过了就强行断开 */
const STOP_GRACE_MS = 1000

/** User-Agent 记下的长度上限 */
const MAX_USER_AGENT_CHARS = 512

export interface NetworkServerLogger {
  info(message: string): void
  warn(message: string): void
}

export interface NetworkServerDeps {
  readonly transport: NetworkTransport
  readonly dispatcher: NetworkDispatcher
  readonly links: NetworkLinkHub
  /** 渲染端构建产物目录（绝对路径；现取，构建产物可以后到） */
  readonly rendererDir: () => string
  /** 文件路由（`/files/*`、`/lib/*`，phase D；现取）；没有 → 这些路径落到静态文件（404） */
  readonly fileRoutes?: () => FileRouteDeps | undefined
  /** widget 转发（`/w/*`，phase D；现取）；没有 → 这些路径落到静态文件（404） */
  readonly widgetProxy?: () => WidgetProxyDeps | undefined
  /** 一个客户端连上了（已经进了传输的表） */
  readonly onConnection?: (connection: NetworkConnection) => void
  /** 一个客户端走了（已经从传输的表里摘掉、链路已结束） */
  readonly onDisconnection?: (connection: NetworkConnection) => void
  /**
   * 对端地址的附加一道门（只开放给一个网络时：对端必须在那个网段里；现取）。不给 / 回 true → 只看原有的私有地址那道门
   */
  readonly acceptPeer?: (address: string) => boolean
  readonly logger?: NetworkServerLogger
  readonly heartbeatMs?: number
  readonly maxBufferedBytes?: number
  readonly maxClients?: number
}

export interface NetworkServer {
  /** 开始监听；回真正绑上的端口（`port` 给 0 时由系统挑）。监听失败（端口被占 …）→ 拒绝，服务回到未监听 */
  start(port: number, host?: string): Promise<number>
  /** 关掉每条连接（1001）与 HTTP 服务；没在监听 → 什么也不做 */
  stop(reason?: string): Promise<void>
  /** 此刻在监听的端口；没在监听 → undefined */
  readonly port: number | undefined
  /** 此刻监听的地址（`127.0.0.1` / `0.0.0.0` …）；没在监听 → undefined */
  readonly host: string | undefined
}

let connectionSeq = 0

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  421: 'Misdirected Request',
  500: 'Internal Server Error',
  503: 'Service Unavailable'
}

/**
 * 三道门里的前两道（每个请求、每次升级都过）：不过 → 状态码 + 一句话；过了 → undefined。`acceptPeer`：只开放给一个
 * 网络时，对端还得在那个网段里
 */
export function requestRejection(
  remoteAddress: string | undefined,
  host: string | undefined,
  port: number,
  acceptPeer?: (address: string) => boolean
): { status: number; text: string } | undefined {
  if (!isPrivatePeerAddress(remoteAddress)) {
    return { status: 403, text: 'ShuviX only accepts connections from the local network.' }
  }
  if (acceptPeer !== undefined && !acceptPeer(displayPeerAddress(remoteAddress))) {
    return {
      status: 403,
      text: 'ShuviX only accepts connections from the network it is shared on.'
    }
  }
  if (!isAllowedHost(host, port)) {
    return { status: 421, text: 'Use an IP address or localhost with the ShuviX port.' }
  }
  return undefined
}

function plain(res: ServerResponse, status: number, text: string, close = false): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(close ? { Connection: 'close' } : {})
  })
  res.end(text)
}

/**
 * 拒掉一次升级：写一个最小的 HTTP 应答，写完再断开（socket 已经不归 http 服务管了；同步 destroy 可能把还没
 * 冲出去的应答丢掉）。对端不读也不会挂着：一小会儿之后照样断开
 */
function rejectUpgrade(socket: Socket, status: number, text: string): void {
  const fallback = setTimeout(() => socket.destroy(), 1000)
  fallback.unref?.()
  try {
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` +
        text,
      () => {
        clearTimeout(fallback)
        socket.destroy()
      }
    )
  } catch {
    clearTimeout(fallback)
    socket.destroy()
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

export function createNetworkServer(deps: NetworkServerDeps): NetworkServer {
  const logger = deps.logger ?? { info: () => {}, warn: () => {} }
  const heartbeatMs = deps.heartbeatMs ?? NETWORK_HEARTBEAT_MS
  const maxBuffered = deps.maxBufferedBytes ?? MAX_NETWORK_BUFFERED_BYTES
  const maxClients = deps.maxClients ?? MAX_NETWORK_CLIENTS

  let http: Server | undefined
  let wss: WebSocketServer | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let boundPort: number | undefined
  let boundHost: string | undefined
  /** 每条连接：上一拍之后回过 pong 没有 */
  const alive = new Map<WebSocket, boolean>()
  /** 还没真正关掉的 socket（关闭握手可能还在途中）—— stop 等一小会儿之后强行断开剩下的 */
  const sockets = new Set<WebSocket>()
  /** 正在握手的升级数（还没进传输的表） */
  let upgrading = 0

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const resolution = resolveStaticRequest(req.method, req.url, deps.rendererDir())
    switch (resolution.kind) {
      case 'method-not-allowed':
        res.setHeader('Allow', 'GET, HEAD')
        plain(res, 405, 'Method not allowed.')
        return
      case 'bad-request':
        plain(res, 400, 'Bad request.')
        return
      case 'not-found':
        plain(res, 404, 'Not found.')
        return
      case 'file':
        break
    }
    let size: number
    try {
      const stat = statSync(resolution.path)
      if (!stat.isFile()) throw new Error('not a file')
      size = stat.size
    } catch {
      if (resolution.entry) {
        plain(res, 503, 'The ShuviX web client is not built (web.html is missing).')
      } else {
        plain(res, 404, 'Not found.')
      }
      return
    }
    res.writeHead(200, {
      'Content-Type': mimeTypeOf(resolution.path),
      'Content-Length': size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(resolution.path)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    const port = boundPort ?? -1
    const rejection = requestRejection(
      req.socket.remoteAddress,
      req.headers.host,
      port,
      deps.acceptPeer
    )
    if (rejection) {
      plain(res, rejection.status, rejection.text, true)
      return
    }
    try {
      if (serveDynamic(req, res)) return
      serveStatic(req, res)
    } catch (error) {
      logger.warn(`network: static request ${req.url} failed: ${String(error)}`)
      plain(res, 500, 'Internal error.')
    }
  }

  /**
   * phase D 的动态路由：`/w/…` 转给 widget 服务，`/files/…` / `/lib/…` 回文件。认领了 → true（应答由它负责）
   */
  function serveDynamic(req: IncomingMessage, res: ServerResponse): boolean {
    const raw = typeof req.url === 'string' && req.url.length > 0 ? req.url : '/'
    const pathname = raw.split('?')[0].split('#')[0]
    const widgetProxy = deps.widgetProxy?.()
    if (widgetProxy && pathname.startsWith(NETWORK_WIDGET_PREFIX)) {
      proxyWidgetRequest(req, res, widgetProxy)
      return true
    }
    const fileRoutes = deps.fileRoutes?.()
    const route = fileRoutes ? fileRouteOf(pathname) : undefined
    if (route === undefined || !fileRoutes) return false
    let url: URL
    try {
      url = new URL(raw, 'http://shuvix.invalid')
    } catch {
      plain(res, 400, 'Bad request.')
      return true
    }
    void serveFileRoute(route, req, res, url, fileRoutes).catch((error) => {
      logger.warn(`network: file request ${req.url} failed: ${String(error)}`)
      plain(res, 500, 'Internal error.')
    })
    return true
  }

  function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => socket.destroy())
    const port = boundPort ?? -1
    const rejection = requestRejection(
      req.socket.remoteAddress,
      req.headers.host,
      port,
      deps.acceptPeer
    )
    if (rejection) {
      rejectUpgrade(socket, rejection.status, rejection.text)
      return
    }
    const path = (req.url ?? '').split('?')[0]
    if (path !== NETWORK_WS_PATH) {
      rejectUpgrade(socket, 404, 'Not found.')
      return
    }
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      rejectUpgrade(socket, 403, 'Cross-origin WebSocket connections are refused.')
      return
    }
    // 握手途中的也算上：几次升级同时到，不该一起越过上限
    if (deps.transport.connections().length + upgrading >= maxClients) {
      rejectUpgrade(socket, 503, 'Too many ShuviX web clients are connected.')
      return
    }
    const server = wss
    if (!server) {
      rejectUpgrade(socket, 503, 'ShuviX network access is shutting down.')
      return
    }
    upgrading++
    let counted = true
    const settle = (): void => {
      if (!counted) return
      counted = false
      upgrading--
    }
    socket.once('close', settle)
    server.handleUpgrade(req, socket, head, (ws) => {
      settle()
      accept(ws, req)
    })
  }

  function accept(ws: WebSocket, req: IncomingMessage): void {
    const userAgent = req.headers['user-agent']
    const client: NetworkClientRef = {
      kind: 'network',
      id: `ws:${++connectionSeq}`,
      remoteAddress: displayPeerAddress(req.socket.remoteAddress),
      userAgent: (typeof userAgent === 'string' ? userAgent : '').slice(0, MAX_USER_AGENT_CHARS)
    }
    const ctx: ClientContext = { client, transport: 'network' }
    const closeHandlers = new Set<() => void>()
    let open = true

    const finish = (): void => {
      if (!open) return
      open = false
      alive.delete(ws)
      deps.links.closeConnection(client.id)
      for (const handler of [...closeHandlers]) {
        try {
          handler()
        } catch (error) {
          logger.warn(`network: close handler for ${client.id} failed: ${String(error)}`)
        }
      }
      closeHandlers.clear()
      deps.onDisconnection?.(connection)
      logger.info(`network: client ${client.id} (${client.remoteAddress}) disconnected`)
    }

    const isOpen = (): boolean => open && ws.readyState === ws.OPEN

    /**
     * 编码一条消息。编不出来（处理函数回了 BigInt / 循环引用之类 JSON 装不下的东西）：结果换成一条失败结果
     * （否则对面那次调用永远等不到回音），推送与视图帧抛出（推送丢掉，链路随之结束）
     */
    const encode = (message: ServerMessage): string => {
      try {
        return encodeServerMessage(message)
      } catch (error) {
        logger.warn(`network: could not encode a ${message.t} for ${client.id}: ${String(error)}`)
        if (message.t !== 'result') throw error
        return encodeServerMessage({
          t: 'result',
          id: message.id,
          ok: false,
          error: {
            message: 'The result could not be sent over the network.',
            code: 'handler_error'
          }
        })
      }
    }

    const transmit = (message: ServerMessage): void => {
      if (ws.bufferedAmount > maxBuffered) {
        logger.warn(`network: client ${client.id} is not reading; disconnecting it`)
        connection.close(1008, 'client too slow')
        throw new Error('network client too slow')
      }
      ws.send(encode(message))
    }

    const connection: NetworkConnection = {
      client,
      connectedAt: Date.now(),
      isOpen,
      send(message) {
        if (!isOpen()) return
        try {
          transmit(message)
        } catch {
          /* 已经在断开 */
        }
      },
      close(code, reason) {
        if (!open) return
        try {
          ws.close(code, reason)
        } catch {
          ws.terminate()
        }
        finish()
      },
      onClose(callback) {
        if (!open) {
          let cancelled = false
          queueMicrotask(() => {
            if (!cancelled) callback()
          })
          return () => {
            cancelled = true
          }
        }
        const entry = (): void => callback()
        closeHandlers.add(entry)
        return () => {
          closeHandlers.delete(entry)
        }
      }
    }

    const linkConnection = {
      id: client.id,
      remoteAddress: client.remoteAddress,
      isOpen,
      sendSync(link: string, frame: unknown): void {
        if (!isOpen()) throw new Error('network client disconnected')
        transmit({ t: 'sync', link, frame })
      }
    }

    ws.on('message', (data, isBinary) => {
      if (!open || isBinary) return
      const text = rawText(data)
      const message = decodeClientMessage(text)
      if (message === undefined) {
        // 认得出 id 的坏 invoke 照样回一条失败结果：不让对面那次调用永远等下去
        const id = malformedInvokeId(text)
        if (id !== undefined) {
          connection.send({
            t: 'result',
            id,
            ok: false,
            error: { message: 'Malformed request.', code: 'bad_request' }
          })
        }
        return
      }
      switch (message.t) {
        case 'invoke':
          void deps.dispatcher.invoke(ctx, message).then((result) => connection.send(result))
          return
        case 'send':
          deps.dispatcher.send(ctx, message)
          return
        case 'sync':
          deps.links.receive(linkConnection, message.link, message.frame)
          return
      }
    })
    ws.on('pong', () => alive.set(ws, true))
    ws.on('close', () => {
      sockets.delete(ws)
      finish()
    })
    ws.on('error', (error) => {
      logger.warn(`network: client ${client.id} socket error: ${String(error)}`)
      finish()
    })

    alive.set(ws, true)
    sockets.add(ws)
    deps.transport.add(connection)
    logger.info(`network: client ${client.id} connected from ${client.remoteAddress}`)
    deps.onConnection?.(connection)
  }

  function beat(): void {
    for (const [ws, answered] of [...alive]) {
      if (!answered) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }
  }

  return {
    get port() {
      return boundPort
    },

    get host() {
      return boundPort === undefined ? undefined : boundHost
    },

    async start(port, host = '0.0.0.0') {
      if (http) throw new Error('network server is already running')
      const server = createServer(onRequest)
      server.on('upgrade', onUpgrade)
      server.on('clientError', (_error, socket) => socket.destroy())
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
      server.on('error', (error) => logger.warn(`network: server error: ${String(error)}`))
      http = server
      boundPort = (server.address() as AddressInfo).port
      boundHost = host
      wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NETWORK_MESSAGE_BYTES })
      heartbeat = setInterval(beat, heartbeatMs)
      heartbeat.unref?.()
      logger.info(`network: listening on ${host}:${boundPort}`)
      return boundPort
    },

    async stop(reason = 'network access turned off') {
      const server = http
      if (!server) return
      http = undefined
      boundPort = undefined
      if (heartbeat !== undefined) clearInterval(heartbeat)
      heartbeat = undefined
      // 先停止接受新连接（监听句柄当场关掉，同一个端口马上就能再绑），再关每条连接
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      deps.transport.closeAll(1001, reason)
      wss?.close()
      wss = undefined
      // 关闭握手给一小会儿；还没走完的强行断开（对面可能已经睡死）
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))])
      for (const ws of [...sockets]) ws.terminate()
      sockets.clear()
      logger.info('network: stopped listening')
    }
  }
}
