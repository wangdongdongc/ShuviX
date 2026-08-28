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
import type {
  AgentHarnessEvent,
  AgentMessage,
  Session,
  SessionTreeEntry
} from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai'
import {
  INLINE_TOKENS_CUSTOM_TYPE,
  aggregateUsage,
  entriesToChatMessages,
  usageDetailOf
} from './projection'
import type { RoundUsageDetail } from './projection'
import type { ChatQueuedMessage } from '@shuvix/chat-protocol/events'
import type {
  ChatEvent,
  ChatMessage,
  RuntimeHttpLog,
  RuntimeLogger,
  ToolResultTransform,
  ToolResultTransformInput
} from '../types'

export interface HarnessEventDeps {
  logger: RuntimeLogger
  httpLog?: RuntimeHttpLog
  getModelId: () => string
  /** 工具结果广播前的瘦身（图片 → 提示文本等）。harness 侧只影响广播，不影响落盘。 */
  transformToolResult: ToolResultTransform
  /**
   * user 消息落盘后是否广播 user_message（默认 true）。
   * 派生 agent 关掉：面板经 sub_session_register 已展示 prompt 卡片，
   * 追问消息由 manager 带着 inlineTokens 手工广播 —— 自动广播会造成重复。
   */
  broadcastUserMessages?: boolean
}

export interface HarnessEventState {
  streamBuffer: { content: string; thinking: string }
  pendingLogIds: string[]
  generatingToolCall: { name: string; argsJson: string } | null
  /**
   * 最近一条已广播的 assistant 卡片 id（= entry id）。
   * 工具事件带上它，前端就知道该把结果回填进哪张卡的哪个块 ——
   * message_end 必定早于它自己那批工具事件，所以这里总是最新的那张。
   */
  assistantMessageId: string | null
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
    pendingLogIds: [],
    generatingToolCall: null,
    assistantMessageId: null
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

/**
 * 本轮结局 —— 取最后一条 assistant 消息的 stopReason。
 *
 * pi 的 stopReason 有五种，但对消费方（通知文案、后续可能的重试提示）只有三种结局：
 * 'stop' / 'length' / 'toolUse' 都是**正常走完**（toolUse 结尾说明后面还有工具轮，
 * 整轮仍是正常收束），'aborted' 是用户按了停止，'error' 是这轮没跑成。
 */
function endReason(last: AssistantMessage | undefined): 'ok' | 'aborted' | 'error' {
  if (last?.stopReason === 'aborted') return 'aborted'
  if (last?.stopReason === 'error') return 'error'
  return 'ok'
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

  // 这条 assistant entry 投影出的整张卡立刻广播（含最后那次终答）——
  // 卡里的工具块此时还没有结果，随后的 tool_end 按 toolCallId 回填。
  // 顺序上先于下面的预展示工具事件，前端拿到 tool_start 时卡片必定已存在。
  const card = projected.find((m) => m.role === 'assistant' && m.type === 'message')
  ctx.state.assistantMessageId = card?.id ?? null
  if (card) {
    ctx.broadcast({
      type: 'assistant_message',
      sessionId: ctx.sessionId,
      messageId: card.id,
      message: JSON.stringify(card)
    })
  }

  ctx.state.streamBuffer = { content: '', thinking: '' }
  ctx.broadcast({ type: 'text_end', sessionId: ctx.sessionId })
}

function handleToolStart(
  ctx: HarnessEventContext,
  event: Extract<AgentHarnessEvent, { type: 'tool_execution_start' }>
): void {
  ctx.broadcast({
    type: 'tool_start',
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    toolArgs: event.args as Record<string, unknown> | undefined,
    messageId: ctx.state.assistantMessageId ?? undefined
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
  const isError = event.isError || false
  // 广播前过一遍宿主注入的瘦身管线（桌面把 ImageContent 换成占位文本）——
  // 否则 read 一张图会把整段 base64 经 IPC 灌进渲染进程再铺到工具卡片上。
  // 只影响广播：entry 树里存的仍是发给模型的原始 toolResult。
  // 宿主不注入时 defaultToolResultTransform 是 passthrough，与改动前逐字节相同。
  const transformed = ctx.deps.transformToolResult({
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    sessionId: ctx.sessionId,
    isError,
    content: (result?.content ?? []) as ToolResultTransformInput['content'],
    details: result?.details
  })

  ctx.broadcast({
    type: 'tool_end',
    sessionId: ctx.sessionId,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: transformed.content,
    isError,
    messageId: ctx.state.assistantMessageId ?? undefined,
    details: transformed.details
  })
}

async function handleAgentEnd(
  ctx: HarnessEventContext,
  event: Extract<AgentHarnessEvent, { type: 'agent_end' }>
): Promise<void> {
  ctx.deps.logger.info(`结束 session=${ctx.sessionId}`)

  // 汇总本次运行（含所有中间工具轮，跨 steer）的 token 用量
  const details: RoundUsageDetail[] = []
  let lastAssistant: AssistantMessage | undefined
  for (const m of event.messages) {
    if (!isAssistant(m)) continue
    lastAssistant = m
    const d = usageDetailOf(m)
    if (d) details.push(d)
  }
  const usage = aggregateUsage(details)

  const entry = await lastEntry(ctx)
  const projected = entry
    ? entriesToChatMessages([entry], ctx.sessionId, ctx.deps.getModelId())
    : []
  // 终答卡在 message_end 时已经广播过（带它自己那次调用的用量）；这里再带一份
  // 只为两件事：前端 TTS 朗读的素材，以及万一 message_end 丢了的兜底 upsert。
  const finalMessage = projected.find(
    (m): m is ChatMessage & { role: 'assistant'; type: 'message' } =>
      m.role === 'assistant' && m.type === 'message'
  )

  ctx.broadcast({
    type: 'agent_end',
    sessionId: ctx.sessionId,
    reason: endReason(lastAssistant),
    message: finalMessage ? JSON.stringify(finalMessage) : undefined,
    usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, details: [] }
  })
}

/**
 * 队列消息 → 面板投影。只取正文与图片数：队列是只读回执，不需要更多。
 *
 * pi 的三条队列存的是完整 AgentMessage，`queue_update` 每次重发全量快照
 * （见 harness 的 emitQueueUpdate），所以这里无状态、纯映射。
 */
function toQueuedMessage(message: AgentMessage): ChatQueuedMessage {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return { text: content, imageCount: 0 }
  if (!Array.isArray(content)) return { text: '', imageCount: 0 }
  let text = ''
  let imageCount = 0
  for (const part of content as Array<{ type?: string; text?: string }>) {
    if (part?.type === 'text') text += part.text ?? ''
    else if (part?.type === 'image') imageCount++
  }
  return { text, imageCount }
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
      ctx.state.assistantMessageId = null
      ctx.state.generatingToolCall = null
      ctx.broadcast({ type: 'agent_start', sessionId: ctx.sessionId })
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
    case 'queue_update':
      // 三条用户消息队列的只读快照 —— 前端整体替换即可（pi 只重发全量）
      ctx.broadcast({
        type: 'queue_update',
        sessionId: ctx.sessionId,
        steer: event.steer.map(toQueuedMessage),
        followUp: event.followUp.map(toQueuedMessage),
        nextTurn: event.nextTurn.map(toQueuedMessage)
      })
      break
    case 'session_compact':
      // 压缩已提交，会话消息列表整体改写 —— 通知前端重拉
      ctx.broadcast({ type: 'messages_reloaded', sessionId: ctx.sessionId })
      break
    default:
      break
  }
}
