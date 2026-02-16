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
        sessionId: activeSessionId,
        provider: sessionProvider,
        model: sessionModel,
        systemPrompt,
        workingDirectory: currentSession?.workingDirectory || undefined,
        dockerEnabled: currentSession?.dockerEnabled === 1,
        dockerImage: currentSession?.dockerImage || undefined,
        apiKey: providerInfo?.apiKey || undefined,
        baseUrl: providerInfo?.baseUrl || undefined,
        messages: msgs.map((m) => ({ role: m.role, content: m.content }))
      })
    }
    loadSession()
  }, [activeSessionId, loaded, sessions, providers, systemPrompt, setActiveProvider, setActiveModel])

  /** 处理 Agent 流式事件（所有 session 的事件都处理，按 sessionId 隔离状态） */
  const handleAgentEvent = useCallback(
    async (event: any): Promise<void> => {
      const store = useChatStore.getState()
      const sid: string = event.sessionId

      switch (event.type) {
        case 'agent_start':
          store.setIsStreaming(sid, true)
          store.clearStreamingContent(sid)
          break

        case 'text_delta':
          store.appendStreamingContent(sid, event.data || '')
          break

        case 'text_end':
          break

        case 'tool_start':
          store.addToolExecution(sid, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.toolArgs,
            status: 'running',
            messageId: event.data
          })
          // 仅当前活跃会话时添加到消息列表（tool_call 消息已在 main 进程持久化）
          if (sid === store.activeSessionId && event.data) {
            const msgs = await window.api.message.list(sid)
            const toolCallMsg = msgs.find((m) => m.id === event.data)
            if (toolCallMsg) store.addMessage(toolCallMsg)
          }
          break

        case 'tool_end':
          store.updateToolExecution(sid, event.toolCallId, {
            status: event.toolIsError ? 'error' : 'done',
            result: event.toolResult
          })
          // 仅当前活跃会话时添加 tool_result 消息
          if (sid === store.activeSessionId && event.data) {
            const msgs2 = await window.api.message.list(sid)
            const toolResultMsg = msgs2.find((m) => m.id === event.data)
            if (toolResultMsg) store.addMessage(toolResultMsg)
          }
          break

        case 'docker_event':
          // 仅当前活跃会话时添加 docker_event 消息
          if (sid === store.activeSessionId && event.data) {
            const msgs3 = await window.api.message.list(sid)
            const dockerMsg = msgs3.find((m) => m.id === event.data)
            if (dockerMsg) store.addMessage(dockerMsg)
          }
          break

        case 'agent_end': {
          const content = store.getSessionStreamContent(sid)
          if (content) {
            const assistantMsg = await window.api.message.add({
              sessionId: sid,
              role: 'assistant',
              content
            })
            // 仅当该 session 是当前查看的会话时，才更新内存中的消息列表
            if (sid === store.activeSessionId) {
              store.addMessage(assistantMsg)
            }

            // 首次对话时后台让 AI 生成标题（对用户透明）
            const textMsgCount = store.messages.filter((m) => m.type === 'text' || !m.type).length
            if (textMsgCount <= 2) {
              const userMsg = store.messages.find((m) => m.role === 'user')
              if (userMsg) {
                // 异步生成，不阻塞主流程
                window.api.session.generateTitle({
                  sessionId: sid,
                  userMessage: userMsg.content,
                  assistantMessage: content
                }).then((res) => {
                  if (res.title) {
                    useChatStore.getState().updateSessionTitle(sid, res.title)
                  }
                }).catch(() => {})
              }
            }
          }
          store.clearStreamingContent(sid)
          store.clearToolExecutions(sid)
          store.setIsStreaming(sid, false)
          break
        }

        case 'error':
          store.setError(event.error || '未知错误')
          store.setIsStreaming(sid, false)
          store.clearStreamingContent(sid)
          store.clearToolExecutions(sid)
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
