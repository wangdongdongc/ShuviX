/**
 * Agent 事件路由（宿主无关）：把 pi-agent-core 的 AgentEvent 转换为 ChatEvent，
 * 并通过注入的 persistence 落库、通过 broadcastEvent 广播。
 *
 * 从桌面版 agentEventHandler.ts 抽取，所有直接 import 的单例（messageService / sessionDao /
 * httpLogService / transformToolResultForPersist / allowList）替换为 ctx.deps 注入。
 */
import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai'
import { isAssistantMessage, isUserMessage } from './messageGuards'
import type {
  ChatEvent,
  ChatMessage,
  MessageMetadata,
  RuntimeStatus,
  RuntimeEventDeps
} from './types'

/** AgentSession 的可变事件状态（直接引用，handler 可读写） */
export interface SessionEventState {
  streamBuffer: {
    content: string
    thinking: string
    images: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
  }
  turnCounter: number
  pendingLogIds: string[]
  /** 已预展示的 toolCallId 集合（并行 batch 预展示用） */
  preEmittedToolCalls: Set<string>
  /** toolCallId → tool_use 消息 ID 的映射（用于 completeToolUse） */
  toolUseMessageIds: Map<string, string>
  /** 当前正在生成的工具调用（LLM 流式输出 tool_use 块期间） */
  generatingToolCall: { name: string; argsJson: string } | null
}

/** 事件处理器上下文 — per-session 直接引用 */
export interface SessionEventHandlerContext {
  sessionId: string
  state: SessionEventState
  broadcastEvent: (event: ChatEvent) => void
  persistStreamBuffer: (extraMeta?: MessageMetadata) => ChatMessage | null
  emitRuntimeEvent: (runtimeId: string, status: RuntimeStatus | null) => void
  deps: RuntimeEventDeps
}

// ─── Handler 实现 ────────────────────────────────────────

function handleAgentStart(ctx: SessionEventHandlerContext): void {
  ctx.deps.logger.info(`开始 session=${ctx.sessionId}`)
  ctx.state.streamBuffer = { content: '', thinking: '', images: [] }
  ctx.state.turnCounter = 0
  ctx.state.preEmittedToolCalls.clear()
  ctx.state.toolUseMessageIds.clear()
  ctx.state.generatingToolCall = null
  ctx.broadcastEvent({ type: 'agent_start', sessionId: ctx.sessionId })
}

function handleTurnStart(ctx: SessionEventHandlerContext): void {
  ctx.state.turnCounter += 1
  ctx.deps.logger.info(`Turn ${ctx.state.turnCounter} 开始 session=${ctx.sessionId}`)
}

function handleTurnEnd(ctx: SessionEventHandlerContext): void {
  ctx.deps.logger.info(`Turn ${ctx.state.turnCounter} 结束 session=${ctx.sessionId}`)
}

