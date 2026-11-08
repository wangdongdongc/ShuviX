/**
 * 别的会话发进来的消息上系统写的那一段：是哪条会话发的。形状照运行中插话的说明（midRunNote.ts）与触发事件
 * （triggerEvent.ts）：模型文本 = 原文 + 说明；显示侧车 = 原文 + 一枚内联 Token，气泡上是一枚小胶囊，悬停 / 点开看说明。
 * `displayText` 刻意是空串：复制、纯文本、回填输入框都只留原文。
 *
 * 只由宿主在驱动发送时构造（网关的 `prompt` / `steerDriven`），前端从不构造它。本模块纯数据、不依赖 Node / Electron。
 */
import type { DrivingSessionRef } from './types/inputRequest'
import type { InlineToken } from './types/chatMessage'
import { makeTokenMarker } from './utils/inlineTokens'

/** Token 的 `type`；`id` 是发送方会话的 id，`name` 是发送那一刻的标题（胶囊上的标题，之后改了也不回写） */
export const SESSION_SENDER_TOKEN_TYPE = 'session-sender'

/** 显示侧车里这枚 Token 的 uid（一条消息只有一枚） */
export const SESSION_SENDER_UID = 'sender'

/** 模型文本里原文与说明之间的分隔 */
const SEPARATOR = '\n\n'

/** 说明里的标题上限：标题是模型写的，说明要短 */
const TITLE_MAX = 120

/** 标题放进说明里的样子：一行、引号里不再有双引号（标题是模型写的，不能让它走出引号），过长截断（按码点，不切开 emoji） */
function quotedTitle(title: string): string {
  const chars = Array.from(title.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/"/g, "'"))
  return `"${chars.slice(0, TITLE_MAX).join('')}${chars.length > TITLE_MAX ? '…' : ''}"`
}

/**
 * 模型面向的说明（英文）：只写模型自己不知道的事实，不下命令。「答复会交回去」是驱动的结果（完成通知 / wait 带回），
 * 不说的话模型容易拿这个 id 再发一条回去 —— 那条会话多半正忙，或要用户批准。用户在这条会话里回退后原样重发时，
 * 那一轮不再被驱动，这句就不成立了：那时 Token 照旧跟着（重发的还是那条会话的话），接受这点不准。
 */
export function sessionSenderNoteText(
  sender: DrivingSessionRef,
  opts: { userWords?: boolean } = {}
): string {
  const who = sender.kind === 'parent-session' ? 'your parent session' : 'another session'
  const name = sender.title ? ` — ${quotedTitle(sender.title)}` : ''
  // 带了用户原话（userWords.ts）：那一块是用户写的，说明只认领它上面父 agent 写的那段
  const author = opts.userWords
    ? 'An agent there wrote this message, not the user — except the <user-words> block, which ShuviX quoted from the user.'
    : 'An agent there wrote this, not the user.'
  return `[Sent by ${who} (id ${sender.sessionId}${name}). ${author} Your reply is returned to that session when this turn ends; you do not need to send it there yourself.]`
}

/** 说明 Token 本身。payload 带开头的分隔：重新生成经 `resolveTokensForAgent` 把标记换回 payload，要与第一次发的全文逐字相同 */
export function sessionSenderToken(
  sender: DrivingSessionRef,
  opts: { userWords?: boolean } = {}
): InlineToken {
  return {
    type: SESSION_SENDER_TOKEN_TYPE,
    id: sender.sessionId,
    displayText: '',
    payload: `${SEPARATOR}${sessionSenderNoteText(sender, opts)}`,
    name: sender.title || sender.sessionId
  }
}

/** 是不是发送方 Token（只看 type） */
export function isSessionSenderToken(token: unknown): boolean {
  if (typeof token !== 'object' || token === null) return false
  return (token as { type?: unknown }).type === SESSION_SENDER_TOKEN_TYPE
}

/** 显示侧车的形状（与 `InlineTokensSidecar` 相同，这里不依赖运行时） */
interface Display {
  content: string
  tokens: Record<string, InlineToken>
}

/**
 * 一条驱动发送 → 模型文本 + 显示侧车。`text` 是模型文本（Token 已展开）；`display` 是它原有的侧车（有内联 Token 时），
 * 没有就以 `text` 为原文。
 */
export function withSessionSender(
  text: string,
  display: Display | undefined,
  sender: DrivingSessionRef,
  opts: { userWords?: boolean } = {}
): { text: string; display: Display } {
  const token = sessionSenderToken(sender, opts)
  return {
    text: `${text}${token.payload}`,
    display: {
      content: `${display?.content ?? text}${makeTokenMarker(SESSION_SENDER_UID)}`,
      tokens: { ...display?.tokens, [SESSION_SENDER_UID]: token }
    }
  }
}
