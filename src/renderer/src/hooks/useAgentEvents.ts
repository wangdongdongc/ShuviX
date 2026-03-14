import { useEffect, useCallback } from 'react'
import { useChatStore, type ChatMessage } from '../stores/chatStore'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash.startsWith('#settings')

/**
 * Agent 流式事件分发 Hook
 * 处理所有 session 的 Agent 事件，按 sessionId 隔离状态
 */
export function useAgentEvents(): void {
  const handleAgentEvent = useCallback(async (event: ChatEvent): Promise<void> => {
    const store = useChatStore.getState()
    const sid: string = event.sessionId

    switch (event.type) {
      case 'user_message':
        // 用户消息已由后端持久化，同步到本地 store（仅活跃会话）
        if (sid === store.activeSessionId && event.message) {
          store.addMessage(JSON.parse(event.message))
        }
        break

      case 'agent_start':
        store.setIsStreaming(sid, true)
        store.clearStreamingContent(sid)
        break

      case 'text_delta':
        store.appendStreamingContent(sid, event.delta)
        break

      case 'thinking_delta':
        store.appendStreamingThinking(sid, event.delta)
        break

      case 'text_end':
        break

      case 'step_end': {
        // 中间轮次步骤已持久化：清除流式内容 + 同步添加 step 消息到列表
        store.clearStreamingContent(sid)
        if (sid === store.activeSessionId && event.message) {
          store.addMessage(JSON.parse(event.message))
        }
        break
      }

      case 'image_data':
        store.appendStreamingImage(sid, JSON.parse(event.image))
        break

      case 'tool_start': {
        // 根据工具类型设置初始状态：bash 沙箱审批 / ssh 凭据 / 其余直接运行
        let initialStatus: 'running' | 'pending_approval' | 'pending_ssh_credentials' = 'running'
        if (event.approvalRequired) initialStatus = 'pending_approval'
        if (event.sshCredentialRequired) initialStatus = 'pending_ssh_credentials'
        store.addToolExecution(sid, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.toolArgs ?? {},
          turnIndex: event.turnIndex,
          status: initialStatus,
          messageId: event.messageId
        })
        // 仅当前活跃会话时添加到消息列表（tool_call 消息已在 main 进程持久化）
        if (sid === store.activeSessionId && event.messageId) {
          const msgs = await window.api.message.list(sid)
          const toolCallMsg = msgs.find((m) => m.id === event.messageId)
          if (toolCallMsg) store.addMessage(toolCallMsg)
        }
        break
      }

      case 'tool_approval_request':
        // 沙箱模式：bash 命令等待用户审批（备用路径，通常 tool_start 已携带 approvalRequired）
        store.updateToolExecution(sid, event.toolCallId, {
          status: 'pending_approval',
          args: event.toolArgs
        })
        break

      case 'user_input_request':
        // 用户输入请求：写入独立状态（与工具执行解耦）
        store.setPendingUserInput(sid, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          question: event.payload.question,
          detail: event.payload.detail,
          options: event.payload.options,
          allowMultiple: event.payload.allowMultiple
        })
        break

      case 'ssh_credential_request':
        // ssh connect：切换状态为等待凭据输入
        store.updateToolExecution(sid, event.toolCallId, {
          status: 'pending_ssh_credentials'
        })
        break

      case 'tool_end':
        store.updateToolExecution(sid, event.toolCallId, {
          status: event.isError ? 'error' : 'done',
          result: event.result,
          details: event.details
        })
        // tool_end 与 tool_start 共享同一条 tool_use 记录，原地替换而非新增
        if (sid === store.activeSessionId && event.messageId) {
          const msgs2 = await window.api.message.list(sid)
          const toolUseMsg = msgs2.find((m) => m.id === event.messageId)
          if (toolUseMsg) store.replaceMessage(event.messageId, toolUseMsg)
        }
        break

      case 'docker_event':
        if (event.action === 'container_created') {
          store.setSessionDocker(sid, {
            containerId: event.containerId || '',
            image: event.image || ''
          })
        } else {
          store.setSessionDocker(sid, null)
        }
        break

      case 'ssh_event':
        if (event.action === 'ssh_connected') {
          store.setSessionSsh(sid, {
            host: event.host || '',
            port: event.port || 22,
            username: event.username || ''
          })
        } else {
          store.setSessionSsh(sid, null)
        }
        break

      case 'python_event':
        if (event.action === 'runtime_ready') {
          store.setSessionPython(sid, { ready: true })
        } else {
          store.setSessionPython(sid, null)
        }
        break

      case 'sql_event':
        if (event.action === 'runtime_ready') {
          store.setSessionSql(sid, { ready: true })
        } else {
          store.setSessionSql(sid, null)
        }
        break

      case 'acp_event':
        if (event.action === 'session_created') {
          store.addSessionAcp(sid, {
            agentName: event.agentName,
            displayName: event.displayName
          })
        } else {
          store.removeSessionAcp(sid, event.agentName)
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
        // 后端已统一落库，直接从事件中取已保存的 assistant 消息
        const savedMsg = event.message ? JSON.parse(event.message) : null
        store.finishStreaming(sid, savedMsg ?? undefined)

        // 首次对话时后台让 AI 生成标题（对用户透明）
        if (savedMsg && sid === store.activeSessionId) {
          const sidMsgs = await window.api.message.list(sid)
          const textMsgCount = sidMsgs.filter(
            (m: ChatMessage) => m.type === 'text' || !m.type
          ).length
          if (textMsgCount <= 3) {
            const userMsg = sidMsgs.find((m: ChatMessage) => m.role === 'user')
            if (userMsg) {
              window.api.session
                .generateTitle({
                  sessionId: sid,
                  userMessage: userMsg.content,
                  assistantMessage: savedMsg.content
                })
                .then((res) => {
                  if (res.title) {
                    useChatStore.getState().updateSessionTitle(sid, res.title)
                  }
                })
                .catch(() => {})
            }
          }
        }
        break
      }

      case 'subagent_start':
        store.addSubAgentExecution(sid, {
          subAgentId: event.subAgentId,
          subAgentType: event.subAgentType,
          description: event.description,
          parentToolCallId: event.parentToolCallId,
          status: 'running',
          timeline: []
        })
        break

      case 'subagent_end':
        store.endSubAgentExecution(sid, event.subAgentId, event.result, event.usage)
        break

      case 'subagent_tool_start':
        store.addSubAgentTool(sid, event.subAgentId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: 'running',
          summary: event.summary
        })
        break

      case 'subagent_tool_end': {
        const updates: Record<string, unknown> = {}
        // 终态：设置 status
        if (event.result != null || event.isError != null) {
          updates.status = event.isError ? 'error' : 'done'
        }
        // 中间更新 / 终态都可能携带更新的 toolName
        if (event.toolName) {
          updates.toolName = event.toolName
        }
        store.updateSubAgentTool(sid, event.subAgentId, event.toolCallId, updates)
        break
      }

      case 'subagent_text_delta':
        store.appendSubAgentStreamingContent(sid, event.subAgentId, event.delta)
        break

      case 'subagent_thinking_delta':
        store.appendSubAgentStreamingThinking(sid, event.subAgentId, event.delta)
        break

      case 'error':
        // 错误以独立提示消息形式写入会话（不再使用底部错误条/弹窗）
        store.finishStreaming(sid)
        {
          const content = event.error || 'Unknown error'
          const errorMsg = await window.api.message.addErrorEvent({
            sessionId: sid,
            content
          })
          if (sid === store.activeSessionId) {
            store.addMessage(errorMsg)
          }
        }
        break
    }
  }, [])

  // 注册 Agent 事件监听器（仅主窗口）
  useEffect(() => {
    if (isSettingsWindow) return
    const unsubscribe = window.api.agent.onEvent(handleAgentEvent)
    return unsubscribe
  }, [handleAgentEvent])
}
