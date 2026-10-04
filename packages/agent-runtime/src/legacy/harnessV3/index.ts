/**
 * 旧格式（`harness-v3-jsonl`）会话的只读适配器。
 *
 * 换到新存储之后，这种会话不再能继续对话，但永远可以查看（不迁移数据，见
 * chat-protocol 的 sessionStorageKind.ts）。投影是切换存储时冻结进本目录的 `projection.ts`
 * （旧活路径的逐行副本），保证「旧会话现在怎么显示，以后就怎么显示」。
 */
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { entriesToChatMessages } from './projection'
import { readHarnessV3Transcript, type HarnessV3Issue } from './reader'

export * from './types'
export {
  entriesToChatMessages,
  INSTRUCTION_CUSTOM_TYPE,
  INLINE_TOKENS_CUSTOM_TYPE,
  SYSTEM_NOTICE_CUSTOM_TYPE,
  SIDECAR_CUSTOM_TYPES,
  usageOf,
  usageDetailOf,
  aggregateUsage,
  type InlineTokensSidecar,
  type RoundUsageDetail,
  type AggregatedUsage
} from './projection'
export {
  HarnessV3FormatError,
  branchOf,
  contextEntriesOf,
  parseHarnessV3Session,
  readHarnessV3Transcript,
  runConfigOf,
  type HarnessV3Branch,
  type HarnessV3Issue,
  type HarnessV3RunConfig,
  type HarnessV3Transcript,
  type ParsedHarnessV3Session
} from './reader'

export interface LegacyTranscriptView {
  messages: ChatMessage[]
  issues: HarnessV3Issue[]
}

/**
 * 把一份 v3 `.jsonl` 文本渲染成界面消息 —— 与活会话 `message.list` 同一个投影、同一套
 * model / provider 兜底（分支上最后一次 model_change）。会话头不可读时抛 `HarnessV3FormatError`。
 */
export function harnessV3TextToChatMessages(text: string, sessionId: string): LegacyTranscriptView {
  const transcript = readHarnessV3Transcript(text)
  const messages = entriesToChatMessages(
    transcript.contextEntries,
    sessionId,
    transcript.runConfig.model ?? '',
    transcript.runConfig.provider ?? ''
  )
  return { messages, issues: transcript.issues }
}
