/**
 * AgentHarnessEvent → ChatEvent 转换（宿主无关）。
 *
 * 与旧 eventHandler.ts 最大的差别：**这里不再持久化任何东西**。
 * harness 在 `message_end` 时自己 `session.appendMessage()`，在 `turn_end` 时 flush
 * 待写 entry —— 落盘是它的职责。本模块退化成纯粹的「协议翻译 + 广播」，
 * 旧文件里 addStepText / addToolUse / completeToolUse 那一整套调用全部消失。
 *
 * 消息 id 的来源也随之改变：
 *  - assistant / user 消息 → harness 追加后的 entry id（`session.getLeafId()`，
 *    message_end 时该 entry 已落盘）；
 *  - tool_use → toolCallId（工具事件早于 entry 可见，且 toolCallId 本身全局唯一）。
 * 两者都与 projection.ts 的投影规则一一对应，保证「流式看到的 id」和
 * 「重新加载后投影出的 id」是同一个。
 */
import type { AgentHarnessEvent, Session, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai'
import {
  INLINE_TOKENS_CUSTOM_TYPE,
  aggregateUsage,
  entriesToChatMessages,
  usageDetailOf
} from './projection'
import type { RoundUsageDetail } from './projection'
import type {
  ChatEvent,
  ChatMessage,
  RuntimeHttpLog,
  RuntimeLogger,
  ToolResultTransform
} from '../types'

export interface HarnessEventDeps {
  logger: RuntimeLogger
  httpLog?: RuntimeHttpLog
  getModelId: () => string
  /** 工具结果广播前的瘦身（图片 → 提示文本等）。harness 侧只影响广播，不影响落盘。 */
  transformToolResult: ToolResultTransform
  /** batch 预展示阶段是否跳过该工具（需用户交互的工具返回 true） */
  shouldDeferToolDisplay: (toolName: string, args: Record<string, unknown>) => boolean
  /**
   * user 消息落盘后是否广播 user_message（默认 true）。
   * 派生 agent 关掉：面板经 sub_session_register 已展示 prompt 卡片，
   * 追问消息由 manager 带着 inlineTokens 手工广播 —— 自动广播会造成重复。
   */
  broadcastUserMessages?: boolean
}

export interface HarnessEventState {
  streamBuffer: { content: string; thinking: string }
  turnCounter: number
  pendingLogIds: string[]
  /** 已在 batch 阶段预广播过 tool_start 的 toolCallId */
  preEmittedToolCalls: Set<string>
  generatingToolCall: { name: string; argsJson: string } | null
}

export interface HarnessEventContext {
  sessionId: string
  session: Session
  state: HarnessEventState
  broadcast: (event: ChatEvent) => void
  deps: HarnessEventDeps
}

export function createHarnessEventState(): HarnessEventState {
  return {
    streamBuffer: { content: '', thinking: '' },
    turnCounter: 0,
    pendingLogIds: [],
    preEmittedToolCalls: new Set(),
    generatingToolCall: null
  }
}

/** 取刚落盘的那条 entry（message_end 之后 leaf 即是它） */
async function lastEntry(ctx: HarnessEventContext): Promise<SessionTreeEntry | undefined> {
  const leafId = await ctx.session.getLeafId()
  return leafId ? await ctx.session.getEntry(leafId) : undefined
}

function isAssistant(msg: unknown): msg is AssistantMessage {
  return typeof msg === 'object' && msg !== null && (msg as { role?: string }).role === 'assistant'
}

/** message_update：流式增量广播（唯一还需要 streamBuffer 的地方） */
function handleMessageUpdate(
  ctx: HarnessEventContext,
  event: Extract<AgentHarnessEvent, { type: 'message_update' }>
): void {
  const msgEvent = event.assistantMessageEvent
  if (msgEvent.type === 'text_delta') {
    ctx.state.streamBuffer.content += msgEvent.delta || ''
    ctx.broadcast({ type: 'text_delta', sessionId: ctx.sessionId, delta: msgEvent.delta || '' })
    return
  }
  if (msgEvent.type === 'thinking_delta') {
    ctx.state.streamBuffer.thinking += msgEvent.delta || ''
    ctx.broadcast({ type: 'thinking_delta', sessionId: ctx.sessionId, delta: msgEvent.delta || '' })
    return
  }
  if (msgEvent.type === 'toolcall_start') {
    const block = msgEvent.partial?.content?.[msgEvent.contentIndex ?? 0] as
      | { type: string; name?: string }
      | undefined
    const toolName = block?.type === 'toolCall' ? block.name || '' : ''
    if (toolName) {
      ctx.state.generatingToolCall = { name: toolName, argsJson: '' }
      ctx.broadcast({ type: 'toolcall_generating', sessionId: ctx.sessionId, toolName })
    }
    return
  }
  if (msgEvent.type === 'toolcall_delta') {
    const gen = ctx.state.generatingToolCall
    if (!gen) return
    const delta = msgEvent.delta || ''
    gen.argsJson += delta
    ctx.broadcast({
      type: 'toolcall_generating',
      sessionId: ctx.sessionId,
      toolName: gen.name,
      argsDelta: delta
    })
  }
}

/**
 * message_end：广播这条消息投影出的 ChatMessage。
 *
 * harness 已经把 entry 落盘了，所以这里直接把 entry 投影一遍，把结果发给前端 ——
 * 前端拿到的 id 与「重新加载会话后」投影出的 id 完全一致。
 */
async function handleMessageEnd(
  ctx: HarnessEventContext,
  event: Extract<AgentHarnessEvent, { type: 'message_end' }>
): Promise<void> {
  ctx.state.generatingToolCall = null
  const msg = event.message

  if (!isAssistant(msg)) {
    if (ctx.deps.broadcastUserMessages === false) return
    // 用户消息（含 steer / followUp 注入）：广播供其他前端同步
    const entry = await lastEntry(ctx)
    if (entry) {
      // 父节点若是内联 Token 侧车，一并投影 —— 广播出的气泡与重载后一致（芯片态）
      let slice: SessionTreeEntry[] = [entry]
      if (entry.parentId) {
        const parent = await ctx.session.getEntry(entry.parentId)
        if (parent?.type === 'custom' && parent.customType === INLINE_TOKENS_CUSTOM_TYPE) {
          slice = [parent, entry]
        }
      }
      const [projected] = entriesToChatMessages(slice, ctx.sessionId, ctx.deps.getModelId())
      if (projected) {
        ctx.broadcast({
          type: 'user_message',
          sessionId: ctx.sessionId,
          message: JSON.stringify(projected)
        })
      }
    }
    return
  }

  if (msg.stopReason === 'error' && msg.errorMessage) {
    ctx.deps.logger.error(`API 错误: ${msg.errorMessage}`)
    ctx.broadcast({ type: 'error', sessionId: ctx.sessionId, error: msg.errorMessage })
  }

  // HTTP 日志用量回填
  const logId = ctx.state.pendingLogIds.shift()
  if (logId && ctx.deps.httpLog && msg.usage) {
    let responseJson: string | undefined
    try {
      responseJson = JSON.stringify({ content: msg.content, stopReason: msg.stopReason }, null, 2)
    } catch {
      /* 序列化失败则不存响应 */
    }
    ctx.deps.httpLog.updateUsage(
      logId,
      msg.usage.input,
      msg.usage.output,
      msg.usage.totalTokens,
      responseJson
    )
  }

  if (msg.usage) {
    const promptTokens = (msg.usage.totalTokens || 0) - (msg.usage.output || 0)
    if (promptTokens > 0) {
      ctx.broadcast({ type: 'token_usage', sessionId: ctx.sessionId, promptTokens })
    }
  }

  const entry = await lastEntry(ctx)
  const projected = entry
    ? entriesToChatMessages([entry], ctx.sessionId, ctx.deps.getModelId())
    : []

  // 中间轮（含 toolCall）投影出的 step_* 逐条广播；tool_use 由工具事件负责，此处跳过
  for (const m of projected) {
    if (m.type === 'step_text' || m.type === 'step_thinking') {
      ctx.broadcast({
        type: 'step_end',
        sessionId: ctx.sessionId,
        messageId: m.id,
        message: JSON.stringify(m)
      })
    }
  }

  ctx.state.streamBuffer = { content: '', thinking: '' }
  ctx.broadcast({ type: 'text_end', sessionId: ctx.sessionId })

  // 并行 batch 预展示：≥2 个工具调用时提前铺出卡片（跳过需用户交互的工具）
  const toolCalls = msg.content.filter(
    (c): c is Extract<typeof c, { type: 'toolCall' }> => c.type === 'toolCall'
  )
  if (toolCalls.length >= 2) {
    for (const tc of toolCalls) {
      const args = (tc.arguments || {}) as Record<string, unknown>
      if (ctx.deps.shouldDeferToolDisplay(tc.name, args)) continue
      ctx.broadcast({
        type: 'tool_start',
        sessionId: ctx.sessionId,
        toolCallId: tc.id,
        toolName: tc.name,
        toolArgs: args,
        messageId: tc.id,
        turnIndex: ctx.state.turnCounter
      })
      ctx.state.preEmittedToolCalls.add(tc.id)
    }
  }
}

function handleToolStart(
  ctx: HarnessEventContext,
  event: Extract<AgentHarnessEvent, { type: 'tool_execution_start' }>
): void {
  if (ctx.state.preEmittedToolCalls.has(event.toolCallId)) {
    ctx.state.preEmittedToolCalls.delete(event.toolCallId)
    return
  }
  ctx.broadcast({
    type: 'tool_start',
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    toolArgs: event.args as Record<string, unknown> | undefined,
    messageId: event.toolCallId,
    turnIndex: ctx.state.turnCounter
  })
}

function handleToolEnd(
  ctx: HarnessEventContext,
  event: Extract<AgentHarnessEvent, { type: 'tool_execution_end' }>
): void {
  const result = event.result as
    | {
        content?: Array<TextContent | ImageContent>
        details?: import('../types').ToolResultDetails
      }
    | undefined
  const rawContent = result?.content ?? []
  const broadcastContent =
    rawContent.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n') || ''

  ctx.broadcast({
    type: 'tool_end',
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: broadcastContent,
    isError: event.isError || false,
    messageId: event.toolCallId,
    details: result?.details
  })
}

async function handleAgentEnd(
  ctx: HarnessEventContext,
  event: Extract<AgentHarnessEvent, { type: 'agent_end' }>
): Promise<void> {
  ctx.deps.logger.info(`结束 session=${ctx.sessionId}`)
  ctx.state.preEmittedToolCalls.clear()

  // 汇总本次运行（含所有中间工具轮，跨 steer）的 token 用量
  const details: RoundUsageDetail[] = []
  for (const m of event.messages) {
    if (!isAssistant(m)) continue
    const d = usageDetailOf(m)
    if (d) details.push(d)
  }
  const usage = aggregateUsage(details)

  const entry = await lastEntry(ctx)
  const projected = entry
    ? entriesToChatMessages([entry], ctx.sessionId, ctx.deps.getModelId())
    : []
  const finalMessage = projected.find(
    (m): m is ChatMessage & { role: 'assistant'; type: 'text' } =>
      m.role === 'assistant' && m.type === 'text'
  )
  // 单 entry 投影只带得上末次调用的用量，这里换成整轮聚合 ——
  // 与重载路径（全量投影按轮累计）看到的数字一致。
  if (finalMessage && usage) {
    finalMessage.metadata = { ...finalMessage.metadata, usage }
  }

  ctx.broadcast({
    type: 'agent_end',
    sessionId: ctx.sessionId,
    message: finalMessage ? JSON.stringify(finalMessage) : undefined,
    usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, details: [] }
  })
}

