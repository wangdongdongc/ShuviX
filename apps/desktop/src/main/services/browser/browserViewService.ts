/**
 * BrowserViewService — 管理浏览器窗口里的多 tab WebContentsView（网格卡片墙）
 *
 * Tab 真源在主进程：Map<tabId, WebContentsView> + activeTabId。
 * renderer 侧 store 只是镜像，经 `browser-view:tab-*` 事件单向同步。
 *
 * **activeTabId 是用户选中的那一页（Chrome 的「当前标签页」），只由用户改**：点标签、快捷键、
 * 新开 tab、关掉选中的那页时落到邻居。agent 的动作从不改它 —— agent 开的 tab 在后台、操作哪页都
 * 不切过去（2026-10-16 用户裁定：选中永不跟随 agent），否则用户正看着的页面会被 agent 换走。
 * agent 在哪页上干活另记一份（agentUse：最近操作它的会话），标签上的圆点与提示条读它。
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

import { WebContentsView, BrowserWindow, session, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { createLogger } from '../../logger'
import { settingsDao } from '../../dao/settingsDao'
import { browserCdpManager } from './browserCdpService'
import { clipUrl, externalOpenDecision, routeExternalUrl } from '../externalOpen'
import { appEventBus } from '../../utils/appEventBus'
import { destroyStagingWindow, getStagingWindow, STAGING_SIZE } from './stagingWindow'
import { agentActing, hasAgentGuards, uninstallAgentGuards } from './agentGuards'
import { browserShortcutFor, nextZoomPercent, type BrowserShortcut } from './shortcuts'
import {
  internalPageOf,
  internalPageUrl,
  type InternalPage
} from '../../../shared/browserInternalPages'

const log = createLogger('BrowserView')

/**
 * 内置浏览器的独立持久化 partition。
 * 与主应用 defaultSession 隔离 cookie / localStorage / IndexedDB / cache / Service Worker，
 * 同时保留登录态持久化（`persist:` 前缀）。
 */
export const BROWSER_PARTITION = 'persist:shuvix-browser'

/** tab 数量上限 — 每个 WebContentsView 是独立渲染进程，防失控 */
const MAX_TABS = 12
/** ⌘⇧T 能重开的、最近被用户关掉的页面个数 */
const MAX_CLOSED_URLS = 10
/** 同一个 tab 上 agent 动作的提示（tab-agent 事件）最密多久发一次 */
const AGENT_USE_THROTTLE_MS = 250

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
  /**
   * 页面 zoomFactor；1 = 原样。与宿主窗口的 UI zoom 无关。
   * 不给 = 用户自己按站点调的缩放（⌘+ / ⌘−，见 userZoom）—— 单页视图就是这样；平铺墙按卡片宽度给。
   */
  zoom?: number
}

/** renderer 上报的布局表：tabId → 落位（CSS px；apply 时才乘窗口 zoom，避免 zoom 变化后陈旧） */
let layout = new Map<string, Slot>()
/** 卡片墙此刻是否让 view 上墙（有对话框覆盖层时 renderer 报 false，view 全部回停放窗口让位） */
let panelVisible = false
let sessionInitialized = false
/**
 * 用户在证书警告页上点了「继续前往（不安全）」的站点（host，跨 tab 共享）；进程结束即失效。
 * 照 Chrome：放行只对这个站点、只到退出为止。
 */
const trustedHosts = new Set<string>()
/**
 * 每个 tab 最近一次因证书错误被挡下的主框架加载：警告页上的「继续前往」只认这一条（host 与要重新加载的地址），
 * 不接受 renderer 报来的任意 host —— 放行哪个站点由主进程自己看到的那次错误决定。
 */
const certBlocked = new Map<string, { host: string; url: string }>()
/**
 * 内部页面（shuvix://settings …）：tabId → 页名。这种 tab 的 webContents 只是一张 about:blank 占位，
 * 页面本身是浏览器窗口外壳里的 DOM（见 shared/browserInternalPages.ts）；agent 看不到它们。
 */
const internalPages = new Map<string, InternalPage>()

