import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { settingsDao } from '../dao/settingsDao'
import { widgetService } from './widget'
import { appEventBus } from '../utils/appEventBus'
import { createLogger } from '../logger'

const log = createLogger('WidgetWindow')

/**
 * Widget 独立窗口服务 —— 把单个 widget 以"小应用窗口"的形态打开
 *
 * 结构参照 pinnedChatService（注册表 + focus-if-open + 无边框自绘标题栏），但更简单：
 * - 不绑定 ChatFrontend（widget 窗口没有聊天事件流）
 * - bounds / 置顶状态按 widget 各存各的（widget ≈ 独立小应用，不共享全局一份）
 * - 窗口只承载 renderer 的 WidgetWindowShell；server 懒启动、URL 获取都由 shell
 *   通过 widget:open IPC 完成，主进程这边不等待构建，窗口即开即显
 */

function stateKey(widgetId: string): string {
  return `window.widgetWindow.${widgetId}`
}

const DEFAULT_BOUNDS = { width: 480, height: 620 }
const MIN_WIDTH = 320
const MIN_HEIGHT = 240

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  /** 默认 false —— widget 窗口是"普通小应用"，与悬浮聊天的默认置顶语义不同 */
  alwaysOnTop: boolean
}

const windows = new Map<string, BrowserWindow>()
let getThemeBgColor: () => string = () => '#0d1117'
let initialized = false

function readState(widgetId: string): WindowState {
  const fallback: WindowState = { ...DEFAULT_BOUNDS, alwaysOnTop: false }
  try {
    const raw = settingsDao.findByKey(stateKey(widgetId))
    if (!raw) return fallback
    const saved = JSON.parse(raw) as Partial<WindowState>
    const w = Number(saved.width)
    const h = Number(saved.height)
    if (!w || !h || w < MIN_WIDTH || h < MIN_HEIGHT) return fallback
    return {
      width: w,
      height: h,
      ...(saved.x != null && saved.y != null
        ? { x: Math.round(saved.x), y: Math.round(saved.y) }
        : {}),
      alwaysOnTop: saved.alwaysOnTop ?? false
    }
  } catch {
    return fallback
  }
}

function saveState(widgetId: string, win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    const b = win.getBounds()
    const state: WindowState = {
      x: b.x,
      y: b.y,
      width: Math.max(MIN_WIDTH, b.width),
      height: Math.max(MIN_HEIGHT, b.height),
      alwaysOnTop: win.isAlwaysOnTop()
    }
    settingsDao.upsert(stateKey(widgetId), JSON.stringify(state))
  } catch (err) {
    log.warn(`保存 widget 窗口状态失败: ${err}`)
  }
}

export function initWidgetWindowService(opts: { getThemeBgColor: () => string }): void {
  getThemeBgColor = opts.getThemeBgColor
  if (initialized) return
  initialized = true
  // widget 被删除 / 归档时联动关闭对应窗口。widget.changed 无载荷 → 逐个核对存在性
  appEventBus.subscribe((event) => {
    if (event.type !== 'widget.changed') return
    for (const [id, win] of windows) {
      if (win.isDestroyed()) continue
      const widget = widgetService.getById(id)
      if (!widget || widget.archivedAt > 0) win.close()
    }
  })
}

/**
 * 在独立窗口打开 widget。
 * - 已开：focus 现有窗口（幂等）
 * - 未开：立即创建窗口；构建 / URL 获取由窗口内 shell 调 widget:open 完成
 */
export function open(widgetId: string): void {
  const widget = widgetService.getById(widgetId)
  if (!widget) throw new Error(`Widget "${widgetId}" not found`)
  if (widget.archivedAt > 0) throw new Error(`Widget "${widgetId}" is archived`)

  const existing = windows.get(widgetId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }

  const state = readState(widgetId)
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x != null && state.y != null ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    resizable: true,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: state.alwaysOnTop,
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // widget 内容（跨源 iframe）里的 window.open / target=_blank → 系统浏览器
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // 拦截顶层导航（防 widget 把 shell 整个带走），dev 下放行 HMR
  win.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'] || ''
    if (rendererUrl && url.startsWith(rendererUrl)) return
    event.preventDefault()
    shell.openExternal(url)
  })

  const hash = `widget-window?widgetId=${encodeURIComponent(widgetId)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('close', () => saveState(widgetId, win))
  win.on('closed', () => {
    // 用户点关闭与 close(id) 主动关闭都汇到这里 —— 注册表清理只在此处做
    if (windows.get(widgetId) === win) windows.delete(widgetId)
    // 关窗即退出 app：同步从 server 反注册，让卡片"运行中"状态与窗口存在性对齐
    // （已反注册 / widget 已删除时是幂等 no-op）
    widgetService.stopWidget(widgetId)
  })

  windows.set(widgetId, win)
  log.info(`打开 widget 窗口 ${widgetId}（当前 ${windows.size} 个）`)
}

/** 关闭指定 widget 的独立窗口（bounds 在 close 事件里保存） */
export function close(widgetId: string): void {
  const win = windows.get(widgetId)
  if (!win || win.isDestroyed()) return
  win.close()
}

/** 关闭全部 widget 窗口（主窗口关闭时联动，与悬浮聊天一致） */
export function closeAll(): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.close()
  }
}

/** 切换指定窗口"始终置顶"，并持久化到 per-widget 状态 */
export function setAlwaysOnTop(widgetId: string, value: boolean): boolean {
  const win = windows.get(widgetId)
  if (!win || win.isDestroyed()) return false
  win.setAlwaysOnTop(value)
  try {
    const stored = readState(widgetId)
    settingsDao.upsert(stateKey(widgetId), JSON.stringify({ ...stored, alwaysOnTop: value }))
  } catch (err) {
    log.warn(`保存 widget 窗口置顶状态失败: ${err}`)
  }
  return value
}

/** 查询指定窗口"始终置顶"状态（窗口不在时回落到持久化值） */
export function getAlwaysOnTop(widgetId: string): boolean {
  const win = windows.get(widgetId)
  if (!win || win.isDestroyed()) return readState(widgetId).alwaysOnTop
  return win.isAlwaysOnTop()
}
