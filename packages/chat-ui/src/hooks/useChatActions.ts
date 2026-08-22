import { getSessionChannelApi, getHostApi } from '@shuvix/chat-ui'
import { useCallback, useState } from 'react'
import { useChatStore } from '../stores/chatStore'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

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
  /**
   * 统一的"用户输入响应"入口。
   * 命令询问 / 选择题 / SSH 凭证 / 其它反馈都通过该方法路由。
   * 副作用(如写入 allowList)由后端工具响应回调根据 response.extra 处理。
   */
  handleInputResponse: (requestId: string, response: InputResponse) => Promise<void>
  /** 创建新会话 */
  handleNewChat: () => Promise<void>
}

/**
 * 聊天操作 Hook — 封装消息回退、重新生成、工具询问、用户输入等业务逻辑
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
    const store = useChatStore.getState()
    const target = store.messages.find((m) => m.id === pendingRollbackId)
    // 只允许回退到用户输入的文本消息
    if (!target || target.role !== 'user' || target.type !== 'text') return

    const host = getHostApi()
    if (!host) return // 渠道端只读：不可回退历史
    const rollbackContent = target.content
    const rollbackTokens = target.metadata?.inlineTokens
    // 会话树回退到该用户消息之前（append-only：旧分支保留在树上）
    await host.message.rollback({
      sessionId: activeSessionId,
      messageId: pendingRollbackId
    })
    const msgs = await getSessionChannelApi().message.list(activeSessionId)
    store.setMessages(msgs)
    await getSessionChannelApi().agent.init({ sessionId: activeSessionId })
    // 将用户消息重建为输入框草稿（含内联 Token 恢复），便于编辑后重新发送。
    // 直接回填裸 content 会让 {{shuvixInlineToken}} 标记失去 metadata → token 失效丢信息，
    // 故经 draftRestoreRequest 信号交由 InputArea 重建明文并重新登记粘贴芯片/@ 引用。
    store.requestDraftRestore(rollbackContent, rollbackTokens)
  }, [activeSessionId, pendingRollbackId])

  /** 取消回退 */
  const cancelRollback = useCallback(() => {
    setPendingRollbackId(null)
  }, [])

  /** 重新生成最近一次助手回复（回退到用户消息前 + 重发） */
  const handleRegenerate = useCallback(
    async (assistantMsgId: string) => {
      if (!activeSessionId) return
      const store = useChatStore.getState()
      const idx = store.messages.findIndex((m) => m.id === assistantMsgId)
      // 向前查找最近的 user/text 消息
      let lastUserText = ''
      let lastUserTokens: Record<string, InlineToken> | undefined
      let userMsgId = ''
      for (let j = idx - 1; j >= 0; j--) {
        const m = store.messages[j]
        if (m.role === 'user' && m.type === 'text') {
          lastUserText = m.content
          lastUserTokens = m.metadata?.inlineTokens
          userMsgId = m.id
          break
        }
      }
      if (!userMsgId) return
      const host = getHostApi()
      if (!host) return // 渠道端只读：不可重新生成（会删历史）
      // 会话树回退到该用户消息之前
      await host.message.rollback({ sessionId: activeSessionId, messageId: userMsgId })
      // 重新拉取消息 + 重建 Agent
      const msgs = await getSessionChannelApi().message.list(activeSessionId)
      store.setMessages(msgs)
      await getSessionChannelApi().agent.init({ sessionId: activeSessionId })
      // 重新发送（后端统一持久化用户消息）；透传原消息的内联 Token，
      // 否则含 {{shuvixInlineToken}} 标记的消息会以裸标记发给 LLM 且新落库消息丢失 metadata
      await getSessionChannelApi().agent.prompt({
        sessionId: activeSessionId,
        text: lastUserText,
        inlineTokens: lastUserTokens
      })
    },
    [activeSessionId]
  )

  /**
   * 统一的"用户输入响应"入口。
   * 后端按 response.kind 路由到对应工具的挂起 Promise。
   * 副作用(如 rememberPath → allowList)走 response.extra,由工具响应回调处理。
   */
  const handleInputResponse = useCallback(
    async (requestId: string, response: InputResponse) => {
      if (!activeSessionId) return
      await getSessionChannelApi().agent.respondToInput({
        sessionId: activeSessionId,
        requestId,
        response
      })
      // 后端 resolve 后会广播 input_request_resolved → store 自动移除该 pending,无需本地手动清理
    },
    [activeSessionId]
  )

  /** 创建新会话（宿主能力；渠道端无此入口） */
  const handleNewChat = useCallback(async () => {
    const host = getHostApi()
    if (!host) return
    const session = await host.session.create()
    const sessions = await host.session.list()
    useChatStore.getState().setSessions(sessions)
    useChatStore.getState().setActiveSessionId(session.id)
  }, [])

  return {
    handleRollback,
    pendingRollbackId,
    confirmRollback,
    cancelRollback,
    handleRegenerate,
    handleInputResponse,
    handleNewChat
  } satisfies UseChatActionsReturn
}
