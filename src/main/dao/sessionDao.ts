import { BaseDao } from './database'
import { buildJsonPatch } from './utils'
import type { Session, SessionModelMetadata, SessionSettings } from './types'

/** DB 原始行类型（JSON 字段在 DB 中为字符串） */
type SessionRow = Omit<Session, 'modelMetadata' | 'settings'> & {
  modelMetadata: string
  settings: string
}

/** 安全解析 JSON，失败返回空对象 */
function safeParse<T>(json: string | undefined | null): T {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {} as T
  }
}

/** 将 DB 行的 JSON 字符串字段解析为类型化对象 */
function parseRow(row: SessionRow): Session {
  return {
    ...row,
    modelMetadata: safeParse<SessionModelMetadata>(row.modelMetadata),
    settings: safeParse<SessionSettings>(row.settings)
  }
}

/**
 * Session DAO — 会话表的纯数据访问操作
 */
export class SessionDao extends BaseDao {
  /** 获取所有会话，按更新时间倒序 */
  findAll(): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updatedAt DESC')
      .all() as SessionRow[]
    return rows.map(parseRow)
  }

  /** 根据 ID 获取单个会话 */
  findById(id: string): Session | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined
    return row ? parseRow(row) : undefined
  }

  /** 按需查询：只 SELECT 指定字段，JSON 字段仅在需要时解析 */
  pick<K extends keyof Session>(id: string, fields: K[]): Pick<Session, K> | undefined {
    const columns = fields.map((f) => String(f)).join(', ')
    const row = this.stmt(`SELECT ${columns} FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    const result = { ...row } as Record<string, unknown>
    if ('modelMetadata' in row) {
      result.modelMetadata = safeParse<SessionModelMetadata>(row.modelMetadata as string)
    }
    if ('settings' in row) {
      result.settings = safeParse<SessionSettings>(row.settings as string)
    }
    return result as Pick<Session, K>
  }

  /** 从 settings JSON 中按需提取指定字段（使用 json_extract，无需解析整个 JSON） */
  pickSettings<K extends keyof SessionSettings>(
    id: string,
    keys: K[]
  ): Pick<SessionSettings, K> | undefined {
    const selects = keys
      .map((k) => `json_extract(settings, '$.${String(k)}') as ${String(k)}`)
      .join(', ')
    const row = this.stmt(`SELECT ${selects} FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    // json_extract 对数组/对象返回 JSON 字符串，需二次解析
    for (const k of keys) {
      const v = row[String(k)]
      if (typeof v === 'string' && v.startsWith('[')) {
        row[String(k)] = JSON.parse(v)
      }
    }
    return row as Pick<SessionSettings, K>
  }

  /** 插入会话 */
  insert(session: Session): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id, title, projectId, provider, model, systemPrompt, modelMetadata, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        session.id,
        session.title,
        session.projectId,
        session.provider,
        session.model,
        session.systemPrompt,
        JSON.stringify(session.modelMetadata),
        JSON.stringify(session.settings),
        session.createdAt,
        session.updatedAt
      )
  }

  /** 更新标题和时间戳 */
  updateTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?')
      .run(title, Date.now(), id)
  }

  /** 更新会话模型配置（provider/model） */
  updateModelConfig(id: string, provider: string, model: string): void {
    this.db
      .prepare('UPDATE sessions SET provider = ?, model = ?, updatedAt = ? WHERE id = ?')
      .run(provider, model, Date.now(), id)
  }

  /** 更新时间戳 */
  touch(id: string): void {
    this.db.prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(Date.now(), id)
  }

  /** 更新会话所属项目 */
  updateProjectId(id: string, projectId: string | null): void {
    this.db
      .prepare('UPDATE sessions SET projectId = ?, updatedAt = ? WHERE id = ?')
      .run(projectId, Date.now(), id)
  }

  /** 查找指定项目下的所有会话 */
  findByProjectId(projectId: string): Session[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE projectId = ? ORDER BY updatedAt DESC')
      .all(projectId) as SessionRow[]
    return rows.map(parseRow)
  }

  /** 更新模型元数据（patch 语义：仅更新传入的字段，其余保留） */
  updateModelMetadata(id: string, patch: SessionModelMetadata): void {
    const { setClauses, values } = buildJsonPatch(patch as Record<string, unknown>)
    if (!setClauses) return
    this.db
      .prepare(
        `UPDATE sessions SET modelMetadata = json_set(COALESCE(modelMetadata, '{}'), ${setClauses}), updatedAt = ? WHERE id = ?`
      )
      .run(...values, Date.now(), id)
  }

  /** 更新会话级配置（patch 语义：仅更新传入的字段，其余保留） */
  updateSettings(id: string, patch: SessionSettings): void {
    const { setClauses, values } = buildJsonPatch(patch as Record<string, unknown>)
    if (!setClauses) return
    this.db
      .prepare(
        `UPDATE sessions SET settings = json_set(COALESCE(settings, '{}'), ${setClauses}), updatedAt = ? WHERE id = ?`
      )
      .run(...values, Date.now(), id)
  }

  /** 查找绑定了指定 Telegram Bot 的会话 */
  findByTelegramBotId(botId: string): Session | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE json_extract(settings, '$.telegramBotId') = ? LIMIT 1"
      )
      .get(botId) as SessionRow | undefined
    return row ? parseRow(row) : undefined
  }

  /** 清除指定 session 的 telegramBotId（设为 null） */
  clearTelegramBotId(sessionId: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET settings = json_set(COALESCE(settings, '{}'), '$.telegramBotId', null), updatedAt = ? WHERE id = ?`
      )
      .run(Date.now(), sessionId)
  }

  /** 清除所有绑定到指定 bot 的 session 的 telegramBotId */
  clearAllTelegramBotBindings(botId: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET settings = json_set(COALESCE(settings, '{}'), '$.telegramBotId', null), updatedAt = ? WHERE json_extract(settings, '$.telegramBotId') = ?`
      )
      .run(Date.now(), botId)
  }

  /** 删除会话 */
  deleteById(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }
}

export const sessionDao = new SessionDao()
