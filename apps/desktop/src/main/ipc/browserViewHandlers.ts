/**
 * Browser WebContentsView IPC handlers
 *
 * 提供 renderer 对多 tab 嵌入式 WebContentsView 的控制：
 * tab 生命周期（创建/关闭/激活/列表）、导航、bounds 同步、可见性。
 * 导航类通道带 tabId 首参；bounds/visible 是面板级（只作用于激活 tab）。
 */

import { defineHandler, defineListener, type ClientContext } from './registry'
import {
  createTab,
  closeTab,
  activateTab,
  listTabs,
  getTabView,
  setLayout,
  captureTab,
  setPanelVisible,
  isHostWebContents,
  openBrowserWindow,
  isBrowserWindowOpen,
  reopenClosedTab,
  peekClosedTabUrl,
  requestOmniboxFocus,
  zoomTab,
  openAgentSession,
  openInternalPage,
  navigateTab,
  proceedPastCertError,
  tabDisplayUrl,
  isInternalTab,
  openDevtoolsDock,
  closeDevtoolsDock,
  setDevtoolsLayout,
  agentDevtoolsSnapshot,
  clearAgentDevtoolsCalls,
  historyNoteUser
} from '../services/browser'
import {
  INTERNAL_PAGES,
  internalPageOf,
  type InternalPage
} from '../../shared/browserInternalPages'
import type { AgentDevtoolsSnapshot, DevtoolsDockPanel } from '../../shared/browserAgentDevtools'
import type { HistoryTransition } from '../../shared/browserHistory'
import { remoteOpenableUrl, remoteUrlRefusedError } from '../../shared/browserRemoteUrls'
import { isHeadless } from '../utils/headless'

/** 地址栏报来的这次导航是怎么来的（记进历史用）；认不出的当没给 */
function transitionOf(value: unknown): HistoryTransition | undefined {
  return value === 'typed' || value === 'generated' ? value : undefined
}

/** 只认浏览器窗口外壳发来的（别的窗口、网络客户端碰不到停靠区，也读不到 agent 在页面上拿到的东西） */
function fromHostWindow(ctx: ClientContext): boolean {
  return ctx.client.kind === 'window' && isHostWebContents(ctx.client.webContentsId)
}

/**
 * 网络客户端要让浏览器去的地址不是网页 / 空白页 / 内部页面 → 抛（见 shared/browserRemoteUrls.ts：`file:` 页加上
 * 截图就是绕过 files scope 的本地文件读取）。桌面窗口不限
 */
function assertRemoteOpenable(ctx: ClientContext, url: unknown): void {
  if (ctx.client.kind === 'network' && !remoteOpenableUrl(url)) throw remoteUrlRefusedError(url)
}

/**
 * 网络客户端的后退 / 前进：先核对紧挨着的那一条（active ± 1）的地址，再**正好去那一条**（goToIndex）。不用
 * goBack / goForward —— Chromium 会跳过没有用户手势留下的条目（history manipulation intervention），核对过的那条
 * 可能被跳过、落到更早的本地文件页上
 */
function remoteHistoryStep(
  ctx: ClientContext,
  tabId: string,
  history: Electron.NavigationHistory,
  offset: -1 | 1
): void {
  const index = history.getActiveIndex() + offset
  assertRemoteOpenable(ctx, history.getEntryAtIndex(index)?.url)
  historyNoteUser(tabId)
  history.goToIndex(index)
}

