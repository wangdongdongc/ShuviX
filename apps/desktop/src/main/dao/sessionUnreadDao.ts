import { BaseDao } from './database'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'

interface SessionUnreadRow {
  sessionId: string
  since: number
  anchorAt: number | null
  failed: number
  manual: number
}

function toUnread(row: SessionUnreadRow): SessionUnread {
  return {
    since: row.since,
    ...(row.anchorAt === null ? {} : { anchorAt: row.anchorAt }),
    failed: row.failed === 1,
    manual: row.manual === 1
  }
}

/**
 * 收件箱的未读（表 session_unread，迁移 v40）—— 纯数据访问。一条未读会话一行，读过就删行（见
 * docs/inbox-read-state-design.md §4）；「什么时候算未读 / 读过」是上层 unreadService 的事。
 */
export class SessionUnreadDao extends BaseDao {
  /** 全部未读（会话 id → 未读） */
  findAll(): Record<string, SessionUnread> {
    const rows = this.stmt(
      'SELECT sessionId, since, anchorAt, failed, manual FROM session_unread'
    ).all() as SessionUnreadRow[]
    const result: Record<string, SessionUnread> = {}
    for (const row of rows) result[row.sessionId] = toUnread(row)
    return result
  }

  findBySessionId(sessionId: string): SessionUnread | null {
    const row = this.stmt(
      'SELECT sessionId, since, anchorAt, failed, manual FROM session_unread WHERE sessionId = ?'
    ).get(sessionId) as SessionUnreadRow | undefined
    return row ? toUnread(row) : null
  }

  /**
   * 一轮跑完、没人在看：已经未读的保留最早的 `since` / `anchorAt`（新内容从第一轮没看的地方开始），
   * `failed` 跟最近一轮走，`manual` 清掉（它现在有真的新内容了）
   */
  markTurn(sessionId: string, at: number, anchorAt: number | null, failed: boolean): void {
    this.stmt(
      `INSERT INTO session_unread (sessionId, since, anchorAt, failed, manual)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(sessionId) DO UPDATE SET failed = excluded.failed, manual = 0,
         anchorAt = CASE WHEN session_unread.manual = 1 THEN excluded.anchorAt
                         ELSE COALESCE(session_unread.anchorAt, excluded.anchorAt) END`
    ).run(sessionId, at, anchorAt, failed ? 1 : 0)
  }

  /** 用户手动标为未读：没有新内容可指，不画分隔线（anchorAt 为空） */
  markManual(sessionId: string, at: number): void {
    this.stmt(
      `INSERT INTO session_unread (sessionId, since, anchorAt, failed, manual)
       VALUES (?, ?, NULL, 0, 1)
       ON CONFLICT(sessionId) DO NOTHING`
    ).run(sessionId, at)
  }

  /** 读过：删行。回删掉的行数（0 = 本来就是已读） */
  deleteBySessionId(sessionId: string): number {
    return this.stmt('DELETE FROM session_unread WHERE sessionId = ?').run(sessionId).changes
  }

  /** 全部标为已读：回被清掉的会话 id */
  deleteAll(): string[] {
    const ids = (
      this.stmt('SELECT sessionId FROM session_unread').all() as Array<{ sessionId: string }>
    ).map((r) => r.sessionId)
    this.stmt('DELETE FROM session_unread').run()
    return ids
  }
}

export const sessionUnreadDao = new SessionUnreadDao()
