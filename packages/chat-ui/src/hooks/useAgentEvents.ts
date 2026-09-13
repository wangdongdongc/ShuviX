import { getChatApi, getSessionChannelApi, useChatHost } from '@shuvix/chat-ui'
import { useEffect, useCallback, useRef } from 'react'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ErrorEventMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { useChatStore, type ChatMessage, type StreamingDeltaBuffer } from '../stores/chatStore'
import { useSubSessionStore, isSubSession } from '../stores/subSessionStore'
import { useBgTaskStore } from '../stores/bgTaskStore'
import { ttsPlayer } from '../services/tts/ttsPlayer'
import { useAppEvent } from './useAppEvents'

/**
 * 构造一条本地 error_event 消息（**不持久化**）。
 *
 * AgentHarness 迁移后消息只能由 harness 产生：模型侧的失败会以 stopReason='error'
 * 的 assistant entry 落盘、并由投影渲染成 error_event；前端侧的错误（连接失败、
 * hook 拒绝等）不再写进会话树，只在当前视图里展示。
 */
async function reportError(sessionId: string, content: string): Promise<ErrorEventMessage> {
  return {
    id: `local-error-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
    sessionId,
    content,
    model: '',
    createdAt: Date.now(),
    role: 'system_notify',
    type: 'error_event',
    metadata: null
  }
}

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

  // 会话标题变更（后端 AI 自动生成 → AppEvent 广播）：各端统一刷新列表标题，单一数据源
  useAppEvent('session.titleChanged', (event) => {
    useChatStore.getState().updateSessionTitle(event.sessionId, event.title)
  })

  // 会话列表成员变化（创建/删除/移动项目）：信号事件 → 重拉全量。覆盖非 UI 发起的变更
  // （IPC/CLI 直建、wiki/memory 去重开会话）与其它窗口的操作；UI 流程自身的乐观刷新照旧。
  // seq 守卫丢弃乱序返回 —— 连续两次变更时旧响应不得覆盖新列表。
  const sessionsRefetchSeq = useRef(0)
  useAppEvent('session.listChanged', () => {
    const seq = ++sessionsRefetchSeq.current
    void getChatApi()
      .session.list()
      .then((sessions) => {
        if (seq === sessionsRefetchSeq.current) useChatStore.getState().setSessions(sessions)
      })
      .catch(() => {
        /* 列表拉取失败：保持现状，等下一次事件/UI 刷新 */
      })
  })

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
        parentToolCallId: event.parentToolCallId,
        subAgentName: event.subAgentName,
        displayName: event.displayName,
        description: event.description,
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        promptInlineTokens: event.inlineTokens,
        contextNote: event.contextNote
      })
      // 刻意不自动打开右侧 Sub-agent 面板：工具派发的（有 parentToolCallId）内联在对话流的
      // ToolCallBlock 卡片中；非工具派发的（如 workflow run() 起的 agent）经工具栏胶囊的
      // 数量徽标可见，用户自己决定看不看 —— 自动弹面板打断当前阅读。
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
        case 'user_message': {
          // 用户追问（继续与子代理对话）：内联到子会话转写
          const msg = JSON.parse(event.message) as ChatMessage
          subStore.appendUserMessage(sid, msg)
          return
        }
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
        case 'assistant_message': {
          // 一次 LLM 调用落盘：整张卡 upsert（工具结果随后按 toolCallId 回填）
          subStore.handleAssistantMessage(sid, JSON.parse(event.message) as ChatMessage)
          return
        }
        case 'tool_start':
          subStore.handleToolStart(sid, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.toolArgs ?? {},
            status: 'running',
            messageId: event.messageId
          })
          return
        case 'tool_end':
          subStore.handleToolEnd(
            sid,
            event.toolCallId,
            {
              status: event.isError ? 'error' : 'done',
              result: event.result,
              details: event.details
            },
            event.messageId
          )
          return
        // 其它事件忽略。多数（input_request / runtime / messages_reloaded）子会话根本不触发；
        // queue_update 会（abort 时 harness 无条件重发一次全量快照），但派生 agent 没有
        // 用户可见的队列入口，收到也无处可显。
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

      case 'assistant_message': {
        // 一次 LLM 调用落盘：清除流式内容 + 按 id upsert 这张卡（单次 set，避免中间帧闪空）
        const card = sid === store.activeSessionId ? JSON.parse(event.message) : null
        store.handleAssistantMessage(sid, card)
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

      case 'queue_update':
        // pi 三条用户消息队列的只读快照（整体替换；不区分是否活跃会话，
        // 队列面板按会话读，切回来时要能看到还排着的东西）
        store.setSessionQueue(sid, {
          steer: event.steer,
          followUp: event.followUp,
          nextTurn: event.nextTurn
        })
        break

      case 'input_request':
        // 统一的"用户输入请求"事件 — 命令询问 / 选择题 / SSH 凭证
        store.addPendingInput(sid, event.request)
        break

      case 'input_request_resolved':
        // 某个 pending 已被解决(本端响应 / 其它前端响应 / agent.abort 都会发出)
        store.removePendingInput(sid, event.requestId)
        break

      case 'tool_start':
        // 工具块已随 assistant 卡到达（message_end 必定早于工具事件），这里只记执行状态
        store.handleToolStart(sid, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.toolArgs ?? {},
          status: 'running',
          messageId: event.messageId
        })
        break

      case 'tool_end':
        // 结果回填进对应卡片的工具块（按 toolCallId 定位）
        store.handleToolEnd(
          sid,
          event.toolCallId,
          {
            status: event.isError ? 'error' : 'done',
            result: event.result,
            details: event.details
          },
          event.messageId
        )
        break

      case 'runtime_event':
        store.setRuntime(sid, event.runtimeId, event.status)
        break

      // 后台任务状态变更（started / exited / killed）。输出不走事件 —— 面板展开时
      // 按字节范围轮询日志文件自取，见 bgTaskStore 的说明。
      case 'bg_task':
        useBgTaskStore.getState().upsert(event.task)
        break

      case 'file_preview':
        // preview 工具（可视化子智能体等）请求打开文件预览：仅当事件属于当前活跃会话时
        // 触发 filePreviewRequest 信号 —— 宿主 useSessionPanelReveal 展开会话面板并切到
        // Files，FilesPanel 相对化路径后打开与点击文件一致的预览。
        // 标记 'agent'：预览面板据此亮出完整路径 —— 这是唯一由智能体（可能受提示注入影响）
        // 发起的预览入口，用户该看见是谁打开了哪个文件。
        if (sid === store.activeSessionId) {
          store.requestFilePreview(event.absPath, 'agent')
        }
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

        // 标题自动生成已下沉到后端（agentSession.prompt，用户输入即触发，不等 agent 响应），
        // 结果经 AppEvent 'session.titleChanged' 广播回来 —— 见本文件底部的 useAppEvent 订阅。
        break
      }

      // ─── 运行时关停（回退/切档案/清空：旧运行时停稳前不许有新的） ───
      case 'agent_closing':
        store.setAgentClosing(sid, event.closing)
        // 关停会把当前 run abort 掉，流式态不会再有后续事件 —— 就地收掉，
        // 免得输入框停留在「运行中」的形态上
        if (event.closing) store.finishStreaming(sid)
        break

      // ─── 消息列表重载（后端整体改写，如 session 工具压缩归档后） ───
      case 'messages_reloaded':
        if (sid === store.activeSessionId) {
          const msgs = await getSessionChannelApi().message.list(sid)
          store.setMessages(msgs)
        }
        break

      case 'error':
        // 错误以独立提示消息形式写入会话（不再使用底部错误条/弹窗）
        store.finishStreaming(sid)
        {
          const content = event.error || 'Unknown error'
          const errorMsg = await reportError(sid, content)
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
    const unsubscribe = getSessionChannelApi().agent.onEvent(handleAgentEvent)
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
