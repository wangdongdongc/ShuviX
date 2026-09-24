import {
  app,
  session,
  BrowserWindow,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen
} from 'electron'
import { join } from 'path'
import { homedir, userInfo } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { registerAppEventBridge } from './services/appEvents'
import { litellmService } from './services/litellmService'
import { providerService } from './services/providerService'
import { initI18n, t } from './i18n'
import { settingsDao } from './dao/settingsDao'
import { mcpService } from './services/mcpService'
import { chatFrontendRegistry, ElectronFrontend } from './frontend'
// 触发所有内置工具的 registerBuiltinTool() 副作用
// services / frontend 层消费注册表前必须由 main-entry 先注册
import './tools/allTools'
import { updateService } from './services/updateService'
import { destroyTerminalsByWindow } from './services/terminalService'
import { killAllBgTasks } from './services/bgTaskService'
import { initPinnedChatService, unpinAll as unpinAllPinnedChat } from './services/pinnedChatService'
import { initNotificationService } from './services/notificationService'
import { initMarkdownWindowService, openMarkdownFile } from './services/markdownWindowService'
import { markdownFilesFromArgv } from './utils/markdownFiles'
import {
  initWidgetWindowService,
  closeAll as closeAllWidgetWindows
} from './services/widgetWindowService'
import { getBrowserOffset, setBrowserOffset, clearBrowserOffset } from './services/panelLayoutState'
// pglite: widget 共享库的 WASM 运行时，退出时统一回收 worker
import { disposePglite } from './services/pglite'
import {
  destroyAllTabs,
  initBrowserSession,
  initBrowserWindowService,
  closeBrowserWindowWithMain,
  destroyBrowserWindow
} from './services/browser'
import {
  approveOpenExternalPermission,
  guardAppWindow,
  routeExternalUrl
} from './services/externalOpen'
import { widgetServer } from './services/widget'
import { cliServer } from './services/cliServer'
import { chromeBridge } from './services/chromeBridge'
import { installChromeNativeHost } from './services/chromeExtensionService'
import { registerChromeFrontend } from './frontend/chrome'
import { randomBytes } from 'crypto'
import { chromeBridgeAddressFile, chromeBridgeSocketPath } from '@shuvix/chat-protocol/chromeBridge'
import { closeAllWatchers } from './services/filesWatcherService'
import { hookService } from './services/hookService'
import { installLlmNetwork } from './services/llmNetwork'
import {
  registerCustomProtocolHandlers,
  registerCustomProtocolSchemes
} from './services/customProtocols'
import { applyNativeThemeSource } from './ipc/settingsHandlers'
import { createLogger } from './logger'
import { mark, measure, measureAsync } from './perf'
const log = createLogger('App')

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
const isMac = process.platform === 'darwin'

/**
 * 这次启动自己带来的 md 文件（Windows / Linux 的 argv；macOS 冷启动的 open-file 早于 ready 就到）。
 * 只有它们决定「这次启动不开主窗口」—— 而且至少一个真开出了窗口才算数（文件在 ready 之前被删了、
 * 其实是个叫 x.md 的目录……），一个都没开成就照常开主窗口，不能让用户面对一个没有窗口的应用。
 */
const launchMarkdownFiles: string[] = markdownFilesFromArgv(process.argv, process.cwd())
/**
 * ready 之前**第二个实例**交来的请求：带文件 = 开这些 md，不带 = 要主窗口。它们不是这次启动的意图，
 * 不能让一次普通启动因此不开主窗口 —— ready 之后照请求补做。
 */
const earlySecondInstance = { files: [] as string[], wantsMainWindow: false }
/** ready 之后（共享窗口服务已装配）才能开窗；之前到的一律先记下 */
let windowIntakeReady = false

/** 把主窗口带到眼前：没开过 / 已关掉就现开一个 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/** 各主题对应的窗口背景色（用于创建窗口时避免白闪） */
const THEME_BG_COLORS: Record<string, string> = {
  'github-dark': '#0d1117',
  dracula: '#282a36',
  'one-dark': '#282c34',
  'catppuccin-mocha': '#1e1e2e',
  'gruvbox-dark': '#282828',
  nord: '#2e3440',
  'tokyo-night': '#1a1b26',
  'github-light': '#ffffff',
  'one-light': '#fafafa',
  'catppuccin-latte': '#eff1f5',
  'solarized-light': '#fdf6e3'
}

