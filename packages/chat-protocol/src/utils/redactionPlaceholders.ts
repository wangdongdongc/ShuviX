/**
 * 自动脱敏的占位符在界面这一侧（docs/auto-redaction-design.md §2.3）：对话记录里存的是
 * `{{REDACTED_API_KEY_k3v7x2mq}}`（v0.2.30 / v0.2.31 记下的是没有 REDACTED_ 的旧写法），
 * 界面把它渲染成标记、显示会话对照表里的真值。这里只认运行时写下的标准写法（与 agent-runtime
 * redaction/placeholder.ts 的 PLACEHOLDER_PATTERN 同一个）；模型写坏的形式只有工具还原那一侧要宽容。
 */

/** 占位符的标准写法：`REDACTED_`（旧写法没有）+ 类别 + `_` + 8 位小写 base32 */
export const PLACEHOLDER_PATTERN = String.raw`\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}`

/** 界面上一处占位符：类别，与真值（表里有、却解不开的没有真值） */
export interface RedactionMarkInfo {
  category: string
  value?: string
  /**
   * 模型收到的是真值（按会话此刻锁住的模型与策略判，与出口同一份判定）：界面就显示真值、不加标记；
   * 否则显示模型收到的占位符，悬停才揭示真值。缺省 = 收到的是占位符
   */
  disclosed?: boolean
  /**
   * 问到的第一个读者（readerKey）各自是否照发（§15.2）。对话记录里一条消息的占位符，只有会话的模型与这条消息的第一个
   * 读者都照发时模型才收到真值；没问到的读者按不照发
   */
  disclosedTo?: Record<string, boolean>
}

/**
 * 第一个读者（docs/auto-redaction-design.md §15.2）：对话记录里一条消息第一次发给的模型 —— 模型回复是产出它的
 * 模型，用户消息是它后面第一条回复的模型。键 = pi 的 provider id + `\0` + 模型 id。
 */
export function readerKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** readerKey 拆回 provider / 模型；不是这个形状 → undefined */
export function parseReaderKey(key: string): { provider: string; model: string } | undefined {
  const cut = key.indexOf('\u0000')
  if (cut <= 0 || cut === key.length - 1 || key.indexOf('\u0000', cut + 1) !== -1) return undefined
  return { provider: key.slice(0, cut), model: key.slice(cut + 1) }
}

/** 这一处在这条消息里模型收到的是不是真值：会话的模型照发，且每个第一个读者都照发（readers 为空 = 只看会话的模型） */
export function disclosedFor(
  info: RedactionMarkInfo | undefined,
  readers: readonly string[]
): boolean {
  if (info?.disclosed !== true) return false
  return readers.every((key) => info.disclosedTo?.[key] === true)
}

/**
 * 用户在输入框里交来要藏的一项（docs/auto-redaction-design.md §14）：+ 添加的，或确认了提示的。真值随这次发送交给宿主，
 * 宿主换成占位符；发送带着这一项（哪怕是空数组）= 输入框自己处理过脱敏，其余照原样发。
 */
export interface UserSecret {
  value: string
  /** PASSWORD / API_KEY / SECRET（+ 添加的由用户选），确认的提示沿用检测出的类别 */
  category: string
}

/** 类别会写进占位符（`{{REDACTED_<类别>_…}}`）：只收占位符认得出来的写法 */
const SECRET_CATEGORY = /^[A-Z][A-Z0-9_]{0,31}$/

/**
 * 前端交来的要藏的值：载荷不可信，只留形状对的；不是数组 → undefined（= 不是输入框发来的，宿主照旧自动脱敏）。
 * 空值丢掉；类别不合占位符写法的当 SECRET。
 */
export function cleanUserSecrets(secrets: unknown): UserSecret[] | undefined {
  if (!Array.isArray(secrets)) return undefined
  const out: UserSecret[] = []
  for (const item of secrets) {
    if (item === null || typeof item !== 'object') continue
    const { value, category } = item as { value?: unknown; category?: unknown }
    if (typeof value !== 'string' || value.length === 0) continue
    out.push({
      value,
      category: typeof category === 'string' && SECRET_CATEGORY.test(category) ? category : 'SECRET'
    })
  }
  return out
}

/** + 添加时可选的类别 */
export const USER_SECRET_CATEGORIES = ['PASSWORD', 'API_KEY', 'SECRET'] as const

/** 输入框里认出的一处可能的敏感内容（只提示，用户确认才藏；§14.2） */
export interface RedactionHint {
  start: number
  end: number
  category: string
}

/** 一次 inspect 最多看多少个字符（超出的部分不提示） */
export const MAX_INSPECT_CHARS = 20_000

/** 一段文本切开之后：原样的文字，或者一处占位符 */
export type RedactionSegment = string | { placeholder: string; category: string }

/** 一次 resolve 最多问多少个（一屏的量；再多分几次问） */
export const MAX_RESOLVE_PLACEHOLDERS = 200

/** 一次 resolve 最多判多少个第一个读者（一个会话里用过的模型不会多） */
export const MAX_RESOLVE_READERS = 16

/** 占位符正文的开头（旧写法没有） */
const PLACEHOLDER_PREFIX = 'REDACTED_'

/** 占位符的类别段（`{{REDACTED_API_KEY_k3v7x2mq}}`、旧写法 `{{API_KEY_k3v7x2mq}}` → `API_KEY`） */
export function categoryOfPlaceholder(placeholder: string): string {
  const body = placeholder.slice(2, placeholder.length - 2 - 9)
  return body.startsWith(PLACEHOLDER_PREFIX) ? body.slice(PLACEHOLDER_PREFIX.length) : body
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
 * 流式文本的结尾还没写完的占位符（`… {{REDACTED_API_KE`、`{{REDACTED_API_KEY_k3v9`）先不显示，写完了再作为标记出现 ——
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
