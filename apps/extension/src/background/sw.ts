/**
 * MV3 service worker —— ShuviX 扩展在 Chrome 里的全部常驻逻辑。
 *
 * 扩展不跑 agent、没有模型与密钥：它是桌面 ShuviX 在用户 Chrome 里的「手」与「窗口」。
 *  - 窗口：每个标签页右侧可以开一个侧边栏，里面是挂在这个标签页上的一条临时会话（会话跑在桌面）；
 *  - 手：桌面的 `chrome` 内置能力服务器要做的浏览器操作，经这里执行（browserOps.ts）。
 * 两者都走同一条原生消息端口（nativeLink.ts）。
 */
import type { BridgeRequest } from '@shuvix/chat-protocol/chromeBridge'
import { ensureNativeLink, linkState, onDesktopMessage, sendToDesktop } from './nativeLink'
import {
  acceptPanelPort,
  deliverDesktopEvent,
  deliverResponse,
  forgetTab,
  openPanelForTab
} from './panels'
import { forgetDebugger, isAttached, runBrowserOp } from './browserOps'

const RECONNECT_ALARM = 'shuvix-native-link'

// ─── 侧边栏：按标签页开，全局默认关（没开过的标签页不显示） ───

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setOptions({ enabled: false }).catch(() => {})
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
  void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 })
  ensureNativeLink()
})

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setOptions({ enabled: false }).catch(() => {})
  void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 })
  ensureNativeLink()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) ensureNativeLink()
})

chrome.action.onClicked.addListener((tab) => openPanelForTab(tab))

chrome.runtime.onConnect.addListener((port) => acceptPanelPort(port))

// ─── 桌面发来的：浏览器操作请求、侧边栏请求的应答、事件 ───

async function answerBrowserOp(request: BridgeRequest): Promise<void> {
  try {
    const result = await runBrowserOp(request.method, request.params)
    sendToDesktop({ type: 'response', id: request.id, ok: true, result: result ?? null })
  } catch (err) {
    sendToDesktop({
      type: 'response',
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

onDesktopMessage((message) => {
  if (message.type === 'request') void answerBrowserOp(message)
  else if (message.type === 'response') deliverResponse(message)
  else deliverDesktopEvent(message)
})

// ─── 浏览器事件 → 桌面 ───

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId)
  forgetDebugger(tabId)
  if (linkState() === 'ready')
    sendToDesktop({ type: 'event', name: 'tabs.removed', params: { tabId } })
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId
  if (tabId == null || !isAttached(tabId)) return
  sendToDesktop({
    type: 'event',
    name: 'debugger.event',
    params: { tabId, method, params: (params ?? {}) as Record<string, unknown> }
  })
})

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId
  if (tabId == null) return
  forgetDebugger(tabId)
  sendToDesktop({ type: 'event', name: 'debugger.detached', params: { tabId, reason } })
})

// SW 每次被唤醒都先把线连上
ensureNativeLink()
