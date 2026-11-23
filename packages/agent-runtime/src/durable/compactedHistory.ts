/**
 * 压缩前的历史（只读回看）：一条压缩头标记之上、被它换成摘要的那一段条目。
 *
 * pi-durable 的压缩不删任何东西：它追加一条头标记 H（`H.head` = 原样保留的第一条，即 `firstKept`），之后的上下文
 * = [H, H.head … 末尾]。H 之前的条目仍在存储里、仍「可见」（fork 感知），只是不在活上下文里。所以 H 压缩掉的
 * 那一段，就是 H 落下之前那一刻的上下文里、`H.head` 之前的部分：
 *
 *   X   = H 之前最新的可见条目（`entries({maxEntryId: H.id - 1}, 1)`，fork 感知；隐藏的回退分支不在其中）
 *   ctx = `context({at: X})` = [更早的头 H' (若有), H'.head … X]
 *   段  = ctx 里 id < H.head 的非头条目；H' 是压缩就排在最前（它的摘要行就是再往上一段的分隔线）
 *
 * id < H.head 去掉的是 H 原样保留的那一截（它们已经在 H 之后的当前上下文里，不能出现两次）。
 * H' 是 `pi.reset`（清空 / 交接开出的新上下文）就到此为止：清空之前的东西不该再翻出来，H' 本身也不画。
 */
import {
  CompactionEntry,
  type Conversation,
  type EntryId,
  type EntryRecord
} from '@earendil-works/pi-durable'
import { backgroundContext as BG } from './context'

/**
 * `compactionId` 那条压缩头标记压缩掉的一段条目（最旧在前，可直接交给投影）。认不出（不是当前对话可见的压缩
 * 条目、前面什么都没有）→ 空数组。
 */
export async function compactedSegment(
  conversation: Conversation,
  compactionId: number
): Promise<EntryRecord[]> {
  if (!Number.isSafeInteger(compactionId) || compactionId <= 1) return []
  const id = compactionId as EntryId
  const marker = (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BG))
    .items[0]
  if (marker?.kind !== CompactionEntry.kind || marker.head === undefined) return []
  const keptFrom = marker.head
  const before = (
    await conversation.entries({ maxEntryId: (compactionId - 1) as EntryId }, 1, undefined, BG)
  ).items[0]
  if (before === undefined) return []
  const view = await conversation.context(BG, { at: before.id })
  const segment: EntryRecord[] = []
  for (const entry of view.entries) {
    if (view.head !== undefined && entry.id === view.head.id) {
      if (entry.kind === CompactionEntry.kind) segment.push(entry)
      continue
    }
    if (entry.head === undefined && entry.id < keptFrom) segment.push(entry)
  }
  return segment
}
