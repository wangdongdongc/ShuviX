/**
 * 转写摘要（P2-14）用例的小工具：手写条目的草稿、往会话里直接追加条目、摘要项的简写。
 *
 * 简写对着设计稿的记号：`U(ts, text)` 人发的消息、`A(ts, text)` agent 的正文、`AC(ts, text)` 压缩摘要
 * （A*）、`Q(ts, question, answer)` 一次 ask 回答。桌面的孪生用例（transcriptParity）也按相对路径用它。
 */
import {
  fauxAssistantMessage,
  type AssistantMessage,
  type ImageContent,
  type TextContent,
  type ThinkingContent,
  type ToolCall
} from '@earendil-works/pi-ai'
import type {
  ConversationId,
  EntryDraft,
  EntryId,
  EntryRecord,
  JsonObject
} from '@earendil-works/pi-durable'
import { backgroundContext as BG } from '../../context'
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from '../../transcriptDigest'
import type {
  TranscriptAskItem,
  TranscriptAssistantItem,
  TranscriptUserItem
} from '../../transcriptDigest'
import type { DurableSession } from '../../durableSession'

export const U = (ts: number, text: string): TranscriptUserItem => ({ kind: 'user', ts, text })
export const A = (ts: number, text: string): TranscriptAssistantItem => ({
  kind: 'assistant',
  ts,
  text
})
export const AC = (ts: number, text: string): TranscriptAssistantItem => ({
  kind: 'assistant',
  ts,
  text,
  compaction: true
})
export const Q = (ts: number, question: string, answer: string): TranscriptAskItem => ({
  kind: 'ask',
  ts,
  question,
  answer
})

/** 一张 1×1 的 png（只当内容块用，不解码） */
export const IMAGE: ImageContent = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }

export const text = (value: string): TextContent => ({ type: 'text', text: value })
export const thinking = (value: string): ThinkingContent => ({ type: 'thinking', thinking: value })
export const call = (name: string, args: JsonObject, id: string): ToolCall => ({
  type: 'toolCall',
  id,
  name,
  arguments: args
})

/** 后台完成通知的正文（与桌面 bgTaskService.formatExitNotice 同一个信封） */
export { bg } from '../integration/support/notices'

/** pi 压缩摘要的外壳（`pi.compaction` 的 user 文本） */
export function wrapSummary(summary: string): string {
  return `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`
}

/** `pi.user`：`ts` 缺省 = 不写时间戳 */
export function userDraft(
  content: string | (TextContent | ImageContent)[],
  ts?: number
): EntryDraft {
  return {
    kind: 'pi.user',
    model: [{ role: 'user', content, ...(ts === undefined ? {} : { timestamp: ts }) } as never]
  }
}

/** `pi.assistant`（provider faux） */
export function assistantDraft(
  content: string | (TextContent | ThinkingContent | ToolCall)[],
  ts: number,
  options: { stopReason?: AssistantMessage['stopReason']; errorMessage?: string } = {}
): EntryDraft {
  return {
    kind: 'pi.assistant',
    model: [fauxAssistantMessage(content, { ...options, timestamp: ts })]
  }
}

/** `pi.tool-result`（没有诊断） */
export function resultDraft(
  callId: string,
  content: string | (TextContent | ImageContent)[],
  options: { isError?: boolean; ts?: number; toolName?: string } = {}
): EntryDraft {
  return {
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: callId,
        toolName: options.toolName ?? 'ask',
        content: typeof content === 'string' ? [text(content)] : content,
        isError: options.isError ?? false,
        timestamp: options.ts ?? 0
      }
    ],
    data: { diagnostics: [] }
  }
}

/** `pi.compaction`：`head` = 第一条保留的条目，user 文本 = 给定文本（缺省带 pi 的外壳） */
export function compactionDraft(
  head: EntryId,
  summary: string,
  ts: number,
  options: { raw?: boolean } = {}
): EntryDraft {
  return {
    kind: 'pi.compaction',
    head,
    model: [
      {
        role: 'user',
        content: [text(options.raw ? summary : wrapSummary(summary))],
        timestamp: ts
      }
    ],
    data: { reason: 'manual' }
  }
}

/** 一个提交里往对话（缺省当前对话）追加这些条目，交回落下的记录 */
export async function appendEntries(
  session: DurableSession,
  drafts: readonly EntryDraft[],
  conversationId?: ConversationId
): Promise<EntryRecord[]> {
  const target = conversationId ?? (await session.currentConversation()).id
  return session.harness.commit(async (tx) => {
    const records: EntryRecord[] = []
    for (const draft of drafts) records.push(await tx.appendEntry(target, draft))
    return records
  }, BG)
}
