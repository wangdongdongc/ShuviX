import { useEffect } from 'react'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { useBrowserStore, CHAT_CONTAINER_ATTR } from './stores/browserStore'
import { useSidebarStore } from './stores/sidebarStore'
import { usePinChatStore } from './stores/pinChatStore'
import { Sidebar } from './components/sidebar/Sidebar'
import { SidebarResizeHandle } from './components/sidebar/SidebarResizeHandle'
import { ChatView } from './components/chat/ChatView'
import { PinnedChatShell } from './components/chat/PinnedChatShell'
import { RightPanel } from './components/browser/RightPanel'
import { BrowserResizeHandle } from './components/browser/BrowserResizeHandle'
import { SettingsPanel } from './components/settings/SettingsPanel'
import { useAppInit } from './hooks/useAppInit'
import { useSessionInit } from './hooks/useSessionInit'
import { useAgentEvents } from './hooks/useAgentEvents'
import { usePinChatSync } from './hooks/usePinChatSync'

/** 根据 URL hash 判断当前窗口类型 */
const isSettingsWindow = window.location.hash.startsWith('#settings')
const isPinnedWindow = window.location.hash.startsWith('#pinned-chat')

/**
 * 应用主入口
 * 根据 hash 区分三种渲染：
 * - 设置窗口（#settings）
 * - 悬浮聊天窗口（#pinned-chat）
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

  // ========== 核心流程 hook ==========
  useAppInit()
  useSessionInit(activeSessionId)
  useAgentEvents()
  usePinChatSync()

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

  // 设置窗口：只渲染设置面板
  if (isSettingsWindow) {
    return <SettingsPanel />
  }

  // 主窗口 ChatView 模式：当前 active session 正在悬浮 → 显示占位态
  const pinnedMode =
    activeSessionId && pinnedSessionIds.has(activeSessionId) ? 'placeholder' : undefined

  // 主窗口：侧边栏 + 聊天区 + 预览面板
  return (
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
      <div
        {...{ [CHAT_CONTAINER_ATTR]: true }}
        className="min-w-[400px] bg-bg-primary"
        style={
          lockedChatWidth != null ? { width: lockedChatWidth, flexShrink: 0 } : { flex: '1 1 0%' }
        }
      >
        <ChatView pinnedMode={pinnedMode} />
      </div>
      {(isBrowserOpen || lockedChatWidth != null) && <BrowserResizeHandle />}
      {(isBrowserOpen || lockedChatWidth != null) && <RightPanel />}
    </div>
  )
}

export default App
