import { useEffect } from 'react'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { Sidebar } from './components/sidebar/Sidebar'
import { ChatView } from './components/chat/ChatView'
import { SettingsPanel } from './components/settings/SettingsPanel'
import { useAppInit } from './hooks/useAppInit'
import { useSessionInit } from './hooks/useSessionInit'
import { useAgentEvents } from './hooks/useAgentEvents'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash === '#settings'

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
  const { theme, fontSize } = useSettingsStore()

  // ========== 核心流程 hook ==========
  useAppInit()
  useSessionInit(activeSessionId)
  useAgentEvents()

  // ========== 外观 ==========

  /** 字体大小：设置 CSS 变量供全局使用 */
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}px`)
  }, [fontSize])

  /** 主题切换：根据 theme 状态设置 data-theme 属性 */
  useEffect(() => {
    const applyTheme = (resolved: 'dark' | 'light'): void => {
      document.documentElement.setAttribute('data-theme', resolved)
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
  }, [theme])

  // ========== 渲染 ==========

  // 设置窗口：只渲染设置面板
  if (isSettingsWindow) {
    return <SettingsPanel />
  }

  // 主窗口：侧边栏 + 聊天区
  return (
    <div className="flex h-full">
      <div className="w-[240px] flex-shrink-0">
        <Sidebar />
      </div>
      <div className="flex-1 min-w-0 bg-bg-primary">
        <ChatView />
      </div>
    </div>
  )
}

export default App
