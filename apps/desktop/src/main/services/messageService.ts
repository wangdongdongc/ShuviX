/**
 * 消息服务 —— 会话对话内容的「UI 视角」读取端（只读投影）。
 *
 * pi-durable 切换（P1-01）之后按会话的存储类型分流：
 *  - `harness-v3-jsonl`（切换前的会话）：照旧可看 —— 经 agent-runtime 的 legacy 读取器把 `.jsonl`
 *    渲染成 ChatMessage（冻结的投影，「旧会话现在怎么显示，以后就怎么显示」）；这种会话只读，
 *    回退 / 截断一律不做（返回「没有可回退的目标」）。
 *  - `durable-sqlite-1`（新会话）：durable 存储的投影还没写 —— TODO(pi-durable p3)：列表暂时为空，
 *    回退 / 截断抛 `PhasePendingError`。
 */
import { PhasePendingError } from '@shuvix/agent-runtime'
import { HARNESS_V3_JSONL, storageKindOf } from '@shuvix/chat-protocol/sessionStorageKind'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { deleteSessionFile, readLegacyTranscript } from './sessionStorage'
import { sessionRecords } from './sessionRecords'

/** 这条会话是不是切换前的旧格式（只读）会话；查不到行按旧格式处理（与 storageKindOf 同口径） */
function isLegacySession(sessionId: string): boolean {
  return storageKindOf(sessionRecords.pick(sessionId, ['storageKind']) ?? {}) === HARNESS_V3_JSONL
}

export class MessageService {
  /** 会话当前上下文对应的消息列表（已应用压缩过滤：被压缩的历史不在其中） */
  async listBySession(sessionId: string): Promise<ChatMessage[]> {
    if (isLegacySession(sessionId)) return readLegacyTranscript(sessionId)?.messages ?? []
    // TODO(pi-durable p3): durable 会话的条目投影（entries → ChatMessage）
    return []
  }

  /** 会话最后一条消息 */
  async findLastBySession(sessionId: string): Promise<ChatMessage | undefined> {
    const msgs = await this.listBySession(sessionId)
    return msgs.length > 0 ? msgs[msgs.length - 1] : undefined
  }

  /**
   * 清空会话（删存储文件，下次发消息会重建）。
   * TODO(pi-durable p1): P1-10 改经 sessionHost.delete（先关掉打开着的存储）。
   */
  clear(sessionId: string): void {
    deleteSessionFile(sessionId)
  }

  // ─── 回退 / 截断 ────────────────────────────────────────

  /**
   * 解析回退目标（**只读，不写**）。消息不在会话里返回 undefined；`{ targetId: null }` 表示回退到最开头。
   *
   * 和 `applyRollback` 分成两步，是为了让调用方能在**动会话之前**先把旧运行时关停
   * （见 DefaultChatGateway.rollbackMessage），也免得为一个不存在的目标白白停掉正在跑的 Agent。
   */
  async resolveRollbackTarget(
    sessionId: string,
    _messageId: string
  ): Promise<{ targetId: string | null } | undefined> {
    // 旧格式会话只读：没有可回退的目标
    if (isLegacySession(sessionId)) return undefined
    // TODO(pi-durable p3): durable 会话的回退（按条目定位 + rewind）
    throw new PhasePendingError('message rollback', 3)
  }

  /** 执行回退：把会话退到 `resolveRollbackTarget` 给出的位置 */
  async applyRollback(sessionId: string, _targetId: string | null): Promise<boolean> {
    if (isLegacySession(sessionId)) return false
    // TODO(pi-durable p3): durable 会话的回退
    throw new PhasePendingError('message rollback', 3)
  }

  /** 回退到指定消息之前（该消息本身也不再在上下文中）。调用方须自行保证此刻没有活跃 run。 */
  async rollbackToMessage(sessionId: string, messageId: string): Promise<boolean> {
    const target = await this.resolveRollbackTarget(sessionId, messageId)
    if (!target) return false
    return await this.applyRollback(sessionId, target.targetId)
  }

  /** 回退到指定消息之后（保留该消息本身） */
  async truncateAfterMessage(sessionId: string, _messageId: string): Promise<boolean> {
    if (isLegacySession(sessionId)) return false
    // TODO(pi-durable p3): durable 会话的截断
    throw new PhasePendingError('message truncate', 3)
  }
}

export const messageService = new MessageService()
