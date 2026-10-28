/**
 * 停靠区 —— 浏览器窗口里页面下方那一块：原生 DevTools 与 agent 的 devtool 两个页签（见 shared/browserAgentDevtools.ts）。
 *
 * **按 tab 记**（照 Chrome）：每一页自己开着 / 关着停靠区、停在哪个页签；换选中的页，停靠区跟着换成那一页的。
 * 只由用户打开、关闭 —— 快捷键（F12 / ⌥⌘I）、⋮ 菜单、页面右键「检查」、提示条；agent 的动作从不碰它。
 *
 * 原生 DevTools 就是 Chromium 自带的那份前端（devtools://devtools/bundled/…，与 Chrome 同一份），
 * `setDevToolsWebContents` 把它开进我们自己的一个 WebContentsView（frontend），再像页面一样按 renderer
 * 上报的矩形挂到浏览器窗口上。agent 的 CDP 接入（webContents.debugger）与它是两个独立的调试客户端，
 * 互不断开（2026-10-21 实测，Electron 39：开 / 关 / 再开 DevTools，agent 的命令照常；先开 DevTools 再
 * attach 也行）。
 *
 * frontend 懒建：停靠区开在「Agent」页签时不建，用户第一次切到「DevTools」才建；关掉停靠区就连它一起销毁
 * （setDevToolsWebContents 要一个从没导航过的 webContents，所以每次重开都是新的一个）。开着但不显示的
 * frontend（停靠区切到了「Agent」、选中了别的页）只是从窗口上摘下来，状态（选中的面板、控制台历史、
 * 网络记录）都留着。
 *
 * frontend 用应用自己的 session —— 它不是网页，不进浏览器的 partition（不该和网站共用 cookie、也不受
 * 网站权限策略管）。它不在 tab 表里，agent 看不到、碰不到。
 */
import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { createLogger } from '../../logger'
import type { DevtoolsDockPanel, DevtoolsDockState } from '../../../shared/browserAgentDevtools'

const log = createLogger('BrowserDevtools')

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Dock {
  panel: DevtoolsDockPanel
  /** 原生 DevTools 前端（还没切到过「DevTools」页签 = null） */
  frontend: WebContentsView | null
}

/** tabId → 这一页的停靠区（关着 = 没有这一项） */
const docks = new Map<string, Dock>()

/**
 * 前端加载到哪了：页面的 devtools-opened 到来（Electron 在前端报 loadCompleted 时发）之前，前端还收不了
 * DevToolsAPI 的调用 —— 2026-10-28 实测，did-finish-load 时调 showPanel 会被吞掉。那之前要做的先记着。
 */
interface FrontendState {
  ready: boolean
  pending: string[]
}
const frontendStates = new WeakMap<WebContentsView, FrontendState>()
/** renderer 上报的原生 DevTools 该铺在哪（CSS px）；停靠区没显示「DevTools」页签时为 null */
let nativeSlot: { tabId: string; bounds: Rect } | null = null
/** 正挂在浏览器窗口上的那个 frontend（同一时刻最多一个） */
let mounted: { view: WebContentsView; parent: BrowserWindow } | null = null

/**
 * 宿主接进来的东西（browserViewService 启动时注入）：找页面、发事件、窗口在不在、frontend 上的快捷键。
 * 这样本模块不 import browserViewService，两边不绕圈。
 */
export interface DockHost {
  pageOf: (tabId: string) => WebContents | null
  hostWindow: () => BrowserWindow | null
  /** 浏览器窗口此刻让不让原生 view 上墙（对话框覆盖层开着时 false） */
  panelVisible: () => boolean
  send: (channel: string, payload: unknown) => void
  /** frontend 上也接浏览器快捷键（焦点在 DevTools 里时 ⌘W、F12 照样管用） */
  installShortcuts: (wc: WebContents) => void
  /** DevTools 里点的链接（控制台里的地址、Network 面板的「在新标签页中打开」）：开成新 tab */
  openUrl: (url: string) => void
}
let host: DockHost | null = null

export function setDockHost(h: DockHost): void {
  host = h
}

function publish(tabId: string): void {
  const dock = docks.get(tabId)
  host?.send('browser-view:tab-devtools', {
    tabId,
    devtools: dock ? { panel: dock.panel } : null
  })
}

/** 这一页的停靠区状态（关着回 undefined） */
export function devtoolsDockOf(tabId: string): DevtoolsDockState | undefined {
  const dock = docks.get(tabId)
  return dock ? { panel: dock.panel } : undefined
}

