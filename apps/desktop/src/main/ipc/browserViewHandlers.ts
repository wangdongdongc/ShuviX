/**
 * Browser WebContentsView IPC handlers
 *
 * 提供 renderer 对多 tab 嵌入式 WebContentsView 的控制：
 * tab 生命周期（创建/关闭/激活/列表）、导航、bounds 同步、可见性。
 * 导航类通道带 tabId 首参；bounds/visible 是面板级（只作用于激活 tab）。
 */

import { defineHandler, defineListener } from './registry'
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
  isBrowserWindowOpen
} from '../services/browser'

export function registerBrowserViewHandlers(): void {
  // ====== 浏览器窗口 ======

  /** 用户从主窗口（顶栏按钮 / widget「在浏览器中打开」）打开或聚焦浏览器窗口 */
  defineHandler('browser-view:open-window', () => {
    openBrowserWindow()
  })

  /** 浏览器窗口此刻是否建出来且可见（关窗只是隐藏 → false）；只读 */
  defineHandler('browser-view:is-window-open', () => isBrowserWindowOpen())

  // ====== tab 生命周期 ======

  defineHandler('browser-view:create-tab', (_ctx, url?: string) =>
    createTab(url, { activate: true })
  )

  defineHandler('browser-view:close-tab', (_ctx, tabId: string) => {
    closeTab(tabId)
  })

  defineHandler('browser-view:activate-tab', (_ctx, tabId: string) => {
    activateTab(tabId)
  })

  defineHandler('browser-view:list-tabs', () => listTabs())

  // ====== 导航 ======

  defineHandler('browser-view:navigate', (_ctx, tabId: string, url: string) => {
    const view = getTabView(tabId)
    if (view) view.webContents.loadURL(url)
  })

  defineHandler('browser-view:go-back', (_ctx, tabId: string) => {
    const view = getTabView(tabId)
    if (view && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack()
    }
  })

  defineHandler('browser-view:go-forward', (_ctx, tabId: string) => {
    const view = getTabView(tabId)
    if (view && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward()
    }
  })

  defineHandler('browser-view:reload', (_ctx, tabId: string) => {
    const view = getTabView(tabId)
    if (view) view.webContents.reload()
  })

  defineHandler('browser-view:stop', (_ctx, tabId: string) => {
    const view = getTabView(tabId)
    if (view) view.webContents.stop()
  })

  /** 抓 tab 画面（平铺墙滚动时的占位图） */
  defineHandler('browser-view:capture', (_ctx, tabId: string) => captureTab(tabId))

  defineHandler('browser-view:get-url', (_ctx, tabId: string) => {
    const view = getTabView(tabId)
    return view ? view.webContents.getURL() : ''
  })

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
}
