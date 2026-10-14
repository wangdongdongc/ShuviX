/**
 * 视图同步的线协议（pi 1.2 / chord2）—— 前端持有一个**目标**（一条会话，或一个派生 agent）的视图。
 *
 * 视图经 chord2 的链路（link）同步：主进程是 chord 宿主（`agent-runtime/sync/viewServer`），每个前端是一个
 * 客户端宿主（chat-ui 的 syncClient），两者之间是一条**链路**，链路上跑 chord 自己的帧（hello / hold /
 * sub / state …）。本包不依赖 chord，所以这里只有宿主之间约定的那一点：目标、错误码，以及承载链路的
 * **链路渠道**（{@link SyncLinkChannel}）。
 */

/** 同步目标：一条会话（根对话的 SessionView），或一个派生 agent（它对话的 AgentView） */
export type SyncTarget = { kind: 'session'; sessionId: string } | { kind: 'agent'; agentId: string }

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** 线上来的值是不是合法的同步目标（id 必须是非空字符串；其余种类一律不认） */
export function isSyncTarget(value: unknown): value is SyncTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const target = value as { kind?: unknown; sessionId?: unknown; agentId?: unknown }
  if (target.kind === 'session') return nonEmpty(target.sessionId)
  if (target.kind === 'agent') return nonEmpty(target.agentId)
  return false
}

/** 目标的稳定键（`session:<id>` / `agent:<id>`）：同一个 id 的会话与 agent 不会撞 */
export function syncTargetKey(target: SyncTarget): string {
  return target.kind === 'session' ? `session:${target.sessionId}` : `agent:${target.agentId}`
}

/** 线上的严格 JSON 值（与 chord 的 `JsonValue` 同形；本包不依赖 chord） */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * 视图绑定 `error` 时的码：目标不存在（会话被删、派生 agent 认不出 / 根会话还没在主进程里打开过）。
 * 服务端抛的是 chord 的 `unavailable` + reason `not_found`，客户端把它映射成这个码；其余 chord 错误原样用
 * chord 的码（`forbidden` / `invalid` / `unavailable` …）。
 */
export const SYNC_NOT_FOUND = 'not_found'

/**
 * 承载视图同步链路的渠道（`SessionChannelApi.sync`）—— 全是普通函数，好过 Electron 的 contextBridge。
 *
 * 一条渠道上可以有多条链路，每条有一个**链路 id**（客户端为每条新链路现取一个，不复用）：帧带着它走，
 * 收的一侧按它分开。于是重连 / 页面重载之后，旧链路迟到的帧不会落进新链路（chord 的 hold / sub id 每条
 * 链路都从 1 数起），同一个窗口里也可以并存几个客户端（e2e 探针）。
 *
 *  - 桌面窗口：`ipcRenderer.send('sync:frame', link, frame)` / `sync:frame` 推回；传输永远在（没有 up/down）。
 *  - Chrome 侧边栏：桥事件 `sync.link {panelId, link, frame}`；桥断开 / 桌面不在时 down，回到 ready 时 up。
 */
export interface SyncLinkChannel {
  /** 发一帧到服务端（某条链路上） */
  send(link: string, frame: JsonValue): void
  /** 收服务端推来的帧（带链路 id）；返回注销 */
  onFrame(callback: (link: string, frame: JsonValue) => void): () => void
  /** 传输断了：这条渠道上的每条链路都没了（可选；没有 = 传输不会自己断） */
  onDown?(callback: (reason: string) => void): () => void
  /** 传输断过之后又能用了（可选） */
  onUp?(callback: () => void): () => void
  /** 传输此刻能不能用（可选；没有 = 总能用） */
  isUp?(): boolean
}