/** 最近一个在这页上动作的会话（标签上的圆点、「〈会话〉正在使用此页面」提示条） */
interface AgentUse {
  sessionId: string
  /** 上一次给 renderer 发提示的时刻（节流用） */
  sentAt: number
}
const agentUse = new Map<string, AgentUse>()
/** 哪个会话的 agent 开的这个 tab（list_tabs 给它标「opened by you」）；用户开的不在表里 */
const openerSession = new Map<string, string>()
/**
 * 宿主接进来的两件与会话有关的事。浏览器模块不碰会话表、不碰主窗口（单测也就不必拉起数据库）：
 * main/index.ts 启动时注入。
 */
export interface BrowserSessionHooks {
  /** 会话标题（提示条、标签悬停里写的会话名）；查不到回空串 */
  sessionTitle: (sessionId: string) => string
  /** 把主窗口拉到前面并切到这个会话（提示条上的「查看对话」）；会话不存在回 false */
  openSession: (sessionId: string) => boolean
}
let sessionHooks: BrowserSessionHooks = { sessionTitle: () => '', openSession: () => false }

export function setBrowserSessionHooks(hooks: BrowserSessionHooks): void {
  sessionHooks = hooks
}

/** 「查看对话」：交给宿主把主窗口切到那个会话 */
export function openAgentSession(sessionId: string): boolean {
  return sessionHooks.openSession(sessionId)
}

/** 用户最近关掉的页面地址（⌘⇧T 从尾巴上取） */
const closedUrls: string[] = []
/**
 * 用户按站点调的页面缩放（host → zoomFactor），照 Chrome：⌘+ / ⌘− 记在站点上，换 tab、导航回来都还在。
 * Chromium 自己的缩放也按 host 共享，但平铺墙会按卡片宽度把同站页面改小 —— 这份表是用户的那个值，
 * 回到单页视图时照它恢复。进程结束即失效。
 */
const userZoom = new Map<string, number>()

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
  const zoom = slot.zoom ?? userZoomOf(view)
  if (Math.abs(view.webContents.getZoomFactor() - zoom) > 0.001) {
    view.webContents.setZoomFactor(zoom)
  }
}

/**
 * 缩放按站点记，与 Chromium 自己的按站点缩放同一个键（HostZoomMap：有主机名用主机名 —— 不含端口；
 * 没有主机名的 file: / about: 之类用整个地址，不含 # 之后）：localhost:3000 与 localhost:4000 是同一个站点，
 * 两个本地文件各是各的。
 */
function zoomKeyOf(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname || url.split('#')[0]
  } catch {
    return url
  }
}

/** 这个 view 当前站点上用户调的缩放（没调过 = 1） */
function userZoomOf(view: WebContentsView): number {
  return userZoom.get(zoomKeyOf(view.webContents.getURL())) ?? 1
}

