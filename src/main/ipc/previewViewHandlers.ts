/**
 * Preview WebContentsView IPC handlers
 *
 * 提供 renderer 对嵌入式 WebContentsView 的控制：
 * 导航、前进/后退、刷新、停止、bounds 同步、可见性
 */

import { ipcMain } from 'electron'
import { getPreviewView, getPreviewHostWindow } from '../services/previewViewService'

export function registerPreviewViewHandlers(): void {
  // ====== 导航 ======

  ipcMain.handle('preview-view:navigate', (_event, url: string) => {
    const view = getPreviewView()
    if (view) view.webContents.loadURL(url)
  })

  ipcMain.handle('preview-view:go-back', () => {
    const view = getPreviewView()
    if (view && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack()
    }
  })

  ipcMain.handle('preview-view:go-forward', () => {
    const view = getPreviewView()
    if (view && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward()
    }
  })

  ipcMain.handle('preview-view:reload', () => {
    const view = getPreviewView()
    if (view) view.webContents.reload()
  })

  ipcMain.handle('preview-view:stop', () => {
    const view = getPreviewView()
    if (view) view.webContents.stop()
  })

  ipcMain.handle('preview-view:get-url', () => {
    const view = getPreviewView()
    return view ? view.webContents.getURL() : ''
  })

  // ====== 布局 ======

  /** 更新 WebContentsView 的位置和大小（renderer 传来 CSS 像素，需乘以 zoom） */
  ipcMain.on(
    'preview-view:update-bounds',
    (_event, bounds: { x: number; y: number; width: number; height: number }) => {
      const view = getPreviewView()
      const win = getPreviewHostWindow()
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
  ipcMain.on('preview-view:set-visible', (_event, visible: boolean) => {
    const view = getPreviewView()
    if (view) view.setVisible(visible)
  })
}
