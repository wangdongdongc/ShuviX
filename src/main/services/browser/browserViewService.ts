/**
 * BrowserViewService — 管理主窗口中嵌入的 WebContentsView（浏览器面板）
 *
 * 替代旧的 iframe 方案，提供：
 * - 完整的 webContents API（导航、截图、CDP 调试等）
 * - 跨域页面的无限制访问
 * - 通过 IPC 向 renderer 转发导航 / 加载事件
 */

import { WebContentsView, BrowserWindow, shell } from 'electron'
import { createLogger } from '../../logger'
import { browserCdpService } from './browserCdpService'

const log = createLogger('BrowserView')

let view: WebContentsView | null = null
let hostWindow: BrowserWindow | null = null

/** 创建 WebContentsView 并附加到主窗口 */
export function createBrowserView(win: BrowserWindow): void {
  if (view) destroyBrowserView()
  hostWindow = win

  view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true
      // 无 preload — 纯 Web 内容，与主 renderer 完全隔离
    }
  })

  // 初始隐藏
  view.setVisible(false)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  win.contentView.addChildView(view)

  const wc = view.webContents

  // 外部链接用系统浏览器打开
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // ====== 转发事件到 renderer ======

  wc.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame || !hostWindow || hostWindow.isDestroyed()) return
    hostWindow.webContents.send('browser-view:did-start-loading', url)
  })

  wc.on('did-navigate', (_event, url) => {
    if (!hostWindow || hostWindow.isDestroyed()) return
    hostWindow.webContents.send('browser-view:did-navigate', url)
  })

  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame || !hostWindow || hostWindow.isDestroyed()) return
    hostWindow.webContents.send('browser-view:did-navigate', url)
  })

  wc.on('did-finish-load', () => {
    if (!hostWindow || hostWindow.isDestroyed()) return
    hostWindow.webContents.send('browser-view:did-finish-load')
  })

  wc.on('did-fail-load', () => {
    if (!hostWindow || hostWindow.isDestroyed()) return
    hostWindow.webContents.send('browser-view:did-finish-load')
  })

  log.info('WebContentsView created')
}

/** 销毁 WebContentsView */
export function destroyBrowserView(): void {
  // 先断开 CDP debugger，释放自动化状态
  browserCdpService.detach()
  if (view) {
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.contentView.removeChildView(view)
    }
    // WebContentsView 被移除后，关闭其 webContents 释放资源
    view.webContents.close()
    view = null
    log.info('WebContentsView destroyed')
  }
  hostWindow = null
}

export function getBrowserView(): WebContentsView | null {
  return view
}

export function getBrowserHostWindow(): BrowserWindow | null {
  return hostWindow
}
