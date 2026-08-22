/**
 * SessionTreeEntry[] → ChatMessage[] 投影 —— harness 会话树的「UI 视角」。
 *
 * **一条 entry = 一条 ChatMessage = UI 上一项**。这是投影层唯一的结构规则：
 * 会话树里没有「一次 agent 循环」这种东西，所以 UI 也不再有 —— 一次 LLM 调用
 * （一条 assistant entry）投影成一条带 blocks 的助手消息，卡内按模型输出顺序
 * 渲染思考 / 正文 / 工具调用；轮中插入的 steer 就是它本来的样子：一条用户消息。
 *
 * 映射规则：
 *   user 消息            → UserTextMessage
 *   assistant 消息       → AssistantMessage（thinking/text/toolCall → blocks，usage 记本次调用）
 *   toolResult 消息      → 回填到同 toolCallId 的 tool 块上（不产生独立消息）
 *   compactionSummary    → AssistantMessage + isCompactionSummary
 *   custom(instruction)  → UserTextMessage + isInstructionInjection
 *   custom(inline_tokens)→ 不产出消息；把紧随其后的 user 消息还原成标记文本 + inlineTokens
 *   stopReason==='error' → ErrorEventMessage
 *
 * id 稳定性：消息 id **就是** entry id（不再有 `:think` / `:text` 派生后缀，工具块也不
 * 单独占 id）。entry 是 append-only 的，所以同一条消息在任何一次重新投影里 id 都不变 ——
 * React key、messages_reloaded、流式增量更新、回退定位都依赖这一点。
 */
import type { AgentMessage, SessionTreeEntry } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai'
import type {
  AssistantBlock,
  AssistantToolBlock,
  ChatMessage,
  ImageMeta,
  InlineToken,
  ToolResultDetails,
  UsageInfo
} from '@shuvix/chat-protocol/types/chatMessage'
import { hasThinkingContent } from '@shuvix/chat-protocol/utils/thinking'

/** 指令注入使用的 custom_message 类型标记（与 instructionInjector 共用） */
export const INSTRUCTION_CUSTOM_TYPE = 'shuvix:instruction'

/**
 * 内联 Token 显示侧车：`HarnessSession.prompt` 在 user 消息 entry **之前**追加的
 * 纯 custom entry，携带「带 {{shuvixInlineToken:uid}} 标记的原始文本 + tokens 字典」。
 *
 * 动机：harness 落盘的 user 消息是**展开后的全文**（LLM 的真理源 —— 轮次上下文、
 * 滚动压缩、标题生成看到的都是它，无二义）；而 UI 芯片（slash 命令 / @文件 / 长文粘贴）
 * 需要标记态原文。旧模型把标记文本存在 messages 行、只对 LLM 展开；迁移后树里只剩
 * 展开文本，芯片信息丢失。侧车恢复显示态：不进模型上下文，仅供本投影把紧随其后的
 * user 消息还原成「标记文本 + metadata.inlineTokens」。
 */
export const INLINE_TOKENS_CUSTOM_TYPE = 'shuvix:inline_tokens'

/** 侧车 entry 的 data 形状（HarnessSession.prompt 写入 / 本投影读取） */
export interface InlineTokensSidecar {
  /** 带 {{shuvixInlineToken:uid}} 标记的原始展示文本 */
  content: string
  /** uid → InlineToken 字典 */
  tokens: Record<string, InlineToken>
}

function asInlineTokensSidecar(data: unknown): InlineTokensSidecar | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as { content?: unknown; tokens?: unknown }
  if (typeof d.content !== 'string') return null
  if (typeof d.tokens !== 'object' || d.tokens === null) return null
  return d as unknown as InlineTokensSidecar
}

/**
 * 单条 assistant 消息的用量 —— 一条 entry = 一次 LLM 调用，所以这就是它自己的账。
 * 整轮聚合（跨工具轮、跨 steer）只存在于 agent_end 事件里，不进消息元数据。
 */
