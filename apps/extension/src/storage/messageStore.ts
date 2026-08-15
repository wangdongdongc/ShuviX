/**
 * 消息存储 —— 会话 entry 树的「UI 视角」读取端（扩展）。
 *
 * 与桌面 messageService 完全同构：迁移到 AgentHarness 后写入口全部消失
 * （add / addToolUse / completeToolUse / addStepText / addErrorEvent …），
 * 消息由 harness 落成 entry，这里只做投影。
 * 读取经 sessionEntryStore 的共享 registry —— 与运行时同一棵树，不重复加载。
 */
import { INLINE_TOKENS_CUSTOM_TYPE, entriesToChatMessages } from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { deleteSessionFile, getSessionTree } from './sessionEntryStore'

export const messageStore = {
  /** 会话当前上下文对应的消息列表（已应用压缩过滤：被压缩的历史不在其中） */
  async list(sessionId: string): Promise<ChatMessage[]> {
    const session = await getSessionTree(sessionId)
    if (!session) return [] // 还没发过消息 → 没有转写文件
    const entries = await session.buildContextEntries()
    return entriesToChatMessages(entries, sessionId)
  },

  /** 清空会话（直接删掉转写文件；下次发消息会重建） */
  async clear(sessionId: string): Promise<void> {
    await deleteSessionFile(sessionId)
  },

  /**
   * 回退到指定消息之前：把 leaf 移到目标 entry 的父节点。
   * append-only 树上，旧的 deleteFrom / deleteAfter / deleteOne 语义都收敛到这一个操作。
   * 追加经共享实例 —— Agent 运行时与读取端同步可见。
   */
  async rollback(sessionId: string, messageId: string): Promise<void> {
    const entryId = messageId.includes(':') ? messageId.slice(0, messageId.indexOf(':')) : messageId
    const session = await getSessionTree(sessionId)
    if (!session) return
    const entry = await session.getEntry(entryId)
    if (!entry) return
    // user 消息前若有内联 Token 显示侧车，一并越过（与桌面 messageService 同构）
    let targetId = entry.parentId
    if (targetId) {
      const parent = await session.getEntry(targetId)
      if (parent?.type === 'custom' && parent.customType === INLINE_TOKENS_CUSTOM_TYPE) {
        targetId = parent.parentId
      }
    }
    await session.moveTo(targetId)
  }
}
