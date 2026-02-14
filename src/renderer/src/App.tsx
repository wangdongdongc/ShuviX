import { useEffect, useCallback } from 'react'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SettingsPanel } from './components/SettingsPanel'

/**
 * 应用主入口 — 三栏布局（侧边栏 + 聊天区 + 设置面板）
 * 负责初始化数据加载和 Agent 事件监听
 */
function App(): React.JSX.Element {
  const { activeSessionId } = useChatStore()
  const { provider, model, systemPrompt, apiKeys, baseUrls, loaded } = useSettingsStore()

  /** 应用启动时加载数据 */
  useEffect(() => {
    const init = async (): Promise<void> => {
      // 加载设置
      const settings = await window.api.settings.getAll()
      useSettingsStore.getState().loadSettings(settings)

      // 加载会话列表
      const sessions = await window.api.session.list()
      useChatStore.getState().setSessions(sessions)
    }
    init()
  }, [])

  /** 切换会话时加载消息并初始化 Agent */
  useEffect(() => {
    if (!activeSessionId || !loaded) return

    const loadSession = async (): Promise<void> => {
      // 加载会话消息
      const msgs = await window.api.message.list(activeSessionId)
      useChatStore.getState().setMessages(msgs)

      // 初始化 Agent（传入自定义 Base URL）
      const apiKey = apiKeys[provider]
      const baseUrl = baseUrls[provider]
      await window.api.agent.init({
        provider,
        model,
        systemPrompt,
        apiKey,
        baseUrl: baseUrl || undefined,
        messages: msgs.map((m) => ({ role: m.role, content: m.content }))
      })
    }
    loadSession()
  }, [activeSessionId, loaded])

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
          // text_end 仅标记文本流结束，不保存消息
          break

        case 'agent_end': {
          // agent_end 是最终事件，在此保存助手消息
          const content = store.streamingContent
          if (content && store.activeSessionId) {
            const assistantMsg = await window.api.message.add({
              sessionId: store.activeSessionId,
              role: 'assistant',
              content
            })
            store.addMessage(assistantMsg)

            // 首条助手回复时，自动用前几个字更新会话标题
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

  /** 注册 Agent 事件监听器 */
  useEffect(() => {
    const unsubscribe = window.api.agent.onEvent(handleAgentEvent)
    return unsubscribe
  }, [handleAgentEvent])

  return (
    <div className="flex h-full">
      {/* 侧边栏 */}
      <div className="w-[240px] flex-shrink-0">
        <Sidebar />
      </div>

      {/* 聊天主区域 */}
      <div className="flex-1 min-w-0 bg-bg-primary">
        <ChatView />
      </div>

      {/* 设置面板（浮层） */}
      <SettingsPanel />
    </div>
  )
}

export default App