/**
 * 建这一页的原生 DevTools 前端（已经有就用那个）。页面已经没了回 null。
 */
function ensureFrontend(tabId: string, dock: Dock): WebContentsView | null {
  if (dock.frontend && !dock.frontend.webContents.isDestroyed()) return dock.frontend
  const page = host?.pageOf(tabId)
  if (!page || page.isDestroyed()) return null
  const frontend = new WebContentsView()
  frontendStates.set(frontend, { ready: false, pending: [] })
  host?.installShortcuts(frontend.webContents)
  page.setDevToolsWebContents(frontend.webContents)
  page.openDevTools({ mode: 'detach', activate: false })
  dock.frontend = frontend
  log.info(`DevTools opened (tab ${tabId})`)
  return frontend
}

/** 收掉这一页的原生 DevTools 前端（关 DevTools、销毁 view） */
function disposeFrontend(tabId: string, dock: Dock): void {
  const frontend = dock.frontend
  if (!frontend) return
  dock.frontend = null
  unmount(frontend)
  const page = host?.pageOf(tabId)
  if (page && !page.isDestroyed()) page.closeDevTools()
  if (!frontend.webContents.isDestroyed()) frontend.webContents.close()
  log.info(`DevTools closed (tab ${tabId})`)
}

function unmount(view: WebContentsView): void {
  if (mounted?.view !== view) return
  if (!mounted.parent.isDestroyed()) mounted.parent.contentView.removeChildView(view)
  mounted = null
}

/**
 * 打开这一页的停靠区（已经开着就换到这个页签）。切到「DevTools」才建原生前端。
 * 只由用户的动作调。
 */
export function openDevtoolsDock(tabId: string, panel: DevtoolsDockPanel): void {
  if (!host?.pageOf(tabId)) return
  let dock = docks.get(tabId)
  if (!dock) {
    dock = { panel, frontend: null }
    docks.set(tabId, dock)
  }
  dock.panel = panel
  if (panel === 'devtools') ensureFrontend(tabId, dock)
  publish(tabId)
  applyDevtoolsLayout()
}

/** 关掉这一页的停靠区（原生 DevTools 一起关掉） */
export function closeDevtoolsDock(tabId: string): void {
  const dock = docks.get(tabId)
  if (!dock) return
  docks.delete(tabId)
  disposeFrontend(tabId, dock)
  publish(tabId)
  applyDevtoolsLayout()
}

/** F12 / ⌥⌘I：开着就关，关着就开在「DevTools」页签 */
export function toggleDevtoolsDock(tabId: string): void {
  if (docks.has(tabId)) closeDevtoolsDock(tabId)
  else openDevtoolsDock(tabId, 'devtools')
}

/**
 * ⌥⌘J / Ctrl+Shift+J：原生 DevTools 正显示着就关（照 Chrome：停靠着的 DevTools 再按一次是关）；
 * 否则打开到「DevTools」页签、切到 Console。
 */
export function toggleDevtoolsConsole(tabId: string): void {
  if (docks.get(tabId)?.panel === 'devtools') {
    closeDevtoolsDock(tabId)
    return
  }
  openDevtoolsDock(tabId, 'devtools')
  callFrontend(tabId, 'DevToolsAPI.showPanel("console")')
}

/**
 * ⌥⌘C / ⌘⇧C / Ctrl+Shift+C：打开到「DevTools」页签并切换「选择元素」模式 —— 开着再按一次就退出
 * （enterInspectElementMode 在前端里执行的就是那个切换动作，与 Chrome 同一个入口；2026-10-28 实测）。
 */
export function toggleInspectElementMode(tabId: string): void {
  openDevtoolsDock(tabId, 'devtools')
  callFrontend(tabId, 'DevToolsAPI.enterInspectElementMode()')
}

/**
 * 在这一页的原生 DevTools 前端里调一个 DevToolsAPI 方法（Chrome 的 DevToolsWindow::DoAction 走的同一组
 * 入口）。前端还没加载完就记下来，等 noteDevtoolsOpened。script 只来自本模块的固定字面量。
 */
function callFrontend(tabId: string, script: string): void {
  const frontend = docks.get(tabId)?.frontend
  const state = frontend ? frontendStates.get(frontend) : undefined
  if (!frontend || !state) return
  if (!state.ready) {
    state.pending.push(script)
    return
  }
  runInFrontend(frontend, script)
}

