import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { chatFrontendRegistry, type ChatFrontend } from '../frontend/core'
import { settingsDao } from '../dao/settingsDao'
import { createLogger } from '../logger'

const log = createLogger('PinnedChat')

const BOUNDS_KEY = 'window.pinnedBounds'
const DEFAULT_BOUNDS = { width: 400, height: 600 }
const CASCADE_STEP = 28
const isMac = process.platform === 'darwin'

interface SavedBounds {
  width: number
  height: number
  x?: number
  y?: number
}

interface PinnedChatState {
  pinnedSessionIds: string[]
}

interface PinnedEntry {
  window: BrowserWindow
  frontend: ChatFrontend
}

export type UnpinReason = 'user' | 'window-closed' | 'session-deleted' | 'app-quit'

let mainWindow: BrowserWindow | null = null
const pinned = new Map<string, PinnedEntry>()
/** 正在拆除中的 sessionId — 防止 close → closed 链路的重入 unpin */
const closing = new Set<string>()
let getThemeBgColor: () => string = () => '#0d1117'
let createPinnedFrontend: ((window: BrowserWindow) => ChatFrontend) | null = null

function readSavedBounds(): SavedBounds {
  try {
    const raw = settingsDao.findByKey(BOUNDS_KEY)
    if (!raw) return DEFAULT_BOUNDS
    const saved = JSON.parse(raw) as Partial<SavedBounds>
    const w = Number(saved.width)
    const h = Number(saved.height)
    if (!w || !h || w < 320 || h < 400) return DEFAULT_BOUNDS
    if (saved.x != null && saved.y != null) {
      return { width: w, height: h, x: Math.round(saved.x), y: Math.round(saved.y) }
    }
    return { width: w, height: h }
  } catch {
    return DEFAULT_BOUNDS
  }
}

function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  try {
    const b = win.getBounds()
    settingsDao.upsert(
      BOUNDS_KEY,
      JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height })
    )
  } catch (err) {
    log.warn(`保存悬浮窗 bounds 失败: ${err}`)
  }
}

/**
 * 防止 macOS 因悬浮窗的 frameless + alwaysOnTop + setVisibleOnAllWorkspaces 组合
 * 把 NSApplicationActivationPolicy 自动切到 Accessory，导致 Dock 图标消失。
 * 这里显式把策略设回 'regular' 并 show() dock，是幂等 + 防御性的调用。
 */
function ensureMacAppVisible(): void {
  if (!isMac) return
  try {
    // 只有当 Dock 图标真的被切走时才修复。
    // 在 regular 模式下再次调用 setActivationPolicy('regular') 会让 macOS 重新应用策略，
    // 过程中瞬间隐藏-再显示 app 所有窗口（主窗口会"闪一下"）。
    if (!app.dock || app.dock.isVisible()) return
    app.setActivationPolicy?.('regular')
    void app.dock.show()
  } catch (err) {
    log.warn(`恢复 Dock 可见状态失败: ${err}`)
  }
}

function broadcastState(): void {
  const state: PinnedChatState = { pinnedSessionIds: Array.from(pinned.keys()) }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:pin-state-changed', state)
  }
  for (const { window } of pinned.values()) {
    if (!window.isDestroyed()) {
      window.webContents.send('window:pin-state-changed', state)
    }
  }
}

