/**
 * Chrome 前端 —— 把桥（services/chromeBridge）接到会话层：标签页会话的开关、侧边栏的对话接口、
 * 事件推送。它是 frontend 的一种具体实现（与 electron 并列）：会话服务、网关都在它下面。
 *
 * 桥上扩展能发来的请求只有三种：
 *  - `tabSession.open`：取（没有就建）这个标签页的会话，并把本连接绑成它的前端；
 *  - `channel.call`：单会话对话接口（白名单 + 归属核对，见 channel.ts）；
 *  - `panel.appearance`：侧边栏跟着桌面的主题 / 字号 / 语言走。
 *
 * 会话内容（消息、流式卡、工具进度、询问）经视图同步到达侧边栏（P3-09）：`channel.call('sync.invoke')`
 * 把 chord 调用交给 SyncHub（客户端 `chrome:<connId>`），帧经路由传输的 `chrome` 那条（chromeSyncTransport）
 * 推成桥事件 `sync.frame`。
 */
import i18next from 'i18next'
import type { AppEvent } from '@shuvix/chat-protocol/appEvents'
import type { ChromePanelAppearance } from '@shuvix/chat-protocol/chromeBridge'
import { chatFrontendRegistry } from '../core'
import { appEventBus } from '../../utils/appEventBus'
import { settingsDao } from '../../dao/settingsDao'
import { chromeBridge, type BridgeConnection } from '../../services/chromeBridge'
import { createLogger } from '../../logger'
import { syncTransport } from '../sync/syncWiring'
import { ChromeFrontend } from './ChromeFrontend'
import { callPanelChannel } from './channel'
import {
  CHROME_CLIENT_PREFIX,
  createChromeSyncTransport,
  forgetAgentRoots
} from './chromeSyncTransport'
import {
  closeTabSession,
  connectionOwnsSession,
  openTabSession,
  sweepTabSessions
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
      }
    }
  })
  appEventBus.subscribe(forwardAppEvent)
  // 视图同步的 Chrome 传输：帧按客户端 id `chrome:<connId>` 找回那条连接推出去（不建 hub —— 它仍在第一次
  // 同步调用时才建）
  syncTransport.addRoute(
    CHROME_CLIENT_PREFIX,
    createChromeSyncTransport({
      connections: {
        byId: (connId) => chromeBridge.connectionById(connId),
        onClosed: (listener) => chromeBridge.onConnectionClosed(listener)
      },
      logger: syncLog
    })
  )
  chromeBridge.onConnectionClosed((conn) => forgetAgentRoots(conn.id))
}
