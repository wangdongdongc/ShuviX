/**
 * 运行中插话的说明（docs/task-list-design.md §2）：会话正忙时受理的一条 steer，模型文本末尾带一段固定说明，
 * 显示侧车里是一枚说明 Token（形状与判据见 chat-protocol `midRunNote.ts`）。纯函数，不依赖 Node / Electron。
 */
import type { JsonObject, UserInput } from '@earendil-works/pi-durable'
import {
  MID_RUN_NOTE_SEPARATOR,
  MID_RUN_NOTE_TEXT,
  midRunNoteDisplay
} from '@shuvix/chat-protocol/midRunNote'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import { userText } from './projection/entryText'

/**
 * 一条插话 → 模型看到的内容 + 显示侧车。文本消息直接拼在末尾；带图的消息在最后加一个文本块（图片原样）。
 * 显示侧车的原文与投影读 user 文本同一个口径（文本块按 '' 拼接、图片丢掉）。
 *
 * 通知形状的插话（整段只有 `<background-task …>` / `<session …>` 块，`isSystemNoticeText`）→ undefined：
 * 那是系统写的话（PIN-16），队列计数、视图队列、撤回、投影、转写摘要都按形状认它 —— 加了说明它就不再是那个
 * 形状，也不该被当成用户在运行中插的话。空闲时同样的文字也照旧是通知，两边一致。
 */
export function withMidRunNote(
  content: UserInput
): { content: UserInput; display: JsonObject } | undefined {
  const text = userText(content)
  if (isSystemNoticeText(text)) return undefined
  const note = `${MID_RUN_NOTE_SEPARATOR}${MID_RUN_NOTE_TEXT}`
  const display = midRunNoteDisplay(text) as unknown as JsonObject
  if (typeof content === 'string') return { content: `${content}${note}`, display }
  return { content: [...content, { type: 'text', text: note }], display }
}
