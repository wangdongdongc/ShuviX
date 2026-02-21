import { useEffect, useCallback } from 'react'
import i18next from 'i18next'
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
  const { activeSessionId } = useChatStore()
  const { theme, fontSize, loaded, setActiveProvider, setActiveModel } = useSettingsStore()

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

      // 同步前端 i18n 语言（优先用户设置，否则保持检测值）
      const savedLang = settings['general.language']
      if (savedLang && savedLang !== i18next.language) {
        i18next.changeLanguage(savedLang)
      }

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
      // 加载消息用于 UI 渲染
      const msgs = await window.api.message.list(activeSessionId)
      useChatStore.getState().setMessages(msgs)

      // 后端初始化 Agent 并返回会话信息
      const result = await window.api.agent.init({ sessionId: activeSessionId })

      // 同步前端 UI 状态
      setActiveProvider(result.provider)
      setActiveModel(result.model)

      const caps = result.capabilities || {}
      const hasReasoning = !!caps.reasoning
      useChatStore.getState().setModelSupportsReasoning(hasReasoning)
      useChatStore.getState().setModelSupportsVision(!!caps.vision)
      useChatStore.getState().setMaxContextTokens(caps.maxInputTokens || 0)

      // 从最后一条 assistant 消息的 metadata 恢复已占用上下文 token 数
      const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.metadata)
      const lastUsage = (() => {
        try { return lastAssistant ? JSON.parse(lastAssistant.metadata!).usage : null } catch { return null }
      })()
      if (lastUsage) {
        const details = lastUsage.details
        const last = details?.length > 0 ? details[details.length - 1] : null
        const promptTokens = last
          ? (last.total || 0) - (last.output || 0)
          : (lastUsage.total || 0) - (lastUsage.output || 0)
        useChatStore.getState().setUsedContextTokens(promptTokens > 0 ? promptTokens : null)
      } else {
        useChatStore.getState().setUsedContextTokens(null)
      }

      // 从 modelMetadata 恢复用户上次设置的思考深度
      const meta = (() => { try { return JSON.parse(result.modelMetadata || '{}') } catch { return {} } })()
      const savedLevel = meta.thinkingLevel
      const restoredLevel = hasReasoning ? (savedLevel || 'medium') : 'off'
      useChatStore.getState().setThinkingLevel(restoredLevel)
      await window.api.agent.setThinkingLevel({ sessionId: activeSessionId, level: restoredLevel as any })
    }
    loadSession()
  }, [activeSessionId, loaded, setActiveProvider, setActiveModel])

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

        case 'thinking_delta':
          store.appendStreamingThinking(sid, event.data || '')
          break

        case 'text_end':
          break

        case 'tool_start': {
          // 沙箱模式 bash 工具：直接以 pending_approval 状态创建，无需等待额外事件
          const initialStatus = event.approvalRequired ? 'pending_approval' : 'running'
          console.log('[Renderer] tool_start', event.toolCallId, event.toolName, 'approvalRequired=', event.approvalRequired, 'status=', initialStatus)
          store.addToolExecution(sid, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.toolArgs,
            status: initialStatus as 'running' | 'pending_approval',
            messageId: event.data
          })
          // 仅当前活跃会话时添加到消息列表（tool_call 消息已在 main 进程持久化）
          if (sid === store.activeSessionId && event.data) {
            const msgs = await window.api.message.list(sid)
            const toolCallMsg = msgs.find((m) => m.id === event.data)
            if (toolCallMsg) store.addMessage(toolCallMsg)
          }
          break
        }

        case 'tool_approval_request':
          // 沙箱模式：bash 命令等待用户审批
          console.log('[Renderer] 收到审批请求', event.toolCallId, 'toolExecutions:', store.sessionToolExecutions[sid])
          store.updateToolExecution(sid, event.toolCallId, {
            status: 'pending_approval',
            args: event.toolArgs
          })
          console.log('[Renderer] 更新后 toolExecutions:', useChatStore.getState().sessionToolExecutions[sid])
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
          // 更新已占用上下文 token 数（total - output = prompt_tokens，包含 cached tokens）
          if (event.usage && sid === store.activeSessionId) {
            const details = event.usage.details
            const last = details?.length > 0 ? details[details.length - 1] : null
            const promptTokens = last
              ? (last.total || 0) - (last.output || 0)
              : (event.usage.total || 0) - (event.usage.output || 0)
            store.setUsedContextTokens(promptTokens > 0 ? promptTokens : null)
          }
          const content = store.getSessionStreamContent(sid)
          if (content) {
            const thinking = store.getSessionStreamThinking(sid)
            const meta: Record<string, any> = {}
            if (thinking) meta.thinking = thinking
            if (event.usage) meta.usage = event.usage
            // 从会话列表获取当前模型名称
            const session = store.sessions.find((s) => s.id === sid)
            const assistantMsg = await window.api.message.add({
              sessionId: sid,
              role: 'assistant',
              content,
              metadata: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
              model: session?.model || ''
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
          store.setError(event.error || 'Unknown error')
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
      // 同步前端 i18n 语言
      const savedLang = settings['general.language']
      if (savedLang && savedLang !== i18next.language) {
        i18next.changeLanguage(savedLang)
      }
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
