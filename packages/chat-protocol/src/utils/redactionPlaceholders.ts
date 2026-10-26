/**
 * 自动脱敏的占位符在界面这一侧（docs/auto-redaction-design.md §2.3）：对话记录里存的是 `{{API_KEY_k3v7x2mq}}`，
 * 界面把它渲染成标记、显示会话对照表里的真值。这里只认运行时写下的标准写法（与 agent-runtime
 * redaction/placeholder.ts 的 PLACEHOLDER_PATTERN 同一个）；模型写坏的形式只有工具还原那一侧要宽容。
 */

/** 占位符的标准写法：类别 + `_` + 8 位小写 base32 */
export const PLACEHOLDER_PATTERN = String.raw`\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}`

/** 界面上一处占位符：类别，与真值（表里有、却解不开的没有真值） */
export interface RedactionMarkInfo {
  category: string
  value?: string
}

/** 一段文本切开之后：原样的文字，或者一处占位符 */
export type RedactionSegment = string | { placeholder: string; category: string }

/** 一次 resolve 最多问多少个（一屏的量；再多分几次问） */
export const MAX_RESOLVE_PLACEHOLDERS = 200

/** 占位符的类别段（`{{API_KEY_k3v7x2mq}}` → `API_KEY`） */
export function categoryOfPlaceholder(placeholder: string): string {
  return placeholder.slice(2, placeholder.length - 2 - 9)
}

export function isPlaceholder(text: string): boolean {
  return new RegExp(`^${PLACEHOLDER_PATTERN}$`).test(text)
}

export function hasPlaceholder(text: string): boolean {
  return text.includes('{{') && new RegExp(PLACEHOLDER_PATTERN).test(text)
}

/** 按占位符切开；没有占位符时交回只含原文的一段 */
export function splitPlaceholders(text: string): RedactionSegment[] {
  if (!text.includes('{{')) return [text]
  const re = new RegExp(PLACEHOLDER_PATTERN, 'g')
  const out: RedactionSegment[] = []
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push({ placeholder: m[0], category: categoryOfPlaceholder(m[0]) })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.length === 0 ? [text] : out
}

/** 文本里出现的占位符（去重，按出现次序） */
export function placeholdersIn(text: string): string[] {
  if (!text.includes('{{')) return []
  return [...new Set(text.match(new RegExp(PLACEHOLDER_PATTERN, 'g')) ?? [])]
}

/** 占位符换回真值（复制出去的是用户看到的样子）；查不到的原样留着 */
export function restorePlaceholders(
  text: string,
  valueOf: (placeholder: string) => string | undefined
): string {
  if (!text.includes('{{')) return text
  return text.replace(new RegExp(PLACEHOLDER_PATTERN, 'g'), (p) => valueOf(p) ?? p)
}

/**
 * 流式文本的结尾还没写完的占位符（`… {{API_KE`、`{{API_KEY_k3v9`）先不显示，写完了再作为标记出现 ——
 * 否则那几个字符先以原文闪一下。只截结尾、只截看得出是占位符开头的那一段。
 */
export function trimPartialPlaceholder(text: string): string {
  const at = text.lastIndexOf('{{')
  if (at < 0 || text.length - at > 2 + 64 + 1 + 8 + 2) return text
  const tail = text.slice(at)
  return /^\{\{(?:[A-Z][A-Z0-9_]*(?:_[a-z2-7]{0,8}(?:\}\}?)?)?)?$/.test(tail) &&
    !isPlaceholder(tail)
    ? text.slice(0, at)
    : text
}
