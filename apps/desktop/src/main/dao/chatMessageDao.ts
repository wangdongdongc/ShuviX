import { v4 as uuidv4 } from 'uuid'
import { BaseDao } from './database'
import type { ChatAttachmentRef, ChatMessageInsert, ChatMessageRow } from './types/chatMessage'

/** DB 原始行（JSON 字段在 DB 里是字符串，布尔是 0/1） */
type Row = Omit<ChatMessageRow, 'attachments' | 'isError'> & {
  attachments: string | null
  isError: number
}

function parseRow(row: Row): ChatMessageRow {
  const { attachments: rawAttachments, isError, ...rest } = row
  let attachments: ChatAttachmentRef[] | undefined
  if (rawAttachments) {
    try {
      const parsed = JSON.parse(rawAttachments)
      if (Array.isArray(parsed) && parsed.length) attachments = parsed
    } catch {
      /* 坏的描述符不该让整条会话读不出来 —— 丢掉这一条的附件，消息本身照常 */
    }
  }
  return {
    ...rest,
    // 可空列统一收成「缺省即不铺键」，读侧不必到处判空串
    botName: rest.botName || undefined,
    displayName: rest.displayName || undefined,
    decision: rest.decision || undefined,
    reply: rest.reply || undefined,
    inlineTokens: rest.inlineTokens || undefined,
    replyToId: rest.replyToId || undefined,
    rootId: rest.rootId || undefined,
    ...(attachments ? { attachments } : {}),
    ...(isError === 1 ? { isError: true as const } : {})
  }
}

/**
 * 群聊消息 DAO（表 `chat_messages`，迁移 v16）—— 只服务聊天会话。
 *
 * **seq 在事务内分配**：`better-sqlite3` 是同步的，`db.transaction()` 直接给到
 * 「读当前最大 seq → 插入」的原子性。v1 在会话树上要为这件事维护一整套异步互斥
 * （持锁跨越 getLeafId + append，外加禁写位与排空），这里一句事务就够了。
 */
export class ChatMessageDao extends BaseDao {
  /** 会话全量，按 seq 升序 */
  findBySession(sessionId: string): ChatMessageRow[] {
    const rows = this.stmt('SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY seq ASC').all(
      sessionId
    ) as Row[]
    return rows.map(parseRow)
  }

  /** 会话尾部 N 条，仍按 seq 升序返回（管线窗口用） */
  findTail(sessionId: string, limit: number): ChatMessageRow[] {
    const rows = this.stmt(
      'SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, limit) as Row[]
    return rows.reverse().map(parseRow)
  }

  /** 某条之后的全部消息（笔记增量窗；不含该条自身） */
  findAfterSeq(sessionId: string, seq: number): ChatMessageRow[] {
    const rows = this.stmt(
      'SELECT * FROM chat_messages WHERE sessionId = ? AND seq > ? ORDER BY seq ASC'
    ).all(sessionId, seq) as Row[]
    return rows.map(parseRow)
  }

  findById(id: string): ChatMessageRow | undefined {
    const row = this.stmt('SELECT * FROM chat_messages WHERE id = ?').get(id) as Row | undefined
    return row ? parseRow(row) : undefined
  }

  /**
   * 追加一条消息 —— **唯一的写入口**。seq 与 id 在同一个事务里定下，
   * 并发写者不会拿到相同的 seq（用户连发与 bot 回复交错是常态）。
   */
  append(input: ChatMessageInsert): ChatMessageRow {
    const id = input.id ?? uuidv4()
    const createdAt = Date.now()
    const insert = this.db.transaction((): number => {
      const max = this.stmt(
        'SELECT COALESCE(MAX(seq), 0) as m FROM chat_messages WHERE sessionId = ?'
      ).get(input.sessionId) as { m: number }
      const seq = max.m + 1
      this.stmt(
        `INSERT INTO chat_messages
           (id, sessionId, seq, authorKind, botName, displayName, content, decision,
            reply, inlineTokens, attachments, isError, replyToId, rootId, hop, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.sessionId,
        seq,
        input.authorKind,
        input.botName ?? null,
        input.displayName ?? null,
        input.content,
        input.decision ?? null,
        input.reply ?? null,
        input.inlineTokens ?? null,
        input.attachments?.length ? JSON.stringify(input.attachments) : null,
        input.isError ? 1 : 0,
        input.replyToId ?? null,
        input.rootId ?? null,
        input.hop ?? 0,
        createdAt
      )
      return seq
    })
    const seq = insert()
    return { ...input, id, seq, createdAt, hop: input.hop ?? 0 }
  }

  /** 会话内消息条数（删除确认弹窗等只要个数的地方） */
  countBySession(sessionId: string): number {
    const row = this.stmt('SELECT COUNT(*) as n FROM chat_messages WHERE sessionId = ?').get(
      sessionId
    ) as { n: number }
    return row.n
  }

  /**
   * 回退：删掉该条**及其之后**的一切。
   *
   * 群聊里「回退」的语义就是撤回这条与后续 —— 会话树那种「保留旧分支」在这里买不到
   * 东西（没有 regenerate 的分叉需求，也没有压缩）。返回被删掉的行，供调用方清理附件。
   */
  deleteFromMessage(sessionId: string, messageId: string): ChatMessageRow[] {
    const target = this.findById(messageId)
    if (!target || target.sessionId !== sessionId) return []
    const doomed = this.stmt(
      'SELECT * FROM chat_messages WHERE sessionId = ? AND seq >= ? ORDER BY seq ASC'
    ).all(sessionId, target.seq) as Row[]
    this.stmt('DELETE FROM chat_messages WHERE sessionId = ? AND seq >= ?').run(
      sessionId,
      target.seq
    )
    return doomed.map(parseRow)
  }

  /** 清空会话（清空对话 / 删除会话共用） */
  deleteBySession(sessionId: string): void {
    this.stmt('DELETE FROM chat_messages WHERE sessionId = ?').run(sessionId)
  }
}

export const chatMessageDao = new ChatMessageDao()
