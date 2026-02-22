import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * 聊天操作 Hook — 封装消息回退、重新生成、工具审批、用户输入等业务逻辑
 */
export function useChatActions(activeSessionId: string | null) {
  const { t } = useTranslation()

  /** 回退到指定消息（删除之后的所有消息，重新初始化 Agent） */
  const handleRollback = useCallback(async (messageId: string) => {
    if (!activeSessionId) return
    if (!window.confirm(t('chat.rollbackConfirm'))) return
    await window.api.message.rollback({ sessionId: activeSessionId, messageId })
    const msgs = await window.api.message.list(activeSessionId)
    useChatStore.getState().setMessages(msgs)
    await window.api.agent.init({ sessionId: activeSessionId })
  }, [activeSessionId])

  /** 重新生成最近一次助手回复（回退到用户消息前 + 重发） */
  const handleRegenerate = useCallback(async (assistantMsgId: string) => {
    if (!activeSessionId) return
    const store = useChatStore.getState()
    const idx = store.messages.findIndex((m) => m.id === assistantMsgId)
    // 向前查找最近的 user/text 消息
    let lastUserText = ''
    let userMsgId = ''
    for (let j = idx - 1; j >= 0; j--) {
      if (store.messages[j].role === 'user' && store.messages[j].type === 'text') {
        lastUserText = store.messages[j].content
        userMsgId = store.messages[j].id
        break
      }
    }
    if (!userMsgId) return
    // 删除用户消息及之后的所有消息
    await window.api.message.deleteFrom({ sessionId: activeSessionId, messageId: userMsgId })
    // 重新拉取消息 + 重建 Agent
    const msgs = await window.api.message.list(activeSessionId)
    store.setMessages(msgs)
    await window.api.agent.init({ sessionId: activeSessionId })
    // 重新保存用户消息并发送
    const userMsg = await window.api.message.add({ sessionId: activeSessionId, role: 'user', content: lastUserText })
    store.addMessage(userMsg)
    await window.api.agent.prompt({ sessionId: activeSessionId, text: lastUserText })
  }, [activeSessionId])

  /** 沙箱审批：用户允许/拒绝 bash 命令执行 */
  const handleToolApproval = useCallback(async (toolCallId: string, approved: boolean) => {
    await window.api.agent.approveToolCall({ toolCallId, approved })
    const store = useChatStore.getState()
    if (activeSessionId) {
      store.updateToolExecution(activeSessionId, toolCallId, {
        status: approved ? 'running' : 'error'
      })
    }
  }, [activeSessionId])

  /** ask 工具：用户选择回调 */
  const handleUserInput = useCallback(async (toolCallId: string, selections: string[]) => {
    await window.api.agent.respondToAsk({ toolCallId, selections })
    const store = useChatStore.getState()
    if (activeSessionId) {
      store.updateToolExecution(activeSessionId, toolCallId, {
        status: 'running'
      })
    }
  }, [activeSessionId])

  /** 创建新会话 */
  const handleNewChat = useCallback(async () => {
    const settings = useSettingsStore.getState()
    const session = await window.api.session.create({
      provider: settings.activeProvider,
      model: settings.activeModel,
      systemPrompt: settings.systemPrompt
    })
    const sessions = await window.api.session.list()
    useChatStore.getState().setSessions(sessions)
    useChatStore.getState().setActiveSessionId(session.id)
  }, [])

  return { handleRollback, handleRegenerate, handleToolApproval, handleUserInput, handleNewChat }
}
