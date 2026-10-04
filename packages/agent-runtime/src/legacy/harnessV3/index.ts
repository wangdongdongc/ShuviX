/**
 * 旧格式（`harness-v3-jsonl`）会话的只读适配器。
 *
 * 换到新存储之后，这种会话不再能继续对话，但永远可以查看（不迁移数据，见
 * chat-protocol 的 sessionStorageKind.ts）。投影目前仍复用活路径上的 `entriesToChatMessages`，
 * 保证「旧会话现在怎么显示，以后就怎么显示」；切换存储时它会连同本目录一起冻结。
 */
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { entriesToChatMessages } from '../../harness/projection'
import { readHarnessV3Transcript, type HarnessV3Issue } from './reader'

export * from './types'
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
    // 本目录的条目类型与 pi 0.80 的 SessionTreeEntry 逐字段同形；投影冻结进本目录时这个转换随之消失
    transcript.contextEntries as unknown as SessionTreeEntry[],
    sessionId,
    transcript.runConfig.model ?? '',
    transcript.runConfig.provider ?? ''
  )
  return { messages, issues: transcript.issues }
}
