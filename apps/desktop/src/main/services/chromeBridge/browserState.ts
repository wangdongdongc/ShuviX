/**
 * 每个已连接浏览器（按扩展的 installId）一份的浏览器侧状态：CDP 会话、按标签页的操作队列、
 * 各会话的标签组、以及「这一轮跑完就释放调试」的租约计数。
 *
 * 为什么按浏览器而不是按会话：标签页属于整个浏览器，同一个浏览器里可以同时开着好几个标签页会话，
 * 它们可能碰到同一个页 —— CDP 的 attach 状态、同一个 tab 上的串行队列都必须是浏览器级的
 * （与桌面内置浏览器面板的「tab 是全 app 共享的」同一个道理）。标签页 id 只在一个浏览器里唯一，
 * 所以也不能全进程一份。
 *
 * **状态跨连接存活**：本地组件重启、桌面重连之后还是同一个浏览器，队列与标签组照旧；
 * 只有 CDP 会话随连接断开清掉本地记账（扩展那边也会在端口断开时主动 detach，见扩展 SW）。
 */
import {
  CdpAttachManager,
  createBrowserTabQueue,
  type BrowserTabQueue,
  type CdpTabTransportFactory
} from '@shuvix/agent-runtime'
import type { ExtensionEventMap } from '@shuvix/chat-protocol/chromeBridge'
import { chromeBridge, type BridgeConnection } from './server'

/** 浏览器没连着时给模型的话 —— 它能照着告诉用户该做什么 */
export const CHROME_NOT_CONNECTED =
  'Chrome is not connected to ShuviX right now (the browser may have been closed, or the ShuviX extension was reloaded). Ask the user to reopen the ShuviX side panel in Chrome.'

type CdpListener = (method: string, params: Record<string, unknown>) => void

/** 取某浏览器此刻的连接；没连着抛给模型看的错 */
export function requireConnection(installId: string): BridgeConnection {
  const conn = chromeBridge.connectionFor(installId)
  if (!conn) throw new Error(CHROME_NOT_CONNECTED)
  return conn
}

export class ChromeBrowserState {
  /** 同一个 tab 上的操作串行（不同会话的 server 共用这一条） */
  readonly tabQueue: BrowserTabQueue = createBrowserTabQueue()
  readonly cdp: CdpAttachManager
  /** 会话 → 它开出来的标签页所在的组（浏览器重启后组 id 失效，由扩展的 group.ensure 重建） */
  readonly groups = new Map<string, number>()
  private readonly attached = new Set<number>()
  private readonly listeners = new Map<number, Set<CdpListener>>()
  /** 此刻正在跑一轮的会话（按会话记，漏收一次 agent_end 也不会让计数永远不归零） */
  private readonly running = new Set<string>()

  constructor(readonly installId: string) {
    this.cdp = new CdpAttachManager(this.transportFactory())
  }

  private transportFactory(): CdpTabTransportFactory {
    return {
      attach: async (tabKey) => {
        const tabId = Number(tabKey)
        await requireConnection(this.installId).request('debugger.attach', { tabId })
        this.attached.add(tabId)
        const listeners = new Set<CdpListener>()
        this.listeners.set(tabId, listeners)
        return {
          // 每条命令现取连接：桌面重连之后是另一个连接对象，同一个浏览器
          sendCommand: async <T>(method: string, params?: Record<string, unknown>) =>
            (await requireConnection(this.installId).request('debugger.send', {
              tabId,
              method,
              params
            })) as T,
          onEvent: (fn) => {
            listeners.add(fn)
            return () => listeners.delete(fn)
          },
          detach: async () => {
            this.forget(tabId)
            await chromeBridge
              .connectionFor(this.installId)
              ?.request('debugger.detach', { tabId })
              .catch(() => {})
          }
        }
      }
    }
  }

  /** 扩展转来的一条 CDP 事件 */
  deliver(event: ExtensionEventMap['debugger.event']): void {
    for (const fn of this.listeners.get(event.tabId) ?? []) fn(event.method, event.params ?? {})
  }

  /** 调试被外部断开（用户点掉横幅 / 开了 DevTools / 页关了）：只清本地记账 */
  externalDetach(tabId: number): void {
    this.forget(tabId)
    this.cdp.handleExternalDetach(String(tabId))
  }

  /** 连接断了：所有 attach 记账作废（扩展那边在端口断开时自己 detach），轮次记账一并清掉 */
  disconnected(): void {
    for (const tabId of [...this.attached]) this.externalDetach(tabId)
    this.running.clear()
  }

  /** 某会话一轮运行开始 / 结束。整个浏览器没有在跑的轮次时释放全部调试（横幅随之消失） */
  beginRun(sessionId: string): void {
    this.running.add(sessionId)
  }

  endRun(sessionId: string): void {
    this.running.delete(sessionId)
    // 释放是廉价的：下一轮任何操作经 cdp.session() 自动重新接管；uid 映射丢了无妨 ——
    // 工具说明本就要求 click / fill 之前先 snapshot
    if (this.running.size === 0) void this.cdp.detachAll()
  }

  /** 会话没了（标签页关了）：它的轮次与标签组记账随之作废 */
  forgetSession(sessionId: string): void {
    this.groups.delete(sessionId)
    this.endRun(sessionId)
  }

  private forget(tabId: number): void {
    this.attached.delete(tabId)
    this.listeners.delete(tabId)
  }
}

const states = new Map<string, ChromeBrowserState>()

/** 某浏览器的状态（懒建，常驻） */
export function chromeBrowserState(installId: string): ChromeBrowserState {
  let state = states.get(installId)
  if (!state) {
    state = new ChromeBrowserState(installId)
    states.set(installId, state)
  }
  return state
}

/** 现有状态（不建） */
export function existingChromeBrowserState(installId: string): ChromeBrowserState | undefined {
  return states.get(installId)
}

// 浏览器事件先在这里消费（CDP 状态），会话层面的反应（标签页关了就结束会话）在 Chrome 前端
chromeBridge.onExtensionEvent((conn, name, params) => {
  const installId = conn.info?.installId
  if (!installId) return
  const state = states.get(installId)
  if (!state) return
  if (name === 'debugger.event') {
    state.deliver(params as ExtensionEventMap['debugger.event'])
  } else if (name === 'debugger.detached') {
    state.externalDetach((params as ExtensionEventMap['debugger.detached']).tabId)
  } else if (name === 'tabs.removed') {
    state.externalDetach((params as ExtensionEventMap['tabs.removed']).tabId)
  }
})

chromeBridge.onConnectionClosed((conn) => {
  const installId = conn.info?.installId
  if (installId) states.get(installId)?.disconnected()
})
