import { v7 as uuidv7 } from 'uuid'
import { BaseDao } from './database'
import { buildJsonPatch } from './utils'
import { encrypt, decrypt } from '../utils/crypto'
import type { Provider, ProviderModel } from './types'
import type { AvailableModel, ModelCapabilities } from '../types'

function decryptProvider<T extends Provider | undefined>(p: T): T {
  if (!p) return p
  return { ...p, apiKey: decrypt(p.apiKey) } as T
}

/**
 * Provider DAO — 提供商和模型表的纯数据访问操作
 */
export class ProviderDao extends BaseDao {
  // ============ 提供商操作 ============

  /** 获取所有提供商，自定义在前，再按 sortOrder 排序 */
  findAll(): Provider[] {
    const rows = this.stmt(
      'SELECT * FROM providers ORDER BY isBuiltin ASC, sortOrder ASC'
    ).all() as Provider[]
    return rows.map(decryptProvider)
  }

  /** 获取所有已启用的提供商，自定义在前 */
  findEnabled(): Provider[] {
    const rows = this.stmt(
      'SELECT * FROM providers WHERE isEnabled = 1 ORDER BY isBuiltin ASC, sortOrder ASC'
    ).all() as Provider[]
    return rows.map(decryptProvider)
  }

  /** 根据 ID 获取提供商 */
  findById(id: string): Provider | undefined {
    const row = this.stmt('SELECT * FROM providers WHERE id = ?').get(id) as Provider | undefined
    return decryptProvider(row)
  }

