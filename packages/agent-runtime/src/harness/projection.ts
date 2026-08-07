/**
 * SessionTreeEntry[] → ChatMessage[] 投影 —— harness 会话树的「UI 视角」。
 *
 * 这是替换 transcript/convert.ts 正向投影（ChatMessage → AgentMessage）之后留下的唯一方向：
 * entry 树是真理，UI 看到的是它的投影。旧模型里 DB 行本身就是 UI 契约，
 * 现在需要一次结构变换 —— 主要是「一条 assistant 消息内部的内容块」摊平成
 * chat-ui 期待的多条 ChatMessage。
 *
 * 映射规则（刻意贴住 chat-ui 现有渲染，避免改前端）：
 *   user 消息            → UserTextMessage
 *   assistant 无 toolCall → 终答：AssistantTextMessage（thinking / usage 收进 metadata）
 *   assistant 有 toolCall → 中间轮：thinking→step_thinking，text→step_text，toolCall→tool_use
 *   toolResult 消息      → 回填到同 toolCallId 的 tool_use 上（不产生独立气泡）
 *   compactionSummary    → AssistantTextMessage + isCompactionSummary
 *   custom(instruction)  → UserTextMessage + isInstructionInjection
 *   stopReason==='error' → ErrorEventMessage
 *
 * id 稳定性：直接派生自 entry id（`<entryId>` / `<entryId>:c<idx>` …）。entry 是 append-only 的，
 * 所以同一条消息在任何一次重新投影里 id 都不变 —— React key、messages_reloaded、
 * 流式增量更新都依赖这一点。
 */
import type { AgentMessage, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai'
import type {
  ChatMessage,
  ImageMeta,
  ToolResultDetails
} from '@shuvix/chat-protocol/types/chatMessage'

/** 指令注入使用的 custom_message 类型标记（与 instructionInjector 共用） */
export const INSTRUCTION_CUSTOM_TYPE = 'instruction'

/**
 * 自动压缩标记：`HarnessSession.maybeAutoCompact` 在 compaction entry 之后追加的
 * 纯 custom entry。不进模型上下文（pi 对 custom 默认零投影），只供本投影把
 * 紧邻的压缩摘要卡片标成「自动压缩」。
 */
export const AUTO_COMPACT_CUSTOM_TYPE = 'auto_compact'

/** 单次 LLM 调用的用量明细（UsageInfo.details 元素，全字段必填 —— 兼容 ChatTokenUsage） */
export interface RoundUsageDetail {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  stopReason: string
}

/** 从一条 assistant 消息提取本次调用的用量明细 */
export function usageDetailOf(msg: AssistantMessage): RoundUsageDetail | undefined {
  const usage = msg.usage
  if (!usage) return undefined
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.totalTokens || usage.input + usage.output,
    stopReason: msg.stopReason || ''
  }
}

/** 聚合用量：全字段必填，可同时充当消息元数据的 UsageInfo 与 agent_end 事件的 ChatTokenUsage */
export interface AggregatedUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  details: RoundUsageDetail[]
}

/**
 * 各次调用明细 → 聚合用量。
 *
 * 终答气泡显示的是**整轮**（含所有中间工具轮）的消耗，details 保留逐次明细
 * 供 UI 展开 —— 与旧模型里 eventHandler 落库到最终消息的形状一致。
 */
export function aggregateUsage(details: RoundUsageDetail[]): AggregatedUsage | undefined {
  if (details.length === 0) return undefined
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const d of details) {
    sum.input += d.input
    sum.output += d.output
    sum.cacheRead += d.cacheRead
    sum.cacheWrite += d.cacheWrite
    sum.total += d.total
  }
  return { ...sum, details: [...details] }
}

/** 内容块数组 → 纯文本（丢弃非文本块） */
function textOf(content: string | Array<TextContent | ImageContent>): string {
  if (typeof content === 'string') return content
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('')
}

/** 内容块数组 → 图片元数据 */
function imagesOf(content: string | Array<TextContent | ImageContent>): ImageMeta[] | undefined {
  if (typeof content === 'string') return undefined
  const imgs = content
    .filter((c): c is ImageContent => c.type === 'image')
    .map((c) => ({ data: c.data, mimeType: c.mimeType }))
  return imgs.length > 0 ? imgs : undefined
}