/** 用户缩放的百分比（提示与地址栏右端的缩放标识用） */
function userZoomPercentOf(view: WebContentsView): number {
  return Math.round(userZoomOf(view) * 100)
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
    const { bounds } = slot
    const zoom = slot.zoom ?? userZoomOf(view)
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
 *
 * 选不选中它照 Chrome：用户在自己正看着的那页上点出来的（窗口在前台、开它的就是选中的那页、agent 此刻
 * 没在那页上动作）开在前台；其余 —— agent 点出来的、后台页面自己弹的 —— 开在后台，不换掉用户正看着的页。
 * agent 那页弹出的新页记在同一个会话名下（list_tabs 里是「opened by you」）。
 */
function openPopupTab(openerTabId: string, url: string): void {
  const byAgent = agentActing(openerTabId)
  const activate = !!browserWindowInFront() && openerTabId === activeTabId && !byAgent
  const opener = byAgent ? agentUse.get(openerTabId)?.sessionId : undefined
  const opts = { activate, ...(opener ? { openerSessionId: opener } : {}) }
  try {
    if (!hasAgentGuards(openerTabId)) {
      createTab(url, opts)
      return
    }
    const id = createTab('about:blank', opts)
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

/**
 * 创建新 tab；返回 tabId。超过 MAX_TABS 抛错。
 *
 * `activate`：开在前台（用户的动作：新标签页、⌘T、自己点出来的弹出页）。不给就开在后台 —— 但一个 tab
 * 都没选中时（窗口是空的）新 tab 照样成为选中的那页，没有谁正看着别的页会被换走。
 * `openerSessionId`：agent 开的 tab 记下是哪个会话开的。
 */
export function createTab(
  url?: string,
  opts?: { activate?: boolean; openerSessionId?: string; internalPage?: InternalPage }
): string {
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
  // 浏览器窗口的 renderer 给它排出卡片槽后，applyLayout 再把它挂上墙。
  // 停放窗口建不出来（无头运行的服务器上 Chromium 拒绝开窗之类）：收掉这个 view、抛给调用方 ——
  // agent 的工具据此回一个失败，而不是留下一个挂不上任何窗口的 webContents
  try {
    park(tabId, view)
  } catch (error) {
    parentOf.delete(tabId)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not create the browser's hidden window: ${reason}`)
  }

  const wc = view.webContents

  // 浏览器快捷键（⌘T / ⌘W / ⌘L / ⌘R …）：焦点在页面里时由这里接。只有真实键盘触发，agent 的 CDP 按键不会
  installShortcuts(wc)

  // 弹窗 / target=_blank：http(s) 在面板新开 tab，其他协议能否交给系统见 routeWindowOpen
  wc.setWindowOpenHandler(({ url: targetUrl }) => {
    routeWindowOpen(tabId, targetUrl, wc.getURL())
    return { action: 'deny' }
  })

  // ====== 证书错误：照 Chrome 用整页警告，不弹框 ======
  // 证书有问题的主框架加载一律挡下（页面区显示「您的连接不是私密连接」）；用户在警告上点「继续前往（不安全）」
  // 才放行这个站点、直到退出（proceedPastCertError）。按钮在浏览器窗口外壳里，agent 点不到 —— agent 发起的
  // 导航既不会凭空弹出对话框，也不能替用户放行。设置里「忽略全部证书错误」打开时一律放行（内网自签名用）。
  wc.on('certificate-error', (event, certUrl, _error, _cert, callback, isMainFrame) => {
    event.preventDefault()
    // 照 Chrome，放行按主机名记（不含端口）
    let host: string
    try {
      host = new URL(certUrl).hostname
    } catch {
      callback(false)
      return
    }
    if (!host) {
      callback(false)
      return
    }
    const ignoreAll = settingsDao.findByKey('tool.browser.ignoreCertificateErrors') === 'true'
    if (ignoreAll || trustedHosts.has(host)) {
      callback(true)
      return
    }
    if (isMainFrame) certBlocked.set(tabId, { host, url: certUrl })
    log.info(`Certificate error for ${host}: blocked (the page shows the warning)`)
    callback(false)
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

  // 渲染进程崩溃 / 被杀时不会有 did-stop-loading，兜底熄灭 spinner；卡片换成「页面崩溃了」+ 重试
  // （崩溃的 view 什么也不画，不换的话就是一张空白卡片）。重新加载开始时 did-start-loading 清掉它
  wc.on('render-process-gone', (_event, details) => {
    log.warn(`Tab renderer gone: ${tabId} (${details.reason})`)
    sendToRenderer('browser-view:did-stop-loading', { tabId })
    sendToRenderer('browser-view:did-fail-load', {
      tabId,
      errorCode: 0,
      errorDescription: details.reason,
      url: wc.getURL(),
      crashed: true
    })
  })

  // 地址栏即时反馈：导航一开始就把目标 URL 交给 renderer（主框架、非 same-document）
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    // 内部页面那张 about:blank 占位之外的导航（地址栏、后退前进）：这个 tab 不再是内部页面
    if (internalPages.has(tabId) && details.url !== 'about:blank') internalPages.delete(tabId)
    // 去了别的地址：上一次被挡下的证书错误作废（警告页上的「继续前往」只对它自己那次加载有效）
    if (certBlocked.get(tabId)?.url !== details.url) certBlocked.delete(tabId)
    sendToRenderer('browser-view:did-navigate', { tabId, url: displayUrlOf(tabId, details.url) })
  })

  // 提交了导航：地址、能否后退 / 前进、这个站点上用户调的缩放（换了站点就换一个值）
  const sendCommitted = (navUrl: string): void => {
    sendToRenderer('browser-view:did-navigate', {
      tabId,
      url: displayUrlOf(tabId, navUrl),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      zoomPercent: userZoomPercentOf(view)
    })
  }

  wc.on('did-navigate', (_event, navUrl) => {
    reapplyZoom(tabId)
    sendCommitted(navUrl)
  })

  wc.on('did-navigate-in-page', (_event, navUrl, isMainFrame) => {
    if (!isMainFrame) return
    sendCommitted(navUrl)
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

  // 页面自己 window.close()（登录弹窗授权完成、会话过期页……）：Electron 不问任何人就销毁这个
  // webContents，view 被摘离窗口，之后 `view.webContents` 是 undefined、对旧引用调方法抛
  // "Object has been destroyed"（2026-10-08 实测，Electron 39；历史不止一条也照关）。
  // 当作这个 tab 关掉了 —— 不收的话 tab 表里留着一个空壳：卡片空白，点关闭在
  // `webContents.close()` 上抛错、renderer 收不到 tab-closed，再点已经查无此 tab，永远关不掉；
  // applyLayout / listTabs 碰到它也会抛。我们自己 close() 的那条路先摘了表项，这里就不再动。
  wc.on('destroyed', () => {
    if (tabs.get(tabId) !== view) return
    log.info(`Tab closed by its page: ${tabId}`)
    forgetTab(tabId, view)
  })

  const activate = !!opts?.activate || activeTabId === null
  tabs.set(tabId, view)
  if (opts?.openerSessionId) openerSession.set(tabId, opts.openerSessionId)
  if (opts?.internalPage) internalPages.set(tabId, opts.internalPage)
  sendToRenderer('browser-view:tab-created', {
    tabId,
    url: opts?.internalPage ? internalPageUrl(opts.internalPage) : (url ?? 'about:blank'),
    active: activate
  })

  // 总是真的导航一次（没给地址就是 about:blank；内部页面也是 —— 页面本身在外壳里）：从没导航过的
  // webContents 没有渲染进程，agent 之后 attach 上去发的 CDP 命令会一直等下去
  void wc.loadURL(opts?.internalPage ? 'about:blank' : (url ?? 'about:blank'))
  if (activate) activateTab(tabId)
  publishTabCount()

  log.info(`Tab created: ${tabId}${url ? ` → ${url}` : ''} (${tabs.size} total)`)
  return tabId
}

/**
 * 选中指定 tab（用户的动作）—— 只改「用户当前看的是哪一页」。
 * 可见性与位置一律由 renderer 的布局表决定（单页视图据此只给选中的那页排位），这里不动任何 view 的落位。
 */
export function activateTab(tabId: string): void {
  const view = tabs.get(tabId)
  if (!view || tabId === activeTabId) return

  activeTabId = tabId

  // CDP 会话按显式 tabId per-tab 管理（browserCdpManager），切 tab 不再断开/清缓冲

  sendToRenderer('browser-view:tab-activated', { tabId })
}

/**
 * 关闭 tab；若关的是选中的 tab，选中右邻（无则左邻），关最后一个则置空。
 * `remember`：用户关的（标签上的 ×、⌘W、菜单）记下地址，⌘⇧T 能重开；agent 的 close_tab 不记。
 */
export function closeTab(tabId: string, opts?: { remember?: boolean }): void {
  const view = tabs.get(tabId)
  if (!view) return
  const wc = view.webContents
  if (opts?.remember) {
    const url = displayUrlOf(tabId, wc.getURL())
    if (url && url !== 'about:blank') {
      closedUrls.push(url)
      if (closedUrls.length > MAX_CLOSED_URLS) closedUrls.shift()
    }
  }
  forgetTab(tabId, view)
  wc.close()
}

/** 重开最近被用户关掉的页面（⌘⇧T），开在前台；没有可重开的回 null */
export function reopenClosedTab(): string | null {
  // 开满了就什么也不做、记录留着 —— 先取出来再建会在 createTab 抛错时把那个地址弄丢
  if (tabs.size >= MAX_TABS) return null
  const url = closedUrls.pop()
  if (!url) return null
  // 关掉的是设置页之类的内部页面：照样开回来（已经开着就选中它）
  const page = internalPageOf(url)
  return page ? openInternalPage(page) : createTab(url, { activate: true })
}

/**
 * 把 tab 从表里摘掉并告诉 renderer —— 关闭 tab 除「销毁 webContents」以外的全部收尾。
 * closeTab 摘完再 close()；页面自己关掉的（createTab 里的 destroyed）只摘。
 */
function forgetTab(tabId: string, view: WebContentsView): void {
  // tab 即将销毁：清理其 CDP 会话（本地状态即可，webContents.close 会带走 debugger）与防护
  uninstallAgentGuards(tabId)
  browserCdpManager.handleExternalDetach(tabId, 'tab-closed')

  const ids = [...tabs.keys()]
  tabs.delete(tabId)
  layout.delete(tabId)
  agentUse.delete(tabId)
  openerSession.delete(tabId)
  internalPages.delete(tabId)
  certBlocked.delete(tabId)
  const parent = parentOf.get(tabId)
  parentOf.delete(tabId)
  if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(view)

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

/** tab 列表快照里的一行 */
export interface BrowserTabSnapshot {
  id: string
  url: string
  title: string
  /** 用户选中的那一页 */
  active: boolean
  cdpAttached: boolean
  cdpIntercepting: boolean
  /** 渲染进程崩了（浏览器窗口晚于崩溃才打开时，靠它把卡片画成「页面崩溃了」） */
  crashed: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 用户在这个站点上调的缩放（百分比） */
  zoomPercent: number
  /** 最近在这页上动作的会话（没有 agent 碰过就没有） */
  agentSessionId?: string
  agentSessionTitle?: string
  /** 开这个 tab 的会话（agent 开的才有） */
  openerSessionId?: string
  /** 内部页面（shuvix://settings …）：url 是它的显示地址 */
  internalPage?: InternalPage
}

/** tab 列表快照（renderer 水合用），顺序 = tab 条顺序；带 CDP 状态供重载后恢复标识 */
export function listTabs(): BrowserTabSnapshot[] {
  return [...tabs.entries()].map(([id, view]) => {
    const cdp = browserCdpManager.cdpState(id)
    const wc = view.webContents
    const use = agentUse.get(id)
    const opener = openerSession.get(id)
    const internal = internalPages.get(id)
    return {
      id,
      url: displayUrlOf(id, wc.getURL() || 'about:blank'),
      title: wc.getTitle(),
      active: id === activeTabId,
      cdpAttached: cdp.attached,
      cdpIntercepting: cdp.intercepting,
      crashed: wc.isCrashed(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      zoomPercent: userZoomPercentOf(view),
      ...(use
        ? { agentSessionId: use.sessionId, agentSessionTitle: sessionTitleOf(use.sessionId) }
        : {}),
      ...(opener ? { openerSessionId: opener } : {}),
      ...(internal ? { internalPage: internal } : {})
    }
  })
}

/** 地址栏里显示的地址：内部页面显示 shuvix://…，其余照原样 */
function displayUrlOf(tabId: string, rawUrl: string): string {
  const page = internalPages.get(tabId)
  return page ? internalPageUrl(page) : rawUrl
}

/** 这个 tab 是不是内部页面（agent 那一侧据此当它不存在） */
export function isInternalTab(tabId: string): boolean {
  return internalPages.has(tabId)
}

/**
 * 打开一个内部页面（⋮ → 设置、站点信息里的「网站设置」、主设置窗口里的「打开浏览器设置」）：
 * 照 Chrome，已经开着就选中那一页，否则新开一个并选中。回 tabId。
 */
export function openInternalPage(page: InternalPage): string {
  for (const [id, p] of internalPages) {
    if (p === page && tabs.has(id)) {
      activateTab(id)
      return id
    }
  }
  return createTab(undefined, { activate: true, internalPage: page })
}

/**
 * 用户在地址栏 / 新标签页 / 错误页的重试里让这个 tab 去一个地址：`shuvix://…` 变成内部页面，
 * 其余照常加载（这个 tab 若原本是内部页面，就不再是了）。
 */
export function navigateTab(tabId: string, url: string): void {
  const view = tabs.get(tabId)
  if (!view || view.webContents.isDestroyed()) return
  const page = internalPageOf(url)
  if (page) {
    internalPages.set(tabId, page)
    // 这页从此对 agent 不存在：agent 若接着它，断开、去掉「正被谁使用」的标记（圆点、提示条跟着消失）
    agentUse.delete(tabId)
    uninstallAgentGuards(tabId)
    void browserCdpManager.detach(tabId).catch(() => undefined)
    sendToRenderer('browser-view:did-navigate', { tabId, url: internalPageUrl(page) })
    void view.webContents.loadURL('about:blank')
    return
  }
  internalPages.delete(tabId)
  void view.webContents.loadURL(url)
}

/**
 * 证书警告页上的「继续前往（不安全）」：放行这个 tab 最近一次被挡下的那个站点（直到退出），重新加载那个地址。
 * 只认主进程自己看到的那次错误；没有就什么也不做（回 false）。
 */
export function proceedPastCertError(tabId: string): boolean {
  const blocked = certBlocked.get(tabId)
  const view = tabs.get(tabId)
  if (!blocked || !view || view.webContents.isDestroyed()) return false
  certBlocked.delete(tabId)
  trustedHosts.add(blocked.host)
  log.info(`Certificate warning bypassed by the user for ${blocked.host}`)
  void view.webContents.loadURL(blocked.url)
  return true
}

/** 用户放行过证书错误的站点（主机名，不含端口；设置页、站点信息里显示；直到退出） */
export function certExceptionHosts(): string[] {
  return [...trustedHosts].sort()
}

/** 地址栏里显示的地址（内部页面是 shuvix://…；IPC get-url 用） */
export function tabDisplayUrl(tabId: string): string {
  const view = tabs.get(tabId)
  if (!view || view.webContents.isDestroyed()) return ''
  return displayUrlOf(tabId, view.webContents.getURL())
}

/** 开这个 tab 的会话（agent 开的才有） */
export function openerSessionOf(tabId: string): string | undefined {
  return openerSession.get(tabId)
}

function sessionTitleOf(sessionId: string): string {
  try {
    return sessionHooks.sessionTitle(sessionId)
  } catch {
    return ''
  }
}

/**
 * agent 在这页上动作了一下（每个带 tabId 的工具调用都会来）：记下是哪个会话，告诉浏览器窗口 ——
 * 标签上的圆点亮起 / 脉动一下，选中这页时提示条写出会话名。**不选中它**（选中只由用户改）。
 * 同一个会话连续动作时节流；换了会话立刻发。
 */
export function noteAgentUse(tabId: string, sessionId: string): void {
  if (!tabs.has(tabId)) return
  const now = Date.now()
  const prev = agentUse.get(tabId)
  if (prev && prev.sessionId === sessionId && now - prev.sentAt < AGENT_USE_THROTTLE_MS) return
  agentUse.set(tabId, { sessionId, sentAt: now })
  sendToRenderer('browser-view:tab-agent', {
    tabId,
    sessionId,
    sessionTitle: sessionTitleOf(sessionId)
  })
}

/**
 * 按站点调缩放（⌘+ / ⌘− / ⌘0，⋮ 菜单）：记进 userZoom，同站点的 tab 一起换（Chrome 的缩放也是按站点的）。
 * 正挂在平铺墙上的卡片按卡片宽度另有缩放，不动它们 —— 回到单页视图时照这个值恢复。
 */
export function zoomTab(tabId: string, direction: 'in' | 'out' | 'reset'): void {
  const view = tabs.get(tabId)
  if (!view || view.webContents.isDestroyed()) return
  const key = zoomKeyOf(view.webContents.getURL())
  const percent = nextZoomPercent(userZoomPercentOf(view), direction)
  if (percent === 100) userZoom.delete(key)
  else userZoom.set(key, percent / 100)
  for (const [id, v] of tabs) {
    if (v.webContents.isDestroyed() || zoomKeyOf(v.webContents.getURL()) !== key) continue
    // 只动按用户缩放排位的（单页视图里的那页）；平铺墙的卡片按卡片宽度另有缩放，停放的不在表里
    const slot = layout.get(id)
    if (slot && slot.zoom === undefined) reapplyZoom(id)
    sendToRenderer('browser-view:tab-zoom', { tabId: id, zoomPercent: percent })
  }
}

// ====== 键盘快捷键 ======

/** 已经接上快捷键的 webContents（外壳每次建窗都会来一次；同一个不接两遍） */
const shortcutTargets = new WeakSet<WebContents>()

/**
 * 把浏览器快捷键接到一个 webContents 上：每个 tab 的页面（createTab 里）和浏览器窗口的外壳
 * （browserWindowService 建窗时）。只认用户真按的键（见 shortcuts.ts 文件头）；停放窗口里的页面
 * 拿不到键盘焦点，所以实际只有挂在浏览器窗口里的那几页会走到这里。
 */
export function installShortcuts(wc: WebContents): void {
  if (shortcutTargets.has(wc)) return
  shortcutTargets.add(wc)
  wc.on('before-input-event', (event, input) => {
    const action = browserShortcutFor(input, process.platform)
    if (!action) return
    event.preventDefault()
    runShortcut(action)
  })
}

/** 选中的那一页（快捷键的作用对象）；没选中任何页回 null */
function selectedView(): { id: string; view: WebContentsView } | null {
  if (!activeTabId) return null
  const view = tabs.get(activeTabId)
  return view && !view.webContents.isDestroyed() ? { id: activeTabId, view } : null
}

/**
 * 用户在外壳里新开了一个空白页（标签条上的 +、菜单、新标签页）：请 renderer 把光标放进地址栏。
 * 键盘焦点本来就在外壳上（用户刚点了它），不碰任何窗口。agent 开的 tab 从不走这里 —— 光标不跟着 agent。
 */
export function requestOmniboxFocus(): void {
  sendToRenderer('browser-view:command', { command: 'focusOmnibox' })
}

/**
 * 让地址栏拿到焦点：键盘焦点先回到外壳（按键时焦点可能在页面里），再请 renderer 聚焦输入框。
 *
 * **只在浏览器窗口已经在前台且有焦点时**才动：`webContents.focus()` 在 macOS / Linux 上会顺手聚焦它所在的
 * 窗口（Electron 的 WebContents::Focus）。快捷键只来自用户真按的键，窗口必然在前台；这道判断保证这里
 * 永远不会把一个窗口弄到眼前（noDisturbGuard.test.ts 的 ST-U14 只放行带着这道判断的这一个函数）。
 */
function focusOmniboxInFront(): void {
  const win = browserWindowInFront()
  if (!win) return
  win.webContents.focus()
  sendToRenderer('browser-view:command', { command: 'focusOmnibox' })
}

/** 执行一个快捷键动作（也供 IPC 复用：外壳的按钮与菜单走同一条路） */
export function runShortcut(action: BrowserShortcut): void {
  const selected = selectedView()
  const ids = [...tabs.keys()]
  switch (action.type) {
    case 'newTab':
      if (tabs.size >= MAX_TABS) return
      createTab(undefined, { activate: true })
      focusOmniboxInFront()
      return
    case 'closeTab':
      if (selected) closeTab(selected.id, { remember: true })
      return
    case 'reopenClosedTab':
      if (tabs.size < MAX_TABS) reopenClosedTab()
      return
    case 'focusOmnibox':
      focusOmniboxInFront()
      return
    case 'reload':
      if (!selected) return
      if (action.ignoreCache) selected.view.webContents.reloadIgnoringCache()
      else selected.view.webContents.reload()
      return
    case 'back':
      if (selected?.view.webContents.navigationHistory.canGoBack()) {
        selected.view.webContents.navigationHistory.goBack()
      }
      return
    case 'forward':
      if (selected?.view.webContents.navigationHistory.canGoForward()) {
        selected.view.webContents.navigationHistory.goForward()
      }
      return
    case 'nextTab':
    case 'previousTab': {
      if (ids.length === 0) return
      const at = activeTabId ? ids.indexOf(activeTabId) : -1
      const step = action.type === 'nextTab' ? 1 : -1
      activateTab(ids[(at + step + ids.length) % ids.length])
      return
    }
    case 'selectTab': {
      const id = action.index === -1 ? ids[ids.length - 1] : ids[action.index]
      if (id) activateTab(id)
      return
    }
    case 'zoom':
      if (selected) zoomTab(selected.id, action.direction)
      return
  }
}

/**
 * 浏览器窗口的 renderer 上报卡片墙布局（CSS px）：**一次提交全部同屏 tab**。
 * 未出现在 entries 里的 tab 一律回停放窗口（不隐藏，见文件头）—— 这是单视图/网格视图的唯一区别，
 * 也是不做逐 tab 增量更新的原因（拖拽/切模式时 N 次 IPC 会撕裂）。
 */
export function setLayout(entries: Array<{ tabId: string; bounds: Rect; zoom?: number }>): void {
  // 没给 zoom 的（单页视图）按用户在那个站点上调的缩放显示，见 Slot.zoom
  layout = new Map(
    entries.map((e): [string, Slot] => [
      e.tabId,
      { bounds: e.bounds, ...(typeof e.zoom === 'number' ? { zoom: e.zoom } : {}) }
    ])
  )
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
  agentUse.clear()
  openerSession.clear()
  internalPages.clear()
  certBlocked.clear()
  closedUrls.length = 0
  userZoom.clear()
  activeTabId = null
  hostWindow = null
  destroyStagingWindow()
  log.info('All browser tabs destroyed')
}

export function getBrowserHostWindow(): BrowserWindow | null {
  return hostWindow
}