  /** 按需查询：只 SELECT 指定字段，apiKey 仅在需要时解密 */
  pick<K extends keyof Provider>(id: string, fields: K[]): Pick<Provider, K> | undefined {
    const columns = fields.map((f) => String(f)).join(', ')
    const row = this.stmt(`SELECT ${columns} FROM providers WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    if ('apiKey' in row) {
      row.apiKey = decrypt(row.apiKey as string)
    }
    return row as Pick<Provider, K>
  }

  /** 更新提供商 API Key */
  updateApiKey(id: string, apiKey: string): void {
    this.stmt('UPDATE providers SET apiKey = ?, updatedAt = ? WHERE id = ?').run(
      encrypt(apiKey),
      Date.now(),
      id
    )
  }

  /** 更新提供商 Base URL */
  updateBaseUrl(id: string, baseUrl: string): void {
    this.stmt('UPDATE providers SET baseUrl = ?, updatedAt = ? WHERE id = ?').run(
      baseUrl,
      Date.now(),
      id
    )
  }

  /** 更新提供商启用状态 */
  updateEnabled(id: string, isEnabled: boolean): void {
    this.stmt('UPDATE providers SET isEnabled = ?, updatedAt = ? WHERE id = ?').run(
      isEnabled ? 1 : 0,
      Date.now(),
      id
    )
  }

  /** 插入自定义提供商（name 必须唯一） */
  insert(provider: {
    id: string
    name: string
    baseUrl: string
    apiKey: string
    apiProtocol: string
  }): void {
    const existing = this.stmt('SELECT id FROM providers WHERE name = ?').get(provider.name)
    if (existing) {
      throw new Error(`提供商名称"${provider.name}"已存在`)
    }
    const now = Date.now()
    const maxOrder = this.getMaxSortOrder()
    this.stmt(
      'INSERT INTO providers (id, name, apiKey, baseUrl, apiProtocol, isBuiltin, isEnabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)'
    ).run(
      provider.id,
      provider.name,
      encrypt(provider.apiKey),
      provider.baseUrl,
      provider.apiProtocol,
      maxOrder + 1,
      now,
      now
    )
  }

  /** 删除提供商及其模型（仅允许删除自定义提供商） */
  delete(id: string): boolean {
    const provider = this.pick(id, ['isBuiltin'])
    if (!provider || provider.isBuiltin) return false
    const deleteTx = this.db.transaction(() => {
      this.stmt('DELETE FROM provider_models WHERE providerId = ?').run(id)
      this.stmt('DELETE FROM providers WHERE id = ?').run(id)
    })
    deleteTx()
    return true
  }

  /** 获取当前最大 sortOrder */
  private getMaxSortOrder(): number {
    const row = this.stmt('SELECT MAX(sortOrder) as maxOrder FROM providers').get() as {
      maxOrder: number | null
    }
    return row?.maxOrder ?? -1
  }

  // ============ 模型操作 ============

  /** 获取某个提供商的所有模型 */
  findModelsByProvider(providerId: string): ProviderModel[] {
    return this.stmt(
      'SELECT * FROM provider_models WHERE providerId = ? ORDER BY sortOrder ASC'
    ).all(providerId) as ProviderModel[]
  }

  /** 获取某个提供商的已启用模型 */
  findEnabledModels(providerId: string): ProviderModel[] {
    return this.stmt(
      'SELECT * FROM provider_models WHERE providerId = ? AND isEnabled = 1 ORDER BY sortOrder ASC'
    ).all(providerId) as ProviderModel[]
  }

  /**
   * 批量同步模型列表（存在则更新排序，不存在则新增并默认禁用）
   * 注意：不会删除已有模型，避免误删用户手动配置
   */
  upsertModels(providerId: string, modelIds: string[]): void {
    const findStmt = this.stmt(
      'SELECT id FROM provider_models WHERE providerId = ? AND modelId = ?'
    )
    const insertStmt = this.stmt(
      'INSERT INTO provider_models (id, providerId, modelId, isEnabled, sortOrder) VALUES (?, ?, ?, 0, ?)'
    )
    const updateSortStmt = this.stmt(
      'UPDATE provider_models SET sortOrder = ? WHERE providerId = ? AND modelId = ?'
    )

    const syncTx = this.db.transaction(() => {
      modelIds.forEach((modelId, idx) => {
        const existing = findStmt.get(providerId, modelId) as { id: string } | undefined
        if (existing) {
          updateSortStmt.run(idx, providerId, modelId)
        } else {
          insertStmt.run(uuidv7(), providerId, modelId, idx)
        }
      })
    })

    syncTx()
  }

  /** 获取所有已启用提供商的已启用模型（用于对话中的模型选择器） */
  findAllEnabledModels(): AvailableModel[] {
    return this.stmt(
      `
        SELECT pm.*, COALESCE(NULLIF(p.displayName, ''), p.name) as providerName
        FROM provider_models pm
        JOIN providers p ON pm.providerId = p.id
        WHERE p.isEnabled = 1 AND pm.isEnabled = 1
        ORDER BY p.sortOrder ASC, pm.sortOrder ASC
      `
    ).all() as AvailableModel[]
  }

  /** 更新模型启用状态 */
  updateModelEnabled(id: string, isEnabled: boolean): void {
    this.stmt('UPDATE provider_models SET isEnabled = ? WHERE id = ?').run(isEnabled ? 1 : 0, id)
  }

  /** 批量更新模型启用状态 */
  batchUpdateModelEnabled(updates: Array<{ id: string; isEnabled: boolean }>): void {
    const stmt = this.stmt('UPDATE provider_models SET isEnabled = ? WHERE id = ?')
    const batch = this.db.transaction(() => {
      for (const u of updates) {
        stmt.run(u.isEnabled ? 1 : 0, u.id)
      }
    })
    batch()
  }

  /** 手动添加单个模型（默认启用） */
  insertModel(providerId: string, modelId: string): void {
    const existing = this.stmt(
      'SELECT id FROM provider_models WHERE providerId = ? AND modelId = ?'
    ).get(providerId, modelId)
    if (existing) return
    const maxOrder = this.stmt(
      'SELECT MAX(sortOrder) as maxOrder FROM provider_models WHERE providerId = ?'
    ).get(providerId) as { maxOrder: number | null }
    this.stmt(
      'INSERT INTO provider_models (id, providerId, modelId, isEnabled, sortOrder) VALUES (?, ?, ?, 1, ?)'
    ).run(uuidv7(), providerId, modelId, (maxOrder?.maxOrder ?? -1) + 1)
  }

  /** 更新模型能力（patch 语义：仅更新传入的字段，其余保留） */
  patchCapabilities(id: string, patch: Partial<ModelCapabilities>): void {
    const { setClauses, values } = buildJsonPatch(patch as Record<string, unknown>)
    if (!setClauses) return
    this.db
      .prepare(
        `UPDATE provider_models SET capabilities = json_set(COALESCE(capabilities, '{}'), ${setClauses}) WHERE id = ?`
      )
      .run(...values, id)
  }

  /** 删除单个模型 */
  deleteModel(id: string): void {
    this.stmt('DELETE FROM provider_models WHERE id = ?').run(id)
  }
}

export const providerDao = new ProviderDao()
