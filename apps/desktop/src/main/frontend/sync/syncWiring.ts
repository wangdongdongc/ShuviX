/**
 * 视图同步的桌面接线（phase 3，P3-05；plan §C）—— agent-runtime 的 SyncHub 接到桌面上：
 *
 *  - **钩子扇出**（`sessionHostHooks`）：SessionHost 的 `onSessionOpened` / `onSessionClosed` 是单个回调
 *    （`SessionHostDeps`，`buildSessionHostDeps` 接 `opened` / `closed`），hub 要的是「登记监听器、返回注销」。
 *    扇出按登记次序逐个调；一个监听器抛错只记日志、不拦后面的；派发途中新登记的这一轮不调。
 *  - **宿主适配**（`createSyncHubHost`）：`sealed` 现读**已有的**单例宿主（没建过 → false，读它不建）；
 *    `peek` 交给 `getSessionHost().peek`（DurableSession 直接满足 hub 的 `SyncSession`）。
 *  - **接缝**：`legacyView` = 旧格式（`harness-v3-jsonl`）行的冻结投影（`readLegacyTranscript`；读不出来 →
 *    空消息，仍是只读的旧格式视图，PIN-05）；`resolveAgent` = 派生 agent 路由的 `locate`（重启之后路由
 *    索引在根会话打开时重建，P3-14；根会话还没在这个进程里打开过 → 认不出，`service_not_found`，P3-14 PIN-12）。
 *  - **传输**（`syncTransport`）：按客户端 id 前缀路由；IPC 那条由 `registerSyncHandlers` 注册时挂上
 *    （它手里有 Electron 的 `webContents`），Chrome 那条 P3-09 挂。
 *  - **钉住 / 删除**：`peekSyncHub()` 只读已建的 hub —— 宿主的 `isPinned` 再数 `hasSubscribers`，
 *    sessionService.delete 在关停运行时之后、删行之前调 `deleteSession`（清空从不调，PIN-07）。
 *
 * **懒建**（PIN-12）：import 本模块只建扇出与路由表（两张空表）；hub 在第一次 `getSyncHub()`（第一次
 * `sync:invoke`）才建，宿主在 hub 第一次 peek 时才建。
 */
import {
  createSyncHub,
  type DurableSession,
  type LegacyTranscript,
  type RuntimeLogger,
  type SessionHost,
  type SyncHub,
  type SyncHubHost,
  type SyncSession,
  type SyncSessionClosedReason
} from '@shuvix/agent-runtime'
import { createLogger } from '../../logger'
import { getSessionHost, peekSessionHost } from '../../services/sessionHost'
import { isLegacySession } from '../../services/legacySession'
import { readLegacyTranscript } from '../../services/sessionStorage'
import { forgetClosedSession, indexOpenedSession } from '../../services/sessionSignalSeams'
import { createRoutingSyncTransport, type RoutingSyncTransport } from './ipcSyncTransport'

const log = createLogger('SyncHub')

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

// ─── 传输与 hub ─────────────────────────────────────────

/** 主进程唯一的路由传输（前缀 → 传输）；IPC 那条在 `registerSyncHandlers` 里挂 */
export const syncTransport: RoutingSyncTransport = createRoutingSyncTransport({ logger })

let hub: SyncHub | undefined

/** 主进程唯一的 SyncHub（懒建：第一次同步调用才建） */
export function getSyncHub(): SyncHub {
  hub ??= createSyncHub({
    host: createSyncHubHost(),
    transport: syncTransport,
    legacyView: legacyViewOf,
    resolveAgent: resolveAgentOf,
    logger
  })
  return hub
}

/** 已建的 hub（不建）—— 钉住与删除只读它：没有 hub 就没有订阅 */
export function peekSyncHub(): SyncHub | undefined {
  return hub
}

/** 丢掉单例（先 dispose）；下一次 `getSyncHub()` 新建 —— 仅供单测 */
export function resetSyncHubForTests(): void {
  const previous = hub
  hub = undefined
  previous?.dispose()
}