/** 根据用户主题设置返回窗口背景色 */
function getThemeBgColor(): string {
  try {
    const mode = settingsDao.findByKey('general.theme') || 'dark'
    let themeId: string
    if (mode === 'system') {
      const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
      themeId =
        resolved === 'light'
          ? settingsDao.findByKey('general.lightTheme') || 'github-light'
          : settingsDao.findByKey('general.darkTheme') || 'github-dark'
    } else if (mode === 'light') {
      themeId = settingsDao.findByKey('general.lightTheme') || 'github-light'
    } else {
      themeId = settingsDao.findByKey('general.darkTheme') || 'github-dark'
    }
    return THEME_BG_COLORS[themeId] || '#0d1117'
  } catch {
    return '#0d1117'
  }
}

function getSavedSettingsWindowBounds(): {
  width: number
  height: number
  x?: number
  y?: number
} {
  const defaults = { width: 820, height: 620 }
  try {
    const raw = settingsDao.findByKey('window.settingsBounds')
    if (!raw) return defaults
    const saved = JSON.parse(raw) as { x?: number; y?: number; width?: number; height?: number }
    const w = Number(saved.width)
    const h = Number(saved.height)
    if (!w || !h || w < 600 || h < 400) return defaults

    if (saved.x != null && saved.y != null) {
      const displays = screen.getAllDisplays()
      const visible = displays.some((d) => {
        const b = d.bounds
        return (
          saved.x! >= b.x - w + 100 &&
          saved.x! < b.x + b.width - 100 &&
          saved.y! >= b.y &&
          saved.y! < b.y + b.height - 100
        )
      })
      if (visible) return { width: w, height: h, x: Math.round(saved.x), y: Math.round(saved.y) }
    }
    return { width: w, height: h }
  } catch {
    return defaults
  }
}

/** 打开独立设置窗口（单例） */
function openSettingsWindow(tab?: string): void {
  // 已存在则聚焦
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  const bounds = getSavedSettingsWindowBounds()

  settingsWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x != null && bounds.y != null ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 600,
    minHeight: 400,
    show: false,
    // 任务栏上与主窗口（"ShuviX"）区分；页面 document.title 是产品名，
    // 加载后会覆盖窗口标题 —— 下方 page-title-updated 拦截保住这个标题
    title: `ShuviX — ${t('settings.title')}`,
    // Windows/Linux 下菜单栏默认隐藏（Alt 临时呼出），快捷键不受影响；macOS 菜单本就在系统栏
    ...(!isMac ? { autoHideMenuBar: true } : {}),
    // macOS 使用隐藏标题栏 + 交通灯按钮
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 16, y: 18 }
        }
      : {}),
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 与主窗口同样的守卫：设置页里的链接不该把这个窗口带去外站（preload 对新页面照样生效）
  guardAppWindow(settingsWindow)

  // 加载同一渲染入口，用 #settings hash 区分（可附加 tab 路径如 #settings/providers）
  const hash = tab ? `settings/${tab}` : 'settings'
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }

  // 页面 <title> 是产品名 "ShuviX"，加载完成会覆盖窗口标题 → 拦住，
  // 否则任务栏/Alt+Tab 里主窗口与设置窗口同名无法区分
  settingsWindow.on('page-title-updated', (e) => e.preventDefault())

  // 关闭前保存窗口位置和尺寸
  settingsWindow.on('close', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsDao.upsert('window.settingsBounds', JSON.stringify(settingsWindow.getBounds()))
    }
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
    // 无需在此重同步：设置/提供商的每次变更已由对应 service 在数据层发布事件并广播到所有窗口
  })
}

