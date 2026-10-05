/**
 * 显示侧车（`DisplayDoc.items[requestId]`，内联 Token 的标记态原文）的形状判别与「侧车 → 条目」解析 ——
 * 界面投影与转写摘要共用一份（P2-14 的摘要先写下，phase 3 搬到这里）。不依赖 Node / Electron。
 */
import type { ConversationId, EntryId, EntryRecord, Harness } from '@earendil-works/pi-durable'
import { UserEntry } from '@earendil-works/pi-durable'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { backgroundContext as BG } from '../context'
import { DisplayDoc } from '../docs'

/** 一份显示侧车：带 `{{shuvixInlineToken:uid}}` 标记的原文 + uid → Token 字典 */
export interface DisplayItem {
  readonly content: string
  readonly tokens: Readonly<Record<string, InlineToken>>
}

/**
 * 显示侧车的形状判别：content 是字符串、tokens 是对象（不是 null）才算；否则 undefined，调用方退回
 * 模型文本。判据与冻结投影的 `asInlineTokensSidecar` 相同。交回的是原对象里的两项（不拷贝）。
 */
export function displayItemOf(item: unknown): DisplayItem | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const { content, tokens } = item as { content?: unknown; tokens?: unknown }
  if (typeof content !== 'string') return undefined
  if (typeof tokens !== 'object' || tokens === null) return undefined
  return { content, tokens: tokens as Record<string, InlineToken> }
}

/** 显示侧车的标记态原文；形状不对 → undefined（见 `displayItemOf`） */
export function displayContentOf(item: unknown): string | undefined {
  return displayItemOf(item)?.content
}

/**
 * 显示侧车 → 它落到的条目（P2-14 PIN-04）：当前对话的 `DisplayDoc`（fork 带着 fork 点时的副本，继承的
 * 前缀里那几份侧车也在）逐项按 requestId 找 submission —— submission 归它提交时所在的对话，所以在
 * 活上下文里每个出现过 `pi.user` 的对话（fork 的祖先链）里各找一次，`record.entry` 正是活上下文里的那条
 * user 条目才算数。没有 submission / 还没放下的 / 放下的条目不在活上下文里（压缩切点之前、别的分支）→
 * 忽略；侧车形状不对 → 忽略（那条条目退回模型文本）。按 requestId 找只能在提交里做：这是一个只读提交
 * （不产生发布）。
 */
export async function resolveDisplayItems(
  harness: Harness,
  conversationId: ConversationId,
  entries: readonly EntryRecord[]
): Promise<Map<EntryId, DisplayItem>> {
  const resolved = new Map<EntryId, DisplayItem>()
  const doc = await harness.snapshot(DisplayDoc, conversationId, BG)
  const items: [string, DisplayItem][] = []
  for (const [requestId, item] of Object.entries(doc?.items ?? {})) {
    const display = displayItemOf(item)
    if (display !== undefined) items.push([requestId, display])
  }
  if (items.length === 0) return resolved
  const users = new Map<ConversationId, Set<EntryId>>()
  for (const entry of entries) {
    if (entry.kind !== UserEntry.kind) continue
    let ids = users.get(entry.conversationId)
    if (ids === undefined) {
      ids = new Set()
      users.set(entry.conversationId, ids)
    }
    ids.add(entry.id)
  }
  if (users.size === 0) return resolved
  await harness.commit(async (tx) => {
    for (const [requestId, display] of items) {
      for (const [owner, ids] of users) {
        const record = await tx.submissionByRequest(owner, requestId)
        if (record?.entry !== undefined && ids.has(record.entry)) {
          resolved.set(record.entry, display)
          break
        }
      }
    }
  }, BG)
  return resolved
}
