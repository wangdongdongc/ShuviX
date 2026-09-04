import { v7 as uuidv7 } from 'uuid'
import { BaseDao } from './database'
import { buildJsonPatch } from './utils'
import { encrypt, decrypt } from '../utils/crypto'
import type { Provider, ProviderModel, ProviderOAuthCredential } from './types'
import type { AvailableModel, ModelCapabilities } from '../types'

/** DB 行：比对外视图多一列密文 oauth，少一个派生的 oauthConnected */
type ProviderRow = Omit<Provider, 'oauthConnected'> & { oauth?: string }

/**
 * DB 行 → 对外视图：解密 apiKey，并把 `oauth` 列**换成**一个布尔位。
 *
 * 换而不是加：这个对象会原样经 IPC 送到渲染进程，refresh token 到了那边就等于泄漏。
 * 要凭据本身请走 `readOAuth()`。
 */
function toProviderView<T extends ProviderRow | undefined>(row: T): Provider | undefined {
  if (!row) return undefined
  const { oauth, ...rest } = row
  return { ...rest, apiKey: decrypt(rest.apiKey), oauthConnected: oauth ? 1 : 0 }
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
    ).all() as ProviderRow[]
    return rows.map((r) => toProviderView(r) as Provider)
  }

  /** 获取所有已启用的提供商，自定义在前 */
  findEnabled(): Provider[] {
    const rows = this.stmt(
      'SELECT * FROM providers WHERE isEnabled = 1 ORDER BY isBuiltin ASC, sortOrder ASC'
    ).all() as ProviderRow[]
    return rows.map((r) => toProviderView(r) as Provider)
  }

  /** 根据 ID 获取提供商 */
  findById(id: string): Provider | undefined {
    const row = this.stmt('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
    return toProviderView(row)
  }

  /** 按需查询：只 SELECT 指定字段，apiKey 仅在需要时解密 */
  pick<K extends keyof Provider>(id: string, fields: K[]): Pick<Provider, K> | undefined {
    // oauthConnected 是派生位，不是列 —— 取它就得去查密文列再转 0/1
    const columns = fields.map((f) => (f === 'oauthConnected' ? 'oauth' : String(f))).join(', ')
    const row = this.stmt(`SELECT ${columns} FROM providers WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    if ('apiKey' in row) {
      row.apiKey = decrypt(row.apiKey as string)
    }
    if ('oauth' in row) {
      row.oauthConnected = row.oauth ? 1 : 0
      delete row.oauth
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

  // ============ OAuth 凭据（仅主进程；密文进出，明文不落 IPC） ============

  /** 读取并解密 OAuth 凭据；未登录或密文损坏返回 undefined */
  readOAuth(id: string): ProviderOAuthCredential | undefined {
    const row = this.stmt('SELECT oauth FROM providers WHERE id = ?').get(id) as
      | { oauth?: string }
      | undefined
    if (!row?.oauth) return undefined
    try {
      const parsed = JSON.parse(decrypt(row.oauth)) as Partial<ProviderOAuthCredential>
      if (!parsed?.access || !parsed?.refresh) return undefined
      return {
        access: parsed.access,
        refresh: parsed.refresh,
        expires: typeof parsed.expires === 'number' ? parsed.expires : 0
      }
    } catch {
      // 密钥文件换过 / 手工改坏：当作未登录，用户重新登录即可修复
      return undefined
    }
  }

  /** 写入 OAuth 凭据（登录成功与每次刷新后调用） */
  saveOAuth(id: string, credential: ProviderOAuthCredential): void {
    this.stmt('UPDATE providers SET oauth = ?, updatedAt = ? WHERE id = ?').run(
      encrypt(JSON.stringify(credential)),
      Date.now(),
      id
    )
  }

  /** 清除 OAuth 凭据（退出登录） */
  clearOAuth(id: string): void {
    this.stmt(`UPDATE providers SET oauth = '', updatedAt = ? WHERE id = ?`).run(Date.now(), id)
  }

  /** 更新提供商名称（仅自定义提供商） */
  updateName(id: string, name: string): void {
    this.stmt('UPDATE providers SET name = ?, updatedAt = ? WHERE id = ? AND isBuiltin = 0').run(
      name,
      Date.now(),
      id
    )
  }

  /** 更新提供商接口协议（仅自定义提供商） */
  updateApiProtocol(id: string, apiProtocol: string): void {
    this.stmt(
      'UPDATE providers SET apiProtocol = ?, updatedAt = ? WHERE id = ? AND isBuiltin = 0'
    ).run(apiProtocol, Date.now(), id)
  }

  /** 更新提供商 metadata（仅自定义提供商） */
  updateMetadata(id: string, metadata: string): void {
    this.stmt(
      'UPDATE providers SET metadata = ?, updatedAt = ? WHERE id = ? AND isBuiltin = 0'
    ).run(metadata, Date.now(), id)
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
    metadata?: string
  }): void {
    const existing = this.stmt('SELECT id FROM providers WHERE name = ?').get(provider.name)
    if (existing) {
      throw new Error(`提供商名称"${provider.name}"已存在`)
    }
    const now = Date.now()
    const maxOrder = this.getMaxSortOrder()
    this.stmt(
      'INSERT INTO providers (id, name, apiKey, baseUrl, apiProtocol, metadata, isBuiltin, isEnabled, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)'
    ).run(
      provider.id,
      provider.name,
      encrypt(provider.apiKey),
      provider.baseUrl,
      provider.apiProtocol,
      provider.metadata || '{}',
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
