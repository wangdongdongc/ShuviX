import {
  app,
  shell,
  session,
  net,
  protocol,
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
import { dockerManager } from './services/dockerManager'
import { pythonWorkerManager } from './services/pythonWorkerManager'
import { sqlWorkerManager } from './services/sqlWorkerManager'
import { sshManager } from './services/sshManager'
import { litellmService } from './services/litellmService'
import { providerService } from './services/providerService'
import { initI18n, t } from './i18n'
import { settingsDao } from './dao/settingsDao'
import { mcpService } from './services/mcpService'
import { abortAllAcpSessions } from './subagent'
import { chatFrontendRegistry, ElectronFrontend } from './frontend'
import { telegramService } from './services/telegramService'
import { createLogger } from './logger'
import { mark, measure, measureAsync } from './perf'
const log = createLogger('App')

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
const isMac = process.platform === 'darwin'

/** 各主题对应的窗口背景色（用于创建窗口时避免白闪） */
const THEME_BG_COLORS: Record<string, string> = {
  dark: '#0a0a0f',
  'github-dark': '#0d1117',
  nord: '#2e3440',
  'tokyo-night': '#1a1b26',
  light: '#ffffff',
  'github-light': '#ffffff',
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
          ? settingsDao.findByKey('general.lightTheme') || 'light'
          : settingsDao.findByKey('general.darkTheme') || 'dark'
    } else if (mode === 'light') {
      themeId = settingsDao.findByKey('general.lightTheme') || 'light'
    } else {
      themeId = settingsDao.findByKey('general.darkTheme') || 'dark'
    }
    return THEME_BG_COLORS[themeId] || '#0a0a0f'
  } catch {
    return '#0a0a0f'
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
    title: '设置',
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

  // 关闭前保存窗口位置和尺寸
  settingsWindow.on('close', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsDao.upsert('window.settingsBounds', JSON.stringify(settingsWindow.getBounds()))
    }
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
    // 设置窗口关闭后通知主窗口刷新设置
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:settings-changed')
    }
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
    // 编辑菜单（系统常用快捷键：撤销、重做、剪切、复制、粘贴、全选、删除）
    {
      label: 'Edit',
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
      label: 'Window',
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
            label: 'Dev',
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

function getSavedWindowBounds(): { width: number; height: number; x?: number; y?: number } {
  const defaults = { width: 960, height: 800 }
  try {
    const raw = settingsDao.findByKey('window.mainBounds')
    if (!raw) return defaults
    const saved = JSON.parse(raw) as { x?: number; y?: number; width?: number; height?: number }
    const w = Number(saved.width)
    const h = Number(saved.height)
    if (!w || !h || w < 800 || h < 600) return defaults

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

  // 注册 Electron 主窗口为默认前端
  chatFrontendRegistry.registerDefault(new ElectronFrontend(mainWindow))

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

  // 关闭前保存窗口位置和尺寸（扣除预览面板宽度）
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds()
      if (previewWidthOffset > 0) {
        bounds.width = Math.max(800, bounds.width - previewWidthOffset)
      }
      settingsDao.upsert('window.mainBounds', JSON.stringify(bounds))
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
  // 应用 UI 缩放设置（基础倍率 1.1：100% 对应 zoomFactor 1.1）
  const uiZoom = Math.max(
    0.5,
    Math.min(2.2, (Number(settingsDao.findByKey('general.uiZoom')) / 100 || 1) * 1.1)
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

// 预览面板占用的额外宽度（保存窗口尺寸时需要扣除）
let previewWidthOffset = 0

// 调整主窗口宽度（delta 为 CSS 像素，自动按 zoom factor 换算为屏幕像素）
ipcMain.handle('app:adjust-window-width', (_event, delta: number) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const zoom = mainWindow.webContents.getZoomFactor()
  const scaledDelta = Math.round(delta * zoom)
  const bounds = mainWindow.getBounds()
  const newWidth = Math.max(800, bounds.width + scaledDelta)
  // 获取窗口所在显示器的工作区域，防止超出屏幕
  const { screen } = require('electron')
  const display = screen.getDisplayMatching(bounds)
  const maxRight = display.workArea.x + display.workArea.width
  const clampedWidth = Math.min(newWidth, maxRight - bounds.x)
  if (clampedWidth !== bounds.width) {
    mainWindow.setBounds({ ...bounds, width: clampedWidth })
  }
})

// 设置预览面板宽度偏移（CSS 像素，按 zoom factor 换算为屏幕像素后存储）
// 同时动态调整窗口最小宽度，防止对话区被压缩过窄
ipcMain.handle('app:set-preview-offset', (_event, offset: number) => {
  const zoom = mainWindow?.webContents?.getZoomFactor() || 1
  previewWidthOffset = Math.round(offset * zoom)
  if (mainWindow && !mainWindow.isDestroyed()) {
    const baseMinWidth = 800
    mainWindow.setMinimumSize(baseMinWidth + previewWidthOffset, 600)
  }
})

// 注册自定义协议（必须在 app.whenReady 之前调用）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'shuvix-media',
    privileges: { stream: true, supportFetchAPI: true, bypassCSP: true }
  }
])

app.whenReady().then(() => {
  mark('app.whenReady')
  electronApp.setAppUserModelId('com.shuvix')

  // 注册 shuvix-media:// 协议，安全地为渲染进程提供本地文件（TTS 音频等）
  protocol.handle('shuvix-media', (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname)
    return net.fetch(`file://${filePath}`)
  })

  // 允许渲染进程请求麦克风权限（语音输入）
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true)
      return
    }
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

  measure('setupMenu', () => setupApplicationMenu())

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 注册所有 IPC 处理器
  measure('registerIPC', () => registerIpcHandlers())

  // 从 pi-ai 注册表同步内置提供商的模型列表 + 能力信息（同步操作，无需网络）
  measure('syncBuiltinModels', () => providerService.syncAllBuiltinModels())

  // 启动时异步拉取 LiteLLM 模型数据，完成后为自定义提供商补充模型能力信息
  measureAsync('litellmService.init', () => litellmService.init())
    .then(() => {
      providerService.fillAllMissingCapabilities()
    })
    .catch(() => {})

  // 启动所有已启用的 MCP Server
  measureAsync('mcpService.connectAll', () => mcpService.connectAll()).catch((err) => {
    log.error(`connectAll failed: ${err}`)
  })

  // 恢复有绑定 session 的 Telegram Bot
  telegramService.autoStartBots().catch((err) => {
    log.error(`telegram autoStartBots failed: ${err}`)
  })

  measure('createWindow', () => createWindow())

  app.on('activate', () => {
    // macOS dock 点击时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 应用退出前清理
app.on('before-quit', () => {
  dockerManager.destroyAll().catch(() => {})
  mcpService.disconnectAll().catch(() => {})
  sshManager.disconnectAll().catch(() => {})
  pythonWorkerManager.terminateAll()
  sqlWorkerManager.terminateAll()
  telegramService.stopAll().catch(() => {})
  abortAllAcpSessions()
})

// macOS 下关闭窗口不退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