/** 配置应用菜单（含系统常用快捷键） */
function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS 应用菜单
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: `${t('settings.title')}…`,
                accelerator: 'CommandOrControl+,',
                click: () => openSettingsWindow()
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    // 文件菜单
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('sidebar.newChat'),
          accelerator: 'CommandOrControl+N',
          click: () => mainWindow?.webContents.send('app:new-chat')
        },
        {
          label: t('sidebar.newProject'),
          accelerator: 'CommandOrControl+Shift+N',
          click: () => mainWindow?.webContents.send('app:new-project')
        }
      ]
    },
    // 编辑菜单（系统常用快捷键：撤销、重做、剪切、复制、粘贴、全选、删除）
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    // 窗口菜单
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
      ]
    },
    // 开发模式下添加开发菜单
    ...(is.dev
      ? [
          {
            label: t('menu.dev'),
            submenu: [
              { role: 'toggleDevTools' as const },
              { role: 'reload' as const },
              { role: 'forceReload' as const }
            ]
          }
        ]
      : [])
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** resize handle 宽度（与 renderer 侧保持一致） */
const HANDLE_WIDTH = 1

/** 面板布局（持久化在 window.panelLayout） */
interface PanelLayout {
  sidebarWidth: number
  sidebarOpen: boolean
  chatWidth: number
  browserWidth: number
  browserOpen: boolean
}

const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  sidebarWidth: 240,
  sidebarOpen: true,
  chatWidth: 720,
  browserWidth: 480,
  browserOpen: false
}

/** 从面板布局计算窗口宽度 */
function calcWindowWidth(layout: PanelLayout): number {
  let w = layout.chatWidth
  if (layout.sidebarOpen) w += layout.sidebarWidth + HANDLE_WIDTH
  if (layout.browserOpen) w += layout.browserWidth + HANDLE_WIDTH
  return Math.max(800, w)
}

/** 读取持久化的面板布局 */
function getSavedPanelLayout(): PanelLayout {
  try {
    const raw = settingsDao.findByKey('window.panelLayout')
    if (!raw) return DEFAULT_PANEL_LAYOUT
    const saved = JSON.parse(raw) as Partial<PanelLayout> & {
      previewWidth?: number
      previewOpen?: boolean
    }
    return {
      sidebarWidth: Number(saved.sidebarWidth) || DEFAULT_PANEL_LAYOUT.sidebarWidth,
      sidebarOpen: saved.sidebarOpen ?? DEFAULT_PANEL_LAYOUT.sidebarOpen,
      chatWidth: Math.max(400, Number(saved.chatWidth) || DEFAULT_PANEL_LAYOUT.chatWidth),
      browserWidth:
        Number(saved.browserWidth ?? saved.previewWidth) || DEFAULT_PANEL_LAYOUT.browserWidth,
      browserOpen: saved.browserOpen ?? saved.previewOpen ?? DEFAULT_PANEL_LAYOUT.browserOpen
    }
  } catch {
    return DEFAULT_PANEL_LAYOUT
  }
}

/** 启动时尚未创建 webContents，需根据保存的 uiZoom 计算 zoomFactor 把 CSS 像素换算成 DIP */
function getStartupZoomFactor(): number {
  const pct = Number(settingsDao.findByKey('general.uiZoom')) / 100 || 1
  return Math.max(0.5, Math.min(2.2, pct))
}

function getSavedWindowBounds(): { width: number; height: number; x?: number; y?: number } {
  const layout = getSavedPanelLayout()
  // browser 不自动恢复（renderer 侧不恢复 browserOpen），计算窗口宽度时排除 browser
  // calcWindowWidth 返回 CSS 像素；BrowserWindow.width 需要 DIP，按 zoomFactor 换算
  const zoom = getStartupZoomFactor()
  const defaultWidth = Math.round(calcWindowWidth({ ...layout, browserOpen: false }) * zoom)
  const defaults = { width: defaultWidth, height: 800 }
  try {
    const raw = settingsDao.findByKey('window.mainBounds')
    if (!raw) return defaults
    const saved = JSON.parse(raw) as { x?: number; y?: number; height?: number }
    const h = Number(saved.height)
    if (!h || h < 600) return defaults

    const w = defaultWidth

    // 校验位置是否在可见屏幕范围内
    if (saved.x != null && saved.y != null) {
      const displays = screen.getAllDisplays()
      const visible = displays.some((d) => {
        const b = d.bounds
        return (
          saved.x! >= b.x - w + 100 &&
          saved.x! < b.x + b.width - 100 &&
          saved.y! >= b.y &&
          saved.y! < b.y + b.height - 100
        )
      })
      if (visible) return { width: w, height: h, x: Math.round(saved.x), y: Math.round(saved.y) }
    }
    return { width: w, height: h }
  } catch {
    return defaults
  }
}

