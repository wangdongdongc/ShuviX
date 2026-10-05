/**
 * 消息服务 —— 会话对话内容的「UI 视角」读取端（只读投影）。
 *
 * pi-durable 切换（P1-01）之后按会话的存储类型分流：
 *  - `harness-v3-jsonl`（切换前的会话）：照旧可看 —— 经 agent-runtime 的 legacy 读取器把 `.jsonl`
 *    渲染成 ChatMessage（冻结的投影，「旧会话现在怎么显示，以后就怎么显示」）；这种会话只读，
 *    回退 / 截断一律不做（返回「没有可回退的目标」）。
 *  - `durable-sqlite-1`（新会话）：durable 存储的投影还没写 —— TODO(pi-durable p3)：列表暂时为空，
 *    回退 / 截断抛 `PhasePendingError`。
 *
 * 清空（`clear`）两种都做：经 SessionHost 关掉并删掉存储；旧格式会话清空之后换成当前存储类型，
 * 从此是一条全新的新格式会话（PIN-22，什么都不带过去 —— 不是迁移）。
 */
import { PhasePendingError } from '@shuvix/agent-runtime'
import {
  CURRENT_SESSION_STORAGE_KIND,
  HARNESS_V3_JSONL,
  storageKindOf
} from '@shuvix/chat-protocol/sessionStorageKind'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import { readLegacyTranscript } from './sessionStorage'
import { getSessionHost } from './sessionHost'
import { mirroredAgentLocked, writeSessionMirror } from './sessionMirror'
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
   * 清空会话（裁决 PIN-08）：SessionHost 关掉存储（还在跑的 run 被中止、等它停下）并删掉文件，下一次
   * 发消息从一个只有根对话的新存储开始。之后镜像归位 —— `agentLocked:false`、`runState:'idle'` —— 镜像
   * 原先说有 agent 的，再给界面补一个 `agent_closing{false}`（存储连同锁一起没了，运行时不会再报）。
   * 销毁 agent 不在这里：调用方（网关的 clearMessages）先 `invalidateAgent`，那一步会广播 agent_closing 一对。
   *
   * 旧格式（只读）会话：删掉 `.jsonl`，并把存储类型换成当前类型 —— 清空之后它是一条可以接着用的
   * 新格式会话（PIN-22）。
   */
  async clear(sessionId: string): Promise<void> {
    const legacy = isLegacySession(sessionId) && !!sessionRecords.pick(sessionId, ['id'])
    const wasLocked = mirroredAgentLocked(sessionId)
    await getSessionHost().delete(sessionId)
    if (legacy) sessionRecords.updateStorageKind(sessionId, CURRENT_SESSION_STORAGE_KIND)
    writeSessionMirror(sessionId, { agentLocked: false, runState: 'idle' })
    if (wasLocked)
      chatFrontendRegistry.broadcast({ type: 'agent_closing', sessionId, closing: false })
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
