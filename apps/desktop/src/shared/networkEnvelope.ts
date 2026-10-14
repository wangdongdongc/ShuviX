/**
 * 网络传输的线协议（server mode phase B，docs/server/phase-bc-network-and-web.md §B2）—— 浏览器里的 web 客户端
 * 与主进程的网络服务之间，WebSocket 上一条文本帧一条 JSON 消息：
 *
 *  - 客户端 → 服务端：`{t:'invoke', id, channel, args}` · `{t:'send', channel, args}` · `{t:'sync', link, frame}`
 *  - 服务端 → 客户端：`{t:'result', id, ok:true, value?}` · `{t:'result', id, ok:false, error:{message, code?}}` ·
 *    `{t:'push', channel, args}` · `{t:'sync', link, frame}`
 *
 * **`undefined` 要保住**：IPC 用结构化克隆，处理函数收到的位置参数里的 `undefined` 就是 `undefined`
 * （`buildApi` 把 invoke / send 补齐到恰好 `args` 个参数，`tools.list(undefined, {profile})` 这样的调用很常见），
 * 而 JSON 把数组里的 `undefined` 变成 `null`。所以 `args` 照常编码，另带一个 `u`：值是 `undefined` 的那些
 * 位置的下标；解码时把这些位置换回 `undefined`。处理函数因此收到的参数与经 IPC 时一模一样（顶层位置；对象里
 * 值为 `undefined` 的键照 JSON 的规矩丢掉 —— 读它们的代码 `x.k === undefined` 与 `'k' in x` 之外的写法都一样）。
 * 结果同理：处理函数回 `undefined` → 不带 `value`，客户端据此解出 `undefined`（`null` 原样是 `null`）。
 *
 * 纯 JSON 编解码，不碰 DOM / Node：主进程与浏览器两头都引它。解码对不合形状的输入回 `undefined`（从不抛）。
 */

/** WebSocket 的路径 */
export const NETWORK_WS_PATH = '/ws'

/** 通道名的长度上限（表里最长的也不到 40） */
export const MAX_ENVELOPE_CHANNEL_CHARS = 200

/** 视图同步链路 id 的长度上限（与桌面窗口链路同一个数） */
export const MAX_ENVELOPE_LINK_CHARS = 200

/** 失败结果的码 */
export type EnvelopeErrorCode =
  /** 表里没有这条请求通道（或种类不对、或这条通道不经网络走） */
  | 'unknown_channel'
  /** 只有桌面窗口能用（phase D 之前），见 `DESKTOP_ONLY_CHANNELS` */
  | 'desktop_only'
  /** 处理函数抛了 */
  | 'handler_error'
  /** 认得出 id、其余不合形状的 invoke */
  | 'bad_request'
  /** 连接断了（只在客户端本地用：在途的调用被拒） */
  | 'disconnected'

export interface EnvelopeError {
  readonly message: string
  readonly code?: string
}

export type ClientMessage =
  | {
      readonly t: 'invoke'
      readonly id: number
      readonly channel: string
      readonly args: unknown[]
    }
  | { readonly t: 'send'; readonly channel: string; readonly args: unknown[] }
  | { readonly t: 'sync'; readonly link: string; readonly frame: unknown }

export type ServerMessage =
  | { readonly t: 'result'; readonly id: number; readonly ok: true; readonly value?: unknown }
  | { readonly t: 'result'; readonly id: number; readonly ok: false; readonly error: EnvelopeError }
  | { readonly t: 'push'; readonly channel: string; readonly args: unknown[] }
  | { readonly t: 'sync'; readonly link: string; readonly frame: unknown }

/** 线上的位置参数：JSON 数组 + 值为 `undefined` 的下标（没有就不带 `u`） */
export interface PackedArgs {
  readonly args: unknown[]
  readonly u?: number[]
}

/** 位置参数 → 线上的形状（`undefined` 的位置记进 `u`，数组本身照 JSON 的规矩写成 null） */
export function packArgs(args: readonly unknown[]): PackedArgs {
  const u: number[] = []
  const out: unknown[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === undefined) {
      u.push(i)
      out.push(null)
    } else {
      out.push(args[i])
    }
  }
  return u.length > 0 ? { args: out, u } : { args: out }
}

/** 线上的位置参数 → 原来的数组；形状不对（不是数组、`u` 里有越界 / 非整数下标）→ undefined */
export function unpackArgs(args: unknown, u: unknown): unknown[] | undefined {
  if (!Array.isArray(args)) return undefined
  const out = [...args]
  if (u === undefined) return out
  if (!Array.isArray(u)) return undefined
  for (const index of u) {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= out.length) {
      return undefined
    }
    out[index] = undefined
  }
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isChannel = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ENVELOPE_CHANNEL_CHARS