function runInFrontend(frontend: WebContentsView, script: string): void {
  if (frontend.webContents.isDestroyed()) return
  frontend.webContents.executeJavaScript(script).catch((err: unknown) => {
    log.warn(`DevTools frontend call failed: ${script}`, err)
  })
}

/** 页面的 devtools-opened：它的前端加载完了，先前记着的调用这时做 */
export function noteDevtoolsOpened(tabId: string): void {
  const frontend = docks.get(tabId)?.frontend
  const state = frontend ? frontendStates.get(frontend) : undefined
  if (!frontend || !state || state.ready) return
  state.ready = true
  const pending = state.pending.splice(0)
  for (const script of pending) runInFrontend(frontend, script)
}

/** 页面右键「检查」：打开原生 DevTools 并选中那个位置上的元素（坐标是页面的 CSS px） */
export function inspectElementAt(tabId: string, x: number, y: number): void {
  openDevtoolsDock(tabId, 'devtools')
  const page = host?.pageOf(tabId)
  if (page && !page.isDestroyed() && docks.get(tabId)?.frontend) page.inspectElement(x, y)
}

/**
 * DevTools 自己关掉了（前端崩了之类，不是我们关的）：正看着它就把停靠区一起收；停在「Agent」页签（前端只是
 * 在后台留着）就只丢掉那个前端，下次切回「DevTools」再建一个新的。
 */
export function noteDevtoolsClosed(tabId: string): void {
  const dock = docks.get(tabId)
  if (!dock?.frontend) return
  if (dock.panel === 'devtools') {
    closeDevtoolsDock(tabId)
    return
  }
  const frontend = dock.frontend
  dock.frontend = null
  unmount(frontend)
  if (!frontend.webContents.isDestroyed()) frontend.webContents.close()
}

/**
 * renderer 上报原生 DevTools 那块矩形（CSS px；没显示「DevTools」页签时 null）。
 * 只认开着停靠区、停在「DevTools」页签的那一页。
 */
export function setDevtoolsLayout(slot: { tabId: string; bounds: Rect } | null): void {
  nativeSlot = slot
  applyDevtoolsLayout()
}

/**
 * 把原生 DevTools 摆到该在的地方：上报的那一页、窗口让原生 view 上墙时挂上去，其余一律摘下。
 * 页面的布局变了（窗口缩放、覆盖层开关）也要重摆一次 —— browserViewService 的 applyLayout 会调。
 */
export function applyDevtoolsLayout(): void {
  const win = host?.hostWindow()
  const slot = nativeSlot
  const dock = slot ? docks.get(slot.tabId) : undefined
  const frontend =
    win && !win.isDestroyed() && host?.panelVisible() && slot && dock?.panel === 'devtools'
      ? ensureFrontend(slot.tabId, dock)
      : null
  if (!frontend || !slot || !win) {
    if (mounted) unmount(mounted.view)
    return
  }
  if (mounted && mounted.view !== frontend) unmount(mounted.view)
  if (!mounted) {
    win.contentView.addChildView(frontend)
    mounted = { view: frontend, parent: win }
  }
  const zoom = win.webContents.getZoomFactor()
  frontend.setBounds({
    x: Math.round(slot.bounds.x * zoom),
    y: Math.round(slot.bounds.y * zoom),
    width: Math.round(slot.bounds.width * zoom),
    height: Math.round(slot.bounds.height * zoom)
  })
}

/** 浏览器窗口换了（建出来 / 销毁）：旧窗口上报的矩形作废，frontend 从旧窗口上摘下 */
export function resetDevtoolsLayout(): void {
  nativeSlot = null
  if (mounted) unmount(mounted.view)
}

/** tab 关掉了：它的停靠区一起没了（页面已经在销毁，不必再 closeDevTools） */
export function forgetDevtoolsDock(tabId: string): void {
  const dock = docks.get(tabId)
  if (!dock) return
  docks.delete(tabId)
  if (nativeSlot?.tabId === tabId) nativeSlot = null
  const frontend = dock.frontend
  if (frontend) {
    unmount(frontend)
    if (!frontend.webContents.isDestroyed()) frontend.webContents.close()
  }
}

/** app 退出：全部收掉 */
export function destroyAllDevtoolsDocks(): void {
  for (const tabId of [...docks.keys()]) forgetDevtoolsDock(tabId)
  nativeSlot = null
  mounted = null
}

/** DevTools 里点出来的地址（devtools-open-url）：只开网页 */
export function routeDevtoolsUrl(url: string): void {
  if (/^https?:\/\//i.test(url)) host?.openUrl(url)
}
