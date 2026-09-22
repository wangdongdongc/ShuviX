/**
 * 每个标签页的侧边栏 —— 开、连、转发。
 *
 *  - **开**：点工具栏图标 → 只为**这个**标签页启用并打开侧边栏（全局默认关着，没开过的标签页不显示）。
 *  - **连**：侧边栏页面连一条端口到 SW（名字 `panel:<tabId>`）；SW 把连接状态推给它。
 *  - **转发**：侧边栏的请求原样转给桌面，应答按请求 id 送回；桌面推来的会话事件按会话 id 找到挂着
 *    这条会话的标签页、送给它的侧边栏；应用事件送给所有侧边栏。
 */
import {
  BRIDGE_ERROR_DESKTOP_OFFLINE,
  type BridgeEvent,
  type BridgeResponse
} from '@shuvix/chat-protocol/chromeBridge'
import { PANEL_PORT_PREFIX, type PanelToWorker, type WorkerToPanel } from '../shared/panelLink'
import { linkState, onLinkState, sendToDesktop, ensureNativeLink } from './nativeLink'

interface PanelEntry {
  tabId: number
  port: chrome.runtime.Port
}

/** 标签页 → 它的侧边栏端口 */
const panels = new Map<number, PanelEntry>()
/** 标签页 → 挂在它上面的会话（由 tabSession.open 的应答得知） */
const sessionOfTab = new Map<number, string>()
/** 转给桌面的请求 id → 哪个侧边栏的哪个请求 */
const pending = new Map<
  string,
  { tabId: number; port: chrome.runtime.Port; id: number; method: string }
>()
let seq = 0

function post(port: chrome.runtime.Port, message: WorkerToPanel): void {
  try {
    port.postMessage(message)
  } catch {
    /* 侧边栏已关 */
  }
}

/** 工具栏图标：为当前标签页开侧边栏（必须在用户手势里同步调 open —— 不要先 await 别的） */
export function openPanelForTab(tab: chrome.tabs.Tab): void {
  if (tab.id == null || tab.id < 0) return
  void chrome.sidePanel
    .setOptions({ tabId: tab.id, path: `sidepanel.html?tabId=${tab.id}`, enabled: true })
    .catch(() => {})
  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {})
}

/** 侧边栏连进来 */
export function acceptPanelPort(port: chrome.runtime.Port): void {
  if (!port.name.startsWith(PANEL_PORT_PREFIX)) return
  const tabId = Number(port.name.slice(PANEL_PORT_PREFIX.length))
  if (!Number.isInteger(tabId)) {
    port.disconnect()
    return
  }
  // 同一个标签页的旧端口（页面刷新过）让位
  panels.set(tabId, { tabId, port })
  ensureNativeLink()
  post(port, { kind: 'status', state: linkState() })

  port.onMessage.addListener((message: PanelToWorker) => {
    if (message?.kind !== 'request') return
    if (linkState() !== 'ready') {
      post(port, {
        kind: 'response',
        id: message.id,
        ok: false,
        error: BRIDGE_ERROR_DESKTOP_OFFLINE
      })
      return
    }
    const bridgeId = `p${++seq}`
    pending.set(bridgeId, { tabId, port, id: message.id, method: message.method })
    const sent = sendToDesktop({
      type: 'request',
      id: bridgeId,
      method: message.method,
      params: message.params
    })
    if (!sent) {
      pending.delete(bridgeId)
      post(port, {
        kind: 'response',
        id: message.id,
        ok: false,
        error: BRIDGE_ERROR_DESKTOP_OFFLINE
      })
    }
  })

  port.onDisconnect.addListener(() => {
    if (panels.get(tabId)?.port === port) panels.delete(tabId)
    for (const [key, entry] of pending) if (entry.port === port) pending.delete(key)
  })
}

/** 桌面对某个侧边栏请求的应答 */
export function deliverResponse(response: BridgeResponse): boolean {
  const entry = pending.get(response.id)
  if (!entry) return false
  pending.delete(response.id)
  if (entry.method === 'tabSession.open' && response.ok) {
    const sessionId = (response.result as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId === 'string') sessionOfTab.set(entry.tabId, sessionId)
  }
  post(entry.port, {
    kind: 'response',
    id: entry.id,
    ok: response.ok,
    result: response.result,
    error: response.error
  })
  return true
}

/** 桌面推来的事件：会话事件给挂着那条会话的侧边栏，应用事件给所有侧边栏 */
export function deliverDesktopEvent(event: BridgeEvent): void {
  if (event.name === 'chat.event') {
    const { sessionId, event: chatEvent } = (event.params ?? {}) as {
      sessionId?: string
      event?: unknown
    }
    for (const [tabId, sid] of sessionOfTab) {
      if (sid !== sessionId) continue
      const panel = panels.get(tabId)
      if (panel) post(panel.port, { kind: 'chat.event', event: chatEvent })
    }
  } else if (event.name === 'app.event') {
    const appEvent = (event.params as { event?: unknown } | undefined)?.event
    for (const panel of panels.values()) post(panel.port, { kind: 'app.event', event: appEvent })
  }
}

/** 标签页关了：它的侧边栏跟着没了 */
export function forgetTab(tabId: number): void {
  panels.delete(tabId)
  sessionOfTab.delete(tabId)
}

// 连接状态变化推给所有侧边栏；连接断了，挂着的请求一律以「桌面不在」失败
onLinkState((state) => {
  for (const panel of panels.values()) post(panel.port, { kind: 'status', state })
  if (state !== 'ready') {
    for (const [key, entry] of pending) {
      pending.delete(key)
      post(entry.port, {
        kind: 'response',
        id: entry.id,
        ok: false,
        error: BRIDGE_ERROR_DESKTOP_OFFLINE
      })
    }
  }
})
