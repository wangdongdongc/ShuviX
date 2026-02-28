import { app, shell, BrowserWindow, Menu, ipcMain, nativeImage, screen } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { agentService } from './services/agent'
import { dockerManager } from './services/dockerManager'
import { sshManager } from './services/sshManager'
import { litellmService } from './services/litellmService'
import { providerService } from './services/providerService'
import { initI18n, t } from './i18n'
import { settingsDao } from './dao/settingsDao'
import { mcpService } from './services/mcpService'
import { createLogger } from './logger'
import { mark, measure, measureAsync } from './perf'
const log = createLogger('App')

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
const isMac = process.platform === 'darwin'

/** 根据用户主题设置返回窗口背景色 */
function getThemeBgColor(): string {
  try {
    const theme = settingsDao.findByKey('general.theme') || 'dark'
    if (theme === 'system') {
      const { nativeTheme } = require('electron')
      return nativeTheme.shouldUseDarkColors ? '#0a0a0f' : '#ffffff'
    }
    return theme === 'light' ? '#ffffff' : '#0a0a0f'
  } catch {
    return '#0a0a0f'
  }
}

/** 打开独立设置窗口（单例） */
function openSettingsWindow(): void {
  // 已存在则聚焦
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 820,
    height: 620,
    minWidth: 600,
    minHeight: 400,
    show: false,
    title: '设置',
    // macOS 使用隐藏标题栏 + 交通灯按钮
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 }
    } : {}),
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 加载同一渲染入口，用 #settings hash 区分
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'settings' })
  }

  settingsWindow.on('closed', () => {
    settingsWindow = null
    // 设置窗口关闭后通知主窗口刷新设置
    mainWindow?.webContents.send('app:settings-changed')
  })
}

/** 配置应用菜单（含系统常用快捷键） */
function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS 应用菜单
    ...(isMac ? [{
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
    }] : []),
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
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const }
        ] : [])
      ]
    },
    // 开发模式下添加开发菜单
    ...(is.dev ? [{
      label: 'Dev',
      submenu: [
        { role: 'toggleDevTools' as const },
        { role: 'reload' as const },
        { role: 'forceReload' as const }
      ]
    }] : [])
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
        return saved.x! >= b.x - w + 100 && saved.x! < b.x + b.width - 100
          && saved.y! >= b.y && saved.y! < b.y + b.height - 100
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
    ...(isMac ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 }
    } : {}),
    backgroundColor: getThemeBgColor(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 绑定 Agent 服务到主窗口
  agentService.setWindow(mainWindow)

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

  // 关闭前保存窗口位置和尺寸
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      settingsDao.upsert('window.mainBounds', JSON.stringify(mainWindow.getBounds()))
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
  const uiZoom = Math.max(0.5, Math.min(2.2, (Number(settingsDao.findByKey('general.uiZoom')) / 100 || 1) * 1.1))
  sender.setZoomFactor(uiZoom)
  if (mainWindow && sender === mainWindow.webContents) {
    mark('mainWindow visible (window-ready)')
    mainWindow.show()
  } else if (settingsWindow && !settingsWindow.isDestroyed() && sender === settingsWindow.webContents) {
    settingsWindow.show()
  }
})

// Sidebar 按钮触发打开设置窗口
ipcMain.handle('app:open-settings', () => {
  openSettingsWindow()
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

// 将 base64 图片写入临时文件并用系统默认应用打开
ipcMain.handle('app:open-image', async (_event, dataUrl: string) => {
  const { shell } = await import('electron')
  const { writeFileSync } = await import('fs')
  const { join } = await import('path')
  const { tmpdir } = await import('os')

  // 解析 data URL：data:image/png;base64,xxxxx
  const match = dataUrl.match(/^data:(image\/(\w+));base64,(.+)$/)
  if (!match) return { success: false, error: '无效的图片数据' }

  const ext = match[2] === 'jpeg' ? 'jpg' : match[2]
  const base64Data = match[3]
  const tmpPath = join(tmpdir(), `shuvix-img-${Date.now()}.${ext}`)

  writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'))
  await shell.openPath(tmpPath)
  return { success: true }
})

app.whenReady().then(() => {
  mark('app.whenReady')
  electronApp.setAppUserModelId('com.shuvix')

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
  measureAsync('litellmService.init', () => litellmService.init()).then(() => {
    providerService.fillAllMissingCapabilities()
  }).catch(() => {})

  // 启动所有已启用的 MCP Server
  measureAsync('mcpService.connectAll', () => mcpService.connectAll()).catch((err) => {
    log.error(`connectAll failed: ${err}`)
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
})

// macOS 下关闭窗口不退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
