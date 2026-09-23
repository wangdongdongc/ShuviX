/**
 * BrowserViewService — 管理浏览器窗口里的多 tab WebContentsView（网格卡片墙）
 *
 * Tab 真源在主进程：Map<tabId, WebContentsView> + activeTabId。
 * renderer 侧 store 只是镜像，经 `browser-view:tab-*` 事件单向同步。
 *
 * 位置由浏览器窗口的 renderer 一次性上报的**布局表**决定（tabId → bounds，CSS px 存储、
 * apply 时乘 zoomFactor）：出现在表里的 tab 挂进浏览器窗口、铺在它自己的卡片矩形上；
 * 没出现的**停到停放窗口**（stagingWindow.ts：从不显示的窗口，桌面尺寸）。
 * 单视图就是「表里只有一项」，网格视图是「表里有 N 项」，主进程不需要知道模式。
 *
 * **tab 的 view 永远不 setVisible(false)**：从建出来就隐藏的 view 截图失败、agent 的点击不落地，
 * 出过帧后再隐藏的 view 跨站导航后截图变空（实测，见 stagingWindow.ts）。「不显示」一律等于
 * 「挂在停放窗口里、照常可见」。tab 从停放窗口出生，浏览器窗口开不开、开着是否被盖住、
 * 是否最小化，都不影响 agent 操作它 —— 所以 agent 开 tab 不需要、也不会把浏览器窗口弄出来。
 * 关窗不销毁 tab（保留页面状态），销毁只发生在 closeTab 与 app 退出。
 */

import { WebContentsView, BrowserWindow, dialog, session } from 'electron'
import { randomUUID } from 'crypto'
import { createLogger } from '../../logger'
import { settingsDao } from '../../dao/settingsDao'
import { t } from '../../i18n'
import { browserCdpManager } from './browserCdpService'
import { clipUrl, externalOpenDecision, routeExternalUrl } from '../externalOpen'
import { appEventBus } from '../../utils/appEventBus'
import { destroyStagingWindow, getStagingWindow, STAGING_SIZE } from './stagingWindow'
import { hasAgentGuards, uninstallAgentGuards } from './agentGuards'

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
/** 每个 tab 此刻挂在哪个窗口上：浏览器窗口（在卡片槽里）或停放窗口 */
const parentOf = new Map<string, BrowserWindow>()
let activeTabId: string | null = null
/** 浏览器窗口（卡片墙）；没开过 / 已销毁时为 null —— tab 照样活在停放窗口里 */
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
/** 卡片墙此刻是否让 view 上墙（有对话框覆盖层时 renderer 报 false，view 全部回停放窗口让位） */
let panelVisible = false
let sessionInitialized = false
/** 运行期信任的自签名 host 集合（跨 tab 共享），进程结束即失效 */
const trustedHosts = new Set<string>()
/** 同一 host 的并发证书弹窗合并：复用 in-flight 决策 Promise */
const pendingCertPrompts = new Map<string, Promise<boolean>>()

/**
 * 初始化浏览器 partition 的权限策略。
 *
 * 主应用 defaultSession 的 permission handler 一律放行（自有页面）；
 * 内置浏览器跑用户访问的任意外部站点，安全策略必须独立：默认全部拒绝，
 * 后续如需开启某些权限再做"按域名询问"的对话框。
 *
 * 必须在 `app.whenReady` 之后、首次 createTab 之前调用一次。
 */
export function initBrowserSession(): void {
  if (sessionInitialized) return
  sessionInitialized = true

  const sess = session.fromPartition(BROWSER_PARTITION)
  // 这也是页面**导航**到非网页协议（同框链接、改 location、iframe、cdp Page.navigate）通往系统的
  // 那道门：Electron 以 `openExternal` 权限来问，这里照样拒绝。弹窗的去向另在 createTab 的
  // setWindowOpenHandler 里裁决（externalOpen.ts）。
  sess.setPermissionRequestHandler((_webContents, permission, callback) => {
    log.info(`Permission denied for embedded browser: ${permission}`)
    callback(false)
  })
  // 下载：没人接的话 Electron 缺省弹「另存为」框。用户正看着浏览器窗口（多半是自己点的）就照常；
  // 否则是 agent 在后台点出来的 —— 取消，不弹框。已经带着保存路径的（比如 agent 经 cdp
  // Page.setDownloadBehavior 指定了目录）不会弹框，放它走。
  sess.on('will-download', (event, item) => {
    if (browserWindowInFront() || item.getSavePath()) return
    log.info(
      `Download while the browser window is not in front: cancelled ${clipUrl(item.getURL())}`
    )
    event.preventDefault()
  })
}