const isLinkId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ENVELOPE_LINK_CHARS

const isRequestId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function parse(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** 客户端消息 → 一条文本帧 */
export function encodeClientMessage(message: ClientMessage): string {
  switch (message.t) {
    case 'invoke':
      return JSON.stringify({
        t: 'invoke',
        id: message.id,
        channel: message.channel,
        ...packArgs(message.args)
      })
    case 'send':
      return JSON.stringify({ t: 'send', channel: message.channel, ...packArgs(message.args) })
    case 'sync':
      return JSON.stringify({ t: 'sync', link: message.link, frame: message.frame })
  }
}

/** 一条文本帧 → 客户端消息；不合形状 → undefined */
export function decodeClientMessage(text: unknown): ClientMessage | undefined {
  const raw = parse(text)
  if (raw === undefined) return undefined
  switch (raw.t) {
    case 'invoke': {
      if (!isRequestId(raw.id) || !isChannel(raw.channel)) return undefined
      const args = unpackArgs(raw.args, raw.u)
      return args === undefined
        ? undefined
        : { t: 'invoke', id: raw.id, channel: raw.channel, args }
    }
    case 'send': {
      if (!isChannel(raw.channel)) return undefined
      const args = unpackArgs(raw.args, raw.u)
      return args === undefined ? undefined : { t: 'send', channel: raw.channel, args }
    }
    case 'sync':
      if (!isLinkId(raw.link) || !('frame' in raw)) return undefined
      return { t: 'sync', link: raw.link, frame: raw.frame }
    default:
      return undefined
  }
}

/**
 * 一条解不开的文本帧若是 `t:'invoke'` 且 `id` 合法，回那个 id（服务端据此回一条 `bad_request` 失败结果，
 * 免得对面那次调用永远等下去）；别的一律 undefined
 */
export function malformedInvokeId(text: unknown): number | undefined {
  const raw = parse(text)
  if (raw === undefined || raw.t !== 'invoke' || !isRequestId(raw.id)) return undefined
  return decodeClientMessage(text) === undefined ? raw.id : undefined
}

/** 服务端消息 → 一条文本帧（结果是 `undefined` → 不带 `value`） */
export function encodeServerMessage(message: ServerMessage): string {
  switch (message.t) {
    case 'result':
      if (message.ok) {
        return JSON.stringify(
          message.value === undefined
            ? { t: 'result', id: message.id, ok: true }
            : { t: 'result', id: message.id, ok: true, value: message.value }
        )
      }
      return JSON.stringify({
        t: 'result',
        id: message.id,
        ok: false,
        error:
          message.error.code === undefined
            ? { message: message.error.message }
            : { message: message.error.message, code: message.error.code }
      })
    case 'push':
      return JSON.stringify({ t: 'push', channel: message.channel, ...packArgs(message.args) })
    case 'sync':
      return JSON.stringify({ t: 'sync', link: message.link, frame: message.frame })
  }
}

/** 一条文本帧 → 服务端消息；不合形状 → undefined */
export function decodeServerMessage(text: unknown): ServerMessage | undefined {
  const raw = parse(text)
  if (raw === undefined) return undefined
  switch (raw.t) {
    case 'result': {
      if (!isRequestId(raw.id)) return undefined
      if (raw.ok === true) {
        return 'value' in raw
          ? { t: 'result', id: raw.id, ok: true, value: raw.value }
          : { t: 'result', id: raw.id, ok: true }
      }
      if (raw.ok !== false || !isRecord(raw.error)) return undefined
      const message = typeof raw.error.message === 'string' ? raw.error.message : 'request failed'
      const code = typeof raw.error.code === 'string' ? raw.error.code : undefined
      return {
        t: 'result',
        id: raw.id,
        ok: false,
        error: code === undefined ? { message } : { message, code }
      }
    }
    case 'push': {
      if (!isChannel(raw.channel)) return undefined
      const args = unpackArgs(raw.args, raw.u)
      return args === undefined ? undefined : { t: 'push', channel: raw.channel, args }
    }
    case 'sync':
      if (!isLinkId(raw.link) || !('frame' in raw)) return undefined
      return { t: 'sync', link: raw.link, frame: raw.frame }
    default:
      return undefined
  }
}

/** 错误 → 线上的错误（`code` 只取字符串） */
export function envelopeErrorOf(error: unknown, fallbackCode?: string): EnvelopeError {
  const message = error instanceof Error ? error.message : String(error)
  const raw = isRecord(error) ? error.code : undefined
  const code = typeof raw === 'string' ? raw : fallbackCode
  return code === undefined ? { message } : { message, code }
}
