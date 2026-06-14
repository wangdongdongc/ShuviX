/**
 * BrowserViewService — 管理主窗口中嵌入的 WebContentsView（浏览器面板）
 *
 * 替代旧的 iframe 方案，提供：
 * - 完整的 webContents API（导航、截图、CDP 调试等）
 * - 跨域页面的无限制访问
 * - 通过 IPC 向 renderer 转发导航 / 加载事件
 */

import { WebContentsView, BrowserWindow, dialog, session, shell } from 'electron'
import { createLogger } from '../../logger'
import { settingsDao } from '../../dao/settingsDao'
import { t } from '../../i18n'
import { browserCdpService } from './browserCdpService'

const log = createLogger('BrowserView')

/**
 * 内置浏览器的独立持久化 partition。
 * 与主应用 defaultSession 隔离 cookie / localStorage / IndexedDB / cache / Service Worker，
 * 同时保留登录态持久化（`persist:` 前缀）。
 */
export const BROWSER_PARTITION = 'persist:shuvix-browser'

let view: WebContentsView | null = null
let hostWindow: BrowserWindow | null = null
let sessionInitialized = false
/** 运行期信任的自签名 host 集合，进程结束即失效 */
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
 * 必须在 `app.whenReady` 之后、`createBrowserView` 之前调用一次。
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

/** 创建 WebContentsView 并附加到主窗口 */
export function createBrowserView(win: BrowserWindow): void {
  if (view) destroyBrowserView()
  hostWindow = win

  view = new WebContentsView({
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
  win.contentView.addChildView(view)

  const wc = view.webContents

  // 外部链接用系统浏览器打开
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // ====== 自签名 / 不受信任证书放行（按 host 信任，会话内有效） ======
  // 行为对齐 Chrome：用户点"继续访问"即对该 host 自动放行至会话结束；
  // 同一 host 的并发 cert-error（页面子资源）合并为一次弹窗。
  wc.on('certificate-error', async (event, url, _error, _cert, callback) => {
    event.preventDefault()
    let host: string
    try {
      host = new URL(url).host
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
            detail: url
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

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !hostWindow || hostWindow.isDestroyed()) return
    // -3 (ABORTED) 是用户主动取消导航（例如 cert 弹窗选取消导致的二次 abort），仅作完成处理
    if (errorCode === -3) {
      hostWindow.webContents.send('browser-view:did-finish-load')
      return
    }
    hostWindow.webContents.send('browser-view:did-fail-load', {
      errorCode,
      errorDescription,
      url: validatedURL
    })
  })

  log.info('WebContentsView created')
}

/** 销毁 WebContentsView */
export function destroyBrowserView(): void {
  // 先断开 CDP debugger，释放自动化状态
  browserCdpService.detach()
  trustedHosts.clear()
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
