/**
 * BrowserViewService — 管理主窗口中嵌入的多 tab WebContentsView（浏览器面板）
 *
 * Tab 真源在主进程：Map<tabId, WebContentsView> + activeTabId。
 * renderer 侧 store 只是镜像，经 `browser-view:tab-*` 事件单向同步。
 * 所有 tab 共享面板内容区 bounds（CSS px 存储，apply 时乘 zoomFactor），
 * 仅激活 tab 可见；面板关闭不销毁 tab（保留页面状态），销毁只发生在
 * closeTab 与 app 退出。
 */

import { WebContentsView, BrowserWindow, dialog, session, shell } from 'electron'
import { randomUUID } from 'crypto'
import { createLogger } from '../../logger'
import { settingsDao } from '../../dao/settingsDao'
import { t } from '../../i18n'
import { browserCdpManager } from './browserCdpService'

const log = createLogger('BrowserView')

/**
 * 内置浏览器的独立持久化 partition。
 * 与主应用 defaultSession 隔离 cookie / localStorage / IndexedDB / cache / Service Worker，
 * 同时保留登录态持久化（`persist:` 前缀）。
 */
export const BROWSER_PARTITION = 'persist:shuvix-browser'

/** tab 数量上限 — 每个 WebContentsView 是独立渲染进程，防失控 */
const MAX_TABS = 12

/** 插入序即 tab 条顺序 */
const tabs = new Map<string, WebContentsView>()
let activeTabId: string | null = null
let hostWindow: BrowserWindow | null = null
/** renderer 上报的面板内容区 bounds（CSS px；apply 时才乘 zoom，避免 zoom 变化后陈旧） */
let lastCssBounds: { x: number; y: number; width: number; height: number } | null = null
/** 面板（浏览器页签）当前是否可见 */
let panelVisible = false
let sessionInitialized = false
/** 运行期信任的自签名 host 集合（跨 tab 共享），进程结束即失效 */
const trustedHosts = new Set<string>()
/** 同一 host 的并发证书弹窗合并：复用 in-flight 决策 Promise */
const pendingCertPrompts = new Map<string, Promise<boolean>>()

/**
 * 初始化浏览器 partition 的权限策略。
 *
 * 主应用 defaultSession 的 permission handler 一律放行（语音输入等需要）；
 * 内置浏览器跑用户访问的任意外部站点，安全策略必须独立：默认全部拒绝，
 * 后续如需开启某些权限再做"按域名询问"的对话框。
 *
 * 必须在 `app.whenReady` 之后、首次 createTab 之前调用一次。
 */
export function initBrowserSession(): void {
  if (sessionInitialized) return
  sessionInitialized = true

  const sess = session.fromPartition(BROWSER_PARTITION)
  sess.setPermissionRequestHandler((_webContents, permission, callback) => {
    log.info(`Permission denied for embedded browser: ${permission}`)
    callback(false)
  })
}

/** 记录宿主窗口（窗口创建时调用一次）；tab 按需创建 */
export function initBrowserHost(win: BrowserWindow): void {
  hostWindow = win
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (!hostWindow || hostWindow.isDestroyed()) return
  hostWindow.webContents.send(channel, payload)
}

/** 把 lastCssBounds + panelVisible 施加到激活 view（zoom 现算） */
function applyLayoutToActiveView(): void {
  const view = getActiveView()
  if (!view || !hostWindow || hostWindow.isDestroyed()) return
  if (lastCssBounds) {
    const zoom = hostWindow.webContents.getZoomFactor()
    view.setBounds({
      x: Math.round(lastCssBounds.x * zoom),
      y: Math.round(lastCssBounds.y * zoom),
      width: Math.round(lastCssBounds.width * zoom),
      height: Math.round(lastCssBounds.height * zoom)
    })
  }
  view.setVisible(panelVisible && lastCssBounds !== null)
}

