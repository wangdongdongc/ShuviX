/**
 * 视图同步的桌面接线（phase 3，P3-05；pi 1.2 起换成 chord2 的视图服务端）—— agent-runtime 的 `viewServer` 接到桌面上：
 *
 *  - **钩子扇出**（`sessionHostHooks`）：SessionHost 的 `onSessionOpened` / `onSessionClosed` 是单个回调
 *    （`SessionHostDeps`，`buildSessionHostDeps` 接 `opened` / `closed`），服务端要的是「登记监听器、返回注销」。
 *    扇出按登记次序逐个调；一个监听器抛错只记日志、不拦后面的；派发途中新登记的这一轮不调。
 *  - **宿主适配**（`createSyncHubHost`）：`sealed` 现读**已有的**单例宿主（没建过 → false，读它不建）；
 *    `peek` 交给 `getSessionHost().peek`（DurableSession 直接满足 `SyncSession`）。
 *  - **接缝**：`legacyView` = 旧格式（`harness-v3-jsonl`）行的冻结投影（`readLegacyTranscript`；读不出来 →
 *    空消息，仍是只读的旧格式视图，PIN-05）；`resolveAgent` = 派生 agent 路由的 `locate`（重启之后路由
 *    索引在根会话打开时重建，P3-14；根会话还没在这个进程里打开过 → 认不出 → 「找不到」，P3-14 PIN-12）。
 *  - **主体核对**（`registerViewAuthorizer`）：链路的主体按 `kind` 找核对函数 —— 桌面窗口（`window`）什么都能看；
 *    Chrome 侧边栏（`chrome`）由 Chrome 前端登记（只能看它自己浏览器这一轮的标签页会话）；没登记的种类一律不让看。
 *  - **链路**：桌面窗口的 IPC 链路由 `ipc/syncHandlers` 接（它手里有 Electron 的 `webContents`），Chrome 侧边栏的
 *    链路由 `frontend/chrome/chromeLinks` 接；两者都只调 `getSyncHub().accept(link, principal)`。
 *  - **钉住 / 删除**：`peekSyncHub()` 只读已建的服务端 —— 宿主的 `isPinned` 再数 `hasSubscribers`，
 *    sessionService.delete 在关停运行时之后、删行之前调 `deleteSession`（清空从不调，PIN-07）。
 *
 * **懒建**（PIN-12）：import 本模块只建扇出；服务端在第一次 `getSyncHub()`（第一条链路的第一帧）才建，宿主在
 * 服务端第一次 peek 时才建。（名字沿用 phase 3 的 `SyncHub`：调用方 —— 会话宿主、会话服务与它们的单测 —— 只用
 * `hasSubscribers` / `deleteSession`，两者语义没变。）
 */
import {
  createViewServer,
  type DurableSession,
  type LegacyTranscript,
  type RuntimeLogger,
  type SessionHost,
  type SyncHubHost,
  type SyncSession,
  type SyncSessionClosedReason,
  type ViewPrincipal,
  type ViewServer
} from '@shuvix/agent-runtime'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import { createLogger } from '../../logger'
import { getSessionHost, peekSessionHost } from '../../services/sessionHost'
import { isLegacySession } from '../../services/legacySession'
import { readLegacyTranscript } from '../../services/sessionStorage'
import { forgetClosedSession, indexOpenedSession } from '../../services/sessionSignalSeams'

const log = createLogger('ViewSync')

const logger: RuntimeLogger = {
  info: (message) => log.info(message),
  warn: (message) => log.warn(message),
  error: (message) => log.error(message)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─── 钩子扇出 ───────────────────────────────────────────

/** 宿主回调 → 多个监听器 */
export interface SessionHookFanout<S> {
  /** 交给宿主的 `onSessionOpened`（每个监听器各调一次，同一个对象） */
  readonly opened: (session: S) => void
  /** 交给宿主的 `onSessionClosed`（原因原样转给每个监听器） */
  readonly closed: (sessionId: string, reason: SyncSessionClosedReason) => void
  /** 登记打开监听器；返回注销（重复注销无事） */
  onSessionOpened(listener: (session: S) => void): () => void
  /** 登记关闭监听器；返回注销（重复注销无事） */
  onSessionClosed(
    listener: (sessionId: string, reason: SyncSessionClosedReason) => void
  ): () => void
}

export function createSessionHookFanout<S>(
  options: { logger?: Pick<RuntimeLogger, 'warn'> } = {}
): SessionHookFanout<S> {
  const warn = (message: string): void => (options.logger ?? logger).warn(message)
  const opened = new Set<(session: S) => void>()
  const closed = new Set<(sessionId: string, reason: SyncSessionClosedReason) => void>()

  function dispatch<A extends unknown[]>(
    label: string,
    listeners: Set<(...args: A) => void>,
    args: A
  ): void {
    // 派发前拍个快照：途中新登记的不在这一轮；途中被注销的跳过
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try {
        listener(...args)
      } catch (error) {
        warn(`session hook ${label} listener failed: ${errorText(error)}`)
      }
    }
  }

  function register<L>(listeners: Set<L>, listener: L): () => void {
    // 同一个函数登记两次也是两份登记（各自的注销只摘自己那份）
    const entry = ((...args: unknown[]) =>
      (listener as (...a: unknown[]) => void)(...args)) as unknown as L
    listeners.add(entry)
    return () => {
      listeners.delete(entry)
    }
  }

  return {
    opened: (session) => dispatch('opened', opened, [session]),
    closed: (sessionId, reason) => dispatch('closed', closed, [sessionId, reason]),
    onSessionOpened: (listener) => register(opened, listener),
    onSessionClosed: (listener) => register(closed, listener)
  }
}