/**
 * 与主窗口无关、整个应用只需装配一次的窗口服务。主窗口与 md 窗口都可能是第一个窗口
 * （从系统打开 md 启动时主窗口根本不开），所以谁先来谁装配。
 */
let sharedWindowServicesReady = false
function initSharedWindowServices(): void {
  if (sharedWindowServicesReady) return
  sharedWindowServicesReady = true

  // 初始化通知服务（决策在 agent-runtime，这里只提供窗口句柄：聚焦 / 关窗后重建）
  initNotificationService({
    getMainWindow: () => mainWindow,
    ensureMainWindow: () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    }
  })

  // 初始化 widget 独立窗口服务（owns widget app 窗口）
  initWidgetWindowService({ getThemeBgColor })

  // 初始化内置浏览器 partition 的权限策略（独立于 defaultSession，默认拒绝所有权限请求）
  initBrowserSession()
  // 浏览器是独立窗口（懒创建）：只在用户点开时才建，关窗只隐藏；agent 的 tab 住在停放窗口里
  initBrowserWindowService({ getThemeBgColor })

  // 从系统打开的 md 窗口：每个窗口一条内存会话，前端按窗口单独绑定（id 各不相同）
  initMarkdownWindowService({
    getThemeBgColor,
    createFrontend: (window, id) => new ElectronFrontend(window, id)
  })
}

function createWindow(): void {
  const bounds = getSavedWindowBounds()

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x != null && bounds.y != null ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    show: false,
    icon: join(__dirname, '../../resources/icon.png'),
    // Windows/Linux 下菜单栏默认隐藏（Alt 临时呼出），快捷键不受影响；macOS 菜单本就在系统栏
    ...(!isMac ? { autoHideMenuBar: true } : {}),
    // macOS 使用隐藏标题栏 + 交通灯按钮。
    // y=14：全窗顶部为交通灯预留的是 40px 带（侧边栏 pt-10 / 聊天顶栏 h-10），12pt 的圆点
    // 居中即 (40-12)/2=14 —— 与顶栏内 items-center 的标题文字同在 y=20 的中心线上（原 18 会低 4px）
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 16, y: 14 }
        }
      : {}),
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 注册 Electron 主窗口为默认前端
  chatFrontendRegistry.registerDefault(new ElectronFrontend(mainWindow))

  // 初始化悬浮聊天服务（owns 悬浮窗 + pin 状态）
  // 由 main-entry 注入 ElectronFrontend 工厂，避免 service 层反向依赖 frontend-impl
  initPinnedChatService({
    mainWindow,
    getThemeBgColor,
    createFrontend: (window) => new ElectronFrontend(window, 'electron-pinned')
  })

  initSharedWindowServices()

  // 弹窗与页面内导航（点 <a href>、PDF 里的链接、预览 iframe 里的脚本）都不自己走：
  // 阻止应用变成浏览器，去向交给 externalOpen 那道闸（http(s) → 系统浏览器）
  guardAppWindow(mainWindow)

  // 关闭前清理该窗口关联的终端实例 + 释放 browserOffset 跟踪
  const mainWebContentsId = mainWindow.webContents.id
  const thisWindow = mainWindow
  mainWindow.on('close', () => {
    destroyTerminalsByWindow(mainWebContentsId)
    void unpinAllPinnedChat('window-closed')
    closeAllWidgetWindows()
    // 销毁而非隐藏：隐藏的窗口会让 window-all-closed / Dock 重建主窗口都失灵（tab 留着）
    closeBrowserWindowWithMain()
  })
  mainWindow.on('closed', () => {
    clearBrowserOffset(mainWebContentsId)
    // macOS 关掉主窗口应用仍在跑：别让变量留着一个已销毁的窗口 —— 之后别的窗口（md 窗口、widget）
    // 发来的 window-ready、菜单的「新建会话」一碰它的 webContents 就是 "Object has been destroyed"
    if (mainWindow === thisWindow) mainWindow = null
  })

  // 关闭前保存窗口位置和尺寸
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds()
      // 仅保存位置和高度（宽度由 panelLayout 计算）
      settingsDao.upsert(
        'window.mainBounds',
        JSON.stringify({ x: bounds.x, y: bounds.y, height: bounds.height })
      )
      // 从各面板的持久化设置中汇总保存 panelLayout
      const zoom = mainWindow.webContents.getZoomFactor()
      const windowWidth = bounds.width / zoom // CSS 像素
      const layout = getSavedPanelLayout()
      // 反推 chatWidth = 窗口宽度 - 其他面板。
      // browserOpen 不读 DB —— DB 里的值在「上次会话开过、本次未操作过」时会过期。
      // 用主进程实时跟踪的 browserOffsetByWindow（renderer 每次 set-browser-offset 都会更新）。
      const browserActuallyOpen = getBrowserOffset(mainWebContentsId) > 0
      let chatWidth = windowWidth
      if (layout.sidebarOpen) chatWidth -= layout.sidebarWidth + HANDLE_WIDTH
      if (browserActuallyOpen) chatWidth -= layout.browserWidth + HANDLE_WIDTH
      chatWidth = Math.max(400, Math.round(chatWidth))
      settingsDao.upsert(
        'window.panelLayout',
        JSON.stringify({ ...layout, chatWidth, browserOpen: browserActuallyOpen })
      )
    }
  })

  // 开发环境加载 HMR URL，生产环境加载本地文件
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 获取应用版本号
ipcMain.handle('app:version', () => {
  return app.getVersion()
})

