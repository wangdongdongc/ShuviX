import { useEffect } from 'react'
import { useChatStore, getSessionChannelApi } from '@shuvix/chat-ui'
import { useSettingsStore } from '../renderer/src/stores/settingsStore'
import { ChatHostProvider } from '@shuvix/chat-ui'
import { useSettingsChatHost } from '../renderer/src/host/settingsChatHost'
import { SessionRuntime } from '../renderer/src/host/SessionRuntime'
import { ChatView } from '../renderer/src/components/chat/ChatView'
import { SESSION_ID, api } from './api'

/**
 * WebUI 根组件 — 单会话视图
 * 复用 renderer 的 ChatView，不含 Sidebar/Settings
 */
export default function WebApp(): React.JSX.Element {
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()

  // ─── 初始化：加载设置 + 设置当前 session ───
  // 渠道端无 HostApi：外观经服务端 HTTP 直取，会话经 SessionChannelApi。分享一律「仅查看」，
  // 故直接置 viewOnly=true（只读：隐藏输入、笔记本只读、右侧面板不显示）。
  // provider 目录不加载（模型选择器属宿主能力，已自动隐藏）。
  useEffect(() => {
    useChatStore.getState().setViewOnly(true)
    const init = async (): Promise<void> => {
      // 加载设置（主题、字体等）
      const settings = await api<Record<string, string>>('/settings')
      useSettingsStore.getState().loadSettings(settings)

      // 获取会话信息并设为活跃
      const sessionInfo = await getSessionChannelApi().session.getById(SESSION_ID)
      if (sessionInfo) {
        useChatStore.getState().setSessions([sessionInfo])
        useChatStore.getState().setActiveSessionId(SESSION_ID)
      }
    }
    init()
  }, [])

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const chatHost = useSettingsChatHost()

  // ─── 外观 ───
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}px`)
  }, [fontSize])

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

  return (
    <ChatHostProvider value={chatHost}>
      <SessionRuntime sessionId={activeSessionId} />
      {/* 仅查看：只渲染对话/笔记本只读视图，无右侧面板。min-w-0 让窄视口(手机)下内容正常换行不裁切。 */}
      <div className="h-screen flex bg-bg-primary text-text-primary">
        <div className="flex-1 min-h-0 min-w-0">
          <ChatView />
        </div>
      </div>
    </ChatHostProvider>
  )
}