/** 分发入口：AgentHarnessEvent → ChatEvent 广播 */
export async function forwardHarnessEvent(
  ctx: HarnessEventContext,
  event: AgentHarnessEvent
): Promise<void> {
  switch (event.type) {
    case 'agent_start':
      ctx.deps.logger.info(`开始 session=${ctx.sessionId}`)
      ctx.state.streamBuffer = { content: '', thinking: '' }
      ctx.state.turnCounter = 0
      ctx.state.preEmittedToolCalls.clear()
      ctx.state.generatingToolCall = null
      ctx.broadcast({ type: 'agent_start', sessionId: ctx.sessionId })
      break
    case 'turn_start':
      ctx.state.turnCounter += 1
      break
    case 'message_update':
      handleMessageUpdate(ctx, event)
      break
    case 'message_end':
      await handleMessageEnd(ctx, event)
      break
    case 'tool_execution_start':
      handleToolStart(ctx, event)
      break
    case 'tool_execution_end':
      handleToolEnd(ctx, event)
      break
    case 'agent_end':
      await handleAgentEnd(ctx, event)
      break
    // ─── harness 自有事件 ───
    case 'session_compact':
      // 压缩已提交，会话消息列表整体改写 —— 通知前端重拉
      ctx.broadcast({ type: 'messages_reloaded', sessionId: ctx.sessionId })
      break
    default:
      break
  }
}