interface ProjectionState {
  out: ChatMessage[]
  /** toolCallId → 已产出的 tool_use 消息（等待 toolResult 回填） */
  pendingToolUse: Map<string, ChatMessage & { type: 'tool_use' }>
  /**
   * 当前生效的模型 / provider（由 model_change entry 推进）。
   *
   * assistant 消息不用这两个值 —— pi 的 AssistantMessage 自带 `provider` / `model`，
   * 记录的是**实际产出该消息**的模型，比"会话当前配置"更准（中途切过模型时尤其）。
   * 这里的值只给 user / step / tool_use 这些没有自身归属的消息兜底。
   */
  model: string
  provider: string
  turnIndex: number
  /**
   * 自上一个终答以来各次 LLM 调用的用量明细。终答时聚合挂载并清空 ——
   * 中间工具轮的 usage 不随 step_* 消息丢失，而是累进最终气泡的统计里。
   * 不在 user 消息处重置：steer 会在轮中插入 user 消息，重置会把 steer 前的消耗算丢。
   */
  roundUsage: RoundUsageDetail[]
}

function projectUserMessage(
  state: ProjectionState,
  entryId: string,
  sessionId: string,
  msg: Extract<AgentMessage, { role: 'user' }>,
  createdAt: number
): void {
  state.out.push({
    id: entryId,
    sessionId,
    role: 'user',
    type: 'text',
    content: textOf(msg.content),
    model: state.model,
    provider: state.provider,
    createdAt,
    metadata: { images: imagesOf(msg.content) }
  })
  state.turnIndex += 1
}

function projectAssistantMessage(
  state: ProjectionState,
  entryId: string,
  sessionId: string,
  msg: AssistantMessage,
  createdAt: number
): void {
  // 实际产出这条消息的模型/provider，取自消息自身而非会话当前配置
  const model = msg.model || state.model
  const provider = msg.provider || state.provider

  // 每条 assistant 消息 = 一次 LLM 调用，无论中间轮/终答/失败轮都计入本轮用量
  const detail = usageDetailOf(msg)
  if (detail) state.roundUsage.push(detail)

  // 失败轮：整条消息塌成一条 error_event（旧模型里由 eventHandler 单独落库）
  if (msg.stopReason === 'error' && msg.errorMessage) {
    state.out.push({
      id: entryId,
      sessionId,
      role: 'system_notify',
      type: 'error_event',
      content: msg.errorMessage,
      model,
      provider,
      createdAt,
      metadata: null
    })
    return
  }

  const toolCalls = msg.content.filter((c) => c.type === 'toolCall')
  const isFinalAnswer = toolCalls.length === 0
  const thinking = msg.content
    .filter((c): c is Extract<typeof c, { type: 'thinking' }> => c.type === 'thinking')
    .map((c) => c.thinking)
    .join('\n')
  const text = msg.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('')
  const images = (msg as AssistantMessage & { _images?: ImageMeta[] })._images

  if (isFinalAnswer) {
    state.out.push({
      id: entryId,
      sessionId,
      role: 'assistant',
      type: 'text',
      content: text,
      model,
      provider,
      createdAt,
      metadata: {
        thinking: thinking || undefined,
        usage: aggregateUsage(state.roundUsage),
        images
      }
    })
    state.roundUsage = []
    return
  }

  // 中间轮：thinking / text 作为 step 呈现，toolCall 各自成一条 tool_use
  if (thinking) {
    state.out.push({
      id: `${entryId}:think`,
      sessionId,
      role: 'assistant',
      type: 'step_thinking',
      content: thinking,
      model,
      provider,
      createdAt,
      metadata: { turnIndex: state.turnIndex }
    })
  }
  if (text) {
    state.out.push({
      id: `${entryId}:text`,
      sessionId,
      role: 'assistant',
      type: 'step_text',
      content: text,
      model,
      provider,
      createdAt,
      metadata: { turnIndex: state.turnIndex, images }
    })
  }
  msg.content.forEach((block) => {
    if (block.type !== 'toolCall') return
    const toolUse: ChatMessage & { type: 'tool_use' } = {
      // 用 toolCallId 而不是 entry id 派生：工具事件（tool_start/tool_end）在
      // assistant entry 落盘之前就要广播 messageId，而 toolCallId 此时已经有了。
      id: block.id,
      sessionId,
      role: 'assistant',
      type: 'tool_use',
      // content 是工具结果文本，toolResult 到达时回填；未回填 = 仍在执行
      content: '',
      model,
      provider,
      createdAt,
      metadata: {
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments as Record<string, unknown>,
        turnIndex: state.turnIndex
      }
    }
    state.out.push(toolUse)
    state.pendingToolUse.set(block.id, toolUse)
  })
}

