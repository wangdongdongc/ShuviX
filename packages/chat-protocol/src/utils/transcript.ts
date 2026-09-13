/**
 * 会话 Transcript 转写引擎 —— 把任意 agent 的整段对话（ChatMessage[]）
 * 转写成"一章 Markdown"，作为会话导出 / 压缩归档（agent-runtime sessionTool）/
 * 消息归纳 / 转发等能力的公共底座。
 *
 * 纯函数、零运行时依赖（保持 chat-protocol 为 leaf），三端（main/renderer/extension）
 * 经 `@shuvix/chat-protocol/utils/transcript` 直接复用。
 *
 * - **默认精简**：只保留用户消息 + 助手最终输出（不带工具调用的那条消息的正文），
 *   忽略工具调用 / 思考 / 过程正文。
 *   精简模式天然比原对话更省 token（是原始素材的子集）。
 * - **可详细**：通过 TranscribeOptions 开关逐项纳入 thinking / 工具调用 / 工具结果 /
 *   step / 时间戳 / usage 等。
 */

import type { ChatMessage, ImageMeta, InlineToken, UsageInfo } from '../types/chatMessage'
import { inlineTokensToPlainText, resolveTokensForAgent } from './inlineTokens'

/** 角色 / 分节标签 —— 各端可注入本地化文案；缺省为英文。 */
export interface TranscriptLabels {
  user?: string
  assistant?: string
  thinking?: string
  toolCall?: string
  toolResult?: string
  systemNotice?: string
  image?: string
}

const DEFAULT_LABELS: Required<TranscriptLabels> = {
  user: 'User',
  assistant: 'Assistant',
  thinking: 'Thinking',
  toolCall: 'Tool call',
  toolResult: 'Tool result',
  systemNotice: 'System',
  image: 'image'
}

/** 转写选项。所有 include* 默认 false（精简模式）。 */
export interface TranscribeOptions {
  // —— 详细度开关 ——
  /** 纳入思考：thinking 块 */
  includeThinking?: boolean
  /** 纳入工具调用：tool 块的 toolName + args */
  includeToolCalls?: boolean
  /** 纳入工具结果：tool 块回填的 result（按 maxToolResultChars 截断） */
  includeToolResults?: boolean
  /** 纳入过程正文：与工具调用同处一条消息的 text 块（模型边做边说的话） */
  includeStepText?: boolean
  /** 纳入系统通知：error_event + 指令注入消息 */
  includeSystemNotices?: boolean
  /** 纳入图片占位（绝不内联 base64，仅输出 `[image]`） */
  includeImages?: boolean
  /** 每条消息附时间戳 */
  includeTimestamps?: boolean
  /** 助手消息附 usage 用量 */
  includeUsage?: boolean

  // —— 呈现 ——
  /** 章标题（输出为最顶层标题行） */
  title?: string
  /** 角色标题基准级（章标题 = 该级，角色标题 = 该级 + 1），默认 2 */
  headingLevel?: number
  /** 本地化标签 */
  labels?: TranscriptLabels
  /** inline token 展开方式：false=人读 displayText（精简，默认）/ true=展开 payload */
  expandInlineTokens?: boolean
  /** 工具结果截断上限（字符，中间截断），默认 2000 */
  maxToolResultChars?: number
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 2000

/** 中间截断：保留首尾，中段以标记省略。 */
function truncateMiddle(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text
  const marker = `\n… [truncated ${text.length - max} chars] …\n`
  const keep = Math.max(0, max - marker.length)
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : '')
}

/** 生成 `#` 标题前缀（钳制 1..6）。 */
function heading(level: number, text: string): string {
  const n = Math.min(6, Math.max(1, level))
  return `${'#'.repeat(n)} ${text}`
}

/** 图片占位串（无图返回 ''）。 */
function imagePlaceholders(images: ImageMeta[] | undefined, label: string): string {
  if (!images || images.length === 0) return ''
  return images.map(() => `[${label}]`).join(' ')
}

/** 格式化 usage 为紧凑单行。 */
function formatUsage(usage: UsageInfo): string {
  return `_tokens: in ${usage.input} / out ${usage.output} / total ${usage.total}_`
}

/** ISO 时间戳（UTC，秒级）。 */
function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * 解析用户/助手文本内容里的 inline token 标记。
 * expand=true 展开为发给 agent 的 payload；否则替换为人读 displayText。
 */
