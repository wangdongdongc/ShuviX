/**
 * Browser WebContentsView IPC handlers
 *
 * 提供 renderer 对多 tab 嵌入式 WebContentsView 的控制：
 * tab 生命周期（创建/关闭/激活/列表）、导航、bounds 同步、可见性。
 * 导航类通道带 tabId 首参；bounds/visible 是面板级（只作用于激活 tab）。
 */

import { ipcMain } from 'electron'
import {
  createTab,
  closeTab,
  activateTab,
  listTabs,
  getTabView,
  updateBounds,
  setPanelVisible
} from '../services/browser'

export function registerBrowserViewHandlers(): void {
  // ====== tab 生命周期 ======

  ipcMain.handle('browser-view:create-tab', (_event, url?: string) =>
    createTab(url, { activate: true })
  )

  ipcMain.handle('browser-view:close-tab', (_event, tabId: string) => {
    closeTab(tabId)
  })

  ipcMain.handle('browser-view:activate-tab', (_event, tabId: string) => {
    activateTab(tabId)
  })

  ipcMain.handle('browser-view:list-tabs', () => listTabs())

  // ====== 导航 ======

  ipcMain.handle('browser-view:navigate', (_event, tabId: string, url: string) => {
    const view = getTabView(tabId)
    if (view) view.webContents.loadURL(url)
  })

  ipcMain.handle('browser-view:go-back', (_event, tabId: string) => {
    const view = getTabView(tabId)
    if (view && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack()
    }
  })

  ipcMain.handle('browser-view:go-forward', (_event, tabId: string) => {
    const view = getTabView(tabId)
    if (view && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward()
    }
  })

  ipcMain.handle('browser-view:reload', (_event, tabId: string) => {
    const view = getTabView(tabId)
    if (view) view.webContents.reload()
  })

  ipcMain.handle('browser-view:stop', (_event, tabId: string) => {
    const view = getTabView(tabId)
    if (view) view.webContents.stop()
  })

  ipcMain.handle('browser-view:get-url', (_event, tabId: string) => {
    const view = getTabView(tabId)
    return view ? view.webContents.getURL() : ''
  })

  // ====== 布局（面板级） ======

  /** 更新面板内容区 bounds（renderer 传 CSS 像素，service 侧 apply 时乘 zoom） */
  ipcMain.on(
    'browser-view:update-bounds',
    (_event, bounds: { x: number; y: number; width: number; height: number }) => {
      updateBounds(bounds)
    }
  )

  /** 控制面板（激活 tab 的 view）可见性 */
  ipcMain.on('browser-view:set-visible', (_event, visible: boolean) => {
    setPanelVisible(visible)
  })
}
