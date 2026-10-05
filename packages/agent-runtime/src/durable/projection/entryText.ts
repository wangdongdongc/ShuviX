/**
 * 条目文字的小工具 —— 界面投影（`project.ts`）与转写摘要（`../transcriptDigest.ts`）共用：
 * 时间戳、user 文本、条目的第一条模型消息、pi 压缩摘要的外壳。纯函数，不依赖 Node / Electron。
 */
import type { Message, TextContent, UserMessage } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

/**
 * pi 的压缩摘要外壳（pi-durable `harness/compaction.js` 的 SUMMARY_PREFIX / SUFFIX，未导出）：
 * `pi.compaction` 的 user 文本 = 前缀 + 摘要 + 后缀。
 */
export const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
export const COMPACTION_SUMMARY_SUFFIX = '\n</summary>'

/** 压缩摘要去壳：前后缀都对得上才剥，否则原样交出 */
export function unwrapCompactionSummary(text: string): string {
  if (
    text.length >= COMPACTION_SUMMARY_PREFIX.length + COMPACTION_SUMMARY_SUFFIX.length &&
    text.startsWith(COMPACTION_SUMMARY_PREFIX) &&
    text.endsWith(COMPACTION_SUMMARY_SUFFIX)
  ) {
    return text.slice(
      COMPACTION_SUMMARY_PREFIX.length,
      text.length - COMPACTION_SUMMARY_SUFFIX.length
    )
  }
  return text
}

/** 消息的时间戳；不是有限数 → 0 */
export function tsOf(message: { readonly timestamp?: unknown } | undefined): number {
  const ts = message?.timestamp
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : 0
}

/** user 内容 → 纯文本（文本块按 '' 拼接，图片丢掉）；不是字符串也不是数组 → '' */
export function userText(content: UserMessage['content'] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is TextContent => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

/** 条目的第一条模型消息（角色对不上 → undefined） */
export function firstMessage<R extends Message['role']>(
  entry: EntryRecord,
  role: R
): Extract<Message, { role: R }> | undefined {
  const message = entry.model?.[0]
  return message?.role === role ? (message as Extract<Message, { role: R }>) : undefined
}
