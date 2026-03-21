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

/** 展开命令模板：替换 $ARGUMENTS 占位符，若无占位符则追加到末尾 */
export function expandCommandTemplate(template: string, args: string): string {
  if (template.includes('$ARGUMENTS')) {
    return template.replaceAll('$ARGUMENTS', args)
  }
  if (args) {
    return `${template}\n\n${args}`
  }
  return template
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