/** 创建新 tab；返回 tabId。超过 MAX_TABS 抛错 */
export function createTab(url?: string, opts?: { activate?: boolean }): string {
  if (!hostWindow || hostWindow.isDestroyed()) {
    throw new Error('Browser host window is not available')
  }
  if (tabs.size >= MAX_TABS) {
    throw new Error(`Too many browser tabs (max ${MAX_TABS}). Close some tabs first.`)
  }

  const tabId = randomUUID()
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      // 独立持久化 partition：与主应用 defaultSession 完全隔离，
      // 单独管理 cookie / localStorage / 权限 / 缓存等
      partition: BROWSER_PARTITION
      // 无 preload — 纯 Web 内容，与主 renderer 完全隔离
    }
  })

  // 初始隐藏
  view.setVisible(false)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  hostWindow.contentView.addChildView(view)

  const wc = view.webContents

  // http(s) 弹窗/target=_blank 在面板新开 tab；其他协议（mailto 等）交系统处理
  wc.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:/i.test(targetUrl)) {
      try {
        createTab(targetUrl, { activate: true })
      } catch (err) {
        log.warn('window.open createTab failed', err)
      }
    } else {
      shell.openExternal(targetUrl)
    }
    return { action: 'deny' }
  })

  // ====== 自签名 / 不受信任证书放行（按 host 信任，会话内跨 tab 有效） ======
  // 行为对齐 Chrome：用户点"继续访问"即对该 host 自动放行至会话结束；
  // 同一 host 的并发 cert-error（页面子资源）合并为一次弹窗。
  wc.on('certificate-error', async (event, certUrl, _error, _cert, callback) => {
    event.preventDefault()
    let host: string
    try {
      host = new URL(certUrl).host
    } catch {
      callback(false)
      return
    }
    const ignoreAll = settingsDao.findByKey('tool.browser.ignoreCertificateErrors') === 'true'
    if (ignoreAll || trustedHosts.has(host)) {
      callback(true)
      return
    }
    if (!hostWindow || hostWindow.isDestroyed()) {
      callback(false)
      return
    }

    let pending = pendingCertPrompts.get(host)
    if (!pending) {
      pending = (async () => {
        try {
          const { response } = await dialog.showMessageBox(hostWindow!, {
            type: 'warning',
            buttons: [t('browser.cert.continue'), t('browser.cert.cancel')],
            defaultId: 1,
            cancelId: 1,
            message: t('browser.cert.title', { host }),
            detail: certUrl
          })
          if (response === 0) {
            trustedHosts.add(host)
            return true
          }
          return false
        } catch (err) {
          log.warn('certificate-error dialog failed', err)
          return false
        } finally {
          pendingCertPrompts.delete(host)
        }
      })()
      pendingCertPrompts.set(host, pending)
    }

    callback(await pending)
  })

  // ====== 转发事件到 renderer（payload 均带 tabId） ======

  wc.on('did-start-navigation', (_event, navUrl, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    sendToRenderer('browser-view:did-start-loading', { tabId, url: navUrl })
  })

  wc.on('did-navigate', (_event, navUrl) => {
    sendToRenderer('browser-view:did-navigate', { tabId, url: navUrl })
  })

  wc.on('did-navigate-in-page', (_event, navUrl, isMainFrame) => {
    if (!isMainFrame) return
    sendToRenderer('browser-view:did-navigate', { tabId, url: navUrl })
  })

  wc.on('did-finish-load', () => {
    sendToRenderer('browser-view:did-finish-load', { tabId })
  })

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    // -3 (ABORTED) 是用户主动取消导航（例如 cert 弹窗选取消导致的二次 abort），仅作完成处理
    if (errorCode === -3) {
      sendToRenderer('browser-view:did-finish-load', { tabId })
      return
    }
    sendToRenderer('browser-view:did-fail-load', {
      tabId,
      errorCode,
      errorDescription,
      url: validatedURL
    })
  })

  wc.on('page-title-updated', (_event, title) => {
    sendToRenderer('browser-view:tab-title-updated', { tabId, title })
  })

  wc.on('page-favicon-updated', (_event, favicons) => {
    sendToRenderer('browser-view:tab-favicon-updated', { tabId, favicon: favicons[0] })
  })

  tabs.set(tabId, view)
  sendToRenderer('browser-view:tab-created', {
    tabId,
    url: url ?? 'about:blank',
    active: !!opts?.activate
  })

  if (url) void wc.loadURL(url)
  if (opts?.activate) activateTab(tabId)

  log.info(`Tab created: ${tabId}${url ? ` → ${url}` : ''} (${tabs.size} total)`)
  return tabId
}

