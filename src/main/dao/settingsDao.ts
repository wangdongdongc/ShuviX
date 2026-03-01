import { BaseDao } from './database'
import type { Settings } from './types'

/**
 * Settings DAO — 设置表的纯数据访问操作
 */
export class SettingsDao extends BaseDao {
  /** 根据 key 获取设置值 */
  findByKey(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  /** 获取所有设置，返回 key-value 映射 */
  findAll(): Record<string, string> {
    const rows = this.db.prepare('SELECT * FROM settings').all() as Settings[]
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }

  /** 插入或更新设置 */
  upsert(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }
}

export const settingsDao = new SettingsDao()
