import { getChatApi, useChatHost } from '@shuvix/chat-ui'
import { useEffect, useCallback, useRef } from 'react'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { useChatStore, type ChatMessage, type StreamingDeltaBuffer } from '../stores/chatStore'
import { useSubSessionStore, isSubSession } from '../stores/subSessionStore'
import { ttsPlayer } from '../services/tts/ttsPlayer'
import i18n from 'i18next'

/** 根据 URL hash 判断当前是否是独立设置窗口 */
const isSettingsWindow = window.location.hash.startsWith('#settings')

// ---- Streaming delta rAF buffer ----
// High-frequency delta events (text, thinking, toolcall args) are accumulated here
// and flushed to the store once per animation frame, reducing hundreds of store
// updates per second down to ~60.

const deltaBuffers = new Map<string, StreamingDeltaBuffer>()
let rafId: number | null = null

function getBuffer(sessionId: string): StreamingDeltaBuffer {
  let buf = deltaBuffers.get(sessionId)
  if (!buf) {
    buf = { content: '', thinking: '', toolCallArgsDelta: '' }
    deltaBuffers.set(sessionId, buf)
  }
  return buf
}

function dispatchFlush(snapshot: Map<string, StreamingDeltaBuffer>): void {
  const mainBuf = new Map<string, StreamingDeltaBuffer>()
  for (const [sid, buf] of snapshot) {
    if (isSubSession(sid)) {
      // 子会话：直接 apply 到 subSessionStore（不走 chatStore 的 flushStreamingDeltas）
      const subState = useSubSessionStore.getState()
      if (buf.content) subState.appendTextDelta(sid, buf.content)
      if (buf.thinking) subState.appendThinkingDelta(sid, buf.thinking)
      if (buf.toolCallArgsDelta) subState.appendStreamingToolCallDelta(sid, buf.toolCallArgsDelta)
    } else {
      mainBuf.set(sid, buf)
    }
  }
  if (mainBuf.size > 0) useChatStore.getState().flushStreamingDeltas(mainBuf)
}

function scheduleFlush(): void {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    if (deltaBuffers.size === 0) return
    const snapshot = new Map(deltaBuffers)
    deltaBuffers.clear()
    dispatchFlush(snapshot)
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
  dispatchFlush(snapshot)
}

/**
 * Agent 流式事件分发 Hook
 * 处理所有 session 的 Agent 事件，按 sessionId 隔离状态
 *
 * 高频 delta 事件通过 requestAnimationFrame 批量合并，
 * 每帧最多触发一次 store 更新，大幅减少渲染压力。
 */
