/**
 * 视图同步的契约与链路（Chord 1.6.1 / v2）—— 服务端（`viewServer.ts`，主进程）与客户端（chat-ui 的 syncClient：
 * 桌面渲染进程、Chrome 侧边栏）共用的**唯一一份**。
 *
 * **浏览器安全**：只引 `@earendil-works/chord` 根入口（守护用例 `__tests__/viewContracts.browserSafe.test.ts` 钉住）。
 * chat-ui 经 `@shuvix/agent-runtime/sync/viewContracts` 引它（渲染端 / 扩展 / 单测各有一条子路径别名，不经包入口 ——
 * 入口会把 pi-* 整个拖进来）。
 *
 *  - **契约**：`shuvix.session-view`（参数 `{sessionId}`）与 `shuvix.agent-view`（参数 `{agentId}`），各一个变体
 *    `owner`，两个状态成员：`view`（视图本身）与 `availability`（`available` / `unavailable`）。之后的 server 模式
 *    会加 `viewer` / `participant` 变体（加变体不破坏兼容）。
 *  - **schema 故意是松的**：顶层几个必有的键浅类型，正文 `unknown()`。严格 schema 在 1.2 MB 的快照上要
 *    37 ms（松的 3 ms），chat-protocol 的类型也得再写一份 schema 孪生。快照每次（重新）订阅校验一次。
 *  - **「会话被删了」是状态，不是丢掉的句柄**：删除写成 `availability = 'unavailable'`。
 *  - **找不到**（会话被删、派生 agent 认不出）：chord 的 `unavailable` + `details: { reason: NOT_FOUND_REASON }`；
 *    客户端把它映射成 chat-protocol 的 `SYNC_NOT_FOUND`。
 *  - **链路**：{@link FrameLink} —— chord `Link` 的一个通用实现（基于 `textCodec` 走 JSON 帧信封 `{ t, d }`，
 *    收队列、`bye`、关闭回调），传输只给一个「发一帧」的函数。桌面的 IPC 链路、Chrome 侧边栏链路、客户端的渠道链路、
 *    e2e 探针都用它。
 */
import {
  arr,
  ChordError,
  createHost,
  defineFacet,
  forbidden,
  hostKind,
  isChordError,
  lit,
  nul,
  num,
  obj,
  oneOf,
  remote,
  str,
  textCodec,
  union,
  unknown,
  type ChordErrorCode,
  type FollowObserver,
  type Held,
  type Host,
  type HostError,
  type Link,
  type RefState,
  type Static
} from '@earendil-works/chord'

export {
  ChordError,
  createHost,
  defineFacet,
  forbidden,
  isChordError,
  type ChordErrorCode,
  type FollowObserver,
  type Held,
  type Host,
  type HostError,
  type RefState
}

/** 视图服务端宿主的名字与地址 */
export const VIEW_SERVER_HOST = 'main'
export const ViewServerHostKind = hostKind(VIEW_SERVER_HOST)
export const VIEW_SERVER_ADDRESS = ViewServerHostKind()

/** 视图同步链路共用的编解码器（纯 UTF-8 JSON 元组，无二进制段） */
export const VIEW_LINK_CODEC = textCodec

/** 视图可用性：会话被删 / 派生 agent 的对话没了 → `unavailable`（之后不再变） */
export const AvailabilitySchema = oneOf('available', 'unavailable')
export type ViewAvailability = Static<typeof AvailabilitySchema>

/** SessionView 的松 schema：顶层键浅类型，正文不校验（见文件头） */
export const LooseSessionViewSchema = obj({
  v: lit(1),
  sessionId: str(),
  source: str(),
  capabilities: unknown(),
  conversationId: union([num(), nul()]),
  messages: arr(unknown()),
  live: unknown(),
  toolRuns: unknown(),
  run: unknown(),
  queue: arr(unknown()),
  asks: arr(unknown()),
  context: unknown()
})

/** AgentView 的松 schema */
export const LooseAgentViewSchema = obj({
  v: lit(1),
  agentId: str(),
  sessionId: str(),
  conversationId: num(),
  messages: arr(unknown()),
  live: unknown(),
  toolRuns: unknown(),
  run: unknown(),
  context: unknown()
})

const Id = str({ min: 1 })

/** 一条会话的视图（根对话的 SessionView） */
export const SessionViewContract = remote('shuvix.session-view', {
  version: 1,
  params: { sessionId: Id },
  hostAddress: () => VIEW_SERVER_ADDRESS,
  variants: {
    owner: { state: { view: LooseSessionViewSchema, availability: AvailabilitySchema } }
  }
})

/** 一个派生 agent 的视图（它对话的 AgentView） */
export const AgentViewContract = remote('shuvix.agent-view', {
  version: 1,
  params: { agentId: Id },
  hostAddress: () => VIEW_SERVER_ADDRESS,
  variants: {
    owner: { state: { view: LooseAgentViewSchema, availability: AvailabilitySchema } }
  }
})

// ─── 错误 ───────────────────────────────────────────────

/** 「找不到」的 reason（code 是 `unavailable`，放在 `details.reason` 里以便跨链路传输） */
export const NOT_FOUND_REASON = 'not_found'

/** 目标不存在：会话被删、派生 agent 认不出、它的根会话不可用 */
export function notFoundError(message: string): ChordError {
  return new ChordError({
    code: 'unavailable',
    message,
    details: { reason: NOT_FOUND_REASON }
  })
}

/** 是不是「找不到」 */
export function isNotFoundError(error: unknown): boolean {
  if (!isChordError(error, 'unavailable')) return false
  const details = error.details
  return (
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { reason?: unknown }).reason === NOT_FOUND_REASON
  )
}

