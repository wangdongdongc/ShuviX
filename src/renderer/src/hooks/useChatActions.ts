import { useCallback, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'

/** useChatActions 返回值类型 */
export interface UseChatActionsReturn {
  /** 请求回退（弹出确认弹窗） */
  handleRollback: (messageId: string) => void
  /** 待确认回退的消息 ID（非 null 时渲染确认弹窗） */
  pendingRollbackId: string | null
  /** 确认执行回退 */
  confirmRollback: () => Promise<void>
  /** 取消回退 */
  cancelRollback: () => void
  /** 重新生成最近一次助手回复 */
  handleRegenerate: (assistantMsgId: string) => Promise<void>
  /** 沙箱审批：用户允许/拒绝工具调用 */
  handleToolApproval: (toolCallId: string, approved: boolean) => Promise<void>
  /** ask 工具：用户选择回调 */
  handleUserInput: (toolCallId: string, selections: string[]) => Promise<void>
  /** 创建新会话 */
  handleNewChat: () => Promise<void>
}

/**
 * 聊天操作 Hook — 封装消息回退、重新生成、工具审批、用户输入等业务逻辑
 * @param activeSessionId 当前活动会话ID
 */
export function useChatActions(activeSessionId: string | null): UseChatActionsReturn {

  /** 待确认回退的消息 ID */
  const [pendingRollbackId, setPendingRollbackId] = useState<string | null>(null)

  /** 请求回退（设置待确认状态） */
  const handleRollback = useCallback((messageId: string) => {
    setPendingRollbackId(messageId)
  }, [])

  /** 确认执行回退 */
  const confirmRollback = useCallback(async () => {
    if (!activeSessionId || !pendingRollbackId) return
    setPendingRollbackId(null)
    await window.api.message.rollback({ sessionId: activeSessionId, messageId: pendingRollbackId })
    const msgs = await window.api.message.list(activeSessionId)
    useChatStore.getState().setMessages(msgs)
    await window.api.agent.init({ sessionId: activeSessionId })
  }, [activeSessionId, pendingRollbackId])

  /** 取消回退 */
  const cancelRollback = useCallback(() => {
    setPendingRollbackId(null)
  }, [])

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

  return { handleRollback, pendingRollbackId, confirmRollback, cancelRollback, handleRegenerate, handleToolApproval, handleUserInput, handleNewChat } satisfies UseChatActionsReturn
}
