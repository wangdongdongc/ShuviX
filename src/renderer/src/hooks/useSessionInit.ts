import { useEffect } from 'react'
import { useChatStore, type AssistantTextMessage } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash.startsWith('#settings')

/**
 * 会话级初始化 Hook
 * 切换会话时：加载消息 → 初始化 Agent → 同步所有会话元信息到 store
 * agent.init 返回的结果是唯一数据来源，确保指令状态等信息不存在时序竞争
 */
export function useSessionInit(activeSessionId: string | null): void {
  const loaded = useSettingsStore((s) => s.loaded)
  const setActiveProvider = useSettingsStore((s) => s.setActiveProvider)
  const setActiveModel = useSettingsStore((s) => s.setActiveModel)

  useEffect(() => {
    if (isSettingsWindow || !activeSessionId || !loaded) return
    let cancelled = false

    const loadSession = async (): Promise<void> => {
      // 1. 加载消息用于 UI 渲染
      const msgs = await window.api.message.list(activeSessionId)
      if (cancelled) return
      useChatStore.getState().setMessages(msgs)

      // 2. 后端初始化 Agent 并返回完整会话元信息
      const result = await window.api.agent.init({ sessionId: activeSessionId })
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
      store.setAgentMdLoaded(!!result.agentMdLoaded)

      // 5. 从最后一条 assistant 消息的 metadata 恢复已占用上下文 token 数
      const lastAssistant = [...msgs]
        .reverse()
        .find(
          (m): m is AssistantTextMessage =>
            m.role === 'assistant' && m.type === 'text' && !!m.metadata
        )
      const lastUsage = lastAssistant?.metadata?.usage ?? null
      if (lastUsage) {
        const details = lastUsage.details
        const last = (details?.length ?? 0) > 0 ? details![details!.length - 1] : null
        const promptTokens = last
          ? (last.total || 0) - (last.output || 0)
          : (lastUsage.total || 0) - (lastUsage.output || 0)
        store.setUsedContextTokens(promptTokens > 0 ? promptTokens : null)
      } else {
        store.setUsedContextTokens(null)
      }

      // 6. 获取可用斜杠命令（来自项目 .claude/commands/）
      if (result.workingDirectory) {
        const commands = await window.api.command.list({ sessionId: activeSessionId })
        if (!cancelled) store.setSlashCommands(commands)
      } else {
        store.setSlashCommands([])
      }

      // 7. 从 modelMetadata 恢复思考深度（仅同步 UI 状态，后端已在创建时初始化）
      const restoredLevel = hasReasoning ? result.modelMetadata.thinkingLevel || 'medium' : 'off'
      store.setThinkingLevel(restoredLevel)

      // 7. 查询 Docker/SSH/Plugin 实时资源状态
      const [dockerInfo, sshInfo, pluginRuntimes] = await Promise.all([
        window.api.docker.sessionStatus(activeSessionId),
        window.api.ssh.sessionStatus(activeSessionId),
        window.api.plugin.getRuntimeStatuses(activeSessionId)
      ])
      if (!cancelled) {
        store.setSessionDocker(activeSessionId, dockerInfo)
        store.setSessionSsh(activeSessionId, sshInfo)
        store.setPluginRuntimes(activeSessionId, pluginRuntimes)
      }
    }
    loadSession()
    return () => {
      cancelled = true
    }
  }, [activeSessionId, loaded, setActiveProvider, setActiveModel])
}
