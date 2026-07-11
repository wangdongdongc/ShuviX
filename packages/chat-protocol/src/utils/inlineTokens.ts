/**
 * 内联 Token 工具函数 — 前后端共用
 * 解析 {{shuvixInlineToken:uid}} 标记，配合 metadata.inlineTokens 使用
 */

import type { InlineToken } from '../types/chatMessage'

/** 匹配 {{shuvixInlineToken:uid}} 的正则 */
export const TOKEN_RE = /\{\{shuvixInlineToken:([a-z0-9]+)\}\}/g

/** 生成 Token 标记字符串 */
export function makeTokenMarker(uid: string): string {
  return `{{shuvixInlineToken:${uid}}}`
}

/**
 * 展开命令模板：替换 $ARGUMENTS 占位符，若无占位符则追加到末尾
 * 同时替换 ${CLAUDE_SESSION_ID}（若提供 sessionId）
 */
export function expandCommandTemplate(
  template: string,
  args: string,
  opts?: { sessionId?: string }
): string {
  let result = template.includes('$ARGUMENTS')
    ? template.replaceAll('$ARGUMENTS', args)
    : args
      ? `${template}\n\n${args}`
      : template
  if (opts?.sessionId) {
    result = result.replaceAll('${CLAUDE_SESSION_ID}', opts.sessionId)
  }
  return result
}

/** slash 命令的最小定义（构造内联 Token 所需字段） */
export interface SlashCommandLike {
  commandId: string
  name: string
  template: string
}

/** 构造内联 Token + 标记文本的结果 */
export interface CommandTokenResult {
  /** 含 {{shuvixInlineToken:uid}} 标记 + 可选参数的展示文本（落库/广播用） */
  contentText: string
  /** 单条 cmd 类型内联 Token 字典 */
  inlineTokens: Record<string, InlineToken>
}

/**
 * 用已知命令定义 + 参数构造 cmd 类型内联 Token 与标记文本。
 * 所有发送 slash 命令的入口（主输入框芯片态/直输态、子代理追问）共用此构造逻辑，避免重复。
 */
export function buildCommandToken(
  cmd: SlashCommandLike,
  args: string,
  opts?: { sessionId?: string; uid?: string }
): CommandTokenResult {
  const uid = opts?.uid ?? 't0'
  const payload = expandCommandTemplate(cmd.template, args, { sessionId: opts?.sessionId })
  const token: InlineToken = {
    type: 'cmd',
    id: cmd.commandId,
    displayText: `/${cmd.commandId}`,
    payload,
    name: cmd.name
  }
  return {
    contentText: args ? `${makeTokenMarker(uid)} ${args}` : makeTokenMarker(uid),
    inlineTokens: { [uid]: token }
  }
}

/** `@` 文件引用的最小定义（构造内联 Token 所需字段） */
export interface AtFileLike {
  /** 工作区相对路径（如 `src/components/Button.tsx`），作实体标识与展开正文 */
  rel: string
  /** 文件名（含扩展名，如 `Button.tsx`），作胶囊展示名 */
  base: string
}

/**
 * 用选中的工作区文件构造 `at` 类型内联 Token。
 * - displayText/name = 文件名（胶囊仅展示文件名）
 * - payload = 展开正文，告知 Agent 用户引用了该文件（含相对路径便于其读取）
 *
 * 与 cmd 类型不同：at token 由 resolveTokensForAgent 就地替换标记、保留周围文本，
 * 故一条消息可含多个 at 引用 + 普通文字。
 */
export function buildAtToken(file: AtFileLike): InlineToken {
  return {
    type: 'at',
    id: file.rel,
    displayText: file.base,
    payload: `[workspace file: ${file.rel}]`,
    name: file.base
  }
}

/**
 * 从原始输入识别 slash 命令（"/cmd 参数"）并构造内联 Token；非命令或未匹配返回 null。
 * 命中时一并回传匹配到的命令定义（调用方据 requiredTools 等做后续处理）。
 */
export function parseSlashCommandInput<C extends SlashCommandLike>(
  rawText: string,
  commands: C[],
  opts?: { sessionId?: string; uid?: string }
): (CommandTokenResult & { command: C }) | null {
  if (!rawText.startsWith('/')) return null
  const spaceIdx = rawText.indexOf(' ')
  const cmdId = spaceIdx === -1 ? rawText.slice(1) : rawText.slice(1, spaceIdx)
  const args = spaceIdx === -1 ? '' : rawText.slice(spaceIdx + 1).trim()
  const command = commands.find((c) => c.commandId === cmdId)
  if (!command) return null
  return { ...buildCommandToken(command, args, opts), command }
}

/**
 * 将 content 中的 token 标记替换为 payload，生成发送给 Agent 的文本
 * - cmd 类型：payload 替换整条消息（因为展开的模板已包含用户参数）
 * - 其他类型（at 等）：逐个替换 token 标记处，保留周围文本
 */
export function resolveTokensForAgent(
  content: string,
  tokens?: Record<string, InlineToken>
): string {
  if (!tokens || Object.keys(tokens).length === 0) return content

  // cmd 类型：payload 已包含完整展开模板（含 args），直接替换整条消息
  for (const token of Object.values(tokens)) {
    if (token.type === 'cmd') return token.payload
  }

  // 其他类型（at 等）：逐个替换 token 为 payload，保留周围文本
  return content.replace(TOKEN_RE, (_, uid: string) => {
    return tokens[uid]?.payload ?? ''
  })
}

/**
 * 把 content 中的 token 标记替换为该 token 的人读标签（displayText，如 "/review"），用于派生展示名/标题。
 * 与 resolveTokensForAgent（替换为发给 LLM 的 payload）不同——此处只为人读，不展开模板正文。
 */
export function inlineTokensToPlainText(
  content: string,
  tokens?: Record<string, InlineToken>
): string {
  if (!tokens || Object.keys(tokens).length === 0) return content
  return content.replace(TOKEN_RE, (_, uid: string) => tokens[uid]?.displayText ?? '')
}

// ---- 前端内容分段 ----

/** 内容分段：普通文本 / 有效 token / 无效 token（uid 在 metadata 中缺失） */
export type ContentSegment =
  | { type: 'text'; text: string }
  | { type: 'token'; uid: string; token: InlineToken }
  | { type: 'invalid_token'; uid: string; raw: string }

/**
 * 将 content 拆分为 text 和 token 段，供前端渲染
 * 无 tokens 时返回单个 text 段
 */
export function segmentContent(
  content: string,
  tokens?: Record<string, InlineToken>
): ContentSegment[] {
  if (!tokens || Object.keys(tokens).length === 0) {
    return [{ type: 'text', text: content }]
  }

  const segments: ContentSegment[] = []
  const re = new RegExp(TOKEN_RE.source, 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(content)) !== null) {
    // 标记之前的文本
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: content.slice(lastIndex, match.index) })
    }

    const uid = match[1]
    const token = tokens[uid]
    if (token) {
      segments.push({ type: 'token', uid, token })
    } else {
      segments.push({ type: 'invalid_token', uid, raw: match[0] })
    }

    lastIndex = match.index + match[0].length
  }

  // 标记之后的剩余文本
  if (lastIndex < content.length) {
    segments.push({ type: 'text', text: content.slice(lastIndex) })
  }

  return segments
}