// React 挂载完成后显示对应窗口（同时应用已保存的 UI 缩放）
ipcMain.on('app:window-ready', (event) => {
  const sender = event.sender
  // 应用 UI 缩放设置（zoomFactor 与用户设置的百分比 1:1 对应：100% → 1.0）
  const uiZoom = Math.max(
    0.5,
    Math.min(2.2, Number(settingsDao.findByKey('general.uiZoom')) / 100 || 1)
  )
  sender.setZoomFactor(uiZoom)
  if (mainWindow && sender === mainWindow.webContents) {
    mark('mainWindow visible (window-ready)')
    mainWindow.show()
  } else if (
    settingsWindow &&
    !settingsWindow.isDestroyed() &&
    sender === settingsWindow.webContents
  ) {
    settingsWindow.show()
  }
})

// Sidebar 按钮触发打开设置窗口
ipcMain.handle('app:open-settings', (_event, tab?: string) => {
  openSettingsWindow(tab)
  return { success: true }
})

// 渲染进程要打开的外链（聊天 / 笔记本里的链接、面板的「在系统浏览器打开」、验证页…）。
// 调用方是自己人，但地址多半来自内容（模型写的 md、面板里那个 tab 的地址），所以照样过闸；
// 用户是亲手点的，询问因此不设静默期（byUser）。回 success=false 表示没交给系统。
ipcMain.handle('app:open-external', async (event, url: string) => {
  const success = await routeExternalUrl(url, {
    parent: BrowserWindow.fromWebContents(event.sender),
    byUser: true
  })
  return { success }
})

// 用系统文件管理器打开指定文件夹
ipcMain.handle('app:open-folder', async (_event, folderPath: string) => {
  const { shell } = await import('electron')
  await shell.openPath(folderPath)
  return { success: true }
})

// 在系统文件管理器中定位并选中指定文件（openPath 对压缩包等于直接解压/打开，故用 showItemInFolder）
ipcMain.handle('app:reveal-path', async (_event, filePath: string) => {
  const { shell } = await import('electron')
  shell.showItemInFolder(filePath)
  return { success: true }
})

// 调整调用方窗口的宽度（delta 为 CSS 像素，按窗口自身 zoom factor 换算）
// 主窗口最小宽度 800，悬浮窗最小宽度 320（保留各自创建时的 minWidth）
ipcMain.handle('app:adjust-window-width', (event, delta: number) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  const zoom = win.webContents.getZoomFactor()
  const scaledDelta = Math.round(delta * zoom)
  const bounds = win.getBounds()
  const [minWidth] = win.getMinimumSize()
  const newWidth = Math.max(minWidth || 320, bounds.width + scaledDelta)
  const display = screen.getDisplayMatching(bounds)
  const maxRight = display.workArea.x + display.workArea.width
  const clampedWidth = Math.min(newWidth, maxRight - bounds.x)
  if (clampedWidth !== bounds.width) {
    win.setBounds({ ...bounds, width: clampedWidth }, process.platform === 'darwin')
  }
})

