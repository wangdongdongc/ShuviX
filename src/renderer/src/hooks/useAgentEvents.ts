import { useEffect, useCallback } from 'react'
import { useChatStore, type ChatMessage, type StreamingDeltaBuffer } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { usePreviewStore } from '../stores/previewStore'
import { ttsPlayer } from '../services/tts/ttsPlayer'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash.startsWith('#settings')

// ---- Streaming delta rAF buffer ----
// High-frequency delta events (text, thinking, toolcall args, subagent text/thinking)
// are accumulated here and flushed to the store once per animation frame,
// reducing hundreds of store updates per second down to ~60.

const deltaBuffers = new Map<string, StreamingDeltaBuffer>()
let rafId: number | null = null

function getBuffer(sessionId: string): StreamingDeltaBuffer {
  let buf = deltaBuffers.get(sessionId)
  if (!buf) {
    buf = { content: '', thinking: '', toolCallArgsDelta: '', subAgents: new Map() }
    deltaBuffers.set(sessionId, buf)
  }
  return buf
}

function getSubBuf(
  buf: StreamingDeltaBuffer,
  subAgentId: string
): { content: string; thinking: string } {
  let sub = buf.subAgents.get(subAgentId)
  if (!sub) {
    sub = { content: '', thinking: '' }
    buf.subAgents.set(subAgentId, sub)
  }
  return sub
}

function scheduleFlush(): void {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    if (deltaBuffers.size === 0) return
    const snapshot = new Map(deltaBuffers)
    deltaBuffers.clear()
    useChatStore.getState().flushStreamingDeltas(snapshot)
  })
}

/** Flush buffered deltas synchronously (call before non-delta events to preserve ordering) */
function flushNow(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (deltaBuffers.size === 0) return
  const snapshot = new Map(deltaBuffers)
  deltaBuffers.clear()
  useChatStore.getState().flushStreamingDeltas(snapshot)
}

/**
 * Agent 流式事件分发 Hook
 * 处理所有 session 的 Agent 事件，按 sessionId 隔离状态
 *
 * 高频 delta 事件通过 requestAnimationFrame 批量合并，
 * 每帧最多触发一次 store 更新，大幅减少渲染压力。
 */
export function useAgentEvents(): void {
  const handleAgentEvent = useCallback(async (event: ChatEvent): Promise<void> => {
    const sid: string = event.sessionId

    // ---- High-frequency delta events: buffer and flush on rAF ----
    switch (event.type) {
      case 'text_delta':
        getBuffer(sid).content += event.delta
        scheduleFlush()
        return

      case 'thinking_delta':
        getBuffer(sid).thinking += event.delta
        scheduleFlush()
        return

      case 'toolcall_generating':
        if (event.argsDelta !== undefined) {
          getBuffer(sid).toolCallArgsDelta += event.argsDelta
          scheduleFlush()
          return
        }
        break // argsDelta undefined = new tool call start, fall through to non-delta handling

      case 'subagent_text_delta':
        getSubBuf(getBuffer(sid), event.subAgentId).content += event.delta
        scheduleFlush()
        return

      case 'subagent_thinking_delta':
        getSubBuf(getBuffer(sid), event.subAgentId).thinking += event.delta
        scheduleFlush()
        return
    }

    // ---- Non-delta events: flush pending deltas first to preserve ordering ----
    flushNow()

    const store = useChatStore.getState()

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
        // 中断正在播放的 TTS
        if (ttsPlayer.isPlaying || ttsPlayer.isLoading) ttsPlayer.stop()
        break

      case 'text_end':
        break

      case 'toolcall_generating':
        // Only reaches here when argsDelta is undefined (new tool call start)
        store.finalizeStreamingToolCall(sid)
        store.setStreamingToolCall(sid, { toolName: event.toolName, argsText: '' })
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
        // 清除所有流式工具调用状态，工具即将开始执行
        store.setStreamingToolCall(sid, null)
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

      case 'sql_event':
        if (event.action === 'runtime_ready') {
          store.setSessionSql(sid, { ready: true, storageMode: event.storageMode })
        } else {
          store.setSessionSql(sid, null)
        }
        break

      case 'plugin_runtime_event':
        store.setPluginRuntime(sid, event.runtimeId, event.status)
        break

      case 'preview_event':
        if (event.action === 'server_started' && event.url) {
          let url = event.url
          if (window.api?.app?.platform === 'web') {
            url = `${window.location.origin}/shuvix/preview/${sid}/`
          }
          usePreviewStore.getState().openPreview(url)
          usePreviewStore.setState({ isStartingServer: false, isServerRunning: true })
        } else if (event.action === 'server_stopped') {
          usePreviewStore.setState({ isServerRunning: false, isStartingServer: false })
        } else if (event.action === 'open' && event.url) {
          usePreviewStore.getState().openPreview(event.url)
        } else if (event.action === 'close') {
          usePreviewStore.getState().switchToUrl()
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

        // 自动 TTS 朗读
        if (savedMsg && sid === store.activeSessionId) {
          const { voiceTtsEnabled } = useSettingsStore.getState()
          if (voiceTtsEnabled && savedMsg.content?.trim()) {
            ttsPlayer.speak(savedMsg.content.slice(0, 4000), savedMsg.id).catch(() => {})
          }
        }

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
    return () => {
      unsubscribe()
      // Cancel any pending rAF flush on unmount
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      deltaBuffers.clear()
    }
  }, [handleAgentEvent])
}
