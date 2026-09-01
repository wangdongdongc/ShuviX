import { getHostApi, getSessionChannelApi, useChatHost } from '@shuvix/chat-ui'
import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'
import { useEffect } from 'react'
import { useBgTaskStore } from '../stores/bgTaskStore'
import { useChatStore, type AssistantMessage } from '../stores/chatStore'
import { useModelCatalogStore } from '../stores/modelCatalogStore'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash.startsWith('#settings')

/**
 * 会话级初始化 Hook
 * 切换会话时：加载消息 → 初始化 Agent → 同步所有会话元信息到 store
 * agent.init 返回的结果是唯一数据来源，确保指令状态等信息不存在时序竞争
 */
export function useSessionInit(activeSessionId: string | null): void {
  const { setActiveProvider, setActiveModel } = useChatHost().models
  // 目录加载完成才初始化会话模型（时序与之前 host.models.loaded 一致）
  const loaded = useModelCatalogStore((s) => s.loaded)

  useEffect(() => {
    if (isSettingsWindow || !activeSessionId || !loaded) return
    let cancelled = false

    const loadSession = async (): Promise<void> => {
      // 1. 加载消息用于 UI 渲染
      const msgs = await getSessionChannelApi().message.list(activeSessionId)
      if (cancelled) return
      useChatStore.getState().setMessages(msgs)

      // 打开即读（A4）：聊天会话带着未读被点开，这一眼就是「读过了」。
      // 服务端幂等；有根会话不维护未读，不发这趟 IPC
      {
        const s = useChatStore.getState().sessions.find((x) => x.id === activeSessionId)
        if (s?.settings?.bots?.length && (s.settings.unreadCount ?? 0) > 0) {
          void getHostApi()?.session.markRead?.(activeSessionId)
        }
      }

      // 2. 后端初始化 Agent 并返回完整会话元信息
      const result = await getSessionChannelApi().agent.init({ sessionId: activeSessionId })
      if (cancelled) return

      const store = useChatStore.getState()

      // 3. 同步模型信息
      setActiveProvider(result.provider)
      setActiveModel(result.model)

      const caps = result.capabilities || {}
      const hasReasoning = !!caps.reasoning
      store.setModelSupportsReasoning(hasReasoning)
      store.setModelSupportsVision(!!caps.vision)
      store.setMaxContextTokens(caps.maxInputTokens || 0)

      // 4. 同步会话元信息（projectPath、enabledTools、指令文件状态）
      store.setProjectPath(result.workingDirectory || null)
      store.setEnabledTools(result.enabledTools || [])

      // 5. 从最后一条 assistant 消息的 metadata 恢复已占用上下文 token 数
      // 最后一次调用的用量就是当时的上下文占用（一条消息 = 一次调用）
      const lastAssistant = [...msgs]
        .reverse()
        .find(
          (m): m is AssistantMessage =>
            m.role === 'assistant' && m.type === 'message' && !!m.metadata
        )
      const lastUsage = lastAssistant?.metadata?.usage ?? null
      if (lastUsage) {
        const promptTokens = (lastUsage.total || 0) - (lastUsage.output || 0)
        store.setUsedContextTokens(promptTokens > 0 ? promptTokens : null)
      } else {
        store.setUsedContextTokens(null)
      }

      // 7. 从 modelMetadata 恢复思考深度（仅同步 UI 状态，后端已在创建时初始化）
      const restoredLevel =
        result.modelMetadata.thinkingLevel || (hasReasoning ? DEFAULT_THINKING_LEVEL : 'off')
      store.setThinkingLevel(restoredLevel)

      // 7. 查询运行时资源状态（SSH / DB 等）
      const runtimes = await getSessionChannelApi().runtime.statuses(activeSessionId)
      if (!cancelled) {
        store.setRuntimes(activeSessionId, runtimes)
      }

      // 8. 补后台任务快照 —— bg_task 事件只覆盖「本次前端在线期间」的变更，
      //    刷新/切会话后要靠这一次拉取才知道有哪些任务还在跑（面板 tab 的显隐也依赖它）
      const bgTasks = await getSessionChannelApi().bgTask.list({ sessionId: activeSessionId })
      if (!cancelled) {
        useBgTaskStore.getState().replaceSession(activeSessionId, bgTasks)
      }
    }
    loadSession()
    return () => {
      cancelled = true
    }
  }, [activeSessionId, loaded, setActiveProvider, setActiveModel])

  // 斜杠命令：与会话生命周期解耦
  // - 有会话：返回项目命令 + 已启用 skill
  // - 无会话（欢迎页）：仍返回不依赖项目的 skill 等内置命令源
  useEffect(() => {
    if (isSettingsWindow) return
    let cancelled = false
    getSessionChannelApi()
      .command.list({ sessionId: activeSessionId })
      .then((commands) => {
        if (!cancelled) useChatStore.getState().setSlashCommands(commands)
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionId])
}
