import { useEffect } from 'react'
import { useChatStore } from '@shuvix/chat-ui'
import { useSettingsStore } from './stores/settingsStore'
import { useBrowserStore, CHAT_CONTAINER_ATTR } from './stores/browserStore'
import { useSidebarStore } from './stores/sidebarStore'
import { usePinChatStore } from './stores/pinChatStore'
import { Sidebar } from './components/sidebar/Sidebar'
import { SidebarResizeHandle } from './components/sidebar/SidebarResizeHandle'
import { ChatView } from './components/chat/ChatView'
import { PinnedChatShell } from './components/chat/PinnedChatShell'
import { WidgetWindowShell } from './components/widget/WidgetWindowShell'
import { RightPanel } from './components/browser/RightPanel'
import { BrowserResizeHandle } from './components/browser/BrowserResizeHandle'
import { BottomPanel } from './components/terminal/BottomPanel'
import { useBottomPanelStore } from './stores/bottomPanelStore'
import { SettingsPanel } from './components/settings/SettingsPanel'
import { useAppInit } from './hooks/useAppInit'
import { usePinChatSync } from './hooks/usePinChatSync'
import { ChatHostProvider } from '@shuvix/chat-ui'
import { ContextMenuProvider, type ContextMenuRenderer } from '@shuvix/app-shell'
import { useSettingsChatHost } from './host/settingsChatHost'
import { SessionRuntime } from './host/SessionRuntime'

/** 根据 URL hash 判断当前窗口类型 */
const isSettingsWindow = window.location.hash.startsWith('#settings')
const isPinnedWindow = window.location.hash.startsWith('#pinned-chat')
const isWidgetWindow = window.location.hash.startsWith('#widget-window')

/** 桌面原生右键菜单渲染器（Electron Menu.popup，于光标处弹出，故忽略 position） */
const nativeContextMenu: ContextMenuRenderer = async (items) =>
  (await window.api.contextMenu.popup({ items })).actionId

/**
 * 应用主入口
 * 根据 hash 区分四种渲染：
 * - 设置窗口（#settings）
 * - 悬浮聊天窗口（#pinned-chat）
 * - Widget 独立窗口（#widget-window）
 * - 主窗口（侧边栏 + 聊天区 + 浏览器面板）
 *
 * 核心流程由三个 hook 分别承担：
 * - useAppInit()         应用级初始化（设置、提供商、会话列表）
 * - useSessionInit()     会话级初始化（消息加载、Agent 创建、元信息同步）
 * - useAgentEvents()     Agent 流式事件分发
 */
function App(): React.JSX.Element {
  // 悬浮窗口由 PinnedChatShell 自己管初始化钩子，主流程跳出
  if (isPinnedWindow) {
    return <PinnedChatShell />
  }

  // Widget 独立窗口：仅加载设置的最小 shell，不进入主流程
  if (isWidgetWindow) {
    return <WidgetWindowShell />
  }

  return <MainOrSettings />
}

function MainOrSettings(): React.JSX.Element {
  const { activeSessionId } = useChatStore()
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()
  const isBrowserOpen = useBrowserStore((s) => s.isOpen)
  const lockedChatWidth = useBrowserStore((s) => s.lockedChatWidth)
  const isSidebarOpen = useSidebarStore((s) => s.isOpen)
  const sidebarWidth = useSidebarStore((s) => s.width)
  const isSidebarResizing = useSidebarStore((s) => s.isResizing)
  const pinnedSessionIds = usePinChatStore((s) => s.pinnedSessionIds)
  const isBottomOpen = useBottomPanelStore((s) => s.isOpen)

  // ========== 核心流程 hook ==========
  useAppInit()
  usePinChatSync()

  // 把宿主状态（外观 / 模型选择 / 语音）适配成 chat-ui 的注入值
  const chatHost = useSettingsChatHost()

  // ========== 外观 ==========

  /** 字体大小：设置 CSS 变量供全局使用 */
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}px`)
  }, [fontSize])

  /** 主题切换：根据 theme 模式 + darkTheme/lightTheme 设置 data-theme 属性 */
  useEffect(() => {
    const resolveThemeId = (mode: 'dark' | 'light'): string =>
      mode === 'dark' ? darkTheme : lightTheme

    const applyTheme = (mode: 'dark' | 'light'): void => {
      document.documentElement.setAttribute('data-theme', resolveThemeId(mode))
    }

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(mq.matches ? 'dark' : 'light')
      const handler = (e: MediaQueryListEvent): void => applyTheme(e.matches ? 'dark' : 'light')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      applyTheme(theme)
      return undefined
    }
  }, [theme, darkTheme, lightTheme])

  // ========== 渲染 ==========

  // 主窗口 ChatView 模式：当前 active session 正在悬浮 → 显示占位态
  const pinnedMode =
    activeSessionId && pinnedSessionIds.has(activeSessionId) ? 'placeholder' : undefined

  // 设置窗口：只渲染设置面板；主窗口：侧边栏 + 聊天区 + 预览面板
  const content = isSettingsWindow ? (
    <SettingsPanel />
  ) : (
    <div className="flex h-full bg-bg-primary">
      <div
        className={`flex-shrink-0 overflow-hidden ${isSidebarResizing ? '' : 'transition-[width] duration-200 ease-in-out'}`}
        style={{ width: isSidebarOpen ? sidebarWidth : 0 }}
      >
        <div className="h-full" style={{ width: sidebarWidth }}>
          <Sidebar />
        </div>
      </div>
      {isSidebarOpen && <SidebarResizeHandle />}
      {/* 聊天区列：上为聊天区，下为底部栏（终端）——不占右侧面板空间 */}
      <div
        {...{ [CHAT_CONTAINER_ATTR]: true }}
        className="flex flex-col min-w-[400px] bg-bg-primary"
        style={
          lockedChatWidth != null ? { width: lockedChatWidth, flexShrink: 0 } : { flex: '1 1 0%' }
        }
      >
        <div className="flex-1 min-h-0">
          <ChatView pinnedMode={pinnedMode} />
        </div>
        {isBottomOpen && <BottomPanel />}
      </div>
      {(isBrowserOpen || lockedChatWidth != null) && <BrowserResizeHandle />}
      {(isBrowserOpen || lockedChatWidth != null) && <RightPanel />}
    </div>
  )

  // 会话级初始化 + Agent 事件分发需在 ChatHostProvider 之下运行（useSessionInit/useAgentEvents 读注入值）
  return (
    <ChatHostProvider value={chatHost}>
      <SessionRuntime sessionId={activeSessionId} />
      <ContextMenuProvider render={nativeContextMenu}>{content}</ContextMenuProvider>
    </ChatHostProvider>
  )
}

export default App