/** agent_end 事件：token 统计、持久化 */
function handleAgentEnd(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'agent_end' }>
): void {
  ctx.deps.logger.info(`结束 session=${ctx.sessionId}`)
  ctx.state.preEmittedToolCalls.clear()
  ctx.state.toolUseMessageIds.clear()
  const endMessages = event.messages
  const details: Array<{
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
    stopReason: string
  }> = []
  for (const m of endMessages) {
    if (isAssistantMessage(m) && m.usage) {
      details.push({
        input: m.usage.input || 0,
        output: m.usage.output || 0,
        cacheRead: m.usage.cacheRead || 0,
        cacheWrite: m.usage.cacheWrite || 0,
        total: m.usage.totalTokens || 0,
        stopReason: m.stopReason || ''
      })
    }
  }
  const totalUsage = details.reduce(
    (acc, d) => ({
      input: acc.input + d.input,
      output: acc.output + d.output,
      cacheRead: acc.cacheRead + d.cacheRead,
      cacheWrite: acc.cacheWrite + d.cacheWrite,
      total: acc.total + d.total
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  )
  // 最后一轮 thinking 也独立落库为 step_thinking
  const buf = ctx.state.streamBuffer
  if (buf.thinking) {
    const thinkingMsg = ctx.deps.persistence.addStepThinking({
      sessionId: ctx.sessionId,
      content: buf.thinking,
      turnIndex: ctx.state.turnCounter,
      model: ctx.deps.getModelId()
    })
    ctx.broadcastEvent({
      type: 'step_end',
      sessionId: ctx.sessionId,
      messageId: thinkingMsg.id,
      message: JSON.stringify(thinkingMsg)
    })
    buf.thinking = ''
  }
  const savedMsg = ctx.persistStreamBuffer(
    totalUsage.total > 0 ? { usage: { ...totalUsage, details } } : {}
  )
  ctx.broadcastEvent({
    type: 'agent_end',
    sessionId: ctx.sessionId,
    usage: { ...totalUsage, details },
    message: savedMsg ? JSON.stringify(savedMsg) : undefined
  })
}

/** message_update 事件：累积 text/thinking delta，转发 toolcall 生成状态 */
function handleMessageUpdate(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'message_update' }>
): void {
  const msgEvent = event.assistantMessageEvent
  if (msgEvent.type === 'text_delta') {
    ctx.state.streamBuffer.content += msgEvent.delta || ''
    ctx.broadcastEvent({
      type: 'text_delta',
      sessionId: ctx.sessionId,
      delta: msgEvent.delta || ''
    })
  } else if (msgEvent.type === 'thinking_delta') {
    ctx.state.streamBuffer.thinking += msgEvent.delta || ''
    ctx.broadcastEvent({
      type: 'thinking_delta',
      sessionId: ctx.sessionId,
      delta: msgEvent.delta || ''
    })
  } else if (msgEvent.type === 'toolcall_start') {
    const block = (
      msgEvent as {
        partial?: { content?: Array<{ type: string; name?: string }> }
        contentIndex?: number
      }
    ).partial?.content?.[(msgEvent as { contentIndex?: number }).contentIndex ?? 0]
    const toolName = block?.type === 'toolCall' ? block.name || '' : ''
    if (toolName) {
      ctx.state.generatingToolCall = { name: toolName, argsJson: '' }
      ctx.broadcastEvent({ type: 'toolcall_generating', sessionId: ctx.sessionId, toolName })
    }
  } else if (msgEvent.type === 'toolcall_delta') {
    const gen = ctx.state.generatingToolCall
    if (gen) {
      const delta = (msgEvent as { delta?: string }).delta || ''
      gen.argsJson += delta
      ctx.broadcastEvent({
        type: 'toolcall_generating',
        sessionId: ctx.sessionId,
        toolName: gen.name,
        argsDelta: delta
      })
    }
  }
}

/** message_end 事件：HTTP 日志更新、图片提取、step 持久化、batch 预展示 */
function handleMessageEnd(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'message_end' }>
): void {
  ctx.state.generatingToolCall = null
  const msg = event.message

  // steer 消息（AgentSession.steer() 注入，带 _isSteer 标记）
  if (isUserMessage(msg) && '_isSteer' in msg) {
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((c): c is TextContent => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
    if (text) {
      const steerMsg = ctx.deps.persistence.add({
        sessionId: ctx.sessionId,
        role: 'user',
        type: 'steer',
        content: text,
        model: ctx.deps.getModelId()
      })
      ctx.broadcastEvent({
        type: 'step_end',
        sessionId: ctx.sessionId,
        messageId: steerMsg.id,
        message: JSON.stringify(steerMsg)
      })
    }
    return
  }

  if (isAssistantMessage(msg)) {
    if (msg.stopReason === 'error' && msg.errorMessage) {
      ctx.deps.logger.error(`API 错误: ${msg.errorMessage}`)
      ctx.broadcastEvent({ type: 'error', sessionId: ctx.sessionId, error: msg.errorMessage })
    }
    const logId = ctx.state.pendingLogIds.shift()
    const msgWithImages = msg as AssistantMessage & {
      _images?: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
    }
    if (logId && ctx.deps.httpLog) {
      const usage = msg.usage
      const logImages = msgWithImages._images
      let responseJson: string | undefined
      try {
        const respData: {
          content: AssistantMessage['content']
          stopReason: AssistantMessage['stopReason']
          images?: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
        } = { content: msg.content, stopReason: msg.stopReason }
        if (logImages && logImages.length > 0) {
          respData.images = logImages
        }
        responseJson = JSON.stringify(respData, null, 2)
      } catch {
        /* 序列化失败则不存响应 */
      }
      ctx.deps.httpLog.updateUsage(
        logId,
        usage.input,
        usage.output,
        usage.totalTokens,
        responseJson
      )
    }
    if (msg.usage) {
      const promptTokens = (msg.usage.totalTokens || 0) - (msg.usage.output || 0)
      if (promptTokens > 0) {
        ctx.broadcastEvent({ type: 'token_usage', sessionId: ctx.sessionId, promptTokens })
      }
    }
    const images = msgWithImages._images
    if (images && images.length > 0) {
      ctx.state.streamBuffer.images.push(...images)
      for (const img of images) {
        ctx.broadcastEvent({
          type: 'image_data',
          sessionId: ctx.sessionId,
          image: JSON.stringify({
            data: `data:${img.mimeType};base64,${img.data}`,
            mimeType: img.mimeType
          })
        })
      }
    }
  }

  let rawToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []
  if (isAssistantMessage(msg)) {
    rawToolCalls = (
      msg.content as Array<{
        type: string
        id?: string
        name?: string
        arguments?: Record<string, unknown>
      }>
    )
      .filter((c) => c.type === 'toolCall' && c.id && c.name)
      .map((tc) => ({ id: tc.id!, name: tc.name!, arguments: tc.arguments || {} }))
  }

  // 中间轮次 step 持久化：有工具调用 → 拆分 step_thinking + step_text
  if (rawToolCalls.length > 0) {
    const buf = ctx.state.streamBuffer
    const turnIndex = ctx.state.turnCounter
    const model = ctx.deps.getModelId()

    if (buf.thinking) {
      const thinkingMsg = ctx.deps.persistence.addStepThinking({
        sessionId: ctx.sessionId,
        content: buf.thinking,
        turnIndex,
        model
      })
      ctx.broadcastEvent({
        type: 'step_end',
        sessionId: ctx.sessionId,
        messageId: thinkingMsg.id,
        message: JSON.stringify(thinkingMsg)
      })
    }

    if (buf.content || buf.images.length) {
      const images = buf.images.length
        ? buf.images.map((img) => ({
            data: `data:${img.mimeType};base64,${img.data}`,
            mimeType: img.mimeType,
            ...(img.thoughtSignature && { thoughtSignature: img.thoughtSignature })
          }))
        : undefined
      const textMsg = ctx.deps.persistence.addStepText({
        sessionId: ctx.sessionId,
        content: buf.content,
        turnIndex,
        images,
        model
      })
      ctx.broadcastEvent({
        type: 'step_end',
        sessionId: ctx.sessionId,
        messageId: textMsg.id,
        message: JSON.stringify(textMsg)
      })
    }

    ctx.state.streamBuffer = { content: '', thinking: '', images: [] }
  }

  let batchToolCalls: typeof rawToolCalls | null = null
  if (rawToolCalls.length >= 2) {
    batchToolCalls = rawToolCalls
  }

  ctx.broadcastEvent({ type: 'text_end', sessionId: ctx.sessionId })

  // 并行 batch 预展示（跳过需用户交互的工具）
  if (batchToolCalls) {
    const turnIndex = ctx.state.turnCounter
    const model = ctx.deps.getModelId()
    for (const tc of batchToolCalls) {
      if (ctx.deps.shouldDeferToolDisplay(tc.name, tc.arguments)) continue
      const toolUseMsg = ctx.deps.persistence.addToolUse({
        sessionId: ctx.sessionId,
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.arguments,
        turnIndex,
        model
      })
      ctx.state.toolUseMessageIds.set(tc.id, toolUseMsg.id)
      ctx.broadcastEvent({
        type: 'tool_start',
        sessionId: ctx.sessionId,
        toolCallId: tc.id,
        toolName: tc.name,
        toolArgs: tc.arguments,
        messageId: toolUseMsg.id,
        turnIndex
      })
      ctx.state.preEmittedToolCalls.add(tc.id)
    }
  }
}

/** tool_execution_start 事件：持久化 tool_call */
function handleToolExecutionStart(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'tool_execution_start' }>
): void {
  if (ctx.state.preEmittedToolCalls.has(event.toolCallId)) {
    ctx.state.preEmittedToolCalls.delete(event.toolCallId)
    return
  }
  const args = event.args as Record<string, unknown> | undefined
  const toolUseMsg = ctx.deps.persistence.addToolUse({
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args,
    turnIndex: ctx.state.turnCounter,
    model: ctx.deps.getModelId()
  })
  ctx.state.toolUseMessageIds.set(event.toolCallId, toolUseMsg.id)
  ctx.broadcastEvent({
    type: 'tool_start',
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    toolArgs: args,
    messageId: toolUseMsg.id,
    turnIndex: ctx.state.turnCounter
  })
}

