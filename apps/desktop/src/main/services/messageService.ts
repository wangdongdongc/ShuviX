/**
 * 消息服务 —— 会话对话内容的「UI 视角」读取端（只读投影）。
 *
 * pi-durable 切换（P1-01）之后按会话的存储类型分流：
 *  - `harness-v3-jsonl`（切换前的会话）：照旧可看 —— 经 agent-runtime 的 legacy 读取器把 `.jsonl`
 *    渲染成 ChatMessage（冻结的投影，「旧会话现在怎么显示，以后就怎么显示」）；这种会话只读，
 *    回退 / 截断一律不做（返回「没有可回退的目标」）。
 *  - `durable-sqlite-1`（新会话）：列表就是界面投影的消息（P3-07）—— `peek`（存储不在就是空，从不打开 /
 *    创建会话）再 `DurableSession.viewSnapshot().messages`，与 SyncHub 推给界面的 `view.messages` 同一份；
 *    回退 / 截断（P3-10b）= 运行时的 `DurableSession.rollbackTo(条目 id, {keep})`：消息 id 就是条目 id
 *    （只认规范的正整数写法，PIN-01），`peek` 打开（从不建存储），运行时校验目标、销毁 agent、建 fork；
 *    被拒（目标不在 / 不是用户消息）= 「没有可回退的目标」，句柄恰好被关掉就再窥视一次（PIN-04）。
 *
 * 清空（`clear`）两种都做：经 SessionHost 关掉并删掉存储；旧格式会话清空之后换成当前存储类型，
 * 从此是一条全新的新格式会话（PIN-22，什么都不带过去 —— 不是迁移）。
 *
 * 走到这里的旧格式会话只剩不绑文件的那些（普通对话、bot 对话、子会话）：绑着文件的（`notebookPath`）
 * 启动时已被原地重置成新格式、旧格式的 Chrome 标签页会话已被删掉（services/legacySwitchover）。重置留下的
 * `.jsonl` 不再读 —— 行已是新格式，这里按新格式走；删除 / 清空时随 deleteSessionStorage 一起删。
 */
import { SessionClosedError } from '@shuvix/agent-runtime'
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
  /**
   * 会话当前上下文对应的消息列表（已应用压缩过滤：被压缩的历史不在其中）。
   *
   * 新格式会话 = 界面投影的 `messages`（P3-07）：只 `peek`（没有存储 → `[]`，从不打开 / 创建会话；宿主已封存
   * → `[]`），再取 `viewSnapshot()`（投影跟上了就用它的值，否则现投影一次，从不挂载）。句柄恰好在两步之间
   * 被关掉（LRU / 退出）就再窥视一次。不认识的存储类型 `peek` 不打开（存储路由答「不在」）。
   */
  async listBySession(sessionId: string): Promise<ChatMessage[]> {
    if (isLegacySession(sessionId)) return readLegacyTranscript(sessionId)?.messages ?? []
    for (let attempt = 0; ; attempt++) {
      const session = await getSessionHost().peek(sessionId)
      if (session === undefined) return []
      try {
        return (await session.viewSnapshot()).messages
      } catch (error) {
        if (!(error instanceof SessionClosedError) || attempt > 0) throw error
      }
    }
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
   * 解析回退目标（**只读，不碰宿主**）：旧格式会话只读、id 不是规范的条目 id（PIN-01）→ undefined；
   * 否则 `{ targetId: messageId }`。目标在不在当前对话里由运行时的 `rollbackTo` 校验（拒绝之前什么都不动），
   * 这里只是旧格式守卫加解析（PIN-05）。`targetId: null`（「回退到最开头」）不再产生。
   */
  async resolveRollbackTarget(
    sessionId: string,
    messageId: string
  ): Promise<{ targetId: string | null } | undefined> {
    if (isLegacySession(sessionId)) return undefined
    return parseEntryId(messageId) === undefined ? undefined : { targetId: messageId }
  }

  /**
   * 执行回退：`rollbackTo(条目 id)`。真的回退了才是 true；旧格式会话、`null`、不规范的 id、没有存储 /
   * 宿主已封存、运行时拒绝（`not_found` / `invalid_target`）都是 false。
   */
  async applyRollback(sessionId: string, targetId: string | null): Promise<boolean> {
    return await this.rollbackDurable(sessionId, targetId, false)
  }

  /**
   * 回退到指定消息之前（该消息本身也不再在上下文中）。运行时自己先停下在跑的 run、销毁 agent，
   * 调用方不必（也不该）预先关停 —— 那样一个无效目标也会把在跑的 run 停掉。
   */
  async rollbackToMessage(sessionId: string, messageId: string): Promise<boolean> {
    const target = await this.resolveRollbackTarget(sessionId, messageId)
    if (!target) return false
    return await this.applyRollback(sessionId, target.targetId)
  }

  /** 回退到指定消息之后（保留该消息本身）：`rollbackTo(条目 id, { keep: true })` */
  async truncateAfterMessage(sessionId: string, messageId: string): Promise<boolean> {
    const target = await this.resolveRollbackTarget(sessionId, messageId)
    if (!target) return false
    return await this.rollbackDurable(sessionId, target.targetId, true)
  }

  /**
   * 回退 / 截断的共用一段：`peek`（没有存储 / 宿主已封存 → false，从不建存储）→ `rollbackTo`。
   * 句柄恰好在两步之间被关掉（`closed`：LRU / 退出）就再窥视一次、只再试一次（PIN-04；拒绝发生在任何
   * 写之前，重试是安全的）。
   */
  private async rollbackDurable(
    sessionId: string,
    targetId: string | null,
    keep: boolean
  ): Promise<boolean> {
    if (targetId === null || isLegacySession(sessionId)) return false
    const entryId = parseEntryId(targetId)
    if (entryId === undefined) return false
    for (let attempt = 0; ; attempt++) {
      const session = await getSessionHost().peek(sessionId)
      if (session === undefined) return false
      const result = keep
        ? await session.rollbackTo(entryId, { keep: true })
        : await session.rollbackTo(entryId)
      if (result.ok) return true
      if (result.reason !== 'closed' || attempt > 0) return false
    }
  }
}

/**
 * 消息 id → 条目 id（PIN-01）：只认规范的正整数写法（`/^[1-9]\d*$/`）且在安全整数范围内；其余（空串、
 * `'0'`、负数、小数、前导零、科学计数、带空白、超出安全整数、UUID……）都不是条目 id。`Number(id)` 单独用
 * 会把 `'1e3'` / `' 42'` / `'01'` 也认下来。
 */
export function parseEntryId(messageId: string): number | undefined {
  if (!/^[1-9]\d*$/.test(messageId)) return undefined
  const id = Number(messageId)
  return Number.isSafeInteger(id) ? id : undefined
}

export const messageService = new MessageService()
