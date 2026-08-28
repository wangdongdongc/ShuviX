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
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

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

  /**
   * 解析回退目标：把 leaf 应该移到哪个 entry（**只读，不写树**）。
   * 消息不在树上返回 undefined；`{ targetId: null }` 表示回退到树根之前。
   *
   * 和 `applyRollback` 分成两步，是为了让调用方能在**动叶子之前**先把旧运行时关停 ——
   * 顺序反过来就是在一个还在写的 run 脚下抽走叶子（见 DefaultChatGateway.rollbackMessage）；
   * 同时也免得为一个根本不存在的目标白白把正在跑的 Agent 停掉。
   */
  async resolveRollbackTarget(
    sessionId: string,
    messageId: string
  ): Promise<{ targetId: string | null } | undefined> {
    const session = await getSessionTree(sessionId)
    if (!session) return undefined
    const entry = await session.getEntry(messageId)
    if (!entry) return undefined
    // user 消息前若有内联 Token 显示侧车，一并越过 —— 免得叶子停在无主侧车上
    let targetId = entry.parentId
    if (targetId) {
      const parent = await session.getEntry(targetId)
      if (parent?.type === 'custom' && parent.customType === INLINE_TOKENS_CUSTOM_TYPE) {
        targetId = parent.parentId
      }
    }
    return { targetId }
  }

  /** 执行回退：把 leaf 移到 `resolveRollbackTarget` 给出的 entry 上 */
  async applyRollback(sessionId: string, targetId: string | null): Promise<boolean> {
    const session = await getSessionTree(sessionId)
    if (!session) return false
    await session.moveTo(targetId)
    return true
  }

  /** 回退到指定消息之前（该消息本身也不再在上下文中）。调用方须自行保证此刻没有活跃 run。 */
  async rollbackToMessage(sessionId: string, messageId: string): Promise<boolean> {
    const target = await this.resolveRollbackTarget(sessionId, messageId)
    if (!target) return false
    return await this.applyRollback(sessionId, target.targetId)
  }

  /** 回退到指定消息之后（保留该消息本身） */
  async truncateAfterMessage(sessionId: string, messageId: string): Promise<boolean> {
    const session = await getSessionTree(sessionId)
    if (!session) return false
    const entry = await session.getEntry(messageId)
    if (!entry) return false
    await session.moveTo(entry.id)
    return true
  }
}

export const messageService = new MessageService()