export function registerBrowserViewHandlers(): void {
  // ====== 浏览器窗口 ======

  /** 用户从主窗口（顶栏按钮 / widget「在浏览器中打开」）打开或聚焦浏览器窗口 */
  defineHandler('browser-view:open-window', () => {
    openBrowserWindow()
  })

  /**
   * 主设置窗口里 MCP → 内置 browser 那一行的「打开浏览器设置」：把浏览器窗口开出来（用户的动作）并打开
   * 设置页（已经开着就选中它）
   */
  defineHandler('browser-view:open-settings', () => {
    openBrowserWindow()
    openInternalPage('settings')
  })

  /** 浏览器窗口里打开一个内部页面（⋮ → 设置、站点信息的「网站设置」）；不开窗口 */
  defineHandler('browser-view:open-internal', (ctx, page: InternalPage) => {
    // 只认桌面窗口：网络客户端不该改这台电脑上浏览器窗口选中的页
    if (ctx.client.kind !== 'window') return
    if ((INTERNAL_PAGES as readonly string[]).includes(page)) openInternalPage(page)
  })

  /**
   * 证书警告页上的「继续前往（不安全）」：只认浏览器窗口外壳发来的（别的窗口、网络客户端、agent 都碰不到它），
   * 放行的是主进程自己记下的那次错误的站点
   */
  defineHandler('browser-view:proceed-unsafe', (ctx, tabId: string) => {
    if (ctx.client.kind !== 'window' || !isHostWebContents(ctx.client.webContentsId)) return false
    return typeof tabId === 'string' ? proceedPastCertError(tabId) : false
  })

  /** 浏览器窗口此刻是否建出来且可见（关窗只是隐藏 → false）；只读 */
  defineHandler('browser-view:is-window-open', () => isBrowserWindowOpen())

  /**
   * 浏览器宿主的样子（web 客户端的浏览器管理页用）：无头运行时这台电脑上没有浏览器窗口，地址栏的搜索引擎 / 搜索建议
   * 这类设置也就不起作用
   */
  defineHandler('browser-view:host-info', () => ({ headless: isHeadless() }))

  // ====== tab 生命周期 ======

  /**
   * 用户新开 tab（开在前台）；空白页顺手把光标放进地址栏（照 Chrome）。`transition`：从地址栏开的
   * （没有选中的页时敲的网址 / 搜索），记进历史用
   */
  defineHandler('browser-view:create-tab', (ctx, url?: string, transition?: unknown) => {
    // 网络客户端：不带地址（空白页）照常，带了就只认网页 / 空白页 / 内部页面；开在后台 —— 浏览器窗口里选中的那页
    // 是坐在这台电脑前的人的，别的设备开的页不抢它，也不动地址栏的光标
    const remote = ctx.client.kind === 'network'
    if (url !== undefined && url !== null && url !== '') assertRemoteOpenable(ctx, url)
    // 内部页面（地址栏 / 新标签页里敲的 shuvix://settings、复制设置页）：打开那一页（已开着就选中它）
    const page = typeof url === 'string' ? internalPageOf(url) : null
    if (page) return remote ? openInternalPage(page, { activate: false }) : openInternalPage(page)
    const how = transitionOf(transition)
    const id = createTab(url, { activate: !remote, ...(how ? { transition: how } : {}) })
    if (!url && !remote) requestOmniboxFocus()
    return id
  })

  /** 用户关的（标签上的 ×、菜单）：记下地址，⌘⇧T / reopenClosedTab 能重开 */
  defineHandler('browser-view:close-tab', (_ctx, tabId: string) => {
    closeTab(tabId, { remember: true })
  })

  /** 网络客户端：要重开的那页不是网页 / 空白页 / 内部页面（这台电脑上关掉的本地文件）→ 抛，记录留着 */
  defineHandler('browser-view:reopen-closed-tab', (ctx) => {
    const next = peekClosedTabUrl()
    if (next !== undefined) assertRemoteOpenable(ctx, next)
    return reopenClosedTab()
  })

  defineHandler('browser-view:activate-tab', (_ctx, tabId: string) => {
    activateTab(tabId)
  })

  defineHandler('browser-view:list-tabs', () => listTabs())

  // ====== 导航 ======

  /**
   * 用户让这个 tab 去一个地址（地址栏、新标签页、重试、历史记录页）；`shuvix://…` 打开内部页面。
   * `transition`：从地址栏去的（typed = 网址、generated = 搜索），记进历史用
   */
  defineHandler(
    'browser-view:navigate',
    (ctx, tabId: string, url: string, transition?: unknown) => {
      if (typeof tabId === 'string' && typeof url === 'string') {
        assertRemoteOpenable(ctx, url)
        navigateTab(tabId, url, transitionOf(transition))
      }
    }
  )

  // 后退 / 前进 / 刷新是用户的动作：之后的导航记在用户头上（历史）。网络客户端退 / 进到的那一页同样只认网页 /
  // 空白页 / 内部页面（这个 tab 早先可能开过本地文件），见 remoteHistoryStep
  defineHandler('browser-view:go-back', (ctx, tabId: string) => {
    const view = getTabView(tabId)
    const history = view?.webContents.navigationHistory
    if (view && history && history.canGoBack()) {
      if (ctx.client.kind === 'network') return remoteHistoryStep(ctx, tabId, history, -1)
      historyNoteUser(tabId)
      history.goBack()
    }
  })

  defineHandler('browser-view:go-forward', (ctx, tabId: string) => {
    const view = getTabView(tabId)
    const history = view?.webContents.navigationHistory
    if (view && history && history.canGoForward()) {
      if (ctx.client.kind === 'network') return remoteHistoryStep(ctx, tabId, history, 1)
      historyNoteUser(tabId)
      history.goForward()
    }
  })

  defineHandler('browser-view:reload', (_ctx, tabId: string) => {
    const view = getTabView(tabId)
    if (!view) return
    historyNoteUser(tabId)
    view.webContents.reload()
  })

  defineHandler('browser-view:stop', (_ctx, tabId: string) => {
    const view = getTabView(tabId)
    if (view) view.webContents.stop()
  })

  /** 按站点调页面缩放（⋮ 菜单、地址栏右端的缩放标识）；快捷键 ⌘+ / ⌘− / ⌘0 在主进程里直接走同一个函数 */
  defineHandler('browser-view:zoom', (_ctx, tabId: string, direction: 'in' | 'out' | 'reset') => {
    if (direction === 'in' || direction === 'out' || direction === 'reset') {
      zoomTab(tabId, direction)
    }
  })

  /**
   * 提示条「〈会话〉正在使用此页面 · 查看对话」：把主窗口拉到前面并切到那个会话（用户自己点的）。
   * 会话已经删了就什么也不做。
   */
  defineHandler('browser-view:open-session', (ctx, sessionId: string) => {
    if (ctx.client.kind !== 'window' || typeof sessionId !== 'string') return
    openAgentSession(sessionId)
  })

  /**
   * 抓 tab 画面（平铺墙滚动时的占位图）。网络客户端只能抓正显示着网页 / 空白页 / 内部页面的 tab —— 这台电脑上开着的
   * 本地文件页对别的设备一样是文件读取
   */
  defineHandler('browser-view:capture', (ctx, tabId: string, maxWidth?: number) => {
    if (ctx.client.kind === 'network') {
      if (typeof tabId !== 'string') return ''
      const url = tabDisplayUrl(tabId)
      if (url === '') return ''
      assertRemoteOpenable(ctx, url)
    }
    return captureTab(tabId, typeof maxWidth === 'number' && maxWidth > 0 ? maxWidth : undefined)
  })

  defineHandler('browser-view:get-url', (_ctx, tabId: string) => tabDisplayUrl(tabId))

  // ====== 布局（面板级） ======

  /** 更新面板布局（renderer 传 CSS 像素，service 侧 apply 时乘 zoom）；一次提交全部同屏 tab */
  defineListener(
    'browser-view:set-layout',
    (
      ctx,
      entries: Array<{
        tabId: string
        bounds: { x: number; y: number; width: number; height: number }
        zoom?: number
      }>
    ) => {
      // 布局表只认宿主窗口（浏览器窗口）上报的矩形：别的窗口发来的会把整张表换掉，
      // 等于让所有 view 消失。主窗口里留下的旧代码若还在发，这里挡住。
      if (ctx.client.kind !== 'window' || !isHostWebContents(ctx.client.webContentsId)) return
      setLayout(entries)
    }
  )

  /** 卡片墙自身的可见性门（对话框覆盖层等）；同样只认宿主窗口 */
  defineListener('browser-view:set-visible', (ctx, visible: boolean) => {
    if (ctx.client.kind !== 'window' || !isHostWebContents(ctx.client.webContentsId)) return
    setPanelVisible(visible)
  })

  // ====== 停靠区（页面下方：原生 DevTools + agent 的 devtool） ======

  /**
   * 打开这一页的停靠区、停在某个页签（⋮ 菜单、提示条、停靠区自己的页签）。内部页面画在外壳里，那张
   * about:blank 占位没什么可调试的 —— 与快捷键同一个口径，不开
   */
  defineHandler('browser-view:devtools-open', (ctx, tabId: string, panel: DevtoolsDockPanel) => {
    if (!fromHostWindow(ctx) || typeof tabId !== 'string' || isInternalTab(tabId)) return
    if (panel === 'devtools' || panel === 'agent') openDevtoolsDock(tabId, panel)
  })

  /** 关掉这一页的停靠区（原生 DevTools 一起关） */
  defineHandler('browser-view:devtools-close', (ctx, tabId: string) => {
    if (!fromHostWindow(ctx) || typeof tabId !== 'string') return
    closeDevtoolsDock(tabId)
  })

  /** 原生 DevTools 那块矩形（CSS px；停靠区没显示「DevTools」页签时 null） */
  defineListener(
    'browser-view:set-devtools-layout',
    (
      ctx,
      slot: {
        tabId: string
        bounds: { x: number; y: number; width: number; height: number }
      } | null
    ) => {
      if (!fromHostWindow(ctx)) return
      setDevtoolsLayout(slot && typeof slot.tabId === 'string' ? slot : null)
    }
  )

  /** 停靠区「Agent」页签：agent 在这一页上的 devtool 调用记录 + 它的网络 / 控制台采集 */
  defineHandler(
    'browser-view:agent-devtools',
    (ctx, tabId: string): AgentDevtoolsSnapshot | null =>
      fromHostWindow(ctx) && typeof tabId === 'string' ? agentDevtoolsSnapshot(tabId) : null
  )

  /** 清空这一页的调用记录（agent 的采集不动） */
  defineHandler('browser-view:agent-devtools-clear', (ctx, tabId: string) => {
    if (!fromHostWindow(ctx) || typeof tabId !== 'string') return
    clearAgentDevtoolsCalls(tabId)
  })
}
