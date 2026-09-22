/**
 * 每个已连接浏览器（按扩展的 installId）一份的浏览器侧状态：CDP 会话、按标签页的操作队列、
 * 各会话的标签组、以及「这一轮跑完就释放调试」的租约计数。
 *
 * 为什么按浏览器而不是按会话：标签页属于整个浏览器，同一个浏览器里可以同时开着好几个标签页会话，
 * 它们可能碰到同一个页 —— CDP 的 attach 状态、同一个 tab 上的串行队列都必须是浏览器级的
 * （与桌面内置浏览器面板的「tab 是全 app 共享的」同一个道理）。标签页 id 只在一个浏览器里唯一，
 * 所以也不能全进程一份。
 *
 * **状态跨连接存活**：本地组件重启、桌面重连之后还是同一个浏览器，队列、标签组、轮次照旧；
 * 只有 CDP 会话的本地记账跟着连接走 —— 扩展在端口断开、或本地组件报告桌面离线时会主动 detach
 * （见扩展 SW），所以一条新连接就绪时、以及当前那条连接断开时清掉它。
 *
 * **轮次按会话的事件流记**（`observeChromeTabRun`，桌面广播 ChatEvent 时旁听），不经侧边栏：
 * 侧边栏关着、连接断过又连上，一轮照样有始有终，调试照样在它跑完时释放。
 */
import {
  CdpAttachManager,
  createBrowserTabQueue,
  type BrowserTabQueue,
  type CdpTabTransportFactory
} from '@shuvix/agent-runtime'
import type { ExtensionEventMap } from '@shuvix/chat-protocol/chromeBridge'
import { chromeTabOf } from '@shuvix/chat-protocol/chromeTabSession'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { sessionDao } from '../../dao/sessionDao'
import { chromeBridge, type BridgeConnection } from './server'
import { forgetSiteGrants } from './siteGrants'

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
  /** 会话 → 它正在进行的那次建组 / 并组（串行：见 joinGroup） */
  private readonly groupChains = new Map<string, Promise<void>>()
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

  /**
   * 连接换了（断开 / 新连接就绪）：所有 attach 记账作废 —— 扩展那边在端口断开、或得知桌面离线时
   * 自己 detach 了。轮次不动：那是桌面这边的事实，与连接无关（见 observeChromeTabRun）。
   */
  resetDebuggers(): void {
    for (const tabId of [...this.attached]) this.externalDetach(tabId)
  }

  /**
   * 把新开的页并进会话的标签组。同一会话串行：并发的两个 open_tab 各自看到「还没有组」，
   * 就会各建一个。`ensure` 拿到当前的组 id（没有 = undefined），回并入后的组 id。
   */
  joinGroup(
    sessionId: string,
    ensure: (current: number | undefined) => Promise<number>
  ): Promise<void> {
    const previous = this.groupChains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const groupId = await ensure(this.groups.get(sessionId))
      // 会话在这期间没了（标签页关了，forgetSession 清掉了它的链）：不再为它记组
      if (this.groupChains.has(sessionId)) this.groups.set(sessionId, groupId)
    })
    const settled = next.catch(() => {})
    this.groupChains.set(sessionId, settled)
    void settled.then(() => {
      if (this.groupChains.get(sessionId) === settled) this.groupChains.delete(sessionId)
    })
    return next
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

  /** 会话没了（标签页关了）：它的轮次、标签组与站点授权随之作废 */
  forgetSession(sessionId: string): void {
    this.groups.delete(sessionId)
    this.groupChains.delete(sessionId)
    forgetSiteGrants(sessionId)
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

// 新连接就绪：扩展那边是一份新的接管状态 —— 本地记账在任何请求之前归零
chromeBridge.onConnectionReady((conn) => {
  const installId = conn.info?.installId
  if (installId) states.get(installId)?.resetDebuggers()
})

// 当前连接断开才归零；一条已经被新连接顶替的旧连接迟到的断开，不能清掉新连接的记账
chromeBridge.onConnectionClosed((conn) => {
  const installId = conn.info?.installId
  if (!installId || chromeBridge.connectionFor(installId)) return
  states.get(installId)?.resetDebuggers()
})

/**
 * 旁听一条 ChatEvent：Chrome 标签页会话一轮的起止 → 那个浏览器的调试租约（桌面广播事件时调用）。
 * 只看 agent_start / agent_end —— 一轮两次查库；派生 agent 的事件带的是它自己的 id，查不到绑定即略过。
 */
export function observeChromeTabRun(event: ChatEvent): void {
  if (event.type !== 'agent_start' && event.type !== 'agent_end') return
  const binding = chromeTabOf(sessionDao.pickSettings(event.sessionId, ['chromeTab']))
  if (!binding) return
  const state = chromeBrowserState(binding.installId)
  if (event.type === 'agent_start') state.beginRun(event.sessionId)
  else state.endRun(event.sessionId)
}
