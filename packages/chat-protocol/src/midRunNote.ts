/**
 * 运行中插话的说明（docs/task-list-design.md §2）—— 会话正忙时插进来的一条用户消息，模型看到的文本末尾
 * 带一段固定说明，免得它把插话当成「原来的活不用干了」。照 Claude Code 对运行中消息的做法。
 *
 * 形状：说明是一个**内联 Token**（显示侧车 `{{shuvixInlineToken:uid}}` + uid → Token）。模型文本 = 原文 +
 * `\n\n` + 说明；显示侧车 = 原文 + 标记。`displayText` 刻意是空串：凡是把 Token 换成人读文字的地方（复制、
 * 纯文本、视图队列、回填输入框）都自然把它丢掉 —— 说明是系统写的，不是用户的话。界面按 `type` / `id` 画成
 * 一个小标签（chat-ui TokenChip），悬停看 payload。
 *
 * 只由运行时在插话受理时加（`DurableSession.admitUser`，受理时会话正忙），前端从不构造它。本模块纯数据、
 * 不依赖 Node / Electron。
 */
import type { InlineToken } from './types/chatMessage'
import { makeTokenMarker, TOKEN_RE } from './utils/inlineTokens'

/** Token 的 `type` / `id` —— 认它只看这两项（`displayText` 与 `payload` 都不当判据） */
export const MID_RUN_NOTE_TOKEN_TYPE = 'note'
export const MID_RUN_NOTE_TOKEN_ID = 'mid-run'

/** 显示侧车里这枚 Token 的 uid（一条消息只有一枚，不会撞） */
export const MID_RUN_NOTE_UID = 'midrun'

/**
 * 模型面向的说明（英文）。放在消息**末尾**；对「受理时在跑、放下时这一轮已经结束」的竞态也成立。
 * 不提任务列表：插话改变计划时要重发列表，这条写在列表工具自己的描述里。
 */
export const MID_RUN_NOTE_TEXT =
  '[Sent while you were working. Address it and carry on with your current work, unless it changes or stops that work. If you had already finished, just respond to it.]'

/** 模型文本里原文与说明之间的分隔 */
export const MID_RUN_NOTE_SEPARATOR = '\n\n'

/** 说明 Token 本身 */
export function midRunNoteToken(): InlineToken {
  return {
    type: MID_RUN_NOTE_TOKEN_TYPE,
    id: MID_RUN_NOTE_TOKEN_ID,
    displayText: '',
    payload: MID_RUN_NOTE_TEXT
  }
}

/** 是不是插话说明 Token（只看 type / id） */
export function isMidRunNoteToken(token: unknown): boolean {
  if (typeof token !== 'object' || token === null) return false
  const t = token as { type?: unknown; id?: unknown }
  return t.type === MID_RUN_NOTE_TOKEN_TYPE && t.id === MID_RUN_NOTE_TOKEN_ID
}

/**
 * 一条用户消息的显示侧车：原文（已脱敏的那份）+ 说明标记。原文里本来就有的标记字样不会被当成 Token ——
 * 侧车的 tokens 里只有说明这一枚，别的 uid 在显示时按无效标记处理，与今天输入框发来的纯文本一致。
 */
export function midRunNoteDisplay(text: string): {
  content: string
  tokens: Record<string, InlineToken>
} {
  return {
    content: `${text}${makeTokenMarker(MID_RUN_NOTE_UID)}`,
    tokens: { [MID_RUN_NOTE_UID]: midRunNoteToken() }
  }
}

/** 这组 Token 里有没有插话说明（任务列表据此认出「插话不是新请求」） */
export function hasMidRunNote(tokens: Record<string, unknown> | undefined): boolean {
  if (tokens === undefined) return false
  return Object.values(tokens).some(isMidRunNoteToken)
}

/**
 * 去掉插话说明那枚 Token；去完一枚不剩 → undefined。重新生成把一条插话当普通消息重发时用：那时它不再是
 * 运行中插进来的，说明不该跟着去（运行时会按那一次的情形重新判断要不要加）。
 */
export function tokensWithoutMidRunNote<T>(
  tokens: Record<string, T> | undefined
): Record<string, T> | undefined {
  if (tokens === undefined || !hasMidRunNote(tokens)) return tokens
  const kept = Object.entries(tokens).filter(([, token]) => !isMidRunNoteToken(token))
  return kept.length === 0 ? undefined : Object.fromEntries(kept)
}

/** 把带标记的显示文本里属于插话说明的标记去掉（读「用户说了什么」的地方用：大纲、转写摘要、重新生成） */
export function withoutMidRunNote(
  content: string,
  tokens: Record<string, unknown> | undefined
): string {
  if (tokens === undefined || !hasMidRunNote(tokens)) return content
  return content.replace(new RegExp(TOKEN_RE.source, 'g'), (marker, uid: string) =>
    isMidRunNoteToken(tokens[uid]) ? '' : marker
  )
}