export function usageOf(msg: AssistantMessage): UsageInfo | undefined {
  const usage = msg.usage
  if (!usage) return undefined
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.totalTokens || usage.input + usage.output
  }
}

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
  /** toolCallId → 已产出的工具块（等待 toolResult 回填） */
  pendingToolBlocks: Map<string, AssistantToolBlock>
  /**
   * 当前生效的模型 / provider（由 model_change entry 推进）。
   *
   * assistant 消息不用这两个值 —— pi 的 AssistantMessage 自带 `provider` / `model`，
   * 记录的是**实际产出该消息**的模型，比"会话当前配置"更准（中途切过模型时尤其）。
   * 这里的值只给 user 消息这些没有自身归属的消息兜底。
   */
  model: string
  provider: string
  /**
   * 待消费的内联 Token 侧车（总是紧邻下一条 user 消息之前追加）。
   * 由下一条 user 消息消费；遇到其他消息则视为陈旧丢弃
   * （随后的 prompt 未能派发 —— 侧车已落盘但 user 消息永远不会来）。
   */
  pendingInline: InlineTokensSidecar | null
}

function projectUserMessage(
  state: ProjectionState,
  entryId: string,
  sessionId: string,
  msg: Extract<AgentMessage, { role: 'user' }>,
  createdAt: number
): void {
  // 侧车还原：内容换回标记态原文，tokens 进 metadata（气泡渲染芯片 / 复制 / 草稿重建用）
  const inline = state.pendingInline
  state.pendingInline = null
  state.out.push({
    id: entryId,
    sessionId,
    role: 'user',
    type: 'text',
    content: inline ? inline.content : textOf(msg.content),
    model: state.model,
    provider: state.provider,
    createdAt,
    metadata: { images: imagesOf(msg.content), ...(inline ? { inlineTokens: inline.tokens } : {}) }
  })
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

  // 失败轮：整条消息塌成一条 error_event（模型侧错误，随回退一起消失）
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

  // 内容块按原序转成 UI 块 —— 顺序即模型输出顺序，不做「过程 / 终答」的再分类
  const blocks: AssistantBlock[] = []
  const texts: string[] = []
  for (const block of msg.content) {
    if (block.type === 'thinking') {
      // 只有空白的思考段（实测见过整块一个 "\n"）丢掉：留着只会渲染出一片空的可点区域
      if (hasThinkingContent(block.thinking))
        blocks.push({ type: 'thinking', text: block.thinking })
    } else if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
      texts.push(block.text)
    } else if (block.type === 'toolCall') {
      const tool: AssistantToolBlock = {
        type: 'tool',
        toolCallId: block.id,
        toolName: block.name,
        args: block.arguments as Record<string, unknown>
      }
      blocks.push(tool)
      state.pendingToolBlocks.set(block.id, tool)
    }
  }

  const images = (msg as AssistantMessage & { _images?: ImageMeta[] })._images
  // 什么都没产出（如首 token 前被中止）：不留空卡片
  if (blocks.length === 0 && !images) return

  state.out.push({
    id: entryId,
    sessionId,
    role: 'assistant',
    type: 'message',
    blocks,
    content: texts.join(''),
    model,
    provider,
    createdAt,
    metadata: {
      // 一条 entry = 一次 LLM 调用，用量各归各，不跨消息累加
      usage: usageOf(msg),
      images
    }
  })
}

function projectToolResult(
  state: ProjectionState,
  msg: Extract<AgentMessage, { role: 'toolResult' }>
): void {
  const target = state.pendingToolBlocks.get(msg.toolCallId)
  if (!target) return // 孤儿结果（历史被压缩截断）——静默丢弃，UI 无处挂载
  target.result = textOf(msg.content)
  target.isError = msg.isError || undefined
  target.details = (msg as { details?: ToolResultDetails }).details
  state.pendingToolBlocks.delete(msg.toolCallId)
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
    pendingToolBlocks: new Map(),
    model: fallbackModel,
    provider: '',
    pendingInline: null
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
        type: 'message',
        blocks: [{ type: 'text', text: entry.summary }],
        content: entry.summary,
        model: state.model,
        provider: state.provider,
        createdAt,
        metadata: { isCompactionSummary: true }
      })
      continue
    }

    if (entry.type === 'custom') {
      // 内联 Token 侧车：暂存，由紧随其后的 user 消息消费
      if (entry.customType === INLINE_TOKENS_CUSTOM_TYPE) {
        state.pendingInline = asInlineTokensSidecar(entry.data)
        continue
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
    // 侧车只配对「紧随其后的 user 消息」；先来了别的消息说明它已陈旧（如 prompt 未派发）
    if (msg.role !== 'user') state.pendingInline = null
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
