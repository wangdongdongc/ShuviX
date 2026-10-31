// 启动诊断（Perf 时间线 + 主线程卡顿看门狗）必须是第一条 import：它在一切应用模块之前求值
import './utils/stallWatchdog/boot'
import {
  app,
  session,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell
} from 'electron'
import { join } from 'path'
import { homedir, userInfo } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { defineHandler, defineListener } from './ipc/registry'
import { attachIpcAdapter, webContentsOf, windowOf } from './ipc/ipcAdapter'
import { registerAppEventBridge } from './services/appEvents'
import { litellmService } from './services/litellmService'
import { providerService } from './services/providerService'
import { initI18n, t } from './i18n'
import { settingsDao } from './dao/settingsDao'
import { browserHistoryDao } from './dao/browserHistoryDao'
import { mcpService, setBuiltinMcpAgentResolver } from './services/mcpService'
import { chatFrontendRegistry, ElectronFrontend } from './frontend'
// 触发所有内置工具的 registerBuiltinTool() 副作用
// services / frontend 层消费注册表前必须由 main-entry 先注册
import './tools/allTools'
import { updateService } from './services/updateService'
import { destroyTerminalsByWindow } from './services/terminalService'
import { killAllBgTasks } from './services/bgTaskService'
import { initPinnedChatService, unpinAll as unpinAllPinnedChat } from './services/pinnedChatService'
import {
  focusSession,
  initNotificationService,
  notifyAskRaised,
  notifyAskResolved,
  setRunErrorTextSource
} from './services/notificationService'
import { sessionRecords } from './services/sessionRecords'
import { sessionRunErrorText, setSessionAskObserver } from './services/sessionSignals'
import { subSessionRunner } from './services/subSessionRunner'
import { initMarkdownWindowService, openMarkdownFile } from './services/markdownWindowService'
import { initPreviewWindowService } from './services/previewWindowService'
import { markdownFilesFromArgv } from './utils/markdownFiles'
import { loadRendererPage } from './utils/rendererPage'
import { appLogPath } from './services/appLogService'
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
  destroyBrowserWindow,
  setBrowserSessionHooks,
  setHistoryStore
} from './services/browser'
import {
  approveOpenExternalPermission,
  guardAppWindow,
  routeExternalUrl
} from './services/externalOpen'
import {
  setWidgetPreviewJudge,
  setWidgetThemeReader,
  widgetServer,
  widgetRuntime,
  widgetService
} from './services/widget'
import { installWidgetTokens } from './services/widget/widgetToken'
import { readSandboxLib, resolvePreviewFilePath } from './services/fileServing'
import { cliServer } from './services/cliServer'
import { SANDBOX_ENABLED_KEY, setSandboxSettingReader } from './services/sandbox'
import { sessionAcl, setAclSkillRoots } from './services/acl'
import { skillService } from './services/skillService'
import { mdMetaStore } from './services/mdMeta'
import { agentService } from './services/agentService'
import { chromeBridge } from './services/chromeBridge'
import { installChromeNativeHost } from './services/chromeExtensionService'
import { registerChromeFrontend } from './frontend/chrome'
import { networkService } from './frontend/network'
import { networkAdmissionOf } from './frontend/network/admissionMigration'
import { randomBytes } from 'crypto'
import { chromeBridgeAddressFile, chromeBridgeSocketPath } from '@shuvix/chat-protocol/chromeBridge'
import { closeAllWatchers } from './services/filesWatcherService'
import { hookService } from './services/hookService'
import { setWhenHostFunctions } from '@shuvix/agent-runtime'
import { activeSessionsOnDay } from './services/sessionDayPromptService'
import { builtinTimer } from './services/triggerTimer'
import { botTriggers } from './services/botTriggerService'
import { botService } from './services/botService'
import { settingsService } from './services/settingsService'
import i18next from 'i18next'
import { policyService } from './services/policyService'
import { desktopPolicyCheckDeps } from './services/policyCheckWiring'
import { runLegacySwitchover } from './services/legacySwitchover'
import { isReviewerIdentity, reviewPermissionRequest } from './services/permissionReview'
import {
  getDesktopNetworkSecurityContext,
  getDesktopSecurityContext,
  setCommandClassifier,
  setPermissionReviewer
} from './services/toolContext'
import { commandClassifier } from './services/commandClassifier'
import { installLlmNetwork } from './services/models'
import {
  installSessionHostQuitHook,
  peekSessionHost,
  sessionAgentResolver
} from './services/sessionHost'
import { desktopRedactionPolicy } from './services/redactionPolicy'
import { setRedactionPolicy } from './services/redactionPolicySeam'
import {
  registerCustomProtocolHandlers,
  registerCustomProtocolSchemes
} from './services/customProtocols'
import { applyNativeThemeSource } from './ipc/settingsHandlers'
import { createLogger } from './logger'
import { mark, measure, measureAsync, step } from './perf'
import { logLaunchTiming } from './utils/stallWatchdog/launchTiming'
import { installMasterKeyProtector } from './utils/crypto'
import { safeStorageProtector } from './utils/keyProtector'
import { simulateStartupStall } from './utils/stallWatchdog/simulate'
import { liveSingletonLockHolder } from './utils/stallWatchdog/singletonLock'
import {
  enableHeadlessMode,
  HEADLESS_SHUTTING_DOWN_LINE,
  HEADLESS_STOPPED_LINE,
  headlessArgsErrorLine,
  headlessBind,
  headlessDeprecationLine,
  headlessLan,
  headlessListenErrorLine,
  headlessPortOverride,
  headlessReadyLine,
  headlessUsage,
  isHeadless,
  parseHeadlessArgs,
  printHeadlessLine
} from './utils/headless'
import {
  readHeadlessAddress,
  removeHeadlessAddress,
  secondInstanceVerdict,
  writeHeadlessAddress
} from './utils/headlessInstance'
import { NETWORK_ADMISSION_POLICY, NETWORK_PORT_KEY, parseNetworkPort } from '../shared/network'
const log = createLogger('App')
mark('main: imports evaluated')

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
const isMac = process.platform === 'darwin'

