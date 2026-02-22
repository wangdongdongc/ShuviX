import { app, shell, BrowserWindow, Menu, ipcMain, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { agentService } from './services/agent'
import { dockerManager } from './services/dockerManager'
import { litellmService } from './services/litellmService'
import { providerService } from './services/providerService'
import { initI18n } from './i18n'
import { settingsDao } from './dao/settingsDao'

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

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
    title: '设置',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0a0a0f',
    vibrancy: 'under-window',
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
          label: '设置…',
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    icon: join(__dirname, '../../resources/icon.png'),
    // macOS 无边框窗口，使用系统交通灯按钮
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0a0a0f',
    vibrancy: 'under-window',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 绑定 Agent 服务到主窗口
  agentService.setWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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
  electronApp.setAppUserModelId('com.shuvix')

  // 设置应用图标（开发模式下 Dock/任务栏也显示自定义图标）
  const iconPath = join(app.getAppPath(), 'resources/icon.png')
  const appIcon = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin' && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon)
  }

  // 初始化 i18n（从 DB 读取用户语言偏好，无则跟随系统）
  const savedLang = settingsDao.findByKey('general.language')
  initI18n(savedLang || undefined)

  setupApplicationMenu()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 注册所有 IPC 处理器
  registerIpcHandlers()

  // 启动时异步拉取 LiteLLM 模型数据，完成后自动补充模型能力信息
  litellmService.init().then(() => {
    providerService.fillAllMissingCapabilities()
  }).catch(() => {})

  createWindow()

  app.on('activate', () => {
    // macOS dock 点击时重新创建窗口
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 应用退出前清理 Docker 容器
app.on('before-quit', () => {
  dockerManager.destroyAll().catch(() => {})
})

// macOS 下关闭窗口不退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