/** 激活指定 tab：隐藏旧激活 view、显示新 view、CDP 换绑 */
export function activateTab(tabId: string): void {
  const view = tabs.get(tabId)
  if (!view || tabId === activeTabId) return

  const prev = getActiveView()
  if (prev) prev.setVisible(false)

  activeTabId = tabId
  applyLayoutToActiveView()

  // CDP 会话按显式 tabId per-tab 管理（browserCdpManager），切 tab 不再断开/清缓冲

  sendToRenderer('browser-view:tab-activated', { tabId })
}

/** 关闭 tab；若关的是激活 tab，激活右邻（无则左邻），关最后一个则置空 */
export function closeTab(tabId: string): void {
  const view = tabs.get(tabId)
  if (!view) return

  // tab 即将销毁：清理其 CDP 会话（本地状态即可，webContents.close 会带走 debugger）
  browserCdpManager.handleExternalDetach(tabId)

  const ids = [...tabs.keys()]
  tabs.delete(tabId)
  if (hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.contentView.removeChildView(view)
  }
  view.webContents.close()

  if (activeTabId === tabId) {
    const idx = ids.indexOf(tabId)
    const nextId = ids[idx + 1] ?? ids[idx - 1] ?? null
    activeTabId = null
    if (nextId) activateTab(nextId)
  }

  sendToRenderer('browser-view:tab-closed', { tabId, activeTabId })
  log.info(`Tab closed: ${tabId} (${tabs.size} remaining)`)
}

/** 当前激活 tab 的 view（CDP / agent 动作用） */
export function getActiveView(): WebContentsView | null {
  return activeTabId ? (tabs.get(activeTabId) ?? null) : null
}

/** 按 id 取 view（IPC 导航 handler 用） */
export function getTabView(tabId: string): WebContentsView | null {
  return tabs.get(tabId) ?? null
}

/** tab 列表快照（renderer 水合用），顺序 = tab 条顺序 */
export function listTabs(): Array<{ id: string; url: string; title: string; active: boolean }> {
  return [...tabs.entries()].map(([id, view]) => ({
    id,
    url: view.webContents.getURL() || 'about:blank',
    title: view.webContents.getTitle(),
    active: id === activeTabId
  }))
}

/** renderer 上报面板内容区 bounds（CSS px），只施加到激活 view */
export function updateBounds(cssBounds: {
  x: number
  y: number
  width: number
  height: number
}): void {
  lastCssBounds = cssBounds
  applyLayoutToActiveView()
}

/** 面板可见性（面板级，与具体 tab 无关） */
export function setPanelVisible(visible: boolean): void {
  panelVisible = visible
  const view = getActiveView()
  if (view) view.setVisible(visible && lastCssBounds !== null)
}

/** 销毁全部 tab（app 退出时） */
export function destroyAllTabs(): void {
  void browserCdpManager.detachAll()
  trustedHosts.clear()
  for (const view of tabs.values()) {
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.contentView.removeChildView(view)
    }
    view.webContents.close()
  }
  tabs.clear()
  activeTabId = null
  hostWindow = null
  log.info('All browser tabs destroyed')
}

export function getBrowserHostWindow(): BrowserWindow | null {
  return hostWindow
}