// 设置浏览器面板宽度偏移 —— 按 sender 窗口分别跟踪
// 状态存放在 services/panelLayoutState，避免与 pinnedChatService 间产生循环依赖
ipcMain.handle('app:set-browser-offset', (event, offset: number) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  setBrowserOffset(win.webContents.id, offset)
})

// 单实例锁：阻止第二个进程启动，避免并发访问数据库
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  log.info('另一个 ShuviX 实例已在运行（单实例锁未获取），本进程退出')
  app.quit()
} else {
  // 第二个实例：Windows / Linux 上「用 ShuviX 打开」一个 md，文件在它的 argv 里 —— 在这里开 md 窗口；
  // 什么文件都没带（再点一次应用图标）才是要主窗口，没开过（从 md 启动的）就现开一个
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const files = markdownFilesFromArgv(argv, workingDirectory)
    if (!windowIntakeReady) {
      if (files.length > 0) earlySecondInstance.files.push(...files)
      else earlySecondInstance.wantsMainWindow = true
      return
    }
    if (files.length > 0) files.forEach((file) => openMarkdownFile(file))
    else showMainWindow()
  })

  // macOS 只经这个事件交文件（冷启动时早于 ready，所以必须在 whenReady 之前挂上）。
  // 是不是 md 交给 openMarkdownFile 判（它两头都认：点的名字与链接指向的真实文件）
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (windowIntakeReady) openMarkdownFile(path)
    else launchMarkdownFiles.push(path)
  })
}

// 自定义协议 scheme 注册必须早于 app.whenReady
registerCustomProtocolSchemes()

// 被遮挡的窗口照常合成。内置浏览器的 tab 常常出生在不可见的地方 —— 停放窗口从不显示，
// 浏览器窗口可能被主窗口盖住、被关掉（隐藏）、最小化、在别的桌面，屏幕也可能锁着。
// 没有这个开关，这些状态下新出生（或跨站导航后）的 view 拿不到第一帧：截图报
// "Current display surface not available"、agent 的鼠标点击不落地（2026-09-23 实测）。
// 代价：被遮挡的窗口不再停止渲染（主窗口被盖住时动画照跑）。e2e harness 本来就带着它启动。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// 全局 fetch 包装：只作用于 LLM 请求（作用域外原样透传），放宽 undici 默认的
// 300s 传输超时并记录 fetch 失败的成因链。必须早于任何 agent 跑起来。
installLlmNetwork()

