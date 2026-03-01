import { useEffect, useCallback } from 'react'
import { useChatStore, type ChatMessage } from '../stores/chatStore'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash === '#settings'

/**
 * Agent 流式事件分发 Hook
 * 处理所有 session 的 Agent 事件，按 sessionId 隔离状态
 */
export function useAgentEvents(): void {
  const handleAgentEvent = useCallback(async (event: ChatEvent): Promise<void> => {
    const store = useChatStore.getState()
    const sid: string = event.sessionId

    switch (event.type) {
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

      case 'image_data':
        store.appendStreamingImage(sid, JSON.parse(event.image))
        break

      case 'tool_start': {
        // 根据工具类型设置初始状态：bash 沙箱审批 / ask 用户输入 / ssh 凭据 / 其余直接运行
        let initialStatus:
          | 'running'
          | 'pending_approval'
          | 'pending_user_input'
          | 'pending_ssh_credentials' = 'running'
        if (event.approvalRequired) initialStatus = 'pending_approval'
        if (event.userInputRequired) initialStatus = 'pending_user_input'
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
        // ask 工具：仅切换状态为等待选择，不覆盖 args（tool_start 已携带完整参数）
        store.updateToolExecution(sid, event.toolCallId, {
          status: 'pending_user_input'
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
          result: event.result
        })
        // 仅当前活跃会话时添加 tool_result 消息
        if (sid === store.activeSessionId && event.messageId) {
          const msgs2 = await window.api.message.list(sid)
          const toolResultMsg = msgs2.find((m) => m.id === event.messageId)
          if (toolResultMsg) store.addMessage(toolResultMsg)
        }
        break

      case 'docker_event': {
        // 仅当前活跃会话时添加 docker_event 消息
        if (sid === store.activeSessionId) {
          const msgs3 = await window.api.message.list(sid)
          const dockerMsg = msgs3.find((m) => m.id === event.messageId)
          if (dockerMsg) {
            store.addMessage(dockerMsg)
            // 同步 sessionResources
            try {
              const meta = JSON.parse(dockerMsg.metadata || '{}')
              if (dockerMsg.content === 'container_created') {
                store.setSessionDocker(sid, {
                  containerId: meta.containerId || '',
                  image: meta.image || ''
                })
              } else if (dockerMsg.content === 'container_destroyed') {
                store.setSessionDocker(sid, null)
              }
            } catch {
              /* 忽略 */
            }
          }
        } else {
          // 非活跃会话：仅更新 sessionResources（确保切换后状态正确）
          const msgs3 = await window.api.message.list(sid)
          const dockerMsg = msgs3.find((m) => m.id === event.messageId)
          if (dockerMsg) {
            try {
              const meta = JSON.parse(dockerMsg.metadata || '{}')
              if (dockerMsg.content === 'container_created') {
                store.setSessionDocker(sid, {
                  containerId: meta.containerId || '',
                  image: meta.image || ''
                })
              } else if (dockerMsg.content === 'container_destroyed') {
                store.setSessionDocker(sid, null)
              }
            } catch {
              /* 忽略 */
            }
          }
        }
        break
      }

      case 'ssh_event': {
        // 仅当前活跃会话时添加 ssh_event 消息
        if (sid === store.activeSessionId) {
          const msgs4 = await window.api.message.list(sid)
          const sshMsg = msgs4.find((m) => m.id === event.messageId)
          if (sshMsg) {
            store.addMessage(sshMsg)
            // 同步 sessionResources
            try {
              const meta = JSON.parse(sshMsg.metadata || '{}')
              if (sshMsg.content === 'ssh_connected') {
                store.setSessionSsh(sid, {
                  host: meta.host || '',
                  port: Number(meta.port) || 22,
                  username: meta.username || ''
                })
              } else if (sshMsg.content === 'ssh_disconnected') {
                store.setSessionSsh(sid, null)
              }
            } catch {
              /* 忽略 */
            }
          }
        } else {
          // 非活跃会话：仅更新 sessionResources
          const msgs4 = await window.api.message.list(sid)
          const sshMsg = msgs4.find((m) => m.id === event.messageId)
          if (sshMsg) {
            try {
              const meta = JSON.parse(sshMsg.metadata || '{}')
              if (sshMsg.content === 'ssh_connected') {
                store.setSessionSsh(sid, {
                  host: meta.host || '',
                  port: Number(meta.port) || 22,
                  username: meta.username || ''
                })
              } else if (sshMsg.content === 'ssh_disconnected') {
                store.setSessionSsh(sid, null)
              }
            } catch {
              /* 忽略 */
            }
          }
        }
        break
      }

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

      case 'error':
        // 错误以独立提示消息形式写入会话（不再使用底部错误条/弹窗）
        store.finishStreaming(sid)
        {
          const content = event.error || 'Unknown error'
          const errorMsg = await window.api.message.add({
            sessionId: sid,
            role: 'system_notify',
            type: 'error_event',
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
