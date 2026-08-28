/**
 * 扩展通知端口 —— 把共享决策器（`@shuvix/agent-runtime` 的 notification/）接到
 * `chrome.notifications` 上。与桌面端 `services/notificationService.ts` 一一对应，
 * 「什么时候该弹」那部分逻辑两端是同一份代码，这里只填宿主特有的四件事。
 *
 * 与桌面的两处实质差异：
 *
 * - **前台判定是同进程的。** Agent 与 UI 跑在同一个整页 App 里，activeSessionId 直接读
 *   chatStore 即可，不需要桌面那条 presence 上报 IPC。
 *
 * - **覆盖面天然更窄。** agent 就活在这个标签页里（SW 扛不了长任务），所以通知只覆盖
 *   「标签页在后台 / 浏览器窗口失焦」；标签页一关 agent 一起没，也就无所谓通知了。
 */
import i18next from 'i18next'
import { createNotificationCenter, type NotificationCenter } from '@shuvix/agent-runtime'
import type { AgentNotification } from '@shuvix/chat-protocol/notification'
import { useChatStore } from '@shuvix/chat-ui'
import { eventBus } from '../runtime/eventBus'

/** 通知 key → 会话 id，点击时据此定位 */
const sessionByKey = new Map<string, string>()

let center: NotificationCenter | null = null

function available(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.notifications
}

/** 把整页 App 的标签页拉到眼前，并切到目标会话 */
async function focusSession(sessionId: string): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent()
    if (tab?.id != null) {
      await chrome.tabs.update(tab.id, { active: true })
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
    }
  } catch (err) {
    console.warn('[shuvix] focus app tab failed', err)
  }
  useChatStore.getState().setActiveSessionId(sessionId)
}

function show(notification: AgentNotification): void {
  sessionByKey.set(notification.key, notification.sessionId)
  // key 即通知 id —— 同 key 再 create 由 Chrome 直接覆盖。
  // 走回调式（而非 MV3 的 Promise 形态）：失败经 lastError 落地，不会变成
  // 一条无人接住的 rejection —— 通知弹不出来不该有能力打断正在跑的会话。
  chrome.notifications.create(
    notification.key,
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: notification.title,
      message: notification.body
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('[shuvix] notification failed', chrome.runtime.lastError.message)
      }
    }
  )
}

function dismiss(key: string): void {
  sessionByKey.delete(key)
  chrome.notifications.clear(key)
}

/**
 * 装配通知：订阅事件流 + 接管点击。在 App 挂载前调用一次。
 *
 * 事件走 `subscribeObserver` 而非 `subscribe` —— 后者计入 `hasListeners()`，
 * 那是「有 UI 能应答询问」的判据，决策器不该冒充它（见 eventBus.ts）。
 */
export function initNotifications(): void {
  if (!available() || center) return

  center = createNotificationCenter({
    notifier: { show, dismiss },
    isForeground: (sessionId) =>
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      useChatStore.getState().activeSessionId === sessionId,
    sessionTitle: (sessionId) =>
      useChatStore.getState().sessions.find((s) => s.id === sessionId)?.title,
    t: (key, vars) => i18next.t(key, vars),
    logger: { warn: (message) => console.warn('[shuvix]', message) }
  })

  eventBus.subscribeObserver((event) => center?.handleEvent(event))

  chrome.notifications.onClicked.addListener((key) => {
    const sessionId = sessionByKey.get(key)
    chrome.notifications.clear(key)
    sessionByKey.delete(key)
    if (!sessionId) return
    center?.sessionOpened(sessionId)
    void focusSession(sessionId)
  })

  chrome.notifications.onClosed.addListener((key) => sessionByKey.delete(key))

  // 用户自己切到某个会话（点侧边栏 / 新建）—— 该会话名下的通知就没意义了
  useChatStore.subscribe((state, prev) => {
    if (state.activeSessionId && state.activeSessionId !== prev.activeSessionId) {
      center?.sessionOpened(state.activeSessionId)
    }
  })
}
