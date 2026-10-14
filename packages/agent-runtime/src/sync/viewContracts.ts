/**
 * 视图同步的契约与链路（pi 1.2 / chord2）—— 服务端（`viewServer.ts`，主进程）与客户端（chat-ui 的 syncClient：
 * 桌面渲染进程、Chrome 侧边栏）共用的**唯一一份**。
 *
 * **浏览器安全**：只引 chord 根入口与 typebox（守护用例 `__tests__/viewContracts.browserSafe.test.ts` 钉住）。
 * chat-ui 经 `@shuvix/agent-runtime/sync/viewContracts` 引它（渲染端 / 扩展 / 单测各有一条子路径别名，不经包入口 ——
 * 入口会把 pi-* 整个拖进来）。
 *
 *  - **契约**：`shuvix.session-view`（输入 `{sessionId}`）与 `shuvix.agent-view`（输入 `{agentId}`），各一个变体
 *    `owner`，两个状态成员：`view`（视图本身）与 `availability`（`available` / `unavailable`）。之后的 server 模式
 *    会加 `viewer` / `participant` 变体（加变体不破坏兼容）。
 *  - **schema 故意是松的**：顶层几个必有的键浅类型，正文 `Type.Unknown()`。严格 schema 在 1.2 MB 的快照上要
 *    37 ms（松的 3 ms），chat-protocol 的类型也得再写一份 TypeBox 孪生。快照每次（重新）订阅校验一次。
 *  - **「会话被删了」是状态，不是丢掉的句柄**：chord2 没有按记录强制处置的公共接口，所以删除写成
 *    `availability = 'unavailable'`。
 *  - **找不到**（会话被删、派生 agent 认不出）：chord 的 `unavailable` + reason {@link NOT_FOUND_REASON}；
 *    客户端把它映射成 chat-protocol 的 `SYNC_NOT_FOUND`。
 *  - **链路**：{@link FrameLink} —— chord `Link` 的一个通用实现（收队列、`bye`、关闭回调），传输只给一个
 *    「发一帧」的函数。桌面的 IPC 链路、Chrome 侧边栏链路、客户端的渠道链路、e2e 探针都用它。
 */
import { ChordError, isChordError, remote, type Frame, type Link } from '@earendil-works/chord'
import { Type, type Static } from 'typebox'

/** 视图服务端宿主的名字（客户端 `get(…, { at })` 用它） */
export const VIEW_SERVER_HOST = 'main'

/** 视图可用性：会话被删 / 派生 agent 的对话没了 → `unavailable`（之后不再变） */
export const AvailabilitySchema = Type.Union([
  Type.Literal('available'),
  Type.Literal('unavailable')
])
export type ViewAvailability = Static<typeof AvailabilitySchema>

/** SessionView 的松 schema：顶层键浅类型，正文不校验（见文件头） */
export const LooseSessionViewSchema = Type.Object({
  v: Type.Literal(1),
  sessionId: Type.String(),
  source: Type.String(),
  capabilities: Type.Unknown(),
  conversationId: Type.Union([Type.Number(), Type.Null()]),
  messages: Type.Array(Type.Unknown()),
  live: Type.Unknown(),
  toolRuns: Type.Unknown(),
  run: Type.Unknown(),
  queue: Type.Array(Type.Unknown()),
  asks: Type.Array(Type.Unknown()),
  context: Type.Unknown()
})

/** AgentView 的松 schema */
export const LooseAgentViewSchema = Type.Object({
  v: Type.Literal(1),
  agentId: Type.String(),
  sessionId: Type.String(),
  conversationId: Type.Number(),
  messages: Type.Array(Type.Unknown()),
  live: Type.Unknown(),
  toolRuns: Type.Unknown(),
  run: Type.Unknown(),
  context: Type.Unknown()
})

const Id = Type.String({ minLength: 1 })

/** 一条会话的视图（根对话的 SessionView） */
export const SessionViewContract = remote('shuvix.session-view', {
  version: 1,
  input: Type.Object({ sessionId: Id }),
  variants: {
    owner: { state: { view: LooseSessionViewSchema, availability: AvailabilitySchema } }
  }
})

/** 一个派生 agent 的视图（它对话的 AgentView） */
export const AgentViewContract = remote('shuvix.agent-view', {
  version: 1,
  input: Type.Object({ agentId: Id }),
  variants: {
    owner: { state: { view: LooseAgentViewSchema, availability: AvailabilitySchema } }
  }
})

// ─── 错误 ───────────────────────────────────────────────

/** 「找不到」的 reason（code 是 `unavailable`） */
export const NOT_FOUND_REASON = 'not_found'

/** 目标不存在：会话被删、派生 agent 认不出、它的根会话不可用 */
export function notFoundError(message: string): ChordError {
  return new ChordError('unavailable', message, { reason: NOT_FOUND_REASON })
}

/** 是不是「找不到」 */
export function isNotFoundError(error: unknown): boolean {
  return isChordError(error, 'unavailable') && error.reason === NOT_FOUND_REASON
}

// ─── 链路 ───────────────────────────────────────────────

/**
 * chord `Link` 的通用实现：传输只管「把一帧发出去」（`transmit`），收到的帧交给 {@link deliver}，传输自己
 * 断了调 {@link ended}。语义与 chord 自带的链路相同：先到的帧排队等接收方、收到 `bye` 即结束、`close`
 * 先给对端发 `bye` 再结束、关闭回调只调一次。
 *
 * `transmit` 抛错（对端已经不在）= 传输断了：链路以 `transport error` 结束，不把异常抛给 chord。
 */
export class FrameLink implements Link {
  #handler: ((frame: Frame) => void) | undefined
  #queue: Frame[] = []
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

  send(frame: Frame): void {
    if (this.#closed) return
    try {
      this.#transmit(frame)
    } catch {
      this.ended('transport error')
    }
  }

  receive(handler: (frame: Frame) => void): void {
    this.#handler = handler
    for (const frame of this.#queue.splice(0)) handler(frame)
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

  /** 传输收到的一帧（未解析的值原样交给 chord —— 它自己校验，坏帧会关掉链路） */
  deliver(frame: unknown): void {
    if (this.#closed) return
    const value = frame as Frame
    if (typeof frame === 'object' && frame !== null && value.t === 'bye') {
      const reason = (value as { reason?: unknown }).reason
      this.ended(typeof reason === 'string' ? reason : 'peer closed')
      return
    }
    if (this.#handler === undefined) this.#queue.push(value)
    else this.#handler(value)
  }

  /** 链路结束（传输断了 / 收到 bye / close）：只通知一次 */
  ended(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#queue = []
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
