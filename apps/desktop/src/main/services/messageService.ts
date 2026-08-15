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
import { INLINE_TOKENS_CUSTOM_TYPE, entriesToChatMessages } from '@shuvix/agent-runtime'
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
    // user 消息前若有内联 Token 显示侧车，一并越过 —— 免得叶子停在无主侧车上
    let targetId = entry.parentId
    if (targetId) {
      const parent = await session.getEntry(targetId)
      if (parent?.type === 'custom' && parent.customType === INLINE_TOKENS_CUSTOM_TYPE) {
        targetId = parent.parentId
      }
    }
    await session.moveTo(targetId)
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