// ─── 链路 ───────────────────────────────────────────────

/** 传输层交换的 JSON 帧信封：`t` 为消息种类（`hello` / `hold` / `state` / `bye` …），`d` 为 chord textCodec 元组 */
export type Frame = {
  readonly t: string
  readonly d?: unknown
  readonly reason?: string
  readonly [key: string]: unknown
}

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder()

const TAG_TO_KIND: Record<string, string> = {
  h: 'hello',
  H: 'hold',
  R: 'release',
  b: 'bound',
  s: 'state',
  f: 'failed',
  l: 'loading',
  g: 'gone',
  p: 'ping',
  P: 'pong',
  a: 'ack',
  T: 'retry',
  V: 'revoke',
  C: 'closed',
  c: 'call',
  r: 'result',
  e: 'error',
  x: 'abort',
  E: 'event'
}

/** 把 chord `textCodec` 产出的 UTF-8 JSON 字节包成带 `t` 标签的 JSON 帧信封 */
export function bytesToFrame(bytes: Uint8Array): Frame {
  const text = UTF8_DECODER.decode(bytes)
  const parsed: unknown = JSON.parse(text)
  let tag: unknown
  if (Array.isArray(parsed)) {
    tag = parsed[0] === '@' && Array.isArray(parsed[2]) ? parsed[2][0] : parsed[0]
  }
  const t = typeof tag === 'string' && tag in TAG_TO_KIND ? TAG_TO_KIND[tag]! : 'frame'
  return { t, d: parsed }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || ArrayBuffer.isView(value)
}

/** 把 JSON 帧信封还原成 chord `textCodec` 的 UTF-8 字节（坏帧也编码后交由 chord 校验并关闭链路） */
export function frameToBytes(frame: unknown): Uint8Array {
  if (isUint8Array(frame)) return frame
  if (typeof frame === 'object' && frame !== null && !Array.isArray(frame) && 'd' in frame) {
    const payload = (frame as { d?: unknown }).d
    if (payload !== undefined) return UTF8_ENCODER.encode(JSON.stringify(payload))
  }
  const json = JSON.stringify(frame)
  return UTF8_ENCODER.encode(json === undefined ? 'undefined' : json)
}

/**
 * chord `Link` 的通用实现：传输只管「把一帧 JSON 发出去」（`transmit`），收到的帧交给 {@link deliver}，传输自己
 * 断了调 {@link ended}。语义与 chord 链路相同：先到的帧排队等接收方、收到 `bye` 即结束、`close` 先给对端发
 * `bye` 再结束、关闭回调只调一次。
 *
 * `transmit` 抛错（对端已经不在）= 传输断了：链路以 `transport error` 结束，不把异常抛给 chord。
 */
export class FrameLink implements Link {
  #handler: ((message: Uint8Array) => void) | undefined
  #queue: Uint8Array[] = []
  readonly #closeHandlers = new Set<(reason: string) => void>()
  #closed = false
  readonly #transmit: (frame: Frame) => void
  readonly #shutdown: ((reason: string) => void) | undefined

  /**
   * @param transmit 把一帧交给传输（同步；保序由传输负责）
   * @param shutdown 链路结束时调一次（摘监听器、清缓冲）；`reason` 是结束的原因
   */
  constructor(transmit: (frame: Frame) => void, shutdown?: (reason: string) => void) {
    this.#transmit = transmit
    this.#shutdown = shutdown
  }

  get closed(): boolean {
    return this.#closed
  }

  send(message: Uint8Array | Frame): void {
    if (this.#closed) return
    try {
      const frame = isUint8Array(message) ? bytesToFrame(message) : (message as unknown as Frame)
      this.#transmit(frame)
    } catch {
      this.ended('transport error')
    }
  }

  onMessage(handler: (message: Uint8Array) => void): void {
    if (this.#closed) return
    this.#handler = handler
    for (const message of this.#queue.splice(0)) handler(message)
  }

  onClose(handler: (reason: string) => void): void {
    if (this.#closed) handler('closed')
    else this.#closeHandlers.add(handler)
  }

  close(reason = 'closed'): void {
    if (this.#closed) return
    try {
      this.#transmit({ t: 'bye', reason })
    } catch {
      // 传输可能已经不在了
    }
    this.ended(reason)
  }

  /** 传输收到的一帧（未解析的值还原为字节交给 chord —— 它自己校验，坏帧会关掉链路） */
  deliver(frame: unknown): void {
    if (this.#closed) return
    if (typeof frame === 'object' && frame !== null && !Array.isArray(frame)) {
      const candidate = frame as { t?: unknown; reason?: unknown }
      if (candidate.t === 'bye') {
        this.ended(typeof candidate.reason === 'string' ? candidate.reason : 'peer closed')
        return
      }
    }
    const bytes = frameToBytes(frame)
    if (this.#handler === undefined) this.#queue.push(bytes)
    else this.#handler(bytes)
  }

  /** 链路结束（传输断了 / 收到 bye / close）：只通知一次 */
  ended(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#queue = []
    this.#handler = undefined
    try {
      this.#shutdown?.(reason)
    } catch {
      // 传输自己的收尾出了问题：照样通知关闭，不把异常抛给 chord（也不从 send 的 catch 里再抛出去）
    }
    for (const handler of [...this.#closeHandlers]) {
      try {
        handler(reason)
      } catch {
        // 关闭回调自己的问题
      }
    }
    this.#closeHandlers.clear()
  }
}
