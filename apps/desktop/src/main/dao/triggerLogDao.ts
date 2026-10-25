import { BaseDao } from './database'
import type { TriggerLogEntry, TriggerLogOutcome } from '@shuvix/chat-protocol/triggerSources'

/** 表里的一行（`event` 是 JSON 文本） */
type TriggerLogRow = Omit<TriggerLogEntry, 'event'> & { event: string }

function parseEvent(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * 触发日志 DAO —— trigger_logs 表（迁移 v35）的纯数据访问
 */
export class TriggerLogDao extends BaseDao {
  insert(entry: TriggerLogEntry): void {
    this.stmt(
      `INSERT INTO trigger_logs (id, createdAt, updatedAt, sourceId, trigger, bot, botDisplayName, botFile,
         bindingIndex, "when", outcome, sessionId, error, event)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id,
      entry.createdAt,
      entry.updatedAt,
      entry.sourceId,
      entry.trigger,
      entry.bot,
      entry.botDisplayName,
      entry.botFile,
      entry.bindingIndex,
      entry.when,
      entry.outcome,
      entry.sessionId,
      entry.error,
      JSON.stringify(entry.event)
    )
  }

  /** 改一条的结果（started → completed / failed） */
  updateOutcome(
    id: string,
    patch: { outcome: TriggerLogOutcome; error?: string; updatedAt: number }
  ): void {
    this.stmt('UPDATE trigger_logs SET outcome = ?, error = ?, updatedAt = ? WHERE id = ?').run(
      patch.outcome,
      patch.error ?? '',
      patch.updatedAt,
      id
    )
  }

  /** 最新的 limit 条，按时间倒序（同一毫秒按 id —— uuidv7 随时间递增） */
  list(limit: number): TriggerLogEntry[] {
    const rows = this.stmt(
      'SELECT * FROM trigger_logs ORDER BY createdAt DESC, id DESC LIMIT ?'
    ).all(limit) as TriggerLogRow[]
    return rows.map((row) => ({ ...row, event: parseEvent(row.event) }))
  }

  clear(): void {
    this.stmt('DELETE FROM trigger_logs').run()
  }

  /** 只留最新的 keep 条 */
  prune(keep: number): void {
    this.stmt(
      `DELETE FROM trigger_logs WHERE id NOT IN
         (SELECT id FROM trigger_logs ORDER BY createdAt DESC, id DESC LIMIT ?)`
    ).run(keep)
  }
}

export const triggerLogDao = new TriggerLogDao()