/** tool_execution_end 事件：持久化 tool_result */
function handleToolExecutionEnd(
  ctx: SessionEventHandlerContext,
  event: Extract<AgentEvent, { type: 'tool_execution_end' }>
): void {
  const result = event.result as
    | { content?: Array<TextContent | ImageContent>; details?: import('./types').ToolResultDetails }
    | undefined
  const rawContent = result?.content ?? []
  const broadcastContent =
    rawContent
      .map((c: TextContent | ImageContent) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n') || ''

  const { content: persistContent, details: persistDetails } = ctx.deps.transformToolResult({
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    sessionId: ctx.sessionId,
    isError: event.isError || false,
    content: rawContent as Array<{ type: string; text?: string }>,
    details: result?.details
  })

  const toolUseMessageId = ctx.state.toolUseMessageIds.get(event.toolCallId)
  if (toolUseMessageId) {
    ctx.deps.persistence.completeToolUse({
      messageId: toolUseMessageId,
      content: persistContent,
      isError: event.isError || false,
      details: persistDetails
    })
    ctx.state.toolUseMessageIds.delete(event.toolCallId)
  }
  ctx.broadcastEvent({
    type: 'tool_end',
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: broadcastContent,
    isError: event.isError || false,
    messageId: toolUseMessageId,
    details: result?.details
  })
}

// ─── 对外分发入口 ──────────────────────────────────────

/** 将 pi-agent-core 事件转换并广播（薄分发器） */
export function forwardAgentEvent(ctx: SessionEventHandlerContext, event: AgentEvent): void {
  switch (event.type) {
    case 'agent_start':
      handleAgentStart(ctx)
      break
    case 'turn_start':
      handleTurnStart(ctx)
      break
    case 'turn_end':
      handleTurnEnd(ctx)
      break
    case 'agent_end':
      handleAgentEnd(ctx, event)
      break
    case 'message_update':
      handleMessageUpdate(ctx, event)
      break
    case 'message_end':
      handleMessageEnd(ctx, event)
      break
    case 'tool_execution_start':
      handleToolExecutionStart(ctx, event)
      break
    case 'tool_execution_end':
      handleToolExecutionEnd(ctx, event)
      break
    default:
      break
  }
}