function resolveContent(
  content: string,
  tokens: Record<string, InlineToken> | undefined,
  expand: boolean
): string {
  return expand ? resolveTokensForAgent(content, tokens) : inlineTokensToPlainText(content, tokens)
}

/** 把多行文本转成 Markdown 引用块（每行前缀 `> `）。 */
function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/**
 * 把整段对话转写成一章 Markdown。
 *
 * @param messages 有序对话（如 messageService.listBySession 的返回）
 * @param options 转写选项
 * @returns 一章 Markdown 文本（空对话返回 ''）
 */
export function transcribeConversation(
  messages: ChatMessage[],
  options: TranscribeOptions = {}
): string {
  const labels: Required<TranscriptLabels> = { ...DEFAULT_LABELS, ...options.labels }
  const baseLevel = options.headingLevel ?? 2
  const roleLevel = baseLevel + 1
  const expand = options.expandInlineTokens ?? false
  const maxToolChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS

  const blocks: string[] = []

  if (options.title) blocks.push(heading(baseLevel, options.title))

  const pushBody = (headingText: string, body: string): void => {
    const trimmed = body.trim()
    if (!trimmed) return
    blocks.push(`${heading(roleLevel, headingText)}\n\n${trimmed}`)
  }

  for (const msg of messages) {
    const ts = options.includeTimestamps ? ` · ${formatTimestamp(msg.createdAt)}` : ''

    if (msg.type === 'error_event') {
      if (options.includeSystemNotices) pushBody(`${labels.systemNotice}${ts}`, msg.content)
      continue
    }

    if (msg.role === 'user') {
      const meta = msg.metadata
      if (meta?.isInstructionInjection) {
        if (options.includeSystemNotices) {
          pushBody(
            `${labels.systemNotice}${ts}`,
            resolveContent(msg.content, meta?.inlineTokens, expand)
          )
        }
        continue
      }
      const text = resolveContent(msg.content, meta?.inlineTokens, expand)
      const imgs = options.includeImages ? imagePlaceholders(meta?.images, labels.image) : ''
      pushBody(`${labels.user}${ts}`, [text, imgs].filter(Boolean).join('\n\n'))
      continue
    }

    // 助手消息：按块的原始顺序转写。
    // 「中间步骤文本」不再是独立消息类型 —— 同一条消息里还有工具调用，说明这段正文
    // 是模型边做边说的过程话，归 includeStepText 管；没有工具调用的才是这次的最终输出。
    const meta = msg.metadata
    const isProcessMessage = msg.blocks.some((b) => b.type === 'tool')
    const parts: string[] = []
    for (const block of msg.blocks) {
      if (block.type === 'thinking') {
        if (options.includeThinking && block.text.trim()) {
          parts.push(`> **${labels.thinking}**\n>\n${quote(block.text)}`)
        }
        continue
      }
      if (block.type === 'text') {
        if (isProcessMessage && !options.includeStepText) continue
        if (block.text.trim()) parts.push(block.text)
        continue
      }
      if (!options.includeToolCalls && !options.includeToolResults) continue
      const name = block.toolName || 'tool'
      if (options.includeToolCalls) {
        const argsStr =
          block.args && Object.keys(block.args).length > 0
            ? `\n\n\`\`\`json\n${truncateMiddle(JSON.stringify(block.args, null, 2), maxToolChars)}\n\`\`\``
            : ''
        const errFlag = block.isError ? ' ⚠️' : ''
        parts.push(`**${labels.toolCall}: ${name}${errFlag}**${argsStr}`)
      }
      if (options.includeToolResults && block.result?.trim()) {
        const result = truncateMiddle(block.result, maxToolChars)
        parts.push(`**${labels.toolResult}**\n\n\`\`\`\n${result}\n\`\`\``)
      }
    }
    if (options.includeImages) {
      const imgs = imagePlaceholders(meta?.images, labels.image)
      if (imgs) parts.push(imgs)
    }
    if (options.includeUsage && meta?.usage) parts.push(formatUsage(meta.usage))
    pushBody(`${labels.assistant}${ts}`, parts.filter(Boolean).join('\n\n'))
  }

  return blocks.join('\n\n')
}