function projectToolResult(
  state: ProjectionState,
  msg: Extract<AgentMessage, { role: 'toolResult' }>
): void {
  const target = state.pendingToolUse.get(msg.toolCallId)
  if (!target) return // 孤儿结果（历史被压缩截断）——静默丢弃，UI 无处挂载
  target.content = textOf(msg.content)
  if (target.metadata) {
    target.metadata.isError = msg.isError || undefined
    target.metadata.details = (msg as { details?: ToolResultDetails }).details
  }
  state.pendingToolUse.delete(msg.toolCallId)
}

/**
 * 把（已过 buildContextEntries 变换的）entry 列表投影成 UI 消息列表。
 *
 * @param entries   会话树 entry（通常是 `session.buildContextEntries()` 的结果）
 * @param sessionId 会话 id（写进每条 ChatMessage）
 * @param fallbackModel entry 里没有 model_change 时使用的模型 id
 */
export function entriesToChatMessages(
  entries: readonly SessionTreeEntry[],
  sessionId: string,
  fallbackModel = ''
): ChatMessage[] {
  const state: ProjectionState = {
    out: [],
    pendingToolUse: new Map(),
    model: fallbackModel,
    provider: '',
    turnIndex: 0,
    roundUsage: []
  }

  for (const entry of entries) {
    const createdAt = Date.parse(entry.timestamp) || 0

    if (entry.type === 'model_change') {
      state.model = entry.modelId
      state.provider = entry.provider
      continue
    }

    if (entry.type === 'compaction') {
      state.out.push({
        id: entry.id,
        sessionId,
        role: 'assistant',
        type: 'text',
        content: entry.summary,
        model: state.model,
        provider: state.provider,
        createdAt,
        metadata: { isCompactionSummary: true }
      })
      continue
    }

    if (entry.type === 'custom') {
      // 自动压缩标记：回溯装饰最近一条压缩摘要卡片（标记总是紧跟 compaction 追加）
      if (entry.customType === AUTO_COMPACT_CUSTOM_TYPE) {
        for (let i = state.out.length - 1; i >= 0; i--) {
          const msg = state.out[i]
          if (
            msg.role === 'assistant' &&
            msg.type === 'text' &&
            msg.metadata?.isCompactionSummary
          ) {
            msg.metadata.autoCompacted = true
            break
          }
        }
      }
      continue
    }

    if (entry.type === 'custom_message') {
      if (entry.customType !== INSTRUCTION_CUSTOM_TYPE || !entry.display) continue
      const details = entry.details as { filename?: string } | undefined
      state.out.push({
        id: entry.id,
        sessionId,
        role: 'user',
        type: 'text',
        content: textOf(entry.content),
        model: state.model,
        provider: state.provider,
        createdAt,
        metadata: {
          isInstructionInjection: true,
          instructionFilename: details?.filename
        }
      })
      continue
    }

    if (entry.type !== 'message') continue

    const msg = entry.message
    switch (msg.role) {
      case 'user':
        projectUserMessage(state, entry.id, sessionId, msg, createdAt)
        break
      case 'assistant':
        projectAssistantMessage(state, entry.id, sessionId, msg as AssistantMessage, createdAt)
        break
      case 'toolResult':
        projectToolResult(state, msg as Extract<AgentMessage, { role: 'toolResult' }>)
        break
      default:
        // bashExecution / branchSummary / compactionSummary 由 entry 层处理或 ShuviX 不产生
        break
    }
  }

  return state.out
}