/**
 * 无头运行（docs/headless/design.md §1）：`--headless` 或 `SHUVIX_HEADLESS=1`。一扇窗都不开（启动、Dock 重开、
 * 第二个实例、点通知、从系统打开的 md、菜单快捷键都不开），网络访问强制开着（端口：`--port`，否则设置里的，
 * 否则 7766；不写设置；谁能连由安全策略 network-admission 定，缺省只放这台电脑 —— 弃用的 `--lan` / `--bind`
 * 只在启动时迁移成那份策略），stdout 上打印就绪 / 出错 / 退出那几行。`--help` 打印用法后退出。
 *
 * 必须在单实例锁之前：`--help` 不该去敲正在跑的那个实例，Linux 的 Ozone 开关也得在 ready 之前加上。
 */
const headlessArgs = parseHeadlessArgs(process.argv, process.env)
if (headlessArgs.help) {
  printHeadlessLine(headlessUsage())
  app.exit(0)
} else if (headlessArgs.headless && headlessArgs.error !== undefined) {
  printHeadlessLine(headlessArgsErrorLine(headlessArgs.error))
  app.exit(2)
} else if (headlessArgs.headless) {
  enableHeadlessMode({ port: headlessArgs.port, lan: headlessArgs.lan, bind: headlessArgs.bind })
  const deprecation = headlessDeprecationLine(headlessArgs)
  if (deprecation) printHeadlessLine(deprecation)
  // macOS：不要 Dock 图标（ready 之后再藏一次，见下）
  if (isMac) app.dock?.hide()
  if (process.platform === 'linux') {
    // 没有显示服务器的 Linux：Chromium 要 Ozone 的 headless 平台才起得来。启动脚本（systemd 服务、
    // shuvix-server）在真正的命令行上带着 `--ozone-platform=headless --disable-gpu`，那是有保证的一条路；
    // 这里再补一次，好让直接敲 `shuvix --headless` 也有机会起来（够不够早要看 Electron 版本）
    app.commandLine.appendSwitch('ozone-platform', 'headless')
    app.disableHardwareAcceleration()
  }
  // 主进程未捕获的异常：Electron 缺省弹一个原生框 —— 没有屏幕的服务器上没人点得掉。记日志，照常跑下去
  process.on('uncaughtException', (error) => {
    log.error(
      `uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : error}`
    )
  })
  log.info(
    `无头运行（headless）：端口 ${headlessArgs.port ?? '取设置'}，谁能连由策略 network-admission 定` +
      `${headlessArgs.bind !== undefined ? `（弃用的 --bind ${headlessArgs.bind}）` : headlessArgs.lan ? '（弃用的 --lan）' : ''}，pid ${process.pid}，不开任何窗口`
  )
}

/** 无头运行时这次退出的退出码（启动时监听不了 → 1）；`quit` 事件里交给 `app.exit` */
let headlessExitCode = 0

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

