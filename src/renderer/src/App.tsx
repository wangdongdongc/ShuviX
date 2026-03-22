import { useEffect } from 'react'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { usePreviewStore, CHAT_CONTAINER_ATTR } from './stores/previewStore'
import { useSidebarStore } from './stores/sidebarStore'
import { Sidebar } from './components/sidebar/Sidebar'
import { SidebarResizeHandle } from './components/sidebar/SidebarResizeHandle'
import { ChatView } from './components/chat/ChatView'
import { PreviewPanel } from './components/preview/PreviewPanel'
import { PreviewResizeHandle } from './components/preview/PreviewResizeHandle'
import { SettingsPanel } from './components/settings/SettingsPanel'
import { useAppInit } from './hooks/useAppInit'
import { useSessionInit } from './hooks/useSessionInit'
import { useAgentEvents } from './hooks/useAgentEvents'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash.startsWith('#settings')

/**
 * 应用主入口
 * 根据 hash 区分：主窗口（侧边栏 + 聊天区）或设置窗口（独立设置页）
 *
 * 核心流程由三个 hook 分别承担：
 * - useAppInit()         应用级初始化（设置、提供商、会话列表）
 * - useSessionInit()     会话级初始化（消息加载、Agent 创建、元信息同步）
 * - useAgentEvents()     Agent 流式事件分发
 */
function App(): React.JSX.Element {
  const { activeSessionId } = useChatStore()
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()
  const isPreviewOpen = usePreviewStore((s) => s.isOpen)
  const lockedChatWidth = usePreviewStore((s) => s.lockedChatWidth)
  const isSidebarOpen = useSidebarStore((s) => s.isOpen)
  const sidebarWidth = useSidebarStore((s) => s.width)

  // ========== 核心流程 hook ==========
  useAppInit()
  useSessionInit(activeSessionId)
  useAgentEvents()

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

  // 主窗口：侧边栏 + 聊天区 + 预览面板
  return (
    <div className="flex h-full bg-bg-primary">
      <div
        className="flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out"
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
        <ChatView />
      </div>
      {(isPreviewOpen || lockedChatWidth != null) && <PreviewResizeHandle />}
      {(isPreviewOpen || lockedChatWidth != null) && <PreviewPanel />}
    </div>
  )
}

export default App
