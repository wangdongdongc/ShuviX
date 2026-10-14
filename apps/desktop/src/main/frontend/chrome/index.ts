/**
 * Chrome 前端 —— 把桥（services/chromeBridge）接到会话层：标签页会话的开关、侧边栏的对话接口、
 * 事件推送。它是 frontend 的一种具体实现（与 electron 并列）：会话服务、网关都在它下面。
 *
 * 桥上扩展能发来的请求只有三种：
 *  - `tabSession.open`：取（没有就建）这个标签页的会话，并把本连接绑成它的前端；
 *  - `channel.call`：单会话对话接口（白名单 + 归属核对，见 channel.ts）；
 *  - `panel.appearance`：侧边栏跟着桌面的主题 / 字号 / 语言走。
 *
 * 会话内容（消息、流式卡、工具进度、询问）经视图同步到达侧边栏（pi 1.2 / chord2）：每个侧边栏一条 chord 链路，
 * 帧是两个方向的桥事件 `sync.link`（`chromeLinks.ts`），链路交给视图服务端；侧边栏能看什么由这里登记的
 * `chrome` 主体核对决定 —— 只能看这个浏览器这一轮的标签页会话（派生 agent 按它的根会话核对）。
 */
import i18next from 'i18next'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { ChromePanelAppearance } from '@shuvix/chat-protocol/chromeBridge'
import { chatFrontendRegistry } from '../core'
import { appEventBus } from '../../utils/appEventBus'
import { settingsDao } from '../../dao/settingsDao'
import { chromeBridge, type BridgeConnection } from '../../services/chromeBridge'
import type { ViewPrincipal } from '@shuvix/agent-runtime'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import { createLogger } from '../../logger'
import { getSyncHub, registerViewAuthorizer } from '../sync/syncWiring'
import { ChromeFrontend } from './ChromeFrontend'
import { callPanelChannel } from './channel'
import { createChromeLinkHub } from './chromeLinks'
import {
  closeTabSession,
  connectionOwnsSession,
  openTabSession,
  sweepTabSessions,
  tabSessionOwnedBy
} from './tabSessions'

/** 侧边栏外观：与桌面渲染层 settingsStore.loadSettings 同一套取值与缺省 */
export function panelAppearance(): ChromePanelAppearance {
  const get = (key: string): string | undefined => settingsDao.findByKey(key) || undefined
  const rawDark = get('general.darkTheme') || 'github-dark'
  const rawLight = get('general.lightTheme') || 'github-light'
  const theme = get('general.theme')
  return {
    theme: theme === 'light' || theme === 'system' ? theme : 'dark',
    darkTheme: rawDark === 'dark' ? 'github-dark' : rawDark,
    lightTheme: rawLight === 'light' ? 'github-light' : rawLight,
    fontSize: Number(get('general.fontSize')) || 14,
    focusMode: get('appearance.focusMode') !== 'false',
    language: get('general.language') || i18next.language || 'en'
  }
}

async function handleRequest(
  conn: BridgeConnection,
  method: string,
  params: unknown
): Promise<unknown> {
  switch (method) {
    case 'tabSession.open': {
      const p = (params ?? {}) as { tabId?: unknown; title?: unknown }
      const sessionId = await openTabSession(conn, {
        tabId: p.tabId as number,
        title: typeof p.title === 'string' ? p.title : undefined
      })
      // 同一连接同一会话的前端 id 相同 —— 面板重开时是覆盖，不会重复推送
      chatFrontendRegistry.bind(sessionId, new ChromeFrontend(conn, sessionId))
      return { sessionId }
    }
    case 'channel.call': {
      const p = (params ?? {}) as { path?: unknown; args?: unknown }
      return callPanelChannel(conn, p.path, p.args)
    }
    case 'panel.appearance':
      return panelAppearance()
    default:
      throw new Error(`Unknown method "${method}".`)
  }
}

/**
 * 应用事件只转侧边栏用得上、而且只该它看到的：本连接标签页会话的标题 / 配置变化，以及设置变化
 * （外观、语言）。别的会话、项目、知识库的动静与侧边栏无关，也不该出这台机器的桌面进程之外。
 */
function forwardAppEvent(event: AppEvent): void {
  for (const conn of chromeBridge.readyConnections()) {
    if (event.type === 'settings.changed') {
      conn.emit('app.event', { event })
    } else if (
      (event.type === 'session.titleChanged' || event.type === 'session.configChanged') &&
      connectionOwnsSession(conn, event.sessionId)
    ) {
      conn.emit('app.event', { event })
    }
  }
}

const syncLog = createLogger('SyncChrome')

/**
 * `chrome` 主体能不能看这个目标：会话目标必须是这个浏览器（installId）这一轮运行（runId）的标签页会话。
 * **派生 agent 目标一律不让看**（同步判定）：侧边栏从不订阅 agent 视图（`tab` 基座没有 agent 工具，子 agent
 * 面板只在桌面），而按根会话核对得先异步解析 agent —— 那条路与目标的激活并行，会让未授权的请求也去 peek 别人的
 * 根会话，「禁止」与「找不到」谁先到也就透露了那个 agent 存不存在
 */
export function chromeViewAllowed(principal: ViewPrincipal, target: SyncTarget): boolean {
  if (target.kind !== 'session') return false
  const installId = typeof principal.installId === 'string' ? principal.installId : ''
  const runId = typeof principal.runId === 'string' ? principal.runId : ''
  return tabSessionOwnedBy(target.sessionId, installId, runId)
}

/** 侧边栏的视图同步链路（每个侧边栏一条），交给视图服务端（第一条链路到了才建它） */
const syncLinks = createChromeLinkHub({
  accept: (link, principal) => getSyncHub().accept(link, principal),
  logger: syncLog
})

let registered = false

/** 启动时装一次（在 IPC 注册之后、桥服务开始监听之前） */
export function registerChromeFrontend(): void {
  if (registered) return
  registered = true
  chromeBridge.setHandlers({
    onReady: (_conn, hello) => void sweepTabSessions(hello),
    onRequest: handleRequest,
    onEvent: (conn, name, params) => {
      if (name === 'tabs.removed') {
        void closeTabSession(conn, (params as { tabId?: number })?.tabId as number)
      } else if (name === 'sync.link') {
        syncLinks.receive(conn, params)
      }
    }
  })
  appEventBus.subscribe(forwardAppEvent)
  // 视图同步：侧边栏只能看自己浏览器这一轮的标签页会话；连接断了，它上面的链路全部结束（订阅、钉住随之松开）
  registerViewAuthorizer('chrome', chromeViewAllowed)
  chromeBridge.onConnectionClosed((conn) => syncLinks.closeConnection(conn.id))
}
