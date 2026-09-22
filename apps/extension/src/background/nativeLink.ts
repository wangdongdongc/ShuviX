/**
 * 通向桌面的那条线 —— 扩展里唯一的原生消息端口（连本地组件 `com.shuvix.chrome_bridge`）。
 *
 * 状态机（侧边栏据此显示空状态）：
 *   connecting ──host:connected──▶ 发 hello ──welcome ok──▶ ready
 *        │                                     └─welcome 不 ok─▶ mismatch
 *        ├──host:offline──▶ desktop-offline（本地组件在，桌面没开；它自己会重连桌面）
 *        └──端口断开──▶ host-missing（Chrome 找不到本地组件）/ desktop-offline（本地组件退出了），退避重连
 *
 * 原生消息端口会给 SW 保活（Chrome 105+），所以连着的时候 SW 不会被回收；连不上时 SW 可能被回收，
 * 由 sw.ts 的 alarm 与各个唤醒点（启动、安装、打开侧边栏）再拉起这条线。
 */
import {
  BridgeChunkAssembler,
  CHROME_BRIDGE_HOST_NAME,
  CHROME_BRIDGE_PROTOCOL,
  isBridgeMessage,
  type BridgeEvent,
  type BridgeHello,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse
} from '@shuvix/chat-protocol/chromeBridge'
import type { PanelLinkState } from '../shared/panelLink'
import { browserLabel, getInstallId, getRunId } from './identity'
import { detachAllDebuggers } from './browserOps'

type DesktopMessage = BridgeRequest | BridgeResponse | BridgeEvent

let port: chrome.runtime.Port | null = null
let state: PanelLinkState = 'connecting'
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 60_000
const assembler = new BridgeChunkAssembler()
const stateListeners = new Set<(state: PanelLinkState) => void>()
const messageListeners = new Set<(message: DesktopMessage) => void>()

export function linkState(): PanelLinkState {
  return state
}

export function onLinkState(fn: (state: PanelLinkState) => void): () => void {
  stateListeners.add(fn)
  return () => stateListeners.delete(fn)
}

/** 桌面发来的请求 / 应答 / 事件 */
export function onDesktopMessage(fn: (message: DesktopMessage) => void): () => void {
  messageListeners.add(fn)
  return () => messageListeners.delete(fn)
}

function setState(next: PanelLinkState): void {
  if (state === next) return
  state = next
  for (const fn of stateListeners) fn(next)
}

/** 发给桌面；没连着回 false（调用方替桌面回错） */
export function sendToDesktop(message: BridgeMessage): boolean {
  if (!port) return false
  try {
    port.postMessage(message)
    return true
  } catch {
    return false
  }
}

async function sendHello(): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])
  const hello: BridgeHello = {
    type: 'hello',
    protocol: CHROME_BRIDGE_PROTOCOL,
    extensionVersion: chrome.runtime.getManifest().version,
    installId: await getInstallId(),
    runId: await getRunId(),
    browser: browserLabel(),
    openTabIds: tabs.map((t) => t.id).filter((id): id is number => id != null && id >= 0)
  }
  sendToDesktop(hello)
}

function onNativeMessage(raw: unknown): void {
  if (!isBridgeMessage(raw)) return
  switch (raw.type) {
    case 'host':
      if (raw.desktop === 'connected') {
        setState('connecting')
        void sendHello()
      } else {
        setState('desktop-offline')
      }
      return
    case 'welcome':
      setState(raw.ok ? 'ready' : 'mismatch')
      return
    case 'chunk': {
      const whole = assembler.push(raw)
      if (whole) onNativeMessage(whole)
      return
    }
    case 'request':
    case 'response':
    case 'event':
      for (const fn of messageListeners) fn(raw)
      return
    default:
      return
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  const delay = reconnectDelay
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    ensureNativeLink()
  }, delay)
}

/** 没连着就连（幂等）。各个唤醒点都调它 */
export function ensureNativeLink(): void {
  if (port) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  let next: chrome.runtime.Port
  try {
    next = chrome.runtime.connectNative(CHROME_BRIDGE_HOST_NAME)
  } catch {
    setState('host-missing')
    scheduleReconnect()
    return
  }
  port = next
  setState('connecting')
  next.onMessage.addListener(onNativeMessage)
  next.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? ''
    if (port === next) port = null
    assembler.clear()
    // 「找不到 / 不许用」= 本地组件没装（桌面没装，或装了还没启动过一次）；其余是它退出了
    setState(
      /not found|forbidden|access to the specified native messaging host/i.test(error)
        ? 'host-missing'
        : 'desktop-offline'
    )
    // 桌面那边的 attach 记账随连接作废 —— 横幅也不该留着
    void detachAllDebuggers()
    scheduleReconnect()
  })
}

/** 连上了就把退避归零（下次断开从 1 秒重试） */
onLinkState((s) => {
  if (s === 'ready') reconnectDelay = 1000
})
