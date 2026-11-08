/**
 * TokenChip 展示层纯逻辑 —— 类型判别、displayText 前缀切分、来源路径、payload 预览。
 * 全部为纯函数（不碰 token 数据结构/明文形态），供 TokenChip 气泡与镜像层两个变体共用。
 */

import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { isGoalSetToken } from '@shuvix/chat-protocol/goalSet'
import { isMidRunNoteToken } from '@shuvix/chat-protocol/midRunNote'
import { isSessionSenderToken } from '@shuvix/chat-protocol/sessionSender'
import { isTriggerEventToken } from '@shuvix/chat-protocol/triggerEvent'
import { isUserWordsToken } from '@shuvix/chat-protocol/userWords'

/**
 * 展示层细分类型：at 按 id 前缀再分 文件 / 知识库 / 会话（token 结构无类型字段，沿用 id 前缀判别）；`note` = 运行时
 * 加的插话说明（chat-protocol midRunNote.ts），只有标签、没有标题；`trigger` = 触发器发的消息里的事件
 * （triggerEvent.ts），标题是触发时间；`sender` = 别的会话发来的消息的发送方（sessionSender.ts），标题是那条会话的标题；
 * `userWords` = 父会话发来的消息上宿主附的用户原话（userWords.ts），标题是附了几条；`goal` = 设定目标那条消息上系统写的
 * 说明（goalSet.ts），同 note 只有标签、没有标题
 */
export type TokenKind =
  | 'cmd'
  | 'file'
  | 'knowledge'
  | 'session'
  | 'paste'
  | 'note'
  | 'trigger'
  | 'sender'
  | 'userWords'
  | 'goal'
  | 'other'

/**
 * 判别展示类型；at token 以 id 的 `knowledge:` 前缀区分知识条目与工作区文件。会话引用同时看 payload（atTokenRef 同一个
 * 口径）：工作区文件的相对路径也可能以 `session:` 开头
 */
export function tokenKind(token: InlineToken): TokenKind {
  if (isMidRunNoteToken(token)) return 'note'
  if (isTriggerEventToken(token)) return 'trigger'
  if (isSessionSenderToken(token)) return 'sender'
  if (isUserWordsToken(token)) return 'userWords'
  if (isGoalSetToken(token)) return 'goal'
  if (token.type === 'cmd') return 'cmd'
  if (token.type === 'paste') return 'paste'
  if (token.type === 'at') {
    if (token.id.startsWith('knowledge:')) return 'knowledge'
    if (token.id.startsWith('session:') && token.payload.startsWith('[session: id ')) {
      return 'session'
    }
    return 'file'
  }
  return 'other'
}

/**
 * displayText 按**第一个** `:` 切分：prefix 含冒号（如 `knowledge:`），title 为其余部分
 * （消歧后缀 ` (kb-b)` 自然归属标题）。无 `:` 时整体为标题、prefix 为空串。
 * prefix + title 必等于原 displayText —— 镜像层两段 span 拼接后与底层原始子串逐字一致。
 */
export function splitTokenTitle(displayText: string): { prefix: string; title: string } {
  const idx = displayText.indexOf(':')
  if (idx === -1) return { prefix: '', title: displayText }
  return { prefix: displayText.slice(0, idx + 1), title: displayText.slice(idx + 1) }
}

/**
 * 气泡/预览卡标题：知识条目、会话引用去掉 `knowledge:` / `session:` 前缀（含消歧后缀），触发事件是触发时间，发送方是那条
 * 会话的标题，其余类型标题即 displayText
 */
export function tokenTitle(token: InlineToken): string {
  const kind = tokenKind(token)
  if (kind === 'knowledge' || kind === 'session') return splitTokenTitle(token.displayText).title
  if (kind === 'trigger' || kind === 'sender' || kind === 'userWords') return token.name ?? ''
  return token.displayText
}

/** 预览卡来源路径：at 文件=工作区相对路径，at 知识=条目 id（去 `knowledge:` 前缀），会话引用=会话 id，发送方=会话 id，cmd=命令 id，paste/其他=无 */
export function tokenSourcePath(token: InlineToken): string | undefined {
  switch (tokenKind(token)) {
    case 'knowledge':
      return token.id.slice('knowledge:'.length)
    case 'session':
      return token.id.slice('session:'.length)
    case 'sender':
    case 'file':
    case 'cmd':
      return token.id
    default:
      return undefined
  }
}

/** payload 预览：前 maxLines 行，超行/超长以 `…` 截断 */
export function payloadPreview(payload: string, maxLines = 3, maxChars = 240): string {
  const lines = payload.split('\n')
  let preview = lines.slice(0, maxLines).join('\n')
  if (preview.length > maxChars) return `${preview.slice(0, maxChars).trimEnd()}…`
  if (lines.length > maxLines) preview += preview.length > 0 ? '\n…' : '…'
  return preview
}