app.whenReady().then(async () => {
  mark('app.whenReady')
  // 必须与 electron-builder.yml 的 appId 一致，否则 Windows 任务栏中
  // 运行中的窗口无法与固定（pinned）的快捷方式归为一组，会显示成两个图标
  electronApp.setAppUserModelId('com.shuvix.app')

  // shuvix-media:// + shuvix-preview://
  registerCustomProtocolHandlers()

  // 主窗口（自有页面）的权限请求一律放行。
  // 例外是 `openExternal` —— 它不是「页面要用某个能力」，而是页面导航到非网页协议、Electron 在问
  // 要不要把这个地址交给操作系统（准了由它自己交，不经 shell.openExternal）。那一档走同一道闸。
  // 注意：内置浏览器跑在独立 partition（BROWSER_PARTITION），权限策略由 initBrowserSession() 单独管理。
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (permission === 'openExternal' && 'externalURL' in details) {
        void approveOpenExternalPermission(webContents, details).then(callback)
        return
      }
      callback(true)
    }
  )

  // 设置应用图标（开发模式下 Dock/任务栏也显示自定义图标）
  const iconPath = join(app.getAppPath(), 'resources/icon.png')
  const appIcon = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin' && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon)
  }

  // 初始化 i18n（从 DB 读取用户语言偏好，无则跟随系统）
  measure('initI18n', () => {
    const savedLang = settingsDao.findByKey('general.language')
    initI18n(savedLang || undefined)
  })

  // 应用用户主题选择到 nativeTheme.themeSource —— 让 widget 等 webContents
  // 的 prefers-color-scheme 跟随 ShuviX 设置，而不只是跟随 OS
  measure('applyNativeTheme', () => {
    applyNativeThemeSource(settingsDao.findByKey('general.theme'))
  })

  measure('setupMenu', () => setupApplicationMenu())

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 注册所有 IPC 处理器
  measure('registerIPC', () => registerIpcHandlers())

  // 装配 hook runner（业务埋点在此之前的 fire 静默丢弃）
  measure('hookService.init', () => hookService.init())

  // 内部事件总线 → 所有窗口的 'app:event' 桥接（AppEvent 通用订阅）
  registerAppEventBridge()

  // 初始化自动更新服务（绑定 electron-updater 事件）
  updateService.init()

  // 从 pi-ai 注册表同步内置提供商的模型列表 + 能力信息（同步操作，无需网络）
  measure('syncBuiltinModels', () => providerService.syncAllBuiltinModels())

  // 启动时异步拉取 LiteLLM 模型数据，完成后为自定义提供商补充模型能力信息
  measureAsync('litellmService.init', () => litellmService.init())
    .then(() => {
      providerService.fillAllMissingCapabilities()
    })
    .catch(() => {})

  // MCP Client 惰性启动：不在这里连 —— 哪条会话用到哪台，创建 Agent 装配工具时才连（见 agents/agentHost）

  // MCP Server 出于安全考虑不自动启动，需用户在设置中手动开启

  // 启动 CLI IPC 服务 —— 给 shuvix-cli 提供 Unix socket / named pipe
  cliServer.start().catch((err) => {
    log.error(`cliServer.start failed: ${err}`)
  })

  // Chrome 扩展：桥服务（本地组件连进来）+ 每次启动重写原生消息宿主的启动脚本与各浏览器的清单。
  // token 与 CLI 共用 —— cliServer.start 同步生成，此刻已经在了
  registerChromeFrontend()
  chromeBridge
    .start({
      socketPath: chromeBridgeSocketPath({
        home: homedir(),
        platform: process.platform,
        user: userInfo().username,
        // Windows 的命名管道没有 0600 那种门，名字又是可猜的：每次启动换一个随机后缀，
        // 真实地址只写进用户目录下的地址文件（本地组件现读），敲门的前提于是与 token 同一道
        nonce: process.platform === 'win32' ? randomBytes(6).toString('hex') : undefined
      }),
      addressFile: chromeBridgeAddressFile(homedir()),
      getToken: () => cliServer.getToken()
    })
    .catch((err) => log.error(`chromeBridge.start failed: ${err}`))
  void installChromeNativeHost()

  // 带着 md 文件启动：只开 md 窗口，主窗口等用户要（点 Dock / 再点一次应用图标）才开
  initSharedWindowServices()
  windowIntakeReady = true
  let openedAtLaunch = 0
  for (const file of launchMarkdownFiles.splice(0)) {
    if (openMarkdownFile(file)) openedAtLaunch++
  }
  if (openedAtLaunch > 0) {
    log.info(`从系统打开 ${openedAtLaunch} 个 md 文件，不开主窗口`)
  } else {
    measure('createWindow', () => createWindow())
  }
  // ready 之前第二个实例交来的请求：照做，但不影响上面这次启动开不开主窗口
  for (const file of earlySecondInstance.files.splice(0)) openMarkdownFile(file)
  if (earlySecondInstance.wantsMainWindow) showMainWindow()

  app.on('activate', () => {
    // macOS dock 点击时重新创建主窗口。按主窗口本身判断，不按「一个窗口都没有」：
    // 浏览器的停放窗口从不显示却一直在（主窗口关着时后台 agent 仍可能在用浏览器）
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

// 应用退出前清理
app.on('before-quit', () => {
  destroyBrowserWindow()
  destroyAllTabs()
  killAllBgTasks()
  mcpService.disconnectAll().catch(() => {})
  widgetServer.dispose()
  chromeBridge.stop()
  cliServer.stop()
  disposePglite()
  closeAllWatchers()
})

// macOS 下关闭窗口不退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