/**
 * 用户此刻是否正看着浏览器窗口（可见、未最小化、有焦点）—— 是就回这个窗口。
 *
 * 所有会弹东西或把焦点交给别的应用的事（证书确认框、外部协议交给系统 / 询问、下载另存为框）
 * 都只在这时发生：agent 在后台驱动的页面无论点了什么，都不能打扰用户在主窗口里打字和操作。
 * 用户自己在浏览器窗口里点的，窗口正有焦点，照常处理。
 */
export function browserWindowInFront(): BrowserWindow | null {
  const w = hostWindow
  return w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused() ? w : null
}

/** 把 view 挂到 target 窗口（已经挂在那里就不动） */
function attachTo(tabId: string, view: WebContentsView, target: BrowserWindow): void {
  const current = parentOf.get(tabId)
  if (current === target) return
  if (current && !current.isDestroyed()) current.contentView.removeChildView(view)
  target.contentView.addChildView(view)
  parentOf.set(tabId, target)
}

/**
 * 停进停放窗口：桌面尺寸、**可见**（见文件头：不在墙上 ≠ 隐藏）。
 *
 * 不动页面缩放：Chromium 的缩放按 host 共享（同一站点的所有 tab 一个缩放），停放的 tab 若重置成 1，
 * 会把墙上同站卡片的缩放一起改掉、两边来回打架。停放的 tab 沿用它那个站点在墙上的缩放
 * （排版宽度 = 1280 / 缩放），从没上过墙的站点就是默认的 1。agent 的坐标都是 CSS px，不受影响。
 */
function park(tabId: string, view: WebContentsView): void {
  attachTo(tabId, view, getStagingWindow())
  view.setBounds({ x: 0, y: 0, width: STAGING_SIZE.width, height: STAGING_SIZE.height })
  view.setVisible(true)
}

/**
 * 换浏览器窗口（窗口建出来 / 销毁时由 browserWindowService 调）。
 * 布局表是旧窗口的 renderer 报的，换窗口即作废：所有 view 先回停放窗口，新窗口的 renderer
 * 上报布局后再按表上墙。窗口销毁时传 null。
 */
export function setHostWindow(win: BrowserWindow | null): void {
  if (hostWindow === win) return
  hostWindow = win
  layout = new Map()
  applyLayout()
}

/** 通知主窗口侧（侧栏浏览器按钮的计数徽标）：tab 数变了 */
function publishTabCount(): void {
  appEventBus.publish({ type: 'browser.tabsChanged', count: tabs.size })
}

