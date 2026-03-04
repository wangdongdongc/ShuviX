import { BaseDao } from './database'
import { encrypt, decrypt } from '../utils/crypto'
import type { TelegramBot } from './types'

/** 解密 token 字段 */
function decryptBot<T extends TelegramBot | undefined>(b: T): T {
  if (!b) return b
  return { ...b, token: decrypt(b.token) } as T
}

/**
 * Telegram Bot DAO — telegram_bots 表的纯数据访问操作
 * token 字段加密存储
 */
export class TelegramBotDao extends BaseDao {
  findAll(): TelegramBot[] {
    const rows = this.db
      .prepare('SELECT * FROM telegram_bots ORDER BY createdAt ASC')
      .all() as TelegramBot[]
    return rows.map(decryptBot)
  }

  findById(id: string): TelegramBot | undefined {
    const row = this.db.prepare('SELECT * FROM telegram_bots WHERE id = ?').get(id) as
      | TelegramBot
      | undefined
    return decryptBot(row)
  }

  findEnabled(): TelegramBot[] {
    const rows = this.db
      .prepare('SELECT * FROM telegram_bots WHERE isEnabled = 1 ORDER BY createdAt ASC')
      .all() as TelegramBot[]
    return rows.map(decryptBot)
  }

  /** 插入 Bot（token 加密），id 为 Telegram bot numeric ID */
  insert(bot: { id: string; name: string; token: string; username: string }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO telegram_bots (id, name, token, username, allowedUsers, isEnabled, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, '[]', 1, ?, ?)`
      )
      .run(bot.id, bot.name, encrypt(bot.token), bot.username, now, now)
  }

  /** 更新 Bot（token 如有变更则重新加密） */
  update(
    id: string,
    fields: Partial<{
      name: string
      token: string
      username: string
      allowedUsers: string
      isEnabled: number
    }>
  ): void {
    const sets: string[] = []
    const values: unknown[] = []
    if (fields.name !== undefined) {
      sets.push('name = ?')
      values.push(fields.name)
    }
    if (fields.token !== undefined) {
      sets.push('token = ?')
      values.push(encrypt(fields.token))
    }
    if (fields.username !== undefined) {
      sets.push('username = ?')
      values.push(fields.username)
    }
    if (fields.allowedUsers !== undefined) {
      sets.push('allowedUsers = ?')
      values.push(fields.allowedUsers)
    }
    if (fields.isEnabled !== undefined) {
      sets.push('isEnabled = ?')
      values.push(fields.isEnabled)
    }
    if (sets.length === 0) return
    sets.push('updatedAt = ?')
    values.push(Date.now())
    values.push(id)
    this.db.prepare(`UPDATE telegram_bots SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM telegram_bots WHERE id = ?').run(id)
  }
}

export const telegramBotDao = new TelegramBotDao()
