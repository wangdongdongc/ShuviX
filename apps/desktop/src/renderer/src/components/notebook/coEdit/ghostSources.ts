/**
 * 协作编辑的虚影来源（P3-08-58）—— 一份会话视图里，此刻正在生成参数、该画虚影的 doc_edit / doc_insert
 * 调用。纯函数（从 `useCoEditing` 抽出来好测）。
 *
 * 虚影只属于**实时卡**：模型还在吐这次调用的参数时才有。参数原文优先取 `live.argsText`（provider 流式给出的
 * 半截 JSON），没有时退而用解析出来的部分参数序列化（F11）。这次调用一旦有了进度（`toolRuns` 里出现且做完）
 * 或落盘的工具块已带结果，就不再是「正在写」—— 落盘之后实时卡本身也就没了。
 */
import { DOC_EDIT_TOOL, DOC_INSERT_TOOL } from '@shuvix/chat-protocol/liveDocument'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'

export interface GhostSource {
  toolCallId: string
  toolName: string
  /** 参数的（半截）JSON 原文 */
  json: string
}

function hasCommittedResult(messages: readonly ChatMessage[], toolCallId: string): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || message.type !== 'message') continue
    for (const block of message.blocks) {
      if (block.type === 'tool' && block.toolCallId === toolCallId)
        return block.result !== undefined
    }
  }
  return false
}

export function ghostSourcesOf(
  view: Pick<SessionView, 'live' | 'toolRuns' | 'messages'> | undefined
): GhostSource[] {
  const live = view?.live
  if (!view || !live) return []
  const out: GhostSource[] = []
  for (const block of live.message.blocks) {
    if (block.type !== 'tool') continue
    if (block.toolName !== DOC_EDIT_TOOL && block.toolName !== DOC_INSERT_TOOL) continue
    if (view.toolRuns[block.toolCallId]?.status === 'done') continue
    if (hasCommittedResult(view.messages, block.toolCallId)) continue
    out.push({
      toolCallId: block.toolCallId,
      toolName: block.toolName,
      json: live.argsText?.[block.toolCallId] ?? JSON.stringify(block.args ?? {})
    })
  }
  return out
}
