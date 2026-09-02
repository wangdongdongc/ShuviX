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
import { SIDECAR_CUSTOM_TYPES, entriesToChatMessages } from '@shuvix/agent-runtime'
import { deleteSessionFile, getSessionTree, readSessionRunConfig } from './sessionStorage'
import { chatMessageDao } from '../dao/chatMessageDao'
import { rowsToChatMessages } from './chatMessageProjection'
import { deleteChatAttachments, deleteSessionAttachments } from './chatAttachments'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

/**
 * 「这是不是聊天会话」的判据 —— 由宿主注入（sessionService 在 init 时注册）。
 *
 * 不在这里直接读 sessionDao：那会让本模块依赖 dao 层，而 `dao/database` 的
 * DatabaseManager **构造即打开 sqlite** —— 单测里（node，原生绑定是 Electron ABI）
 * 一旦被拉进模块图就整个文件收集失败。注入同时也避开了 messageService ↔ sessionService
 * 的循环依赖，与 `addSessionTreePin` / `setBgTaskNotifier` 是同一条习语。
 *
 * 未注册时恒 false（= 全部按有根会话处理），对测试与渠道端都是安全缺省。
 */
let chatSessionPredicate: (sessionId: string) => boolean = () => false

export function setChatSessionPredicate(fn: (sessionId: string) => boolean): void {
  chatSessionPredicate = fn
}

function isChatSession(sessionId: string): boolean {
  return chatSessionPredicate(sessionId)
}

export class MessageService {
  /** 会话当前上下文对应的消息列表（已应用压缩过滤：被压缩的历史不在其中） */
  async listBySession(sessionId: string): Promise<ChatMessage[]> {
    // 聊天会话：平的一张表，没有压缩、没有分叉，读出来按 seq 就是顺序
    if (isChatSession(sessionId)) {
      return rowsToChatMessages(chatMessageDao.findBySession(sessionId))
    }
    const session = await getSessionTree(sessionId)
    if (!session) return [] // 还没发过消息 → 没有转写文件
    const entries = await session.buildContextEntries()
    // fallback 与流式广播同源（都取 readSessionRunConfig）：**「流式所见 = 重开所见」是
    // 两侧一起兑现的**。这里的 entries 过了压缩过滤，一旦某条 model_change 早于压缩切点，
    // 不给 fallback 会让重开后所有 user 消息的 model/provider 塌成空串 —— 而流式当时
    // 显示的是真实模型。聊天会话今天不压缩，摸不到；但这正是那两个参数要防的事
    const cfg = await readSessionRunConfig(sessionId)
    return entriesToChatMessages(entries, sessionId, cfg.model ?? '', cfg.provider ?? '')
  }

  /** 会话最后一条消息 */
  async findLastBySession(sessionId: string): Promise<ChatMessage | undefined> {
    const msgs = await this.listBySession(sessionId)
    return msgs.length > 0 ? msgs[msgs.length - 1] : undefined
  }

  /** 清空会话（聊天会话删行 + 附件；有根会话删转写文件，下次发消息会重建） */
  clear(sessionId: string): void {
    if (isChatSession(sessionId)) {
      chatMessageDao.deleteBySession(sessionId)
      deleteSessionAttachments(sessionId)
      return
    }
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
    // 聊天会话没有树也没有分支：回退就是「删掉这条及其之后」，目标即消息自身。
    // 真正的删除在 applyRollback 里做（与有根会话同样的两步顺序：先关停写者再动数据）
    if (isChatSession(sessionId)) {
      const row = chatMessageDao.findById(messageId)
      return row && row.sessionId === sessionId ? { targetId: messageId } : undefined
    }
    const session = await getSessionTree(sessionId)
    if (!session) return undefined
    const entry = await session.getEntry(messageId)
    if (!entry) return undefined
    // 消息前若有侧车（内联 Token 的显示态），**逐条**越过 —— 叶子停在一条无主侧车上，
    // 它就会被下一条到达的消息当成自己的侧车消费掉。这条路径只服务有根会话：v2 起聊天
    // 会话走表，而署名侧车（bot 署名靠「消息前多写一条 entry、投影时紧邻配对」）随之退场
    let targetId = entry.parentId
    while (targetId) {
      const parent = await session.getEntry(targetId)
      if (parent?.type !== 'custom' || !SIDECAR_CUSTOM_TYPES.includes(parent.customType)) break
      targetId = parent.parentId
    }
    return { targetId }
  }

  /** 执行回退：把 leaf 移到 `resolveRollbackTarget` 给出的 entry 上 */
  async applyRollback(sessionId: string, targetId: string | null): Promise<boolean> {
    if (isChatSession(sessionId)) {
      if (!targetId) return false
      // 硬删（群聊里「回退」就是撤回这条与后续）；顺带清掉这些消息的附件文件，
      // 否则 chat-attachments 目录会攒下永远不再被引用的图片
      const removed = chatMessageDao.deleteFromMessage(sessionId, targetId)
      for (const row of removed) {
        if (row.attachments?.length) deleteChatAttachments(sessionId, row.attachments)
      }
      return removed.length > 0
    }
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
