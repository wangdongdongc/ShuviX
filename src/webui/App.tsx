import { useEffect } from 'react'
import { useChatStore } from '../renderer/src/stores/chatStore'
import { useSettingsStore } from '../renderer/src/stores/settingsStore'
import { useSessionInit } from '../renderer/src/hooks/useSessionInit'
import { useAgentEvents } from '../renderer/src/hooks/useAgentEvents'
import { ChatView } from '../renderer/src/components/chat/ChatView'
import { SESSION_ID } from './api'

/**
 * WebUI 根组件 — 单会话视图
 * 复用 renderer 的 ChatView，不含 Sidebar/Settings
 */
export default function WebApp(): React.JSX.Element {
  const { theme, fontSize } = useSettingsStore()

  // ─── 初始化：加载设置 + 设置当前 session ───
  useEffect(() => {
    const init = async (): Promise<void> => {
      // 加载设置（主题、字体等）
      const settings = await window.api.settings.getAll()
      useSettingsStore.getState().loadSettings(settings)

      // 加载 provider 列表（ModelPicker 需要）
      const [allProviders, availableModels] = await Promise.all([
        window.api.provider.listAll(),
        window.api.provider.listAvailableModels()
      ])
      useSettingsStore.getState().setProviders(allProviders)
      useSettingsStore.getState().setAvailableModels(availableModels)

      // 获取分享模式
      const shareModeResult = await window.api.webui.getShareMode(SESSION_ID)
      useChatStore.getState().setShareMode(shareModeResult)

      // 获取会话信息并设为活跃
      const sessionInfo = await window.api.session.getById(SESSION_ID)
      if (sessionInfo) {
        useChatStore.getState().setSessions([sessionInfo])
        useChatStore.getState().setActiveSessionId(SESSION_ID)
      }
    }
    init()
  }, [])

  // 复用 renderer 的会话初始化 + 事件分发
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  useSessionInit(activeSessionId)
  useAgentEvents()

  // ─── 外观 ───
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}px`)
  }, [fontSize])

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

  return (
    <div className="h-screen flex flex-col bg-bg-primary text-text-primary">
      <div className="flex-1 min-h-0">
        <ChatView />
      </div>
    </div>
  )
}
