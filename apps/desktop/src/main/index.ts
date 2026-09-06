import {
  app,
  shell,
  session,
  BrowserWindow,
  Menu,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { registerAppEventBridge } from './services/appEvents'
import { sshManager } from './services/sshManager'
import { litellmService } from './services/litellmService'
import { providerService } from './services/providerService'
import { initI18n, t } from './i18n'
import { settingsDao } from './dao/settingsDao'
import { mcpService } from './services/mcpService'
import { mcpServerService } from './services/mcpServerService'
import { chatFrontendRegistry, ElectronFrontend } from './frontend'
// 触发所有内置工具的 registerBuiltinTool() 副作用
// services / frontend 层消费注册表前必须由 main-entry 先注册
import './tools/allTools'
import { updateService } from './services/updateService'
import { destroyTerminalsByWindow } from './services/terminalService'
import { killAllBgTasks } from './services/bgTaskService'
import { initPinnedChatService, unpinAll as unpinAllPinnedChat } from './services/pinnedChatService'
import { initNotificationService } from './services/notificationService'
import {
  initWidgetWindowService,
  closeAll as closeAllWidgetWindows
} from './services/widgetWindowService'
import { getBrowserOffset, setBrowserOffset, clearBrowserOffset } from './services/panelLayoutState'
// pglite: widget 共享库的 WASM 运行时，退出时统一回收 worker
import { disposePglite } from './services/pglite'
import { initBrowserHost, destroyAllTabs, initBrowserSession } from './services/browser'
import { widgetServer } from './services/widget'
import { cliServer } from './services/cliServer'
import { closeAllWatchers } from './services/filesWatcherService'
import { workflowService } from './services/workflowService'
import { botService } from './services/botService'
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
  // 记录浏览器面板的宿主窗口（tab 的 WebContentsView 按需创建，renderer 通过 IPC 控制）
  initBrowserHost(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 拦截页面内导航（点击 <a href> 链接），阻止应用变成浏览器，改用系统默认浏览器打开
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 允许开发环境的 HMR 热更新导航
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'] || ''
    if (rendererUrl && url.startsWith(rendererUrl)) return
    event.preventDefault()
    shell.openExternal(url)
  })

  // 关闭前清理该窗口关联的终端实例 + 释放 browserOffset 跟踪
  const mainWebContentsId = mainWindow.webContents.id
  mainWindow.on('close', () => {
    destroyTerminalsByWindow(mainWebContentsId)
    void unpinAllPinnedChat('window-closed')
    closeAllWidgetWindows()
  })
  mainWindow.on('closed', () => {
    clearBrowserOffset(mainWebContentsId)
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

// 用系统默认浏览器打开外部链接
ipcMain.handle('app:open-external', async (_event, url: string) => {
  const { shell } = await import('electron')
  await shell.openExternal(url)
  return { success: true }
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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// 自定义协议 scheme 注册必须早于 app.whenReady
registerCustomProtocolSchemes()

app.whenReady().then(async () => {
  mark('app.whenReady')
  // 必须与 electron-builder.yml 的 appId 一致，否则 Windows 任务栏中
  // 运行中的窗口无法与固定（pinned）的快捷方式归为一组，会显示成两个图标
  electronApp.setAppUserModelId('com.shuvix.app')

  // shuvix-media:// + shuvix-preview://
  registerCustomProtocolHandlers()

  // 主窗口（自有页面）的权限请求一律放行。
  // 注意：内置浏览器跑在独立 partition（BROWSER_PARTITION），权限策略由 initBrowserSession() 单独管理。
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true)
  })

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

  // 装配 workflow 引擎（业务埋点在此之前的 fire 静默丢弃）
  measure('workflowService.init', () => workflowService.init())
  // 注册聊天会话的树钉住谓词（同 workflowService：装配挪进 init 以避开 ESM 初始化环）
  measure('botService.init', () => botService.init())

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

  // 启动所有已启用的 MCP Client
  measureAsync('mcpService.connectAll', () => mcpService.connectAll()).catch((err) => {
    log.error(`connectAll failed: ${err}`)
  })

  // MCP Server 出于安全考虑不自动启动，需用户在设置中手动开启

  // 启动 CLI IPC 服务 —— 给 shuvix-cli 提供 Unix socket / named pipe
  cliServer.start().catch((err) => {
    log.error(`cliServer.start failed: ${err}`)
  })

  measure('createWindow', () => createWindow())

  app.on('activate', () => {
    // macOS dock 点击时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 应用退出前清理
app.on('before-quit', () => {
  destroyAllTabs()
  killAllBgTasks()
  mcpService.disconnectAll().catch(() => {})
  mcpServerService.stop().catch(() => {})
  sshManager.disconnectAll().catch(() => {})
  widgetServer.dispose()
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