/** 布局表只认宿主窗口上报的矩形（别的窗口发来的会把表清空） */
export function isHostWebContents(webContentsId: number): boolean {
  return !!hostWindow && !hostWindow.isDestroyed() && hostWindow.webContents.id === webContentsId
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

/**
 * 把布局表 + panelVisible 施加到全部 view（窗口 zoom 现算）：表里有落位的挂进浏览器窗口、铺到
 * 自己的矩形上；其余停到停放窗口。**没有哪条分支 setVisible(false)**（原因见文件头）。
 */
function applyLayout(): void {
  const host = hostWindow && !hostWindow.isDestroyed() ? hostWindow : null
  const winZoom = host ? host.webContents.getZoomFactor() : 1
  for (const [tabId, view] of tabs) {
    if (view.webContents.isDestroyed()) continue
    const slot = host && panelVisible ? layout.get(tabId) : undefined
    if (!host || !slot) {
      park(tabId, view)
      continue
    }
    attachTo(tabId, view, host)
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

/**
 * tab 里的 window.open / target=_blank 往哪去（从不真开新窗口）：http(s) 新开一个 tab（住进停放窗口，
 * 不打扰任何人）；其余协议交给 externalOpen 那道闸 —— 直接交给系统、先问用户、或拒绝 ——
 * 但**只在用户正看着浏览器窗口时**：mailto 之类会拉起别的应用并抢走焦点，询问框会弹在屏幕上，
 * agent 在后台点出来的都不能这样。用户不在看时一律静默拒绝（记日志）。
 */
/**
 * window.open 出来的 http(s) 页面开成新 tab。开它的 tab 若在 agent 手里（装着防护），这个弹出页也是
 * agent 活动的一部分：先接管、装好文件框 / 打印防护、开好对话框自动处理，**再**加载 —— 否则一加载就
 * 自动打印的「打印版」页面、弹 alert 的页面会从后台弹出原生对话框。
 */
function openPopupTab(openerTabId: string, url: string): void {
  try {
    if (!hasAgentGuards(openerTabId)) {
      createTab(url, { activate: true })
      return
    }
    const id = createTab('about:blank', { activate: true })
    void browserCdpManager
      .session(id)
      .then(async (session) => {
        await session.enableDialogHandling().catch(() => {})
        const view = tabs.get(id)
        if (view && !view.webContents.isDestroyed()) await view.webContents.loadURL(url)
      })
      .catch((err) => log.warn('opening a guarded popup tab failed', err))
  } catch (err) {
    log.warn('window.open createTab failed', err)
  }
}

function routeWindowOpen(openerTabId: string, targetUrl: string, pageUrl: string): void {
  const inFront = browserWindowInFront()
  if (!inFront) {
    const decision = externalOpenDecision(targetUrl)
    if (decision.action === 'web') {
      openPopupTab(openerTabId, decision.url)
    } else {
      log.info(
        `window.open to a non-web target while the browser window is not in front: refused ${clipUrl(targetUrl)}`
      )
    }
    return
  }
  void routeExternalUrl(targetUrl, {
    parent: inFront,
    source: { labelKey: 'externalOpen.fromPanel', value: pageUrl },
    onWeb: (url) => openPopupTab(openerTabId, url)
  })
}

/** 创建新 tab；返回 tabId。超过 MAX_TABS 抛错 */
export function createTab(url?: string, opts?: { activate?: boolean }): string {
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
      partition: BROWSER_PARTITION,
      // 不做后台节流，且**必须在构造时设**。
      // 为什么关：面板不在前台、窗口最小化、平铺墙里没完整露出的卡片，view 都是隐藏的；
      // 默认节流下隐藏页面的计时器被压到约 1 次/秒、requestAnimationFrame 直接停摆
      // （实测 setTimeout(50) 要 830~1000ms，点击后 50ms 的界面更新拖到近 1 秒）——
      // agent 下一拍快照还看不到反应，于是「点了没反应」再点一次。
      // 为什么必须在这里而不是 CDP attach 时：宿主窗口**从未显示过**时运行期调
      // webContents.setBackgroundThrottling()，会永久弄坏该 webContents 的 capturePage
      // （"Current display surface not available for capture"，调回 true、显示窗口、reload
      // 都救不回来）。浏览器窗口是懒创建、以隐藏态起步的，agent 完全可能在它第一次露面之前
      // 就开 tab 并 attach —— 构造时设则在任何窗口状态下都安全（2026-09-22 实测）。
      // 代价是用户自己开的 tab 也不节流 —— 上限 12 个 tab，这个代价换的是截图始终可用。
      backgroundThrottling: false
      // 无 preload — 纯 Web 内容，与主 renderer 完全隔离
    }
  })

  // 从停放窗口出生（可见、桌面尺寸）：浏览器窗口开不开都能被 agent 操作；
  // 浏览器窗口的 renderer 给它排出卡片槽后，applyLayout 再把它挂上墙
  park(tabId, view)

  const wc = view.webContents

  // 弹窗 / target=_blank：http(s) 在面板新开 tab，其他协议能否交给系统见 routeWindowOpen
  wc.setWindowOpenHandler(({ url: targetUrl }) => {
    routeWindowOpen(tabId, targetUrl, wc.getURL())
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
    // 证书问题要用户当场裁决，但弹窗绝不能打扰用户手上的事：只有用户正看着浏览器窗口
    // （窗口可见且有焦点）时才问。否则拒绝这次加载 —— 卡片上会显示证书错误与「重试」，
    // 用户点重试时窗口正有焦点，再问。agent 发起的导航因此永远不会凭空弹出对话框、抢走焦点。
    const parent = browserWindowInFront()
    if (!parent) {
      log.info(`Certificate error for ${host} while the browser window is not in front: refused`)
      callback(false)
      return
    }

    let pending = pendingCertPrompts.get(host)
    if (!pending) {
      pending = (async () => {
        try {
          const { response } = await dialog.showMessageBox(parent, {
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

  // 总是真的导航一次（没给地址就是 about:blank）：从没导航过的 webContents 没有渲染进程，
  // agent 之后 attach 上去发的 CDP 命令会一直等下去
  void wc.loadURL(url ?? 'about:blank')
  if (opts?.activate) activateTab(tabId)
  publishTabCount()

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

  // tab 即将销毁：清理其 CDP 会话（本地状态即可，webContents.close 会带走 debugger）与防护
  uninstallAgentGuards(tabId)
  browserCdpManager.handleExternalDetach(tabId)

  const ids = [...tabs.keys()]
  tabs.delete(tabId)
  layout.delete(tabId)
  const parent = parentOf.get(tabId)
  parentOf.delete(tabId)
  if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(view)
  view.webContents.close()

  if (activeTabId === tabId) {
    const idx = ids.indexOf(tabId)
    const nextId = ids[idx + 1] ?? ids[idx - 1] ?? null
    activeTabId = null
    if (nextId) activateTab(nextId)
  }

  sendToRenderer('browser-view:tab-closed', { tabId, activeTabId })
  publishTabCount()
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

/** tab 列表快照（renderer 水合用），顺序 = tab 条顺序；带 CDP 状态供重载后恢复标识 */
export function listTabs(): Array<{
  id: string
  url: string
  title: string
  active: boolean
  cdpAttached: boolean
  cdpIntercepting: boolean
}> {
  return [...tabs.entries()].map(([id, view]) => {
    const cdp = browserCdpManager.cdpState(id)
    return {
      id,
      url: view.webContents.getURL() || 'about:blank',
      title: view.webContents.getTitle(),
      active: id === activeTabId,
      cdpAttached: cdp.attached,
      cdpIntercepting: cdp.intercepting
    }
  })
}

/**
 * 浏览器窗口的 renderer 上报卡片墙布局（CSS px）：**一次提交全部同屏 tab**。
 * 未出现在 entries 里的 tab 一律回停放窗口（不隐藏，见文件头）—— 这是单视图/网格视图的唯一区别，
 * 也是不做逐 tab 增量更新的原因（拖拽/切模式时 N 次 IPC 会撕裂）。
 */
export function setLayout(entries: Array<{ tabId: string; bounds: Rect; zoom?: number }>): void {
  layout = new Map(entries.map((e) => [e.tabId, { bounds: e.bounds, zoom: e.zoom ?? 1 }]))
  applyLayout()
}

/**
 * 抓某个 tab 当前画面（dataURL，按 maxWidth 缩放）。
 * 平铺墙滚动时露出半张卡片的那一瞬间用它顶上 —— 原生 view 没法被 DOM 裁剪，
 * 但一张 DOM <img> 可以。停放窗口里的 tab 照样抓得到（它们一直可见、一直在出帧）。
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
  for (const [tabId, view] of tabs) {
    uninstallAgentGuards(tabId)
    const parent = parentOf.get(tabId)
    if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(view)
    view.webContents.close()
  }
  tabs.clear()
  parentOf.clear()
  layout.clear()
  activeTabId = null
  hostWindow = null
  destroyStagingWindow()
  log.info('All browser tabs destroyed')
}

export function getBrowserHostWindow(): BrowserWindow | null {
  return hostWindow
}