function createFloatingWindow(sessionId: string): BrowserWindow {
  const bounds = readSavedBounds()
  // 多窗 cascade：每多一个已存在的悬浮窗，新窗口位置错开 CASCADE_STEP 像素
  const offset = pinned.size * CASCADE_STEP
  const x = bounds.x != null ? bounds.x + offset : undefined
  const y = bounds.y != null ? bounds.y + offset : undefined

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(x != null && y != null ? { x, y } : {}),
    minWidth: 320,
    minHeight: 400,
    frame: false,
    resizable: true,
    show: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (isMac) {
    win.setAlwaysOnTop(true, 'floating')
    // 注意：不传 visibleOnFullScreen —— 它会给窗口加上 FullScreenAuxiliary collectionBehavior，
    // 而 "auxiliary" 是 macOS 判定"该 app 是附件类工具"的关键信号，会触发 NSApp 切到 Accessory
    // 激活策略，从而隐藏 Dock 图标。代价：当用户在别的 app 全屏时，悬浮窗不会浮在那个全屏 Space 之上；
    // 跨普通 Space 切换仍然成立。
    win.setVisibleOnAllWorkspaces(true)
    // 极少数情况下 macOS 仍可能切策略 —— 这里做防御性兜底，gated 检查避免不必要的重应用闪烁
    ensureMacAppVisible()
  } else {
    win.setAlwaysOnTop(true)
  }

  const hash = `pinned-chat?sessionId=${encodeURIComponent(sessionId)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('close', () => {
    saveBounds(win)
  })

  win.on('closed', () => {
    // 仅当不是我们主动 close（unpin 流程）时，触发一次 unpin 清理
    if (!closing.has(sessionId)) {
      void unpin(sessionId, 'window-closed')
    }
  })

  return win
}

export function initPinnedChatService(opts: {
  mainWindow: BrowserWindow
  getThemeBgColor: () => string
  /** 由 main-entry 注入：为指定 BrowserWindow 构造 ChatFrontend 实例 */
  createFrontend: (window: BrowserWindow) => ChatFrontend
}): void {
  mainWindow = opts.mainWindow
  getThemeBgColor = opts.getThemeBgColor
  createPinnedFrontend = opts.createFrontend
}

/** 当前所有正在悬浮的 sessionId */
export function getPinnedSessionIds(): string[] {
  return Array.from(pinned.keys())
}

/** 指定 sessionId 是否正在悬浮 */
export function isPinned(sessionId: string): boolean {
  return pinned.has(sessionId)
}

/**
 * 把指定会话提到悬浮窗。
 * - 已悬浮：focus 现有窗口（幂等）
 * - 多个会话可同时悬浮，互不影响
 */
export async function pin(sessionId: string): Promise<void> {
  if (!sessionId) return

  const existing = pinned.get(sessionId)
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) existing.window.restore()
    existing.window.show()
    existing.window.focus()
    return
  }

  if (!createPinnedFrontend) {
    log.warn('pinnedChatService 未初始化 createFrontend 工厂，忽略 pin 请求')
    return
  }

  const window = createFloatingWindow(sessionId)
  // 每个悬浮窗用独立的 frontend id，避免 registry 内部按 id 去重相互覆盖
  const frontend = createPinnedFrontend(window)
  pinned.set(sessionId, { window, frontend })
  chatFrontendRegistry.bind(sessionId, frontend)
  broadcastState()
  log.info(`已悬浮会话 ${sessionId}（当前 ${pinned.size} 个悬浮窗）`)
}

/** 取消指定会话的悬浮 */
export async function unpin(sessionId: string, reason: UnpinReason = 'user'): Promise<void> {
  const entry = pinned.get(sessionId)
  if (!entry) return
  if (closing.has(sessionId)) return
  closing.add(sessionId)
  try {
    chatFrontendRegistry.unbind(sessionId, entry.frontend.id)
    pinned.delete(sessionId)
    if (!entry.window.isDestroyed()) {
      saveBounds(entry.window)
      entry.window.close()
    }
    // 防御性：取消悬浮后再次确保 Dock 图标可见
    ensureMacAppVisible()
    broadcastState()
    log.info(`已取消悬浮 ${sessionId} (${reason})`)
  } finally {
    closing.delete(sessionId)
  }
}

/** 取消全部悬浮（用于主窗关闭 / app quit） */
export async function unpinAll(reason: UnpinReason = 'app-quit'): Promise<void> {
  const ids = Array.from(pinned.keys())
  await Promise.all(ids.map((id) => unpin(id, reason)))
}

/** 把指定 sessionId 的悬浮窗拉到前台 */
export function focusFloating(sessionId: string): void {
  const entry = pinned.get(sessionId)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.window.isMinimized()) entry.window.restore()
  entry.window.show()
  entry.window.focus()
}

export function getState(): PinnedChatState {
  return { pinnedSessionIds: getPinnedSessionIds() }
}
