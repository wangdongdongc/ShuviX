/**
 * BrowserWindowService —— 内置浏览器的独立窗口（单例）：用户看 agent 浏览器的地方
 *
 * 窗口的 renderer 是 `#browser-window` 那套网格卡片墙，只负责上报布局表；上墙的 tab 挂在这个
 * 窗口上，其余停在停放窗口（stagingWindow.ts）。
 *
 * 语义：
 * - **只有用户能把它弄出来**（侧栏按钮 / widget「在浏览器中打开」）。agent 开 tab 不建、不显示、
 *   不置前 —— tab 在停放窗口里照常可被操作，用户在主窗口里打字和操作不受任何影响
 *   （showInactive 在 macOS 上会把窗口叠到最前、盖住主窗口，2026-09-23 实测）。
 * - **关窗 = 隐藏，不销毁**：tab、页面状态、登录态、CDP 会话都留着，重开即时。
 * - 主窗口关闭时销毁（隐藏的窗口仍算开着，会挡住 window-all-closed）；app 退出时销毁。
 */

import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { settingsDao } from '../../dao/settingsDao'
import { createLogger } from '../../logger'
import { t } from '../../i18n'
import { guardAppWindow } from '../externalOpen'
import { destroyAllTabs, setHostWindow } from './browserViewService'

const log = createLogger('BrowserWindow')

const STATE_KEY = 'window.browserWindow'
const DEFAULT_BOUNDS = { width: 1180, height: 820 }
const MIN_WIDTH = 480
const MIN_HEIGHT = 360

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
}

let win: BrowserWindow | null = null
let getThemeBgColor: () => string = () => '#0d1117'
let quitting = false
let initialized = false

function readState(): WindowState {
  try {
    const raw = settingsDao.findByKey(STATE_KEY)
    if (!raw) return { ...DEFAULT_BOUNDS }
    const saved = JSON.parse(raw) as Partial<WindowState>
    const w = Number(saved.width)
    const h = Number(saved.height)
    if (!w || !h || w < MIN_WIDTH || h < MIN_HEIGHT) return { ...DEFAULT_BOUNDS }
    return {
      width: w,
      height: h,
      ...(saved.x != null && saved.y != null
        ? { x: Math.round(saved.x), y: Math.round(saved.y) }
        : {})
    }
  } catch {
    return { ...DEFAULT_BOUNDS }
  }
}

function saveState(): void {
  if (!win || win.isDestroyed()) return
  try {
    const b = win.getBounds()
    settingsDao.upsert(
      STATE_KEY,
      JSON.stringify({
        x: b.x,
        y: b.y,
        width: Math.max(MIN_WIDTH, b.width),
        height: Math.max(MIN_HEIGHT, b.height)
      })
    )
  } catch (err) {
    log.warn(`保存浏览器窗口状态失败: ${err}`)
  }
}

/**
 * 登记主题色取法与退出标记。主窗口每次（重）建都会调到这里（macOS 关窗后从 Dock 重开），
 * 所以幂等：只有主题色取法会更新。
 */
export function initBrowserWindowService(opts: { getThemeBgColor: () => string }): void {
  getThemeBgColor = opts.getThemeBgColor
  if (initialized) return
  initialized = true
  app.on('before-quit', () => {
    quitting = true
  })
}

function create(): BrowserWindow {
  const state = readState()
  const isMac = process.platform === 'darwin'

  const created = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x != null && state.y != null ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    // 任务栏 / Alt+Tab 里与主窗口区分；页面 <title> 是产品名，下方拦截保住这个标题
    title: `ShuviX — ${t('panel.browser')}`,
    ...(!isMac ? { autoHideMenuBar: true } : {}),
    // macOS：交通灯嵌进卡片墙自己的工具条（工具条高 36px，灯高 14px → y 居中 11）
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 11 } } : {}),
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 外壳自己不该被带去外站（卡片里的页面是 WebContentsView，各有各的闸）
  guardAppWindow(created)

  const hash = 'browser-window'
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void created.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    void created.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }

  created.on('page-title-updated', (e) => e.preventDefault())

  // 关窗 = 隐藏：tab 与页面状态留着，重开即时。退出时才真关。
  created.on('close', (event) => {
    saveState()
    if (quitting) return
    event.preventDefault()
    created.hide()
  })

  created.on('closed', () => {
    if (win === created) {
      win = null
      // view 暂时没有父窗口；tab 不销毁，下次开窗会被接回去
      setHostWindow(null)
    }
  })

  win = created
  setHostWindow(created)
  log.info('浏览器窗口已创建')
  return created
}

/** 打开（或聚焦）浏览器窗口 —— 只由用户的动作触发（侧栏按钮 / widget 在浏览器中打开） */
export function openBrowserWindow(): void {
  const target = win && !win.isDestroyed() ? win : create()
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
}

/**
 * 主窗口关闭时联动：**销毁**浏览器窗口（不是隐藏），tab 留着。
 *
 * 不能只隐藏：隐藏的窗口仍算「开着」，Windows/Linux 上 `window-all-closed` 永远不来、
 * app 退不掉；macOS 上 Dock 的 `activate` 按「一个窗口都没有」判断要不要重建主窗口，也会失灵。
 * view 在窗口销毁后暂时没有父窗口（closed → setHostWindow(null)），下次开窗时被接回去。
 * 用 destroy 而不是 close —— close 会走本服务「关窗 = 隐藏」的拦截。
 */
export function closeBrowserWindowWithMain(): void {
  if (win && !win.isDestroyed()) {
    saveState() // destroy 不发 close 事件，位置尺寸在这里存
    // 先把墙上的 tab 停回停放窗口，再销毁窗口（'closed' 事件何时到不必依赖）
    setHostWindow(null)
    win.destroy()
  }
  win = null
  // 停放窗口从不显示，但同样算「开着」：非 macOS 上它会挡住 window-all-closed → app.quit。
  // 那边关主窗口就是要退出，tab 连同停放窗口一起收掉（只销毁停放窗口会让 tab 挂在已死的窗口上）。
  // macOS 关主窗口不退出 app，全都留着，主窗口关着时后台的 agent 仍能用浏览器。
  if (process.platform !== 'darwin') destroyAllTabs()
}

/** app 退出：真正销毁窗口（tab 由 destroyAllTabs 负责） */
export function destroyBrowserWindow(): void {
  quitting = true
  if (win && !win.isDestroyed()) {
    // before-quit 里先于窗口自己的 close 事件销毁它，位置尺寸只能在这里存
    saveState()
    win.destroy()
  }
  win = null
}

export function isBrowserWindowOpen(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible()
}