export function useAgentEvents(): void {
  // TTS 自动朗读开关来自宿主注入（语音为可选端口）；用 ref 供事件回调内同步读取
  const host = useChatHost()
  const ttsEnabledRef = useRef(host.voice?.ttsEnabled)
  useEffect(() => {
    ttsEnabledRef.current = host.voice?.ttsEnabled
  }, [host.voice?.ttsEnabled])

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
    }

    // ---- Non-delta events: flush pending deltas first to preserve ordering ----
    flushNow()

    // sub_session_register / sub_session_end 由 subSessionStore 消费（与 chatStore 无关）
    if (event.type === 'sub_session_register') {
      useSubSessionStore.getState().register({
        subSessionId: event.sessionId,
        parentSessionId: event.parentSessionId,
        subAgentName: event.subAgentName,
        displayName: event.displayName,
        description: event.description,
        systemPrompt: event.systemPrompt,
        prompt: event.prompt
      })
      // 注：右侧 Sub-agent 面板的自动切换由宿主的 useRightPanelBridge 处理（面板属宿主外壳，不在对话框内）
      return
    }
    if (event.type === 'sub_session_end') {
      useSubSessionStore.getState().markEnded({
        subSessionId: event.sessionId,
        result: event.result,
        isError: event.isError
      })
      return
    }

    // 子会话的流式事件：路由到 subSessionStore
    if (isSubSession(sid)) {
      const subStore = useSubSessionStore.getState()
      switch (event.type) {
        case 'agent_start':
          subStore.handleAgentStart(sid)
          return
        case 'agent_end': {
          const finalMsg = event.message ? (JSON.parse(event.message) as ChatMessage) : undefined
          subStore.handleAgentEnd(sid, finalMsg)
          return
        }
        case 'toolcall_generating':
          subStore.finalizeStreamingToolCall(sid)
          subStore.setStreamingToolCall(sid, { toolName: event.toolName, argsText: '' })
          return
        case 'tool_start': {
          const toolMsg: ChatMessage | null = event.messageId
            ? ({
                id: event.messageId,
                sessionId: sid,
                role: 'assistant' as const,
                type: 'tool_use' as const,
                content: '',
                metadata: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.toolArgs ?? {}
                },
                model: '',
                createdAt: Date.now()
              } as ChatMessage)
            : null
          subStore.handleToolStart(
            sid,
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.toolArgs ?? {},
              turnIndex: event.turnIndex,
              status: 'running',
              messageId: event.messageId
            },
            toolMsg
          )
          return
        }
        case 'tool_end': {
          const entry = useSubSessionStore.getState().subSessions[sid]
          const existing = entry?.messages.find((m) => m.id === event.messageId)
          let updated: ChatMessage | null = null
          if (existing && existing.type === 'tool_use') {
            updated = {
              ...existing,
              content: event.result || '',
              metadata: {
                ...(existing.metadata as unknown as Record<string, unknown>),
                isError: event.isError || false,
                details: event.details
              }
            } as ChatMessage
          }
          subStore.handleToolEnd(
            sid,
            event.toolCallId,
            {
              status: event.isError ? 'error' : 'done',
              result: event.result,
              details: event.details
            },
            event.messageId,
            updated
          )
          return
        }
        // 其它事件（step_end / input_request / runtime / compaction 等）子会话不会触发；忽略。
        default:
          return
      }
    }

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
        // 原子操作：清除流式内容 + 添加 step 消息（单次 set，避免中间帧闪空）
        const stepMsg =
          sid === store.activeSessionId && event.message ? JSON.parse(event.message) : null
        store.handleStepEnd(sid, stepMsg)
        break
      }

      case 'image_data':
        store.appendStreamingImage(sid, JSON.parse(event.image))
        break

      case 'token_usage':
        if (sid === store.activeSessionId) {
          store.setUsedContextTokens(event.promptTokens > 0 ? event.promptTokens : null)
        }
        break

      case 'tool_start': {
        // 原子操作：清除流式工具调用 + 添加执行状态 + 构造临时消息（单次 set，避免闪烁）
        // 工具执行状态统一为 'running';"等待用户输入"由独立的 input_request 事件驱动
        const toolMsg =
          sid === store.activeSessionId && event.messageId
            ? ({
                id: event.messageId,
                sessionId: sid,
                role: 'assistant' as const,
                type: 'tool_use' as const,
                content: '',
                metadata: {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.toolArgs ?? {}
                },
                model: '',
                createdAt: Date.now()
              } as ChatMessage)
            : null

        store.handleToolStart(
          sid,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.toolArgs ?? {},
            turnIndex: event.turnIndex,
            status: 'running',
            messageId: event.messageId
          },
          toolMsg
        )
        break
      }

      case 'input_request':
        // 统一的"用户输入请求"事件 — 命令审批 / 选择题 / SSH 凭证
        store.addPendingInput(sid, event.request)
        break

      case 'input_request_resolved':
        // 某个 pending 已被解决(本端响应 / 其它前端响应 / agent.abort 都会发出)
        store.removePendingInput(sid, event.requestId)
        break

      case 'tool_end': {
        // 原子操作：更新执行状态 + 替换消息（单次 set，避免闪烁）
        const execUpdates = {
          status: (event.isError ? 'error' : 'done') as 'done' | 'error',
          result: event.result,
          details: event.details
        }

        // 从现有消息中找到并更新，避免 async 获取
        let updatedToolMsg: ChatMessage | null = null
        if (sid === store.activeSessionId && event.messageId) {
          const existing = store.messages.find((m) => m.id === event.messageId)
          if (existing && existing.type === 'tool_use') {
            updatedToolMsg = {
              ...existing,
              content: event.result || '',
              metadata: {
                ...(existing.metadata as unknown as Record<string, unknown>),
                isError: event.isError || false,
                details: event.details
              }
            } as ChatMessage
          }
        }

        store.handleToolEnd(sid, event.toolCallId, execUpdates, event.messageId, updatedToolMsg)
        break
      }

      case 'runtime_event':
        store.setRuntime(sid, event.runtimeId, event.status)
        break

      // 注：browser_event（右侧浏览器/预览面板）由宿主的 useRightPanelBridge 处理，对话框本身不响应

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
          const voiceTtsEnabled = ttsEnabledRef.current
          if (voiceTtsEnabled && savedMsg.content?.trim()) {
            ttsPlayer.speak(savedMsg.content.slice(0, 4000), savedMsg.id).catch(() => {})
          }
        }

        // 两次标题生成策略(参考 Claude Code):
        //   - 首轮(textMsgCount ≤ 2):快速粗生成,基于第一轮 user+assistant
        //   - 第三轮(textMsgCount 3-4):精化重生成,基于更多上下文(最后 1000 字)
        //   - 之后不再触发
        // 未配置标题模型时,后端 generateTitle 直接返回 null,不浪费调用
        if (savedMsg && sid === store.activeSessionId) {
          const currentSession = store.sessions.find((s) => s.id === sid)
          const defaultTitle = i18n.t('agent.defaultTitle')
          const isUntitled = !currentSession || currentSession.title === defaultTitle
          const sidMsgs = await getChatApi().message.list(sid)
          const textMsgCount = sidMsgs.filter(
            (m: ChatMessage) => m.type === 'text' || !m.type
          ).length
          // 首轮:isUntitled 才触发;第三轮:无条件触发(覆盖粗标题)
          const shouldGenerate =
            (isUntitled && textMsgCount <= 2) || (textMsgCount >= 3 && textMsgCount <= 4)
          if (shouldGenerate) {
            // 拼接对话最后 1000 字符作为输入
            const MAX_CHARS = 1000
            const conversationText = sidMsgs
              .filter(
                (m: ChatMessage) =>
                  (m.role === 'user' || m.role === 'assistant') && m.type === 'text'
              )
              .map((m: ChatMessage) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
              .join('\n')
              .slice(-MAX_CHARS)
            if (conversationText.trim()) {
              getChatApi()
                .session.generateTitle({ sessionId: sid, conversationText })
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

      // ─── 压缩归档事件 ───────────────────────────
      case 'compaction_start':
        store.setCompacting(sid, true)
        break

      case 'compaction_end':
        store.setCompacting(sid, false)
        // 替换整个消息列表：指令注入消息在前，摘要消息在后
        if (sid === store.activeSessionId && event.message) {
          const msgs: ChatMessage[] = []
          if (event.instructionMessages?.length) {
            for (const im of event.instructionMessages) msgs.push(JSON.parse(im))
          }
          msgs.push(JSON.parse(event.message))
          store.setMessages(msgs)
        }
        // 后端在压缩结束时 invalidate 了 AgentSession，需要重建以便后续 prompt 生效
        await getChatApi().agent.init({ sessionId: sid })
        break

      case 'compaction_error':
        store.setCompacting(sid, false)
        // 把压缩失败错误写为一条 error_event 消息,UI 上能看到原因
        {
          const errorMsg = await getChatApi().message.addErrorEvent({
            sessionId: sid,
            content: `压缩失败: ${event.error || 'Unknown error'}`
          })
          if (sid === store.activeSessionId) store.addMessage(errorMsg)
        }
        break

      case 'instructions_injected':
        // 懒注入：将后端写入的指令消息追加到当前会话消息列表
        if (sid === store.activeSessionId && event.messages?.length) {
          for (const im of event.messages) store.addMessage(JSON.parse(im))
        }
        break

      case 'error':
        // 错误以独立提示消息形式写入会话（不再使用底部错误条/弹窗）
        store.finishStreaming(sid)
        {
          const content = event.error || 'Unknown error'
          const errorMsg = await getChatApi().message.addErrorEvent({
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
    const unsubscribe = getChatApi().agent.onEvent(handleAgentEvent)
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
