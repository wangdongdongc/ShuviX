/**
 * Browser WebContentsView IPC handlers
 *
 * 提供 renderer 对嵌入式 WebContentsView 的控制：
 * 导航、前进/后退、刷新、停止、bounds 同步、可见性
 */

import { ipcMain } from 'electron'
import { getBrowserView, getBrowserHostWindow } from '../services/browser'

export function registerBrowserViewHandlers(): void {
  // ====== 导航 ======

  ipcMain.handle('browser-view:navigate', (_event, url: string) => {
    const view = getBrowserView()
    if (view) view.webContents.loadURL(url)
  })

  ipcMain.handle('browser-view:go-back', () => {
    const view = getBrowserView()
    if (view && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack()
    }
  })

  ipcMain.handle('browser-view:go-forward', () => {
    const view = getBrowserView()
    if (view && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward()
    }
  })

  ipcMain.handle('browser-view:reload', () => {
    const view = getBrowserView()
    if (view) view.webContents.reload()
  })

  ipcMain.handle('browser-view:stop', () => {
    const view = getBrowserView()
    if (view) view.webContents.stop()
  })

  ipcMain.handle('browser-view:get-url', () => {
    const view = getBrowserView()
    return view ? view.webContents.getURL() : ''
  })

  // ====== 布局 ======

  /** 更新 WebContentsView 的位置和大小（renderer 传来 CSS 像素，需乘以 zoom） */
  ipcMain.on(
    'browser-view:update-bounds',
    (_event, bounds: { x: number; y: number; width: number; height: number }) => {
      const view = getBrowserView()
      const win = getBrowserHostWindow()
      if (!view || !win || win.isDestroyed()) return

      const zoom = win.webContents.getZoomFactor()
      view.setBounds({
        x: Math.round(bounds.x * zoom),
        y: Math.round(bounds.y * zoom),
        width: Math.round(bounds.width * zoom),
        height: Math.round(bounds.height * zoom)
      })
    }
  )

  /** 控制 WebContentsView 的可见性 */
  ipcMain.on('browser-view:set-visible', (_event, visible: boolean) => {
    const view = getBrowserView()
    if (view) view.setVisible(visible)
  })
}
