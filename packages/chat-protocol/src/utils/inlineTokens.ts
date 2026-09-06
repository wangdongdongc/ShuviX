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
  /** 命令来源；'agent' 为子代理派发命令——无模板，不参与 cmd Token 构造（走独立派发链路） */
  kind?: string
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

/** 粘贴长文的最小定义（构造内联 Token 所需字段） */
export interface PasteLike {
  /** 完整粘贴内容（发给 LLM 的正文） */
  payload: string
  /** 占位/胶囊展示文本（如 `[粘贴文本 #1 · 45 行]`，前端按 locale 构造，与 textarea 占位明文一致） */
  displayText: string
  /** 草稿内序号（1 起），作实体标识 */
  seq: number
  /** 弹窗标题（如 `粘贴文本 #1`） */
  name?: string
}

/**
 * 用长文粘贴构造 `paste` 类型内联 Token。
 * 与 at 类型同属「就地替换」：resolveTokensForAgent 把标记替换为完整粘贴内容、保留周围文本；
 * 气泡侧渲染为胶囊（点击弹窗看原文），避免超长粘贴撑爆聊天记录。
 */
export function buildPasteToken(p: PasteLike): InlineToken {
  return {
    type: 'paste',
    id: `paste-${p.seq}`,
    displayText: p.displayText,
    payload: p.payload,
    name: p.name
  }
}

/**
 * 从原始输入识别 slash 命令（"/cmd 参数"）并构造内联 Token；非命令或未匹配返回 null。
 * 命中时一并回传匹配到的命令定义（调用方据 requiredTools 等做后续处理）。
 * kind='agent' 的派发命令无模板、不构造 cmd Token（由调用方在此之前识别并走派发链路），
 * 落到这里视为未匹配——未接派发链路的入口（如子代理追问框）按普通文本发送。
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
  if (!command || command.kind === 'agent') return null
  return { ...buildCommandToken(command, args, opts), command }
}

/**
 * 将 content 中的 token 标记替换为 payload，生成发送给 Agent 的文本
 * - cmd 类型：payload 替换整条消息（因为展开的模板已包含用户参数）；
 *   参数里可再嵌其他类型标记（如 paste），对 payload 追加一次就地替换
 * - 其他类型（at / paste 等）：逐个替换 token 标记处，保留周围文本
 */
export function resolveTokensForAgent(
  content: string,
  tokens?: Record<string, InlineToken>
): string {
  if (!tokens || Object.keys(tokens).length === 0) return content

  const replaceMarkers = (text: string): string =>
    text.replace(TOKEN_RE, (_, uid: string) => tokens[uid]?.payload ?? '')

  // cmd 类型：payload 已包含完整展开模板（含 args），直接替换整条消息
  for (const token of Object.values(tokens)) {
    if (token.type === 'cmd') return replaceMarkers(token.payload)
  }

  // 其他类型（at / paste 等）：逐个替换 token 为 payload，保留周围文本
  return replaceMarkers(content)
}

/**
 * 把 content 中的 token 标记替换为适合「复制原文」的文本：paste 类型还原完整粘贴内容（payload），
 * 其余类型保持人读 displayText（"/review"、文件名）。供用户气泡复制按钮使用。
 */
export function resolveTokensForCopy(
  content: string,
  tokens?: Record<string, InlineToken>
): string {
  if (!tokens || Object.keys(tokens).length === 0) return content
  return content.replace(TOKEN_RE, (_, uid: string) => {
    const token = tokens[uid]
    if (!token) return ''
    return token.type === 'paste' ? token.payload : token.displayText
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

// ---- 草稿重建（消息回退回填输入框） ----

/** 重建结果：可编辑明文 + 需要重新登记的分类 token（供输入框恢复芯片/引用注册表） */
export interface DraftRebuildResult {
  /** 回填输入框的明文：paste→占位 displayText、at→`@名`、cmd→`/id` 明文（发送时重新解析） */
  text: string
  /** 需重新登记的 at 类型 token（按出现顺序，同 uid 去重） */
  atTokens: InlineToken[]
  /** 需重新登记的 paste 类型 token（按出现顺序，同 uid 去重） */
  pasteTokens: InlineToken[]
}

/**
 * 把持久化消息（含 {{shuvixInlineToken}} 标记的 content + metadata.inlineTokens）
 * 重建为「可编辑草稿」——回退到输入框时使用，避免裸标记落入文本框导致 token 失效丢信息：
 * - paste：替换为占位明文（displayText），调用方据 pasteTokens 重新登记芯片（payload 得以保留）
 * - at：替换为 `@displayText` 明文，调用方据 atTokens 重新登记引用
 * - cmd：替换为 displayText（如 `/review`）——发送时经 parseSlashCommandInput 按当前命令定义重新展开
 * - 未知类型（含群聊时代遗留的 `bot` 提及 token）：替换为 displayText；uid 缺失的标记：丢弃
 */
export function rebuildDraftFromContent(
  content: string,
  tokens?: Record<string, InlineToken>
): DraftRebuildResult {
  const atTokens: InlineToken[] = []
  const pasteTokens: InlineToken[] = []
  const seen = new Set<string>()
  const segments = segmentContent(content, tokens)
  let text = ''
  for (const seg of segments) {
    if (seg.type === 'text') {
      text += seg.text
      continue
    }
    if (seg.type === 'invalid_token') continue
    const token = seg.token
    if (token.type === 'paste') {
      if (!seen.has(seg.uid)) {
        seen.add(seg.uid)
        pasteTokens.push(token)
      }
      text += token.displayText
    } else if (token.type === 'at') {
      if (!seen.has(seg.uid)) {
        seen.add(seg.uid)
        atTokens.push(token)
      }
      text += `@${token.displayText}`
    } else {
      // cmd / 未来类型：displayText 明文（cmd 发送时重新解析展开）
      text += token.displayText
    }
  }
  return { text, atTokens, pasteTokens }
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
