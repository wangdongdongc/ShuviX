/**
 * 消息服务 —— 会话 entry 树的「UI 视角」读取端。
 *
 * 迁移到 AgentHarness 之后，这个服务从「消息的写入方 + 读取方」缩成了**只读投影**：
 * 消息的产生与落盘全部由 harness 在 `message_end` / `turn_end` 完成（写进会话的
 * JSONL 转写文件），这里只负责把 entry 树投影成 chat-ui 认识的 ChatMessage。
 *
 * 随之消失的方法（旧调用方需改造）：
 *   add / addUserText / addAssistantText / addToolUse / completeToolUse /
 *   addStepThinking / addStepText / addErrorEvent —— 写入不再经这里。
 *   rollbackToMessage / deleteFromMessage —— 改为树导航（moveTo），见下方新方法。
 */
import { buildContextEntries } from '@earendil-works/pi-agent-core'
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core'
import { entriesToChatMessages } from '@shuvix/agent-runtime'
import { deleteSessionFile, getSessionTree } from './sessionStorage'
import type { ChatMessage } from '../types'

export class MessageService {
  /** 会话当前上下文对应的消息列表（已应用压缩过滤：被压缩的历史不在其中） */
  async listBySession(sessionId: string): Promise<ChatMessage[]> {
    const session = await getSessionTree(sessionId)
    if (!session) return [] // 还没发过消息 → 没有转写文件
    const entries = await session.buildContextEntries()
    return entriesToChatMessages(entries, sessionId)
  }

  /** 会话最后一条消息 */
  async findLastBySession(sessionId: string): Promise<ChatMessage | undefined> {
    const msgs = await this.listBySession(sessionId)
    return msgs.length > 0 ? msgs[msgs.length - 1] : undefined
  }

  /** 清空会话（直接删掉转写文件；下次发消息会重建） */
  clear(sessionId: string): void {
    deleteSessionFile(sessionId)
  }

  // ─── 树导航（取代旧的「删除消息之后的所有消息」） ────────────────
  //
  // 旧模型靠 DELETE ... WHERE createdAt > ? 物理删除；entry 树是 append-only，
  // 对应操作是把 leaf 移到目标 entry 的父节点 —— 历史仍在文件里，可以再切回去。

  /** 回退到指定消息之前（该消息本身也不再在上下文中） */
  async rollbackToMessage(sessionId: string, messageId: string): Promise<boolean> {
    const session = await getSessionTree(sessionId)
    if (!session) return false
    const entry = await session.getEntry(resolveEntryId(messageId))
    if (!entry) return false
    await session.moveTo(entry.parentId)
    return true
  }

  /** 回退到指定消息之后（保留该消息本身） */
  async truncateAfterMessage(sessionId: string, messageId: string): Promise<boolean> {
    const session = await getSessionTree(sessionId)
    if (!session) return false
    const entry = await session.getEntry(resolveEntryId(messageId))
    if (!entry) return false
    await session.moveTo(entry.id)
    return true
  }

  // ─── 归档（被压缩掉的历史） ────────────────────────────────
  //
  // 旧模型用 archived 标记位；现在「归档」= 落在最后一条 compaction entry
  // 的 firstKeptEntryId 之前的那些 entry —— 由 buildContextEntries 的差集算出。

  private async archivedEntries(sessionId: string): Promise<SessionTreeEntry[]> {
    const session = await getSessionTree(sessionId)
    if (!session) return []
    const leafId = await session.getLeafId()
    if (!leafId) return []
    const all = await session.getBranch()
    const kept = new Set(buildContextEntries(all).map((e) => e.id))
    return all.filter((e) => !kept.has(e.id))
  }

  async countArchived(sessionId: string): Promise<number> {
    const entries = await this.archivedEntries(sessionId)
    return entriesToChatMessages(entries, sessionId).length
  }

  /** 分页加载已归档消息（按时间正序） */
  async listArchivedBySession(
    sessionId: string,
    limit: number,
    offset: number
  ): Promise<ChatMessage[]> {
    const entries = await this.archivedEntries(sessionId)
    const msgs = entriesToChatMessages(entries, sessionId)
    // 与旧行为一致：从最近的往前取 limit 条，再按正序返回
    const end = Math.max(0, msgs.length - offset)
    const start = Math.max(0, end - limit)
    return msgs.slice(start, end)
  }
}

/**
 * ChatMessage id → entry id。
 *
 * 投影时中间轮的 step 会派生出 `<entryId>:think` / `<entryId>:text` 这样的合成 id，
 * 树导航只认原始 entry，所以这里剥掉后缀。tool_use 的 id 是 toolCallId，
 * 不对应任何 entry —— 落回它所属的 assistant entry 由调用方保证（UI 只允许对
 * 用户消息/助手终答发起回退）。
 */
function resolveEntryId(messageId: string): string {
  const idx = messageId.indexOf(':')
  return idx === -1 ? messageId : messageId.slice(0, idx)
}

export const messageService = new MessageService()
