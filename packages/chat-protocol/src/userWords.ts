/**
 * 父会话发进子会话的消息上，宿主原样附上的「用户原话」：用户在父会话里自己写的话（打的消息、对父会话 ask 卡片的回答），
 * 由宿主从父会话的转写里读出来，一字不改地附在父 agent 写的那段话后面。父 agent 改不了它，子会话因此分得清哪些是用户
 * 说的、哪些是 agent 的转述（用户 2026-11-07 的裁定：交接时带上用户原话，并区分谁说的）。
 *
 * 形状照发送方说明（sessionSender.ts）：模型文本 = 原文 + 分隔 + 引用块（之后才是发送方说明）；显示侧车 = 原文 + 一枚
 * 内联 Token，气泡上是一枚小胶囊「用户原话 · N」，点开看全文。`displayText` 刻意是空串：复制、纯文本、回填输入框都只留
 * 父 agent 写的原文。大纲、转写摘要、导出把它当系统写的 Token 去掉（triggerEvent.ts `withoutSystemTokens`）。
 *
 * 只由宿主在驱动发送时构造（挑哪些话、截多长在桌面 services/userWords.ts）；本模块纯数据、不依赖 Node / Electron。
 */
import type { InlineToken } from './types/chatMessage'
import { makeTokenMarker } from './utils/inlineTokens'

/** Token 的 `type`；`id` 是父会话的 id，`name` 是引用了几条（胶囊上的标题） */
export const USER_WORDS_TOKEN_TYPE = 'user-words'

/** 显示侧车里这枚 Token 的 uid（一条消息只有一枚；TOKEN_RE 只认小写字母数字） */
export const USER_WORDS_UID = 'userwords'

/** 模型文本里原文与引用块之间的分隔 */
const SEPARATOR = '\n\n'

/** 引用的一条：用户打的一条消息，或用户对父会话一张 ask 卡片的回答 */
export interface QuotedUserWord {
  kind: 'message' | 'answer'
  /** 毫秒时间戳（消息放下的时刻；回答取提问那条 assistant 的） */
  ts: number
  /** 原文（宿主可能已在中间截掉一段，并在那里写明截掉了多少） */
  text: string
  /** `answer`：父 agent 在卡片上问的问题 */
  question?: string
  /** `message`：用户点了 agent 写的一条提议发出的 —— 人点的，字是 agent 写的 */
  suggested?: true
}

export interface UserWordsQuote {
  /** 父会话 id */
  sessionId: string
  /** `start`：父会话里到目前为止的；`since-last`：父会话上一次给这条子会话发消息之后新说的 */
  scope: 'start' | 'since-last'
  /** 旧 → 新 */
  words: QuotedUserWord[]
  /** 按条数上限没放进来的条数（`start`：首条与最近几条之间的；`since-last`：最近几条之前的） */
  omitted: number
}

/** 属性值里的字符：一行、转义（问题是 agent 写的，不能让它走出引号或伪造标签） */
function attr(value: string): string {
  return value
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 本机时间 `YYYY-MM-DD HH:mm`（同一个块里口径一致即可，模型只用它分先后） */
export function localTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 模型面向的引用块（英文）：只写模型自己不知道的事实，不下命令 —— 这些话是谁写的、谁没动过、范围是哪一段。
 * 怎么对待它们（以用户的话为准、对不上时说出来）是档案的事（coding.md），不在这里。
 */
export function userWordsBlockText(
  quote: UserWordsQuote,
  timeOf: (ts: number) => string = localTime
): string {
  const scope =
    quote.scope === 'start'
      ? "The user's own words in your parent session so far"
      : 'What the user has written in your parent session since its previous message to you'
  // 第一次附的是「首条 + 最近几条」，省掉的在中间；之后附的是「最近几条」，省掉的在前面
  const n = quote.omitted
  const omitted =
    n > 0
      ? ` ${n} ${quote.scope === 'start' ? 'in between' : 'earlier'} ${n === 1 ? 'is' : 'are'} left out.`
      : ''
  const lines = [
    `<user-words from="parent-session" scope="${quote.scope}">`,
    `${scope}, quoted verbatim by ShuviX, oldest first. The agent there did not write or edit them; the text above this block is its own.${omitted}`
  ]
  for (const w of quote.words) {
    const time = `time="${attr(timeOf(w.ts))}"`
    if (w.kind === 'answer') {
      lines.push(`<answer ${time} question="${attr(w.question ?? '')}">\n${w.text}\n</answer>`)
    } else {
      const via = w.suggested ? ' via="suggestion written by the agent, sent by the user"' : ''
      lines.push(`<message ${time}${via}>\n${w.text}\n</message>`)
    }
  }
  lines.push('</user-words>')
  return lines.join('\n')
}

/** 引用 Token 本身。payload 带开头的分隔：重新生成经 `resolveTokensForAgent` 把标记换回 payload，要与第一次发的全文逐字相同 */
export function userWordsToken(
  quote: UserWordsQuote,
  timeOf?: (ts: number) => string
): InlineToken {
  return {
    type: USER_WORDS_TOKEN_TYPE,
    id: quote.sessionId,
    displayText: '',
    payload: `${SEPARATOR}${userWordsBlockText(quote, timeOf)}`,
    name: String(quote.words.length)
  }
}

/** 是不是用户原话 Token（只看 type） */
export function isUserWordsToken(token: unknown): boolean {
  if (typeof token !== 'object' || token === null) return false
  return (token as { type?: unknown }).type === USER_WORDS_TOKEN_TYPE
}

/** 显示侧车的形状（与 `InlineTokensSidecar` 相同，这里不依赖运行时） */
interface Display {
  content: string
  tokens: Record<string, InlineToken>
}

/**
 * 一条驱动发送 + 引用 → 模型文本 + 显示侧车。`text` 是模型文本（Token 已展开）；`display` 是它原有的侧车（有内联 Token
 * 时），没有就以 `text` 为原文。发送方说明要在它**之后**接（`withSessionSender` 带 `{ userWords: true }`）。
 */
export function withUserWords(
  text: string,
  display: Display | undefined,
  quote: UserWordsQuote,
  timeOf?: (ts: number) => string
): { text: string; display: Display } {
  const token = userWordsToken(quote, timeOf)
  return {
    text: `${text}${token.payload}`,
    display: {
      content: `${display?.content ?? text}${makeTokenMarker(USER_WORDS_UID)}`,
      tokens: { ...display?.tokens, [USER_WORDS_UID]: token }
    }
  }
}
