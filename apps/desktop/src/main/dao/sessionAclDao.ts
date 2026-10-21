import { BaseDao } from './database'
import {
  isAclKind,
  isAclSource,
  isPathAccess,
  type AclEntry
} from '@shuvix/chat-protocol/sessionAcl'

/** session_acl 的原始行（attrs 仍是 JSON 文本，今天没有任何种类用它） */
interface SessionAclRow {
  id: string
  sessionId: string
  kind: string
  target: string
  access: string
  source: string
  sourceKey: string
  createdAt: number
  updatedAt: number
}

const COLUMNS = 'id, sessionId, kind, target, access, source, sourceKey, createdAt, updatedAt'

/**
 * 原始行 → AclEntry；认不出的种类 / 来源 / 访问方式返回 null。这种行来自更新的版本（以后的网络权限）
 * 或手改数据库 —— 读的一侧跳过它们，不让一行看不懂的数据拖垮整张表，也绝不把它猜成某种授权。
 */
function parseRow(row: SessionAclRow): AclEntry | null {
  if (!isAclKind(row.kind) || !isAclSource(row.source) || !isPathAccess(row.access)) return null
  return { ...row, kind: row.kind, source: row.source, access: row.access }
}

/**
 * 会话权限表 DAO（表 session_acl，迁移 v33）—— 纯数据访问。对账、继承、谁能改哪一行都归上层
 * （services/acl）。删除会话不会级联到这里（库没开 `PRAGMA foreign_keys`）：必须显式 deleteBySession。
 */
export class SessionAclDao extends BaseDao {
  /** 一条会话的全部行（建立先后序；认不出的行跳过） */
  findBySession(sessionId: string): AclEntry[] {
    const rows = this.stmt(
      `SELECT ${COLUMNS} FROM session_acl WHERE sessionId = ? ORDER BY createdAt, rowid`
    ).all(sessionId) as SessionAclRow[]
    return rows.map(parseRow).filter((entry): entry is AclEntry => entry !== null)
  }

  /** 插入一行。同一 (会话, 种类, 来源, 来源键, 目标) 已有一行即抛错（唯一索引）—— 调用方先查 */
  insert(entry: AclEntry): void {
    this.stmt(
      `INSERT INTO session_acl (${COLUMNS}, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`
    ).run(
      entry.id,
      entry.sessionId,
      entry.kind,
      entry.target,
      entry.access,
      entry.source,
      entry.sourceKey,
      entry.createdAt,
      entry.updatedAt
    )
  }

  /** 改一行的访问方式；返回是否真有一行被改 */
  updateAccess(sessionId: string, id: string, access: AclEntry['access'], at: number): boolean {
    return (
      this.stmt(
        'UPDATE session_acl SET access = ?, updatedAt = ? WHERE sessionId = ? AND id = ?'
      ).run(access, at, sessionId, id).changes > 0
    )
  }

  /** 删一行；返回是否真有一行被删 */
  deleteById(sessionId: string, id: string): boolean {
    return (
      this.stmt('DELETE FROM session_acl WHERE sessionId = ? AND id = ?').run(sessionId, id)
        .changes > 0
    )
  }

  /**
   * 删所有会话里指向某个目标的某种行（会话种类：目标会话被删时，别的会话里授权它的那些行跟着去）；返回删掉的行数
   */
  /** 哪些会话里有指向某个目标的某种行（删之前查，好让那些会话的界面重拉） */
  findSessionsByTarget(kind: AclEntry['kind'], target: string): string[] {
    const rows = this.stmt(
      'SELECT DISTINCT sessionId FROM session_acl WHERE kind = ? AND target = ?'
    ).all(kind, target) as Array<{ sessionId: string }>
    return rows.map((r) => r.sessionId)
  }

  deleteByTarget(kind: AclEntry['kind'], target: string): number {
    return this.stmt('DELETE FROM session_acl WHERE kind = ? AND target = ?').run(kind, target)
      .changes
  }

  /** 删一条会话的全部行（删会话时调）；返回删掉的行数 */
  deleteBySession(sessionId: string): number {
    return this.stmt('DELETE FROM session_acl WHERE sessionId = ?').run(sessionId).changes
  }

  /**
   * 在一个事务里跑 `fn`（对账要么整批落下、要么一行不动）。已在事务里就直接跑 —— 不嵌套 BEGIN。
   * 不用 better-sqlite3 的 `db.transaction`：单测跑在 node:sqlite 上，那边没有这个方法
   */
  transaction<T>(fn: () => T): T {
    const db = this.db as unknown as {
      exec(sql: string): void
      inTransaction?: boolean
      isTransaction?: boolean
    }
    if (db.inTransaction || db.isTransaction) return fn()
    db.exec('BEGIN')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

export const sessionAclDao = new SessionAclDao()
