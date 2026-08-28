/**
 * BrowserViewService — 管理主窗口中嵌入的多 tab WebContentsView（浏览器面板）
 *
 * Tab 真源在主进程：Map<tabId, WebContentsView> + activeTabId。
 * renderer 侧 store 只是镜像，经 `browser-view:tab-*` 事件单向同步。
 *
 * 可见性与位置由 renderer 一次性上报的**布局表**决定（tabId → bounds，CSS px 存储、
 * apply 时乘 zoomFactor）：出现在表里的 tab 显示在它自己的矩形上，没出现的隐藏。
 * 单视图就是「表里只有一项」，网格视图是「表里有 N 项」，主进程不需要知道模式。
 * 面板关闭不销毁 tab（保留页面状态），销毁只发生在 closeTab 与 app 退出。
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
interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 一个 tab 在面板里的落位：矩形 + 页面缩放（卡片小的时候按桌面宽度排版再整体缩小） */
interface Slot {
  bounds: Rect
  /** 页面 zoomFactor；1 = 原样。与宿主窗口的 UI zoom 无关 */
  zoom: number
}

/** renderer 上报的布局表：tabId → 落位（CSS px；apply 时才乘窗口 zoom，避免 zoom 变化后陈旧） */
let layout = new Map<string, Slot>()
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

/**
 * 导航会把页面缩放打回默认值（zoom 按 origin 记，提交时重置），
 * 所以每次导航提交/加载结束都要按布局表里的期望值重设一次。
 */
function reapplyZoom(tabId: string): void {
  const slot = layout.get(tabId)
  const view = tabs.get(tabId)
  if (!slot || !view || view.webContents.isDestroyed()) return
  if (Math.abs(view.webContents.getZoomFactor() - slot.zoom) > 0.001) {
    view.webContents.setZoomFactor(slot.zoom)
  }
}

/** 把布局表 + panelVisible 施加到全部 view（窗口 zoom 现算）：表里有落位的可见，其余隐藏 */
function applyLayout(): void {
  if (!hostWindow || hostWindow.isDestroyed()) return
  const winZoom = hostWindow.webContents.getZoomFactor()
  for (const [tabId, view] of tabs) {
    const slot = panelVisible ? layout.get(tabId) : undefined
    if (!slot) {
      view.setVisible(false)
      continue
    }
    const { bounds, zoom } = slot
    view.setBounds({
      x: Math.round(bounds.x * winZoom),
      y: Math.round(bounds.y * winZoom),
      width: Math.round(bounds.width * winZoom),
      height: Math.round(bounds.height * winZoom)
    })
    // 页面缩放：卡片很小时按桌面宽度排版再整体缩小，避免只看到手机版局部。
    // 对 agent 透明 —— CDP 的坐标与 getBoundingClientRect 都是 CSS px，与 zoom 无关。
    if (Math.abs(view.webContents.getZoomFactor() - zoom) > 0.001) {
      view.webContents.setZoomFactor(zoom)
    }
    view.setVisible(true)
  }
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

  // 加载态直接跟随 Chromium 自己的 tab spinner 位：did-start/stop-loading 必然成对，
  // 无论导航是成功、失败、被 stop() 打断还是转成下载。
  // 切勿退回「did-start-navigation 点亮 / did-finish-load 熄灭」的推导：
  // same-document 导航（pushState / hash 路由）根本不会有 did-finish-load，
  // SPA 每切一次路由就把 spinner 永久卡在加载中。
  wc.on('did-start-loading', () => {
    sendToRenderer('browser-view:did-start-loading', { tabId })
  })

  wc.on('did-stop-loading', () => {
    reapplyZoom(tabId)
    sendToRenderer('browser-view:did-stop-loading', { tabId })
  })

  // 渲染进程崩溃 / 被杀时不会有 did-stop-loading，兜底熄灭 spinner
  wc.on('render-process-gone', (_event, details) => {
    log.warn(`Tab renderer gone: ${tabId} (${details.reason})`)
    sendToRenderer('browser-view:did-stop-loading', { tabId })
  })

  // 地址栏即时反馈：导航一开始就把目标 URL 交给 renderer（主框架、非 same-document）
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    sendToRenderer('browser-view:did-navigate', { tabId, url: details.url })
  })

  wc.on('did-navigate', (_event, navUrl) => {
    reapplyZoom(tabId)
    sendToRenderer('browser-view:did-navigate', { tabId, url: navUrl })
  })

  wc.on('did-navigate-in-page', (_event, navUrl, isMainFrame) => {
    if (!isMainFrame) return
    sendToRenderer('browser-view:did-navigate', { tabId, url: navUrl })
  })

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    // -3 (ABORTED)：用户主动停止或导航被新导航取代，不是错误页；spinner 由 did-stop-loading 收尾
    if (errorCode === -3) return
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

/**
 * 激活指定 tab —— 只改「谁是 agent 的默认目标 + 卡片高亮」。
 * 可见性与位置一律由 renderer 的布局表决定，这里不动任何 view 的落位。
 */
export function activateTab(tabId: string): void {
  const view = tabs.get(tabId)
  if (!view || tabId === activeTabId) return

  activeTabId = tabId

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
  layout.delete(tabId)
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

/**
 * renderer 上报面板布局（CSS px）：**一次提交全部同屏 tab**。
 * 未出现在 entries 里的 tab 一律隐藏 —— 这是单视图/网格视图的唯一区别，
 * 也是不做逐 tab 增量更新的原因（拖拽/切模式时 N 次 IPC 会撕裂）。
 */
export function setLayout(entries: Array<{ tabId: string; bounds: Rect; zoom?: number }>): void {
  layout = new Map(entries.map((e) => [e.tabId, { bounds: e.bounds, zoom: e.zoom ?? 1 }]))
  applyLayout()
}

/**
 * 抓某个 tab 当前画面（dataURL，按 maxWidth 缩放）。
 * 平铺墙滚动时露出半张卡片的那一瞬间用它顶上 —— 原生 view 没法被 DOM 裁剪，
 * 但一张 DOM <img> 可以。隐藏的 view 也能抓到（返回最后一帧）。
 */
export async function captureTab(tabId: string, maxWidth = 480): Promise<string> {
  const view = tabs.get(tabId)
  if (!view || view.webContents.isDestroyed()) return ''
  try {
    const image = await view.webContents.capturePage()
    if (image.isEmpty()) return ''
    const { width } = image.getSize()
    const scaled = width > maxWidth ? image.resize({ width: maxWidth }) : image
    return scaled.toDataURL()
  } catch (err) {
    log.warn('capturePage failed', err)
    return ''
  }
}

/** 面板可见性（面板级，与具体 tab 无关） */
export function setPanelVisible(visible: boolean): void {
  panelVisible = visible
  applyLayout()
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
  layout.clear()
  activeTabId = null
  hostWindow = null
  log.info('All browser tabs destroyed')
}

export function getBrowserHostWindow(): BrowserWindow | null {
  return hostWindow
}
