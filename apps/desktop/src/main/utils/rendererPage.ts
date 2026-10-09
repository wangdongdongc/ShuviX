/**
 * 应用自己的窗口加载渲染端页面：开发环境走 electron-vite 的 dev server（HMR），否则读打包好的
 * 本地文件。各窗口只差一个 hash（`#settings`、`#markdown-window?…`）。
 *
 * **开发环境的加载要看着**：在 macOS 虚拟机上，第一次建窗会卡在 Metal 初始化里
 * （`MTLCopyAllDevices`，约 15 秒），卡完 Chromium 报「Network service crashed, restarting
 * service」。正赶上的那次 http 加载**既不成功也不报错**（请求没到 dev server，`did-fail-load`
 * 也不来），就这么挂着；窗口要等渲染端发 `app:window-ready` 才显示，于是窗口永远不出来。
 * 所以：发出加载后一段时间内主框架导航还没提交（没拿到页面）就重发一次；明确失败了（dev server
 * 还没起来等）也隔一会儿重发。网络服务会自己重启，重发的那次就能走通。正式包读本地文件，
 * 不经网络服务，不受影响 —— 不看着、不重试。
 *
 * 任何模式下，主框架加载失败都记一条日志（以前悄无声息，只剩一扇不出现的窗口）。
 */
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { createLogger } from '../logger'

const log = createLogger('RendererPage')

/** 开发环境：发出加载后这么久主框架导航还没提交，就当它挂住了、重发 */
export const DEV_COMMIT_TIMEOUT_MS = 5000
/** 开发环境：明确失败后隔多久重发 */
export const DEV_RETRY_DELAY_MS = 1000
/** 开发环境：连续重发的上限（挂住与失败合计；拿到一次页面清零） */
export const DEV_RETRY_MAX = 10
/** Chromium 的 ERR_ABORTED：被新的导航顶掉（重发、HMR 整页刷新），不是失败 */
const ERR_ABORTED = -3

/** 给窗口加载渲染端页面（`hash` 选路由）；开发环境下挂住或失败会重发，见文件头 */
export function loadRendererPage(win: BrowserWindow, hash?: string): void {
  const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
  let retries = 0
  let commitTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const clearTimers = (): void => {
    clearTimeout(commitTimer)
    clearTimeout(retryTimer)
  }

  const start = (): void => {
    if (win.isDestroyed()) return
    clearTimers()
    if (!devUrl) {
      void win
        .loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
        .catch(() => {})
      return
    }
    commitTimer = setTimeout(() => {
      log.warn(`page did not start loading within ${DEV_COMMIT_TIMEOUT_MS}ms: ${devUrl}`)
      retryOrGiveUp(0)
    }, DEV_COMMIT_TIMEOUT_MS)
    // 失败时 loadURL 的 Promise 会拒绝；失败由 did-fail-load 记日志、决定重发
    void win.loadURL(hash ? `${devUrl}#${hash}` : devUrl).catch(() => {})
  }

  const retryOrGiveUp = (delayMs: number): void => {
    clearTimers()
    if (win.isDestroyed()) return
    if (retries >= DEV_RETRY_MAX) {
      log.error(`page still not loaded after ${DEV_RETRY_MAX} retries: ${devUrl}`)
      return
    }
    retries++
    retryTimer = setTimeout(start, delayMs)
  }

  // 拿到页面了（主框架导航已提交）：不再等、也不再重发，计数清零。
  // 不能拿 did-finish-load 清零：加载失败时 Chromium 给错误页也发一次 did-finish-load
  // （不发 did-navigate），那样上限永远到不了，dev server 一直没起就每秒重发一次到天荒地老
  win.webContents.on('did-navigate', () => {
    clearTimers()
    retries = 0
  })
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) return
      log.warn(`page load failed (${errorCode} ${errorDescription}): ${validatedURL}`)
      if (devUrl) retryOrGiveUp(DEV_RETRY_DELAY_MS)
    }
  )
  win.on('closed', clearTimers)
  start()
}
