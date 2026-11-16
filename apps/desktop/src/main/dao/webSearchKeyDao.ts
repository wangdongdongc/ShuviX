import { BaseDao } from './database'
import { decryptOrEmpty, encrypt } from '../utils/crypto'

/**
 * web_search_keys 表：商业搜索 API 的密钥（`web_search` 的 API 方式），一家一行，落盘是密文（utils/crypto）。
 * 不放 settings 表：那张表是明文，`settings:get` 智能体与远程访问都读得到。
 */
export class WebSearchKeyDao extends BaseDao {
  /** 一家的密钥（解密）；没存、或解不开 → 空串 */
  find(provider: string): string {
    const row = this.stmt('SELECT apiKey FROM web_search_keys WHERE provider = ?').get(provider) as
      | { apiKey: string }
      | undefined
    return row ? decryptOrEmpty(row.apiKey) : ''
  }

  set(provider: string, apiKey: string): void {
    this.stmt(
      `INSERT INTO web_search_keys (provider, apiKey, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET apiKey = excluded.apiKey, updatedAt = excluded.updatedAt`
    ).run(provider, encrypt(apiKey), Date.now())
  }

  delete(provider: string): void {
    this.stmt('DELETE FROM web_search_keys WHERE provider = ?').run(provider)
  }
}

export const webSearchKeyDao = new WebSearchKeyDao()