/**
 * 主进程唯一的扇出：`buildSessionHostDeps` 接它的 `opened` / `closed`，hub 经宿主适配登记；会话信号
 * （`services/sessionSignals`，P3-08：投影句柄 + 生命周期 + 询问钩子）也登记在这里
 */
export const sessionHostHooks: SessionHookFanout<DurableSession> = createSessionHookFanout()

// 派生 agent 路由的索引重建（P3-14）：路由建出来时把自己登记进 sessionSignalSeams；没建过就什么都不做（PIN-16）
sessionHostHooks.onSessionOpened(indexOpenedSession)
sessionHostHooks.onSessionClosed(forgetClosedSession)

// ─── 宿主适配 ───────────────────────────────────────────

export interface SyncHubHostDeps {
  /** 已建的宿主（不建）—— `sealed` 读它 */
  readonly current?: () => Pick<SessionHost, 'sealed'> | undefined
  /** 宿主（必要时建）—— `peek` 用它 */
  readonly host?: () => Pick<SessionHost, 'peek'>
  readonly hooks?: Pick<SessionHookFanout<SyncSession>, 'onSessionOpened' | 'onSessionClosed'>
}

/** hub 的宿主面：`sealed` 现读、`peek` 交给单例宿主、开 / 关钩子经扇出登记 */
export function createSyncHubHost(deps: SyncHubHostDeps = {}): SyncHubHost {
  const current = deps.current ?? peekSessionHost
  const host = deps.host ?? getSessionHost
  const hooks = deps.hooks ?? sessionHostHooks
  return {
    get sealed() {
      return current()?.sealed ?? false
    },
    peek: (sessionId) => host().peek(sessionId),
    onSessionOpened: (listener) => hooks.onSessionOpened(listener),
    onSessionClosed: (listener) => hooks.onSessionClosed(listener)
  }
}

// ─── 接缝 ───────────────────────────────────────────────

/**
 * 旧格式会话的冻结视图：行是 `harness-v3-jsonl` → 它的消息（`.jsonl` 不在 / 读坏了 → 空消息，PIN-05：
 * 仍是只读的旧格式视图，不落到会去 peek 的 none 视图）；新格式行、不认识的存储类型、查不到行 → undefined。
 */
export function legacyViewOf(sessionId: string): LegacyTranscript | undefined {
  if (!isLegacySession(sessionId, { rowRequired: true })) return undefined
  try {
    const view = readLegacyTranscript(sessionId)
    return { messages: view?.messages ?? [] }
  } catch (error) {
    log.warn(`旧会话 ${sessionId} 的视图读取失败: ${errorText(error)}`)
    return { messages: [] }
  }
}

/**
 * 派生 agent 路由按需加载：它经事件适配器与工具注册表拖进一大片模块，而本模块被 sessionHost /
 * sessionService 静态 import —— 静态引它会把路由在加载期就建出来。只有 agent 目标的订阅才走到这里。
 */
function agentManagerModule(): Promise<typeof import('../../agents/AgentManager')> {
  return import('../../agents/AgentManager')
}

/** 派生 agent → 它的根会话与对话（路由的 `locate`，原样交回）；不认识 → undefined */
export async function resolveAgentOf(
  agentId: string
): Promise<{ sessionId: string; conversationId: number } | undefined> {
  const { agentManager } = await agentManagerModule()
  return agentManager.locate(agentId)
}

// ─── 主体核对 ───────────────────────────────────────────

/** 某种链路主体的核对：这个主体能不能看这个目标（同步或异步） */
export type ViewAuthorizer = (
  principal: ViewPrincipal,
  target: SyncTarget
) => boolean | Promise<boolean>

/** 桌面窗口的主体：`{kind:'window', webContentsId}` —— 桌面窗口里的谁都能看任何会话（与 IPC 一致） */
export const WINDOW_PRINCIPAL_KIND = 'window'

const authorizers = new Map<string, ViewAuthorizer>([[WINDOW_PRINCIPAL_KIND, () => true]])

/** 登记一种主体的核对（同种再登记 = 替换）；返回注销（只摘自己登记的那一个） */
export function registerViewAuthorizer(kind: string, authorizer: ViewAuthorizer): () => void {
  authorizers.set(kind, authorizer)
  return () => {
    if (authorizers.get(kind) === authorizer) authorizers.delete(kind)
  }
}

/** 服务端的 `authorize`：按主体的 kind 找核对；没登记的种类一律不让看 */
export function authorizeView(
  principal: ViewPrincipal,
  target: SyncTarget
): boolean | Promise<boolean> {
  const authorizer = authorizers.get(principal.kind)
  if (authorizer === undefined) return false
  try {
    return authorizer(principal, target)
  } catch (error) {
    log.warn(`view authorizer ${principal.kind} failed: ${errorText(error)}`)
    return false
  }
}

// ─── 服务端 ─────────────────────────────────────────────

let server: ViewServer | undefined

/** 主进程唯一的视图服务端（懒建：第一条链路的第一帧才建） */
export function getSyncHub(): ViewServer {
  server ??= createViewServer({
    host: createSyncHubHost(),
    legacyView: legacyViewOf,
    resolveAgent: resolveAgentOf,
    authorize: authorizeView,
    logger
  })
  return server
}

/** 已建的服务端（不建）—— 钉住与删除只读它：没有服务端就没有人在看 */
export function peekSyncHub(): ViewServer | undefined {
  return server
}

/** 丢掉单例（先关掉它，不等）；下一次 `getSyncHub()` 新建 —— 仅供单测 */
export function resetSyncHubForTests(): void {
  const previous = server
  server = undefined
  void previous?.dispose().catch(() => undefined)
}
