/**
 * 视图同步的线协议（phase 3，形态 A）—— 前端订阅一个**目标**（一条会话，或一个派生 agent），
 * 服务端为每个目标挂一个 chord `RemoteServiceProvider`，单例服务 `shuvix.chat.view` 交出
 * `{ view: ReplicatedState<SessionView | AgentView> }`。帧是 `{target, subscriptionId, update}`，
 * `update` 是 chord 服务状态编码器的输出（本包不依赖 chord，所以这里不展开它的形状）。
 */

/** 视图服务的 id（每个目标一个 provider，服务本身是单例） */
export const CHAT_VIEW_SERVICE_ID = 'shuvix.chat.view'

/** 同步目标：一条会话（根对话的 SessionView），或一个派生 agent（它对话的 AgentView） */
export type SyncTarget = { kind: 'session'; sessionId: string } | { kind: 'agent'; agentId: string }

/** 服务端推给某个前端的一帧：哪个目标、哪个订阅、编码后的更新 */
export interface SyncFrame<U = unknown> {
  target: SyncTarget
  subscriptionId: string
  update: U
}

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

// ─────────────────────────── 渠道上的调用（P3-05） ───────────────────────────

/** 线上的严格 JSON 值（与 chord 的 `JsonValue` 同形；本包不依赖 chord） */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * 一次同步调用跨进程回来的信封（P3-05 PIN-01）：Electron 的 `ipcMain.handle` 拒绝时只带 `message`，
 * chord 的 `RemoteServiceError.code`（如 `service_not_found`）会丢 —— 所以服务端总是 resolve 这个信封，
 * 客户端遇到 `ok:false` 再抛一个带 `.code` 的 Error。
 */
export type SyncInvokeResult =
  | { ok: true; value: JsonValue | undefined }
  | { ok: false; error: { code?: string; message: string } }

/**
 * 渠道的视图同步面（`SessionChannelApi.sync`）：`invoke` 把一次 chord 服务调用发给某个目标，
 * `onFrame` 收服务端推来的帧（每个订阅一个解码器，见 chat-ui 的 syncClient）。失败的调用以带 `code` 的
 * Error 拒绝。
 */
export interface SyncChannel {
  invoke(target: SyncTarget, call: JsonValue): Promise<JsonValue | undefined>
  onFrame(callback: (frame: SyncFrame) => void): () => void
}

/** `SyncInvokeResult` 的失败分支 → 带 `.code` 的 Error（preload 与扩展共用一个口径） */
export function syncInvokeError(error: { code?: string; message: string }): Error & {
  code?: string
} {
  const thrown = new Error(error.message) as Error & { code?: string }
  if (typeof error.code === 'string') thrown.code = error.code
  return thrown
}
