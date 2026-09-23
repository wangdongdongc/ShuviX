/**
 * 原生消息宿主 —— Chrome 为 ShuviX 扩展拉起的本地组件（`cli.js native-host`）。
 *
 * 由宿主清单（`com.shuvix.chrome_bridge.json`，桌面启动时写进各浏览器的 NativeMessagingHosts）
 * 指向的启动脚本拉起：Electron 以 node 模式跑本文件所在的 cli.js。Chrome 只为清单
 * `allowed_origins` 里的那个扩展拉起它，扩展一关端口它的 stdin 就结束、进程随之退出。
 *
 * **它是透明转发**：stdin 的原生消息帧（4 字节小端长度 + UTF-8 JSON）→ socket 上的一行 JSON；
 * socket 的一行 → stdout 的一帧。业务消息一律不解析（协议在扩展与桌面两端，见
 * `@shuvix/chat-protocol/chromeBridge`），它自己只多做三件事：
 *  - 连桌面的桥服务并鉴权（第一行 `{auth: token}`，token 读 `~/.shuvix/cli-token`，桌面每次启动都会
 *    重写，所以每次连都重读）；
 *  - 桌面没开 / 断了就隔几秒重连，并把状态告诉扩展（`{type:'host', desktop}`）；
 *  - 桌面不在时，扩展发来的请求由它直接回 `desktop-offline`，侧边栏据此显示空状态 —— 不必
 *    每个请求都等超时。
 *
 * **stdout 只能写原生消息帧**：任何日志都走 stderr，否则 Chrome 读到的是一帧坏数据、直接断开。
 */
import { connect, type Socket } from 'net'
import type { Readable, Writable } from 'stream'
import { StringDecoder } from 'string_decoder'
import {
  BRIDGE_ERROR_DESKTOP_OFFLINE,
  CHROME_NATIVE_MESSAGE_MAX_BYTES,
  type BridgeHostStatus,
  type BridgeResponse
} from '@shuvix/chat-protocol/chromeBridge'

// ────────────────────── 原生消息封帧 ──────────────────────

/** 原生消息的一帧：4 字节长度（本机字节序 —— Chrome 支持的平台都是小端）+ UTF-8 正文 */
export function encodeNativeMessage(text: string): Buffer {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  return Buffer.concat([head, body])
}

/** 逐块喂 stdin 的字节，吐出凑齐的消息正文 */
export class NativeMessageReader {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): string[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: string[] = []
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0)
      if (this.buf.length < 4 + len) break
      out.push(this.buf.subarray(4, 4 + len).toString('utf8'))
      this.buf = this.buf.subarray(4 + len)
    }
    return out
  }
}

/**
 * 按行切 socket 上的文本流。按字节流解码：多字节字符被拆在两次 `data` 之间时，前半截留在解码器里
 * 等后半截 —— 逐块 `toString('utf8')` 会把两半各换成 U+FFFD，而 JSON 照样能解析，内容被悄悄改坏。
 */
class LineReader {
  private rest = ''
  private readonly decoder = new StringDecoder('utf8')

  push(chunk: Buffer): string[] {
    this.rest += this.decoder.write(chunk)
    const lines = this.rest.split('\n')
    this.rest = lines.pop() ?? ''
    return lines.filter((l) => l.length > 0)
  }
}

// ────────────────────── 宿主本体 ──────────────────────

export interface NativeHostOptions {
  /**
   * 桌面桥服务的地址。给函数的话**每次重连都现算**：桌面重启后地址可能变了
   * （Windows 的管道名每次启动带一个随机后缀，见 `chromeBridgeAddressFile`）。
   */
  socketPath: string | (() => string | undefined)
  /** 读鉴权 token；读不到（桌面从没启动过）回 undefined */
  readToken: () => string | undefined
  /** 重连间隔（毫秒），按失败次数取，用完后一直取最后一个 */
  retryDelaysMs?: readonly number[]
  /** 日志（写 stderr；stdout 是帧通道） */
  log?: (message: string) => void
}

export interface NativeHostHandle {
  /** stdin 结束（扩展关了端口）或被 stop 之后兑现 */
  done: Promise<void>
  stop: () => void
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000] as const

type LinkState = 'offline' | 'connecting' | 'authing' | 'connected'

