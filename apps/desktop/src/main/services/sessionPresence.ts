/**
 * 哪条会话此刻在用户眼前 —— 已读用（docs/inbox-read-state-design.md §3）。不碰 Electron：
 *
 * - 桌面窗口：「窗口展示着它且有焦点」由 notificationService 判（它持有窗口 → 会话表），启动时注入进来。
 * - 网络客户端（浏览器 / 手机）：它自己报「展示着哪条会话、页面在不在眼前」，记在这里；连接断了就忘掉。
 *   桌面通知照旧不把网络客户端算成「正看着」—— 这里只给已读用。
 *
 * 一条会话来到眼前（上报那一刻判定为在眼前）时通知订阅者（unreadService：删掉它的未读）。
 */

/** 桌面窗口那一半（notificationService 注入；不注入 = 没有窗口） */
let windowInFront: (sessionId: string) => boolean = () => false
export function setWindowInFrontChecker(check: (sessionId: string) => boolean): void {
  windowInFront = check
}

/** 网络客户端 id → 它展示着的会话、页面在不在眼前 */
const networkShown = new Map<string, { sessionId: string | null; visible: boolean }>()

/** 网络客户端上报（每次切会话、页面切前后台、得失焦点都报） */
export function noteNetworkShown(
  clientId: string,
  sessionId: string | null,
  visible: boolean
): void {
  networkShown.set(clientId, { sessionId, visible })
}

/** 一条网络连接断了：它不再展示任何会话（否则一台掉线的手机会一直被当成在看） */
export function forgetNetworkClient(clientId: string): void {
  networkShown.delete(clientId)
}

/** 这条会话此刻在用户眼前吗：某个桌面窗口展示着它且有焦点，或者某个网络客户端展示着它且报了可见 */
export function isSessionInFront(sessionId: string): boolean {
  if (windowInFront(sessionId)) return true
  for (const shown of networkShown.values()) {
    if (shown.sessionId === sessionId && shown.visible) return true
  }
  return false
}

const listeners = new Set<(sessionId: string) => void>()

/** 订阅「一条会话来到眼前」 */
export function onSessionInFront(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 某个前端刚报了它在展示这条会话：此刻在眼前就通知订阅者 */
export function noteShown(sessionId: string | null): void {
  if (!sessionId || !isSessionInFront(sessionId)) return
  for (const listener of listeners) listener(sessionId)
}