/** 把主窗口带到眼前：没开过 / 已关掉就现开一个（无头运行时什么也不做 —— createWindow 自己拦） */
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
      const dark = step('nativeTheme.shouldUseDarkColors', () => nativeTheme.shouldUseDarkColors)
      const resolved = dark ? 'dark' : 'light'
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
      const displays = step('screen.getAllDisplays', () => screen.getAllDisplays())
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
  if (isHeadless()) {
    log.info('无头运行：不开设置窗口')
    return
  }
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
  loadRendererPage(settingsWindow, hash)

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
        },
        // Windows / Linux 没有应用菜单：设置放在文件菜单里（菜单栏默认隐藏，看得见的入口是侧栏底部那一行）
        ...(!isMac
          ? [
              { type: 'separator' as const },
              {
                label: `${t('settings.title')}…`,
                accelerator: 'CommandOrControl+,',
                click: () => openSettingsWindow()
              }
            ]
          : [])
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
      : []),
    // 帮助菜单：用户被问「日志在哪」时的去处（设置 → 关于 也有同一个入口）
    {
      role: 'help',
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.showLogFile'),
          click: () => shell.showItemInFolder(appLogPath())
        }
      ]
    }
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
      const displays = step('screen.getAllDisplays', () => screen.getAllDisplays())
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
  step('windowServices › notifications', () =>
    initNotificationService({
      getMainWindow: () => mainWindow,
      ensureMainWindow: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow()
      }
    })
  )
  // 询问不再是 ChatEvent（P3-08）：会话信号接线把询问的挂起 / 落定交给通知；失败通知的正文从投影读。
  // 同一对钩子也告诉子会话运行器：父会话发起的那一轮停下来问了，它的绑定任务进出「等待输入」（§19.3）
  // 两路各自隔离：一路抛错不拦另一路
  const eachSafely = (...calls: Array<() => void>): void => {
    for (const call of calls) {
      try {
        call()
      } catch (error) {
        log.warn(`询问钩子失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  setSessionAskObserver({
    askRaised: (sessionId, request) =>
      eachSafely(
        () => notifyAskRaised(sessionId, request),
        () => subSessionRunner.onAskRaised(sessionId, request)
      ),
    askResolved: (sessionId, requestId) =>
      eachSafely(
        () => notifyAskResolved(sessionId, requestId),
        () => subSessionRunner.onAskResolved(sessionId, requestId)
      )
  })
  setRunErrorTextSource(sessionRunErrorText)

  // 初始化 widget 独立窗口服务（owns widget app 窗口）
  step('windowServices › widget', () => initWidgetWindowService({ getThemeBgColor }))

  // 初始化内置浏览器 partition 的权限策略（独立于 defaultSession，默认拒绝所有权限请求）
  step('windowServices › browserSession', () => initBrowserSession())
  // 浏览器窗口上的会话名（标签悬停、「〈会话〉正在使用此页面」）与「查看对话」
  setBrowserSessionHooks({
    sessionTitle: (id) => sessionRecords.pick(id, ['title'])?.title ?? '',
    openSession: (id) => {
      if (!sessionRecords.findById(id)) return false
      focusSession(id)
      return true
    }
  })
  // 浏览器的历史记录落盘处（browser_history_* 两张表）
  setHistoryStore(browserHistoryDao)
  // 浏览器是独立窗口（懒创建）：只在用户点开时才建，关窗只隐藏；agent 的 tab 住在停放窗口里
  step('windowServices › browserWindow', () => initBrowserWindowService({ getThemeBgColor }))

  // 从系统打开的 md 窗口：每个窗口一条内存会话，前端按窗口单独绑定（id 各不相同）
  step('windowServices › markdown', () =>
    initMarkdownWindowService({
      getThemeBgColor,
      getZoomFactor: getStartupZoomFactor,
      createFrontend: (window, id) => new ElectronFrontend(window, id)
    })
  )
  // 应用内点开的文件：md 进上面的协作编辑窗口，其余可预览的进只读预览窗口（不建会话）
  step('windowServices › preview', () =>
    initPreviewWindowService({ getThemeBgColor, getZoomFactor: getStartupZoomFactor })
  )
}

function createWindow(): void {
  // 无头运行：一扇窗都不开 —— Dock 重开、第二个实例、点通知、菜单都汇到这里
  if (isHeadless()) {
    log.info('无头运行：不开主窗口')
    return
  }
  // 退出半途没了、应用照常跑下去（Dock 重开 / 第二个实例 / 点通知）：会话宿主若已被退出封存，撤销 ——
  // 否则这个新主窗口里每条会话都只剩配置、一条消息都没有。正常启动与普通的关窗再开都是无操作
  sessionHostQuit.resume()
  const bounds = step('createWindow › bounds', () => getSavedWindowBounds())
  const backgroundColor = step('createWindow › theme color', () => getThemeBgColor())
  simulateStartupStall('createWindow')

  mainWindow = step('createWindow › new BrowserWindow', () =>
    newMainWindow(bounds, backgroundColor)
  )
  const win = mainWindow

  // 注册 Electron 主窗口为默认前端
  step('createWindow › default frontend', () =>
    chatFrontendRegistry.registerDefault(new ElectronFrontend(win))
  )

  // 初始化悬浮聊天服务（owns 悬浮窗 + pin 状态）
  // 由 main-entry 注入 ElectronFrontend 工厂，避免 service 层反向依赖 frontend-impl
  step('createWindow › pinned chat', () =>
    initPinnedChatService({
      mainWindow: win,
      getThemeBgColor,
      createFrontend: (window) => new ElectronFrontend(window, 'electron-pinned')
    })
  )

  step('createWindow › shared window services', () => initSharedWindowServices())

  // 弹窗与页面内导航（点 <a href>、PDF 里的链接、预览 iframe 里的脚本）都不自己走：
  // 阻止应用变成浏览器，去向交给 externalOpen 那道闸（http(s) → 系统浏览器）
  step('createWindow › guard', () => guardAppWindow(win))

  step('createWindow › listeners', () => attachMainWindowListeners(win))

  // 开发环境加载 HMR URL（失败会重试），生产环境加载本地文件
  step('createWindow › load page', () => loadRendererPage(win))
}

function newMainWindow(
  bounds: ReturnType<typeof getSavedWindowBounds>,
  backgroundColor: string
): BrowserWindow {
  return new BrowserWindow({
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
    backgroundColor,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
}

/** 主窗口的关闭清理与尺寸保存 */
function attachMainWindowListeners(win: BrowserWindow): void {
  // 关闭前清理该窗口关联的终端实例 + 释放 browserOffset 跟踪
  const mainWebContentsId = win.webContents.id
  const thisWindow = win
  win.on('close', () => {
    destroyTerminalsByWindow(mainWebContentsId)
    void unpinAllPinnedChat('window-closed')
    closeAllWidgetWindows()
    // 销毁而非隐藏：隐藏的窗口会让 window-all-closed / Dock 重建主窗口都失灵（tab 留着）
    closeBrowserWindowWithMain()
  })
  win.on('closed', () => {
    clearBrowserOffset(mainWebContentsId)
    // macOS 关掉主窗口应用仍在跑：别让变量留着一个已销毁的窗口 —— 之后别的窗口（md 窗口、widget）
    // 发来的 window-ready、菜单的「新建会话」一碰它的 webContents 就是 "Object has been destroyed"
    if (mainWindow === thisWindow) mainWindow = null
  })

  // 关闭前保存窗口位置和尺寸
  win.on('close', () => {
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
}

// 通道注册表挂到 ipcMain 上（ipc/ipcAdapter，唯一碰 ipcMain 的地方）：之后每条 defineHandler / defineListener
// 随定义随注册 —— 下面这几条 app:* 因此照旧在模块求值时注册，registerIpcHandlers() 里那批照旧在 ready 时
attachIpcAdapter()

// 获取应用版本号
defineHandler('app:version', () => {
  return app.getVersion()
})

// React 挂载完成后显示对应窗口（同时应用已保存的 UI 缩放）
defineListener('app:window-ready', (ctx) => {
  const sender = webContentsOf(ctx)
  if (!sender) return
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
// 网络客户端（浏览器）不走到这里（通道表的 DESKTOP_ONLY_CHANNELS，web 客户端在新标签页里开 #settings）；
// 万一走到了也不在这台电脑上开窗
defineHandler('app:open-settings', (ctx, tab?: string) => {
  if (ctx.client.kind !== 'window') return { success: false }
  openSettingsWindow(tab)
  return { success: true }
})

// 渲染进程要打开的外链（聊天 / 笔记本里的链接、面板的「在系统浏览器打开」、验证页…）。
// 调用方是自己人，但地址多半来自内容（模型写的 md、面板里那个 tab 的地址），所以照样过闸；
// 用户是亲手点的，询问因此不设静默期（byUser）。回 success=false 表示没交给系统。
defineHandler('app:open-external', async (ctx, url: string) => {
  // 网络客户端（浏览器）的链接该在它自己那边开（web 客户端本地实现）：不替它在这台电脑上开浏览器
  if (ctx.client.kind !== 'window') return { success: false }
  const success = await routeExternalUrl(url, {
    parent: windowOf(ctx),
    byUser: true
  })
  return { success }
})

// 用系统文件管理器打开指定文件夹
defineHandler('app:open-folder', async (_ctx, folderPath: string) => {
  const { shell } = await import('electron')
  await shell.openPath(folderPath)
  return { success: true }
})

// 在系统文件管理器中定位并选中指定文件（openPath 对压缩包等于直接解压/打开，故用 showItemInFolder）
defineHandler('app:reveal-path', async (_ctx, filePath: string) => {
  const { shell } = await import('electron')
  shell.showItemInFolder(filePath)
  return { success: true }
})

// 调整调用方窗口的宽度（delta 为 CSS 像素，按窗口自身 zoom factor 换算）
// 主窗口最小宽度 800，悬浮窗最小宽度 320（保留各自创建时的 minWidth）
defineHandler('app:adjust-window-width', (ctx, delta: number) => {
  const win = windowOf(ctx)
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
defineHandler('app:set-browser-offset', (ctx, offset: number) => {
  const win = windowOf(ctx)
  if (!win || win.isDestroyed()) return
  setBrowserOffset(win.webContents.id, offset)
})

// 单实例锁：阻止第二个进程启动，避免并发访问数据库。
// 锁若被一个还活着的进程拿着（多半是上一次的 ShuviX 还在退出），加锁会在这里同步等它 —— 先记一笔
const lockHolder = liveSingletonLockHolder(app.getPath('userData'))
if (lockHolder) {
  log.warn(
    `single-instance lock is held by live pid ${lockHolder.pid} (${lockHolder.host}): ` +
      'a previous ShuviX is still running or quitting; requestSingleInstanceLock waits on it'
  )
}
// 要无头运行的第二个实例把这一点交过去（additionalData）：跑着的桌面应用据此不开窗
const gotTheLock = step('requestSingleInstanceLock', () =>
  app.requestSingleInstanceLock(headlessArgs.headless ? { shuvixHeadless: true } : undefined)
)
if (!gotTheLock) {
  // 跑着的若是无头实例：打印它的地址、退出码 0（带不带 --headless 都一样，无头进程里不开窗）；
  // 跑着的是桌面应用而这里要无头：说一句、退出码 1；都不是：照旧把 argv 交给桌面应用（它带出主窗口）
  const verdict = secondInstanceVerdict({
    wantsHeadless: headlessArgs.headless,
    address: readHeadlessAddress(app.getPath('userData')),
    lockHolderPid: lockHolder?.pid
  })
  if (verdict.line !== undefined) {
    log.info(`另一个 ShuviX 实例已在运行：${verdict.line}`)
    printHeadlessLine(verdict.line)
    app.exit(verdict.exitCode)
  } else {
    log.info('另一个 ShuviX 实例已在运行（单实例锁未获取），本进程退出')
    app.quit()
  }
} else {
  // 无头实例：拿到锁就写地址文件（第二个实例读它；开始监听后补上地址，退出时删掉）
  if (isHeadless()) writeHeadlessAddress(app.getPath('userData'), { pid: process.pid, urls: [] })

  // 第二个实例：Windows / Linux 上「用 ShuviX 打开」一个 md，文件在它的 argv 里 —— 在这里开 md 窗口；
  // 什么文件都没带（再点一次应用图标）才是要主窗口，没开过（从 md 启动的）就现开一个
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    // 无头运行：不开窗（第二个进程自己打印这边的地址后退出）
    if (isHeadless()) {
      log.info('第二个实例启动：无头运行，忽略（它自己打印地址后退出）')
      return
    }
    // 第二个进程要无头运行而这里是桌面应用：它自己说一句后退出，这边不弹主窗口
    if ((additionalData as { shuvixHeadless?: unknown } | null)?.shuvixHeadless === true) {
      log.info('第二个实例要无头运行，而这里是桌面应用：忽略')
      return
    }
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
    if (isHeadless()) {
      log.info(`无头运行：不开窗，忽略要打开的文件 ${path}`)
      return
    }
    if (windowIntakeReady) openMarkdownFile(path)
    else launchMarkdownFiles.push(path)
  })
}

// 自定义协议 scheme 注册必须早于 app.whenReady
step('registerCustomProtocolSchemes', () => registerCustomProtocolSchemes())

// 被遮挡的窗口照常合成。内置浏览器的 tab 常常出生在不可见的地方 —— 停放窗口从不显示，
// 浏览器窗口可能被主窗口盖住、被关掉（隐藏）、最小化、在别的桌面，屏幕也可能锁着。
// 没有这个开关，这些状态下新出生（或跨站导航后）的 view 拿不到第一帧：截图报
// "Current display surface not available"、agent 的鼠标点击不落地（2026-09-23 实测）。
// 代价：被遮挡的窗口不再停止渲染（主窗口被盖住时动画照跑）。e2e harness 本来就带着它启动。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// 全局 fetch 包装：只作用于 LLM 请求（作用域外原样透传），放宽 undici 默认的
// 300s 传输超时并记录 fetch 失败的成因链。必须早于任何 agent 跑起来。
step('installLlmNetwork', () => installLlmNetwork())

app.whenReady().then(async () => {
  mark('app.whenReady')
  logLaunchTiming()
  // 必须与 electron-builder.yml 的 appId 一致，否则 Windows 任务栏中
  // 运行中的窗口无法与固定（pinned）的快捷方式归为一组，会显示成两个图标
  electronApp.setAppUserModelId('com.shuvix.app')

  // 本地密文的 v2 密钥由系统钥匙环保护（utils/crypto.ts）；safeStorage 要在 ready 之后才能用，
  // 所以尽早装上 —— 在那之前写入的密文用 v1，同样能解
  step('master key protector', () => installMasterKeyProtector(safeStorageProtector))

  // shuvix-media:// + shuvix-preview://
  step('registerCustomProtocolHandlers', () => registerCustomProtocolHandlers())

  // 主窗口（自有页面）的权限请求一律放行。
  // 例外是 `openExternal` —— 它不是「页面要用某个能力」，而是页面导航到非网页协议、Electron 在问
  // 要不要把这个地址交给操作系统（准了由它自己交，不经 shell.openExternal）。那一档走同一道闸。
  // 注意：内置浏览器跑在独立 partition（BROWSER_PARTITION），权限策略由 initBrowserSession() 单独管理。
  // widget 路由的令牌：widget 页面（独立窗口、面板里的 iframe 都在默认会话里）的请求由主进程补上那个 widget 的
  // 令牌，沙箱里的命令 curl 过去拿不到（见 services/widget/widgetToken.ts）
  step('widget tokens', () =>
    installWidgetTokens(session.defaultSession, () => widgetServer.getStatus().port)
  )

  step('defaultSession permission handler', () =>
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        if (permission === 'openExternal' && 'externalURL' in details) {
          void approveOpenExternalPermission(webContents, details).then(callback)
          return
        }
        callback(true)
      }
    )
  )

  // 无头运行：没有 Dock 图标（入口那次之外再藏一次：ready 之前那次不是每个版本都算数）
  if (isHeadless() && process.platform === 'darwin') app.dock?.hide()

  // 设置应用图标（开发模式下 Dock/任务栏也显示自定义图标）
  step('dock icon', () => {
    if (isHeadless()) return
    const iconPath = join(app.getAppPath(), 'resources/icon.png')
    const appIcon = nativeImage.createFromPath(iconPath)
    if (process.platform === 'darwin' && app.dock && !appIcon.isEmpty()) {
      app.dock.setIcon(appIcon)
    }
  })

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

  // 无头运行没有窗口，菜单（与它的快捷键）没有用处
  if (!isHeadless()) measure('setupMenu', () => setupApplicationMenu())

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 注册所有 IPC 处理器
  measure('registerIPC', () => registerIpcHandlers())

  // 装配 hook runner（业务埋点在此之前的 fire 静默丢弃）
  measure('hookService.init', () => hookService.init())
  // 触发绑定的 CEL `when` 能查日历（hook 与 bot 共用）；内置 timer 每分钟发一次全局埋点 `timer.fired`，
  // 订阅它的 bot 绑定命中就新开一条会话（实验）。退出一开始就停表，关停中的会话不再被叫起来
  setWhenHostFunctions({ activeSessions: activeSessionsOnDay })
  // 随应用提供的 bot（日报 bot）第一次启动时按界面语言写进 ~/.shuvix/bots（每个只写一次，删了不再补）；
  // 内置 id 的认定记在设置库里（只认 ShuviX 自己写下的那份文件）
  botService.setBuiltinTrustStore(settingsService)
  step('botService.seedBuiltinBots', () => botService.seedBuiltinBots(i18next.language || 'en'))
  step('builtinTimer.start', () =>
    builtinTimer.start((payload) => botTriggers.fire('timer.fired', payload))
  )
  app.on('before-quit', () => builtinTimer.stop())
  // 询问点的自动审查：安全模块的 onPermissionRequest 经判定型 hook 回答（注入而非 import —— 见 toolContext）
  setPermissionReviewer(reviewPermissionRequest, isReviewerIdentity)
  // 组件删掉了：各会话权限表里授权用它的行一并删掉（复用同一个 id 的新组件不继承旧授权）
  widgetService.onDeleted((widgetId) => sessionAcl.deleteWidget(widgetId))
  // 组件预览页面的请求按发起预览的会话判：只判不问（预览窗口没人看着），同 judgeGate
  setWidgetPreviewJudge({
    widget: (sessionId, access, widgetId, operation) =>
      getDesktopSecurityContext({ sessionId }).judgeGate(access, {
        type: 'widget',
        widgetId,
        name: '',
        operation
      }).allowed,
    readPath: (sessionId, path) =>
      getDesktopSecurityContext({ sessionId }).judgeGate('read', {
        type: 'path',
        path,
        displayPath: path
      }).allowed
  })
  // 组件页面跟应用的主题走：页面骨架与 SSE theme 事件读这三个设置（注入 —— 组件模块不引 dao）
  setWidgetThemeReader(() => ({
    mode: settingsDao.findByKey('general.theme'),
    light: settingsDao.findByKey('general.lightTheme'),
    dark: settingsDao.findByKey('general.darkTheme')
  }))
  // 命令风险分类：同样注入（它要模型注册表）；每次分类记一行分类器日志
  // 自动脱敏出口的策略判定：同样注入（它要安全模块）
  setRedactionPolicy(desktopRedactionPolicy)
  // 分类器在会话之外直接调模型：交给它之前，命令里的敏感内容换成占位符（自动脱敏；它判风险用不着真值）
  setCommandClassifier(async (input, opts) => {
    const redaction = opts?.sessionId
      ? peekSessionHost()?.get(opts.sessionId)?.redaction
      : undefined
    const command = redaction ? await redaction.maskText(input.command) : input.command
    return commandClassifier.classify({ ...input, command }, opts)
  })
  // 内置 MCP 服务器按 `_meta` 里的对话认调用方（安全主体）：同样注入而非 import（见 mcpService）
  step('builtin MCP agent resolver', () => setBuiltinMcpAgentResolver(sessionAgentResolver()))

  // 内部事件总线 → 所有窗口的 'app:event' 桥接（AppEvent 通用订阅）
  step('appEventBridge', () => registerAppEventBridge())

  // 初始化自动更新服务（绑定 electron-updater 事件）
  step('updateService.init', () => updateService.init())

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

  // 命令沙箱读开关的口子：模块本身不碰设置表（它在很多导入链上），由这里注入。
  // 没注入就是关闭 —— 只有真正起来的应用才套沙箱
  setSandboxSettingReader(() => settingsDao.findByKey(SANDBOX_ENABLED_KEY))
  // 会话权限表的技能目录行（acl 是独立模块，不反向依赖 skillService）
  setAclSkillRoots(() => skillService.enabledSkillRoots())
  // md 扩展元数据：agent 档案的补缺值（模型 / 思考档位）读自 md_attrs 的内存快照。agentService 不直接依赖
  // 数据库（单测里没有库），由这里注入读口 —— 没注入就没有补缺，档案就是文件本身
  agentService.setMetaFill((objectId) => mdMetaStore.fillFor(objectId, 'agent'))
  // 内置安全策略 / hook 的停用开关：同一份快照，同样注入（两个服务都不直接依赖数据库）
  policyService.setDisabledReader((objectId) => mdMetaStore.isDisabled(objectId))
  hookService.setDisabledReader((objectId) => mdMetaStore.isDisabled(objectId))

  // 旧格式会话的启动切换（services/legacySwitchover）：绑着文件的原地重置、Chrome 标签页会话删掉。
  // 必须 await 完、排在 CLI 服务 / Chrome 桥 / 任何窗口之前 —— 否则 shuvix-cli、侧边栏或界面可能在
  // 切换途中碰到这些会话（订阅一条马上就不再是旧格式的会话）。它从不 reject，启动不会因此中止
  await runLegacySwitchover()

  // 启动 CLI IPC 服务 —— 给 shuvix-cli 提供 Unix socket / named pipe
  cliServer.setPolicyCheckDeps(() => desktopPolicyCheckDeps(() => networkService.status()))
  step('cliServer.start', () =>
    cliServer.start().catch((err) => {
      log.error(`cliServer.start failed: ${err}`)
    })
  )

  // Chrome 扩展：桥服务（本地组件连进来）+ 每次启动重写原生消息宿主的启动脚本与各浏览器的清单。
  // token 与 CLI 共用 —— cliServer.start 同步生成，此刻已经在了
  step('registerChromeFrontend', () => registerChromeFrontend())
  step('chromeBridge.start', () =>
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
  )
  step('installChromeNativeHost', () => void installChromeNativeHost())

  // 网络访问（局域网里的浏览器，server mode phase B）：缺省关，设置里开着才监听。与 CLI / Chrome 桥一样排在
  // 旧格式切换之后（浏览器里的界面同样可能碰到那些会话）；监听失败只记进状态（设置页显示原因），不拦启动。
  // phase D：文件路由（自定义协议的 HTTP 等价物）与 widget 转发的依赖在这里交进去。
  // 无头运行：强制开着（端口：--port，否则设置里的，否则 7766；不写设置；谁能连由策略 network-admission 定，
  // 弃用的 --lan / --bind 在 init 时迁移成那份策略），开始监听后打印就绪那一行。
  // 安全策略那一侧（2026-10-19，docs/network-policy/design.md）：网络主体的 SecurityContext、准入策略的状态、
  // 定时核策略目录、迁移旧的局域网共享设置都在这里交进去
  if (isHeadless()) {
    networkService.setHeadless({
      port: headlessPortOverride() ?? parseNetworkPort(settingsDao.findByKey(NETWORK_PORT_KEY)),
      lan: headlessLan(),
      bind: headlessBind()
    })
  }
  const networkReady = step('networkService.init', () =>
    networkService.init({
      fileRoutes: {
        resolvePreviewPath: resolvePreviewFilePath,
        readSandboxLib,
        logger: { warn: (message) => log.warn(message) }
      },
      widgetProxy: {
        target: () => {
          const status = widgetServer.getStatus()
          return status.running && status.port > 0
            ? { host: '127.0.0.1', port: status.port }
            : undefined
        },
        logger: { warn: (message) => log.warn(message) }
      },
      security: {
        contextFor: getDesktopNetworkSecurityContext,
        admission: () => networkAdmissionOf(policyService.listForSettings()),
        refreshPolicies: () => void policyService.refresh(),
        hasUserAdmission: () =>
          policyService
            .listForSettings()
            .some((row) => row.source === 'user' && row.name === NETWORK_ADMISSION_POLICY),
        createPolicy: (text) => policyService.createPolicy(text)
      }
    })
  )
  if (isHeadless()) void networkReady.then(announceHeadlessNetwork)

  // 带着 md 文件启动：只开 md 窗口，主窗口等用户要（点 Dock / 再点一次应用图标）才开。
  // 无头运行：窗口服务照样装配（通知中心、内置浏览器的 partition …），但一扇窗都不开
  step('initSharedWindowServices', () => initSharedWindowServices())
  windowIntakeReady = true
  if (isHeadless()) {
    const ignored = launchMarkdownFiles.splice(0)
    if (ignored.length > 0) log.info(`无头运行：不开窗，忽略 ${ignored.length} 个要打开的 md 文件`)
  } else {
    let openedAtLaunch = 0
    for (const file of launchMarkdownFiles.splice(0)) {
      if (step('open launch md file', () => openMarkdownFile(file))) openedAtLaunch++
    }
    if (openedAtLaunch > 0) {
      log.info(`从系统打开 ${openedAtLaunch} 个 md 文件，不开主窗口`)
    } else {
      measure('createWindow', () => createWindow())
    }
  }
  // ready 之前第二个实例交来的请求：照做，但不影响上面这次启动开不开主窗口
  for (const file of earlySecondInstance.files.splice(0)) openMarkdownFile(file)
  if (earlySecondInstance.wantsMainWindow) showMainWindow()
  mark('startup: ready handler done')

  app.on('activate', () => {
    // macOS dock 点击时重新创建主窗口。按主窗口本身判断，不按「一个窗口都没有」：
    // 浏览器的停放窗口从不显示却一直在（主窗口关着时后台 agent 仍可能在用浏览器）。
    // 无头运行不开窗（`open -a ShuviX` 也会走到这里）
    if (isHeadless()) return
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  })
})

// 应用退出：先关停所有打开着的会话（每会话一个 durable Harness；第一次 before-quit 被拦下，
// closeAll 最多等 5 秒，再在下一个任务里重新 quit）。正忙的会话被关停时不改运行标记，下次打开报
// interrupted。其余清理由钩子在被放行的那次 before-quit 里跑一次（会话都关完之后 —— 关停中的 run
// 还可能在用 MCP / 后台任务 / 浏览器）
const sessionHostQuit = installSessionHostQuitHook(app, {
  teardown: () => {
    destroyBrowserWindow()
    destroyAllTabs()
    killAllBgTasks()
    mcpService.disconnectAll().catch(() => {})
    widgetServer.dispose()
    widgetRuntime.dispose()
    chromeBridge.stop()
    void networkService.shutdown()
    cliServer.stop()
    disposePglite()
    closeAllWatchers()
  }
})

// macOS 下关闭窗口不退出应用。无头运行本来就没有窗口：内置浏览器的停放窗口收掉时也不该把应用带走
app.on('window-all-closed', () => {
  if (isHeadless()) return
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * 无头运行：网络服务第一次对完账 —— 在监听就打印就绪那一行（地址与设置页列出的同一份）并补进地址文件；
 * 监听不了（端口被占 …）就打印原因、以退出码 1 退出（systemd 据此记一次失败）
 */
function announceHeadlessNetwork(): void {
  const status = networkService.status()
  if (status.listening) {
    printHeadlessLine(headlessReadyLine(status.addresses))
    writeHeadlessAddress(app.getPath('userData'), {
      pid: process.pid,
      port: status.port,
      urls: status.addresses
    })
    log.info(`无头运行：就绪，端口 ${status.port}`)
    return
  }
  const line = headlessListenErrorLine(status.port, status.error ?? 'not listening')
  log.error(line)
  printHeadlessLine(line)
  headlessExitCode = 1
  app.quit()
}

// 无头运行的退出：开始退出时一行（信号也走这里 —— Electron 把 SIGINT / SIGTERM 变成一次正常的 quit，
// 第二个信号走系统缺省直接结束），退出流程走完一行；地址文件删掉；启动失败的退出码在这里交出去
if (isHeadless()) {
  let shuttingDown = false
  app.on('before-quit', () => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('无头运行：开始退出')
    printHeadlessLine(HEADLESS_SHUTTING_DOWN_LINE)
  })
  app.on('quit', () => {
    removeHeadlessAddress(app.getPath('userData'), process.pid)
    printHeadlessLine(HEADLESS_STOPPED_LINE)
    if (headlessExitCode !== 0) app.exit(headlessExitCode)
  })
}

// 主入口求值完毕：此后到 app.whenReady 之间是 Chromium / macOS 自己的启动（不在 JS 里），
// 卡在那段时看门狗报的位置就是「after "main: entry evaluated…"」
simulateStartupStall('preReady')
mark('main: entry evaluated, waiting for ready')