export function runNativeHost(
  stdin: Readable,
  stdout: Writable,
  opts: NativeHostOptions
): NativeHostHandle {
  const log = opts.log ?? (() => {})
  const delays = opts.retryDelaysMs?.length ? opts.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS
  const reader = new NativeMessageReader()

  let state: LinkState = 'offline'
  let socket: Socket | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  let stopped = false
  /** 上次告诉扩展的桌面状态 —— 只在变化时说，重连循环里不刷屏 */
  let reported: BridgeHostStatus['desktop'] | null = null
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })

  const writeFrame = (text: string): void => {
    if (stopped) return
    try {
      stdout.write(encodeNativeMessage(text))
    } catch (err) {
      log(`write to extension failed: ${(err as Error).message}`)
      stop()
    }
  }

  const report = (desktop: BridgeHostStatus['desktop']): void => {
    if (reported === desktop) return
    reported = desktop
    const status: BridgeHostStatus = { type: 'host', desktop }
    writeFrame(JSON.stringify(status))
  }

  /** 桌面发来的一行 → 扩展。超过原生消息上限的丢掉（桌面该分片而没分，是桌面的 bug） */
  const relayToExtension = (line: string): void => {
    if (Buffer.byteLength(line, 'utf8') > CHROME_NATIVE_MESSAGE_MAX_BYTES) {
      log(`dropped an oversized message from the desktop (${Buffer.byteLength(line)} bytes)`)
      return
    }
    try {
      JSON.parse(line)
    } catch {
      log('dropped a malformed line from the desktop')
      return
    }
    writeFrame(line)
  }

  /** 扩展发来的一条 → 桌面；桌面不在时请求当场回错，其余丢掉 */
  const relayToDesktop = (text: string): void => {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      log('dropped a malformed message from the extension')
      return
    }
    if (state === 'connected' && socket) {
      // 重新序列化：保证一条就是一行（扩展侧的序列化本就紧凑，这里不赌）
      socket.write(JSON.stringify(message) + '\n')
      return
    }
    const request = message as { type?: unknown; id?: unknown }
    if (request.type === 'request' && typeof request.id === 'string') {
      const response: BridgeResponse = {
        type: 'response',
        id: request.id,
        ok: false,
        error: BRIDGE_ERROR_DESKTOP_OFFLINE
      }
      writeFrame(JSON.stringify(response))
    }
    // hello 这类在桌面不在时无处可去：扩展收到 host:connected 后会重说一遍
    report('offline')
  }

  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return
    const delay = delays[Math.min(failures, delays.length - 1)]
    failures++
    retryTimer = setTimeout(() => {
      retryTimer = null
      connectDesktop()
    }, delay)
  }

  const dropLink = (): void => {
    const wasConnected = state === 'connected'
    state = 'offline'
    socket = null
    if (wasConnected) log('desktop disconnected')
    report('offline')
    scheduleRetry()
  }

  function connectDesktop(): void {
    if (stopped) return
    const token = opts.readToken()
    const target = typeof opts.socketPath === 'function' ? opts.socketPath() : opts.socketPath
    if (!token || !target) {
      report('offline')
      scheduleRetry()
      return
    }
    state = 'connecting'
    const lines = new LineReader()
    const sock = connect(target)
    socket = sock
    sock.on('connect', () => {
      state = 'authing'
      sock.write(JSON.stringify({ auth: token }) + '\n')
    })
    sock.on('data', (chunk: Buffer) => {
      for (const line of lines.push(chunk)) {
        if (state === 'authing') {
          let reply: { auth?: unknown } = {}
          try {
            reply = JSON.parse(line) as { auth?: unknown }
          } catch {
            /* 当作鉴权失败 */
          }
          if (reply.auth !== 'ok') {
            log('desktop rejected the handshake')
            sock.destroy()
            return
          }
          state = 'connected'
          failures = 0
          log('connected to the desktop')
          report('connected')
          continue
        }
        if (state === 'connected') relayToExtension(line)
      }
    })
    // error 之后必有 close；只在 close 里收尾，避免同一次断开处理两遍
    sock.on('error', () => {})
    sock.on('close', () => {
      if (socket !== sock) return
      dropLink()
    })
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    socket?.destroy()
    socket = null
    finish()
  }

  stdin.on('data', (chunk: Buffer) => {
    for (const text of reader.push(chunk)) relayToDesktop(text)
  })
  // 扩展关了端口（重载、卸载、浏览器退出）→ 宿主退出
  stdin.on('end', stop)
  stdin.on('close', stop)
  stdout.on('error', stop)

  connectDesktop()
  return { done, stop }
}
