/**
 * 桌面通知端口 —— 把共享决策器（`@shuvix/agent-runtime` 的 notification/）接到 Electron 上。
 *
 * 这里只做四件宿主才知道的事，「什么时候该弹」一概不管（那在决策器里，两端共用）：
 *  1. **怎么弹** —— `new Notification().show()`，按 key 维护活体以便撤回。
 *  2. **用户在看哪** —— 渲染进程按窗口上报当前会话（`reportActiveSession`），
 *     叠加 `win.isFocused()` 实时判定。主进程自己是不知道 activeSessionId 的，
 *     而判定又不能放渲染层：macOS 关窗不退出应用，agent 照跑，那时压根没有渲染进程，
 *     恰恰是最该通知的时候。
 *  3. **会话叫什么** —— sessionDao。
 *  4. **开关** —— `notification.enabled`，实时读，缺省开。
 *
 * 点击行为本期只有一个：把对应会话拉到眼前（悬浮窗优先，其次主窗；主窗已销毁就重建，
 * 会话 id 先存着等渲染就绪来取）。通知内的允许/拒绝按钮留待后续，见
 * `@shuvix/chat-protocol/notification` 的文件头注。
 */
import { app, BrowserWindow, Notification } from 'electron'
import { join } from 'path'
import { createNotificationCenter, type NotificationCenter } from '@shuvix/agent-runtime'
import type { AgentNotification } from '@shuvix/chat-protocol/notification'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { sessionDao } from '../dao/sessionDao'
import { settingsDao } from '../dao/settingsDao'
import { focusFloating, isPinned } from './pinnedChatService'
import { t } from '../i18n'
import { createLogger } from '../logger'

const log = createLogger('Notification')

/** 通知图标：macOS 忽略此项（恒用应用图标），Windows/Linux 需要显式给 */
const ICON_PATH = join(__dirname, '../../resources/icon.png')

export interface NotificationServiceDeps {
  /** 主窗口句柄（可能为 null / 已销毁） */
  getMainWindow: () => BrowserWindow | null
  /** 主窗口不在时重建 —— 通知点击要能把关掉的窗口拉回来 */
  ensureMainWindow: () => void
}

let deps: NotificationServiceDeps | null = null
let center: NotificationCenter | null = null

/** 活体通知：key → Notification，用于「同 key 覆盖」与撤回 */
const live = new Map<string, Notification>()

/** webContents.id → 该窗口当前展示的会话（渲染进程上报） */
const activeSessionByWindow = new Map<number, string | null>()

/** 主窗重建期间暂存的跳转目标 —— 渲染就绪后由 `consumePendingOpenSession` 取走 */
let pendingOpenSessionId: string | null = null

function windowOf(webContentsId: number): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows().find((w) => {
    if (w.isDestroyed()) return false
    return w.webContents.id === webContentsId
  })
  return win ?? null
}

/** 用户此刻正看着这个会话吗：某个存活窗口在展示它**且**该窗口处于焦点 */
function isForeground(sessionId: string): boolean {
  let foreground = false
  for (const [webContentsId, shown] of activeSessionByWindow) {
    const win = windowOf(webContentsId)
    if (!win) {
      activeSessionByWindow.delete(webContentsId) // 窗口没了，顺手清理
      continue
    }
    if (shown === sessionId && win.isFocused()) foreground = true
  }
  return foreground
}

function notificationsEnabled(): boolean {
  // 缺省开：设置里没这一项时视为开启（与其它布尔设置一致，'false' 才是关）
  return settingsDao.findByKey('notification.enabled') !== 'false'
}

/** 把会话拉到用户眼前，并切到它 */
function focusSession(sessionId: string): void {
  // 悬浮窗优先：会话被 pin 出去了，用户期待的是那个窗口，而不是主窗切过去
  if (isPinned(sessionId)) {
    focusFloating(sessionId)
    return
  }

  const win = deps?.getMainWindow() ?? null
  if (!win || win.isDestroyed()) {
    // macOS 关窗后应用仍在跑 —— 重建窗口，会话 id 交给渲染就绪后来取
    pendingOpenSessionId = sessionId
    deps?.ensureMainWindow()
    return
  }

  if (win.isMinimized()) win.restore()
  win.show()
  // macOS 上单靠 win.focus() 不会把应用抢到前台
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
  win.webContents.send('notification:open-session', sessionId)
}

function show(notification: AgentNotification): void {
  if (!Notification.isSupported()) return
  // 同 key 覆盖：先撤旧的，避免通知中心里堆同一件事的历史版本
  live.get(notification.key)?.close()
  live.delete(notification.key)

  const native = new Notification({
    title: notification.title,
    body: notification.body,
    icon: ICON_PATH
  })
  native.on('click', () => {
    // macOS 点击只收起横幅，通知中心里还留着 —— 显式关掉
    native.close()
    live.delete(notification.key)
    center?.sessionOpened(notification.sessionId)
    focusSession(notification.sessionId)
  })
  native.on('close', () => {
    if (live.get(notification.key) === native) live.delete(notification.key)
  })
  live.set(notification.key, native)
  native.show()
  log.info(`通知: kind=${notification.kind} session=${notification.sessionId}`)
}

function dismiss(key: string): void {
  live.get(key)?.close()
  live.delete(key)
}

/**
 * 由 main-entry 在窗口创建后调用（依赖注入窗口句柄，避免 service → main-entry 反向依赖）。
 *
 * 幂等：createWindow 会重复执行（macOS 关窗后从 dock 重开、通知点击拉回窗口），
 * 但决策器持有子会话血缘与未撤回的通知 key，重建一次就全丢了 —— 只刷新窗口句柄。
 */
export function initNotificationService(injected: NotificationServiceDeps): void {
  deps = injected
  if (center) return
  center = createNotificationCenter({
    notifier: { show, dismiss },
    isForeground,
    sessionTitle: (sessionId) => sessionDao.findById(sessionId)?.title,
    enabled: notificationsEnabled,
    t: (key, vars) => t(key, vars),
    logger: { warn: (message) => log.warn(message) }
  })
}

/** ChatEvent 流的旁路入口（electronEventSink 广播时顺带喂一份）—— 未初始化时静默丢弃 */
export function notifyOnChatEvent(event: ChatEvent): void {
  center?.handleEvent(event)
}

/** 渲染进程上报：该窗口当前展示的会话（null = 无会话，如设置窗口） */
export function reportActiveSession(webContentsId: number, sessionId: string | null): void {
  activeSessionByWindow.set(webContentsId, sessionId)
  // 用户已经看到它了，该会话名下挂着的通知就没意义了
  if (sessionId) center?.sessionOpened(sessionId)
}

/** 渲染进程初始化时取走待跳转会话（主窗刚被通知点击重建的情形），取后即清 */
export function consumePendingOpenSession(): string | null {
  const sessionId = pendingOpenSessionId
  pendingOpenSessionId = null
  return sessionId
}
