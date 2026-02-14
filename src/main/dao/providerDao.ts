import { databaseManager } from './database'
import type { Provider, ProviderModel } from '../types'

/**
 * Provider DAO — 提供商和模型表的纯数据访问操作
 */
export class ProviderDao {
  private get db() {
    return databaseManager.getDb()
  }

  // ============ 提供商操作 ============

  /** 获取所有提供商，按 sortOrder 排序 */
  findAll(): Provider[] {
    return this.db
      .prepare('SELECT * FROM providers ORDER BY sortOrder ASC')
      .all() as Provider[]
  }

  /** 获取所有已启用的提供商 */
  findEnabled(): Provider[] {
    return this.db
      .prepare('SELECT * FROM providers WHERE isEnabled = 1 ORDER BY sortOrder ASC')
      .all() as Provider[]
  }

  /** 根据 ID 获取提供商 */
  findById(id: string): Provider | undefined {
    return this.db
      .prepare('SELECT * FROM providers WHERE id = ?')
      .get(id) as Provider | undefined
  }

  /** 更新提供商 API Key */
  updateApiKey(id: string, apiKey: string): void {
    this.db
      .prepare('UPDATE providers SET apiKey = ?, updatedAt = ? WHERE id = ?')
      .run(apiKey, Date.now(), id)
  }

  /** 更新提供商 Base URL */
  updateBaseUrl(id: string, baseUrl: string): void {
    this.db
      .prepare('UPDATE providers SET baseUrl = ?, updatedAt = ? WHERE id = ?')
      .run(baseUrl, Date.now(), id)
  }

  /** 更新提供商启用状态 */
  updateEnabled(id: string, isEnabled: boolean): void {
    this.db
      .prepare('UPDATE providers SET isEnabled = ?, updatedAt = ? WHERE id = ?')
      .run(isEnabled ? 1 : 0, Date.now(), id)
  }

  // ============ 模型操作 ============

  /** 获取某个提供商的所有模型 */
  findModelsByProvider(providerId: string): ProviderModel[] {
    return this.db
      .prepare('SELECT * FROM provider_models WHERE providerId = ? ORDER BY sortOrder ASC')
      .all(providerId) as ProviderModel[]
  }

  /** 获取某个提供商的已启用模型 */
  findEnabledModels(providerId: string): ProviderModel[] {
    return this.db
      .prepare('SELECT * FROM provider_models WHERE providerId = ? AND isEnabled = 1 ORDER BY sortOrder ASC')
      .all(providerId) as ProviderModel[]
  }

  /** 获取所有已启用提供商的已启用模型（用于对话中的模型选择器） */
  findAllEnabledModels(): (ProviderModel & { providerName: string })[] {
    return this.db
      .prepare(`
        SELECT pm.*, p.name as providerName
        FROM provider_models pm
        JOIN providers p ON pm.providerId = p.id
        WHERE p.isEnabled = 1 AND pm.isEnabled = 1
        ORDER BY p.sortOrder ASC, pm.sortOrder ASC
      `)
      .all() as (ProviderModel & { providerName: string })[]
  }

  /** 更新模型启用状态 */
  updateModelEnabled(id: string, isEnabled: boolean): void {
    this.db
      .prepare('UPDATE provider_models SET isEnabled = ? WHERE id = ?')
      .run(isEnabled ? 1 : 0, id)
  }

  /** 批量更新模型启用状态 */
  batchUpdateModelEnabled(updates: Array<{ id: string; isEnabled: boolean }>): void {
    const stmt = this.db.prepare('UPDATE provider_models SET isEnabled = ? WHERE id = ?')
    const batch = this.db.transaction(() => {
      for (const u of updates) {
        stmt.run(u.isEnabled ? 1 : 0, u.id)
      }
    })
    batch()
  }
}

export const providerDao = new ProviderDao()
