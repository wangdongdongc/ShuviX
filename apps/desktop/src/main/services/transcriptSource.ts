/**
 * 会话转写的读口 —— 两个「读会话里说过什么」的消费者共用：自动审查的输入（`permissionReview`）与起标题
 * 的会话事实（`sessionTriggerFacts`）。按会话的存储类型分流，交回同一种形状的转写项（旧 → 新）：
 *
 *  - `durable-sqlite-1`（内存会话也是 —— 它们的行同样写着这一类）：`getSessionHost().peek(id)` +
 *    agent-runtime 的 `readTranscriptDigest`（当前对话的活上下文）。**只 peek**：存储不存在就是空转写；
 *    从不打开 / 创建存储、从不建 agent（`open` / `ensureAgentSession` / `openSessionStorage` 一个都不碰，
 *    P2-14-37 扫源码钉住）。peek 会重开一条关掉了但存储还在的会话，这是允许的（LRU 照常回收它）。
 *  - `harness-v3-jsonl`，或查不到行（与 `storageKindOf` / messageService 同一口径）：照旧
 *    `messageService.listBySession`（冻结投影），经 `transcriptItemsOf` 换成同一种形状。
 *  - 不认识的存储类型（更新的版本写的）：空转写，哪个读者都不跑。
 *
 * 失败照常抛出（审查交回 null 去问人、起标题的事实构造被拒）；peek 交回 undefined 不是失败。
 * 上限（每条 1500 字 / 首条 + 尾部 / 尾部 1000 字）不在这里 —— 各在消费者里只定义一次。
 */
import {
  readTranscriptDigest,
  type TranscriptAskItem,
  type TranscriptAssistantItem,
  type TranscriptUserItem
} from '@shuvix/agent-runtime'
import {
  DURABLE_SQLITE_1,
  HARNESS_V3_JSONL,
  storageKindOf
} from '@shuvix/chat-protocol/sessionStorageKind'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { messageService } from './messageService'
import { getSessionHost } from './sessionHost'
import { sessionRecords } from './sessionRecords'

/**
 * 一条转写项。`systemWritten` 只出现在旧格式会话上：系统写的 user 消息（后台完成通知、指令注入）——
 * 审查不收它；旧会话的起标题事实照旧把它算作一条 user（P2-14-34）。durable 的摘要里根本没有系统写的
 * user（通知是 `shuvix.notice`，按形状认出的通知也不交出）。
 */
export type TranscriptItem =
  | (TranscriptUserItem & { readonly systemWritten?: true })
  | TranscriptAssistantItem
  | TranscriptAskItem

/** 旧格式会话的消息列表（冻结投影）→ 转写项：user / assistant 各一项，内置 ask 的回答紧跟在它那条 assistant 后 */
export function transcriptItemsOf(messages: readonly ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const meta = message.metadata
      items.push({
        kind: 'user',
        ts: message.createdAt,
        text: message.content,
        ...(meta?.isSystemNotice || meta?.isInstructionInjection
          ? { systemWritten: true as const }
          : {})
      })
      continue
    }
    if (message.role !== 'assistant') continue // 错误事件（system_notify）不是对话
    items.push({
      kind: 'assistant',
      ts: message.createdAt,
      text: message.content,
      ...(message.metadata?.isCompactionSummary ? { compaction: true as const } : {})
    })
    // 只认内置 ask 工具（第三方工具名恒带 mcp__ 前缀，撞不上）；取消的（isError）不算回答
    for (const block of message.blocks ?? []) {
      if (block.type !== 'tool' || block.toolName !== 'ask') continue
      if (typeof block.result !== 'string' || block.isError) continue
      items.push({
        kind: 'ask',
        ts: message.createdAt,
        question: typeof block.args?.question === 'string' ? block.args.question : '',
        answer: block.result
      })
    }
  }
  return items
}

/** 一条会话的转写（当前上下文，旧 → 新）；路由见文件头 */
export async function readSessionTranscript(sessionId: string): Promise<TranscriptItem[]> {
  const kind = storageKindOf(sessionRecords.pick(sessionId, ['storageKind']) ?? {})
  if (kind === HARNESS_V3_JSONL) {
    return transcriptItemsOf(await messageService.listBySession(sessionId))
  }
  if (kind !== DURABLE_SQLITE_1) return [] // 更新的版本写的格式：不认识就不读（PIN-08）
  const session = await getSessionHost().peek(sessionId)
  if (session === undefined) return [] // 从未发过消息（存储不存在）/ 宿主已封存
  return (await readTranscriptDigest(session)).items
}
