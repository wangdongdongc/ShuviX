import { useEffect, useCallback } from 'react'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SettingsPanel } from './components/SettingsPanel'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash === '#settings'

/**
 * 应用主入口
 * 根据 hash 区分：主窗口（侧边栏 + 聊天区）或设置窗口（独立设置页）
 */
function App(): React.JSX.Element {
  const { activeSessionId, sessions } = useChatStore()
  const { systemPrompt, providers, theme, fontSize, loaded, setActiveProvider, setActiveModel } = useSettingsStore()

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

  /** 应用启动时加载数据（主窗口和设置窗口共用） */
  useEffect(() => {
    const init = async (): Promise<void> => {
      // 加载通用设置
      const settings = await window.api.settings.getAll()
      useSettingsStore.getState().loadSettings(settings)

      // 加载提供商列表和可用模型
      const allProviders = await window.api.provider.listAll()
      useSettingsStore.getState().setProviders(allProviders)
      const availableModels = await window.api.provider.listAvailableModels()
      useSettingsStore.getState().setAvailableModels(availableModels)

      // 仅主窗口加载会话列表
      if (!isSettingsWindow) {
        const sessions = await window.api.session.list()
        useChatStore.getState().setSessions(sessions)
      }
    }
    init()
  }, [])

  // ========== 以下仅主窗口需要 ==========

  /** 切换会话时加载消息并初始化 Agent */
  useEffect(() => {
    if (isSettingsWindow || !activeSessionId || !loaded) return

    const loadSession = async (): Promise<void> => {
      const msgs = await window.api.message.list(activeSessionId)
      useChatStore.getState().setMessages(msgs)

      const currentSession = sessions.find((s) => s.id === activeSessionId)
      const sessionProvider = currentSession?.provider || 'openai'
      const sessionModel = currentSession?.model || 'gpt-4o-mini'

      // 将当前激活模型同步为该会话配置
      setActiveProvider(sessionProvider)
      setActiveModel(sessionModel)

      const providerInfo = providers.find((p) => p.id === sessionProvider)
      await window.api.agent.init({
        provider: sessionProvider,
        model: sessionModel,
        systemPrompt,
        apiKey: providerInfo?.apiKey || undefined,
        baseUrl: providerInfo?.baseUrl || undefined,
        messages: msgs.map((m) => ({ role: m.role, content: m.content }))
      })
    }
    loadSession()
  }, [activeSessionId, loaded, sessions, providers, systemPrompt, setActiveProvider, setActiveModel])

  /** 处理 Agent 流式事件 */
  const handleAgentEvent = useCallback(
    async (event: any): Promise<void> => {
      const store = useChatStore.getState()

      switch (event.type) {
        case 'agent_start':
          store.setIsStreaming(true)
          store.clearStreamingContent()
          break

        case 'text_delta':
          store.appendStreamingContent(event.data || '')
          break

        case 'text_end':
          break

        case 'agent_end': {
          const content = store.streamingContent
          if (content && store.activeSessionId) {
            const assistantMsg = await window.api.message.add({
              sessionId: store.activeSessionId,
              role: 'assistant',
              content
            })
            store.addMessage(assistantMsg)

            if (store.messages.length <= 2) {
              const title = content.slice(0, 30).replace(/\n/g, ' ') + (content.length > 30 ? '...' : '')
              await window.api.session.updateTitle({ id: store.activeSessionId, title })
              store.updateSessionTitle(store.activeSessionId, title)
            }
          }
          store.clearStreamingContent()
          store.setIsStreaming(false)
          break
        }

        case 'error':
          store.setError(event.error || '未知错误')
          store.setIsStreaming(false)
          store.clearStreamingContent()
          break
      }
    },
    []
  )

  /** 注册 Agent 事件监听器（仅主窗口） */
  useEffect(() => {
    if (isSettingsWindow) return
    const unsubscribe = window.api.agent.onEvent(handleAgentEvent)
    return unsubscribe
  }, [handleAgentEvent])

  /** 监听设置变更，实时刷新主题/字体等（仅主窗口） */
  useEffect(() => {
    if (isSettingsWindow) return
    const unsubscribe = window.api.app.onSettingsChanged(async () => {
      const settings = await window.api.settings.getAll()
      useSettingsStore.getState().loadSettings(settings)
      const allProviders = await window.api.provider.listAll()
      useSettingsStore.getState().setProviders(allProviders)
      const availableModels = await window.api.provider.listAvailableModels()
      useSettingsStore.getState().setAvailableModels(availableModels)
    })
    return unsubscribe
  }, [])

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
