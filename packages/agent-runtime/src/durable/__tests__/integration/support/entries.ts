/** 读转写里的工具结果条目（按 toolCallId）与它的诊断 */
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import { ToolResultEntry, type Conversation, type EntryRecord } from '@earendil-works/pi-durable'
import { allEntries } from '../../support/transcript'

/** 结果条目（按 toolCallId 过滤；不给 = 全部），最旧在前 */
export async function resultEntries(
  conversation: Conversation,
  callId?: string
): Promise<EntryRecord[]> {
  return (await allEntries(conversation)).filter((entry) => {
    const message = entry.model?.[0]
    return (
      entry.kind === ToolResultEntry.kind &&
      message?.role === 'toolResult' &&
      (callId === undefined || message.toolCallId === callId)
    )
  })
}

/** 某工具调用的结果条目（恰好一条） */
export async function resultEntry(
  conversation: Conversation,
  callId: string
): Promise<EntryRecord> {
  const entries = await resultEntries(conversation, callId)
  if (entries.length !== 1)
    throw new Error(`expected one tool result for ${callId}, got ${entries.length}`)
  return entries[0]!
}

export function resultMessage(entry: EntryRecord): ToolResultMessage {
  const message = entry.model?.[0]
  if (message?.role !== 'toolResult') throw new Error('not a tool result entry')
  return message
}

/** 结果条目的模型可见文本（文本块拼起来，含 `<harness>` 段） */
export function resultText(entry: EntryRecord): string {
  return resultMessage(entry)
    .content.map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

/** 结果条目 data 里的结构化诊断 */
export function diagnosticsOf(entry: EntryRecord): unknown {
  return (entry.data as { diagnostics?: unknown } | undefined)?.diagnostics
}

/** durable 自己写的错误结果的文本（只有一条 error 诊断、没有正文） */
export function harnessErrorText(message: string): string {
  return `<harness>\n[error] ${message}\n</harness>`
}
