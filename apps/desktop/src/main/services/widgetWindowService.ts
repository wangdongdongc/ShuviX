import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { settingsDao } from '../dao/settingsDao'
import { guardAppWindow } from './externalOpen'
import { widgetService } from './widget'
import { appEventBus } from '../utils/appEventBus'
import { createLogger } from '../logger'
import { loadRendererPage } from '../utils/rendererPage'
import { headlessWindowError, isHeadless } from '../utils/headless'

const log = createLogger('WidgetWindow')

/**
 * Widget 独立窗口服务 —— 把单个 widget 以"小应用窗口"的形态打开
 *
 * 结构参照 pinnedChatService（注册表 + focus-if-open + 无边框自绘标题栏），但更简单：
 * - 不绑定 ChatFrontend（widget 窗口没有聊天事件流）
 * - bounds / 置顶状态按 widget 各存各的（widget ≈ 独立小应用，不共享全局一份）；bounds 在移动 / 缩放时
 *   （防抖）和关窗时都记，存下的位置已不在任何显示器上时（外接屏拔了）不用它、回到居中
 * - 「上次是不是在独立窗口里打开的」（`preferWindow`）也记在这里：Widget 面板点卡片时据此直接开窗口。
 *   只由用户在面板里的选择改写（↗ / 菜单「在独立窗口打开」→ true，菜单「在面板中打开」→ false）；
 *   agent 经 CLI 开窗不算用户的选择，不碰它
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
  /** 用户上次选的是独立窗口（Widget 面板点卡片时直接开窗口）；缺省 false = 在面板里打开 */
  preferWindow: boolean
}

/** 移动 / 缩放后多久记一次 bounds */
const SAVE_BOUNDS_DEBOUNCE_MS = 500

const windows = new Map<string, BrowserWindow>()
let getThemeBgColor: () => string = () => '#0d1117'
let initialized = false

function readSaved(widgetId: string): Partial<WindowState> {
  try {
    const raw = settingsDao.findByKey(stateKey(widgetId))
    return raw ? (JSON.parse(raw) as Partial<WindowState>) : {}
  } catch {
    return {}
  }
}

function writeSaved(widgetId: string, patch: Partial<WindowState>): void {
  try {
    settingsDao.upsert(stateKey(widgetId), JSON.stringify({ ...readSaved(widgetId), ...patch }))
  } catch (err) {
    log.warn(`保存 widget 窗口状态失败: ${err}`)
  }
}

/** 这块矩形还在某个显示器的工作区里（至少露出 80×40 —— 够把标题栏拖回来） */
function onSomeDisplay(x: number, y: number, width: number): boolean {
  try {
    return screen.getAllDisplays().some(({ workArea: a }) => {
      const overlapX = Math.min(x + width, a.x + a.width) - Math.max(x, a.x)
      const overlapY = Math.min(y + 40, a.y + a.height) - Math.max(y, a.y)
      return overlapX >= 80 && overlapY >= 40
    })
  } catch {
    return false
  }
}

function readState(widgetId: string): WindowState {
  const saved = readSaved(widgetId)
  const alwaysOnTop = saved.alwaysOnTop ?? false
  const preferWindow = saved.preferWindow === true
  const w = Number(saved.width)
  const h = Number(saved.height)
  if (!w || !h || w < MIN_WIDTH || h < MIN_HEIGHT) {
    return { ...DEFAULT_BOUNDS, alwaysOnTop, preferWindow }
  }
  const x = saved.x != null ? Math.round(saved.x) : undefined
  const y = saved.y != null ? Math.round(saved.y) : undefined
  return {
    width: w,
    height: h,
    ...(x !== undefined && y !== undefined && onSomeDisplay(x, y, w) ? { x, y } : {}),
    alwaysOnTop,
    preferWindow
  }
}

function saveState(widgetId: string, win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // 最小化 / 全屏时的 bounds 不是用户摆的那个窗口，不记
  if (win.isMinimized() || win.isFullScreen()) return
  const b = win.getBounds()
  writeSaved(widgetId, {
    x: b.x,
    y: b.y,
    width: Math.max(MIN_WIDTH, b.width),
    height: Math.max(MIN_HEIGHT, b.height),
    alwaysOnTop: win.isAlwaysOnTop()
  })
}

/** 用户在 Widget 面板里选了打开方式（见文件头 `preferWindow`） */
export function setPreferWindow(widgetId: string, value: boolean): void {
  if (readSaved(widgetId).preferWindow === value) return
  writeSaved(widgetId, { preferWindow: value })
}

/** 给出的这些 widget 里，哪些上次是在独立窗口里打开的 */
export function preferWindowIds(widgetIds: readonly string[]): string[] {
  return widgetIds.filter((id) => readSaved(id).preferWindow === true)
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
  // 无头运行：不在这台电脑上开窗（CLI 的 `shuvix widget open` 因此回一个失败，agent 照常看得到原因）
  if (isHeadless()) throw headlessWindowError(`widget window for "${widgetId}"`)
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

  // widget 内容（跨源 iframe 里模型写的 HTML）的 window.open / target=_blank，以及顶层导航
  // （防 widget 把 shell 整个带走）：都交给 externalOpen 那道闸，http(s) 才去系统浏览器。
  // 询问框里点名是哪个 widget 要开 —— 用户看到的是窗口里那张卡片，不是某个地址。
  guardAppWindow(win, { labelKey: 'externalOpen.fromWidget', value: widget.name })

  const hash = `widget-window?widgetId=${encodeURIComponent(widgetId)}`
  loadRendererPage(win, hash)

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // 移动 / 缩放后记一次（防抖）：不只靠关窗那一下 —— 进程被杀、崩溃时位置照样留得住
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveState(widgetId, win)
    }, SAVE_BOUNDS_DEBOUNCE_MS)
  }
  win.on('moved', scheduleSave)
  win.on('resized', scheduleSave)
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveState(widgetId, win)
  })
  win.on('closed', () => {
    // 用户点关闭与 close(id) 主动关闭都汇到这里 —— 注册表清理只在此处做
    if (windows.get(widgetId) === win) windows.delete(widgetId)
    // 关窗即退出 app：同步从 server 反注册，让卡片"运行中"状态与窗口存在性对齐
    // （已反注册 / widget 已删除时是幂等 no-op）
    widgetService.stopWidget(widgetId)
  })

  windows.set(widgetId, win)
  log.info(`打开 widget 窗口 ${widgetId}（当前 ${windows.size} 个）`)
  // Widget 面板据此把这个 widget 从面板里收走（同一个 widget 同一时间只开在一处；关窗的广播由 stopWidget 发）
  appEventBus.publish({ type: 'widget.changed' })
}

/** 此刻开着独立窗口的 widget —— Widget 面板据此决定点卡片是在面板里打开，还是把那个窗口提到前面 */
export function openIds(): string[] {
  return [...windows.entries()].filter(([, win]) => !win.isDestroyed()).map(([id]) => id)
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
  writeSaved(widgetId, { alwaysOnTop: value })
  return value
}

/** 查询指定窗口"始终置顶"状态（窗口不在时回落到持久化值） */
export function getAlwaysOnTop(widgetId: string): boolean {
  const win = windows.get(widgetId)
  if (!win || win.isDestroyed()) return readState(widgetId).alwaysOnTop
  return win.isAlwaysOnTop()
}
