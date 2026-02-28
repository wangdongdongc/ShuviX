import { v7 as uuidv7 } from 'uuid'
import { getModels } from '@mariozechner/pi-ai'
import { providerDao } from '../dao/providerDao'
import { litellmService } from './litellmService'
import { createLogger } from '../logger'
import type { ApiProtocol, ModelCapabilities, Provider, ProviderModel } from '../types'

const log = createLogger('ProviderService')

/**
 * 提供商服务 — 编排提供商和模型的业务逻辑
 */
export class ProviderService {
  // ============ 提供商操作 ============

  /** 获取所有提供商（含禁用的） */
  listAll(): Provider[] {
    return providerDao.findAll()
  }

  /** 获取所有已启用的提供商 */
  listEnabled(): Provider[] {
    return providerDao.findEnabled()
  }

  /** 获取单个提供商 */
  getById(id: string): Provider | undefined {
    return providerDao.findById(id)
  }

  /** 更新提供商配置（apiKey、baseUrl） */
  updateConfig(id: string, config: { apiKey?: string; baseUrl?: string }): void {
    if (config.apiKey !== undefined) {
      providerDao.updateApiKey(id, config.apiKey)
    }
    if (config.baseUrl !== undefined) {
      providerDao.updateBaseUrl(id, config.baseUrl)
    }
  }

  /** 切换提供商启用状态 */
  toggleEnabled(id: string, isEnabled: boolean): void {
    providerDao.updateEnabled(id, isEnabled)
  }

  /** 添加自定义提供商 */
  addCustomProvider(params: { name: string; baseUrl: string; apiKey: string; apiProtocol: ApiProtocol }): Provider {
    const id = uuidv7()
    providerDao.insert({
      id,
      name: params.name,
      baseUrl: params.baseUrl.replace(/\/+$/, ''),
      apiKey: params.apiKey,
      apiProtocol: params.apiProtocol
    })
    return providerDao.findById(id)!
  }

  /** 删除自定义提供商 */
  deleteProvider(id: string): boolean {
    return providerDao.delete(id)
  }

  // ============ 模型操作 ============

  /** 获取某个提供商的所有模型（含禁用的，用于设置面板） */
  listModels(providerId: string): ProviderModel[] {
    return providerDao.findModelsByProvider(providerId)
  }

  /** 获取某个提供商的已启用模型 */
  listEnabledModels(providerId: string): ProviderModel[] {
    return providerDao.findEnabledModels(providerId)
  }

  /** 获取所有可用模型（已启用提供商 + 已启用模型，用于对话中的选择器） */
  listAvailableModels(): (ProviderModel & { providerName: string })[] {
    return providerDao.findAllEnabledModels()
  }

  /** 切换模型启用状态 */
  toggleModelEnabled(id: string, isEnabled: boolean): void {
    providerDao.updateModelEnabled(id, isEnabled)
  }

  /** 批量更新模型启用状态 */
  batchToggleModels(updates: Array<{ id: string; isEnabled: boolean }>): void {
    providerDao.batchUpdateModelEnabled(updates)
  }

  /** 手动添加模型 */
  addModel(providerId: string, modelId: string): void {
    providerDao.insertModel(providerId, modelId)
    // 插入后自动补充能力信息
    const provider = providerDao.findById(providerId)
    if (provider) {
      this.fillMissingCapabilities(providerId, provider.name, provider.baseUrl)
    }
  }

  /** 删除模型 */
  deleteModel(id: string): void {
    providerDao.deleteModel(id)
  }

  /** 更新模型能力信息 */
  updateModelCapabilities(id: string, capabilities: ModelCapabilities): void {
    providerDao.updateModelCapabilities(id, JSON.stringify(capabilities))
  }

  /**
   * 为指定提供商下 capabilities 为空的模型自动补充能力信息
   * 已有 capabilities 的模型不会被覆盖
   */
  fillMissingCapabilities(providerId: string, providerName: string, baseUrl?: string): void {
    if (!litellmService.isReady()) return
    const slug = providerName.toLowerCase()
    const models = providerDao.findModelsByProvider(providerId)
    for (const m of models) {
      // 跳过已有能力信息的模型
      const existing = m.capabilities ? JSON.parse(m.capabilities) : {}
      if (Object.keys(existing).length > 0) continue

      const caps = litellmService.getModelCapabilities(m.modelId, slug, baseUrl)
      if (caps && Object.keys(caps).length > 0) {
        providerDao.updateModelCapabilities(m.id, JSON.stringify(caps))
      }
    }
  }

  /** 遍历所有提供商，为 capabilities 为空的模型自动补充能力信息（启动时调用） */
  fillAllMissingCapabilities(): void {
    const providers = providerDao.findAll()
    for (const p of providers) {
      this.fillMissingCapabilities(p.id, p.name, p.baseUrl)
    }
  }

  /**
   * 从 pi-ai 注册表同步单个内置提供商的模型列表 + 能力信息
   * 已有模型不会被删除，仅新增缺失的模型并更新 capabilities
   */
  syncBuiltinModels(providerId: string, slug: string): { total: number; added: number } {
    const piModels = getModels(slug as Parameters<typeof getModels>[0])
    if (!piModels || piModels.length === 0) return { total: 0, added: 0 }

    const modelIds = piModels.map((m) => m.id)
    const existingIds = new Set(providerDao.findModelsByProvider(providerId).map((m) => m.modelId))

    // upsert 模型记录（新模型默认禁用）
    providerDao.upsertModels(providerId, modelIds)

    // 用 pi-ai 的数据填充 capabilities（覆盖已有值，保证与 pi-ai 同步）
    const modelRows = providerDao.findModelsByProvider(providerId)
    const piModelMap = new Map(piModels.map((m) => [m.id, m]))
    for (const row of modelRows) {
      const pm = piModelMap.get(row.modelId)
      if (!pm) continue
      const caps: ModelCapabilities = {
        reasoning: pm.reasoning || false,
        vision: (pm.input as string[])?.includes('image') || false,
        maxInputTokens: pm.contextWindow,
        maxOutputTokens: pm.maxTokens,
      }
      providerDao.updateModelCapabilities(row.id, JSON.stringify(caps))
    }

    const added = modelIds.filter((id) => !existingIds.has(id)).length
    return { total: modelIds.length, added }
  }

  /** 为所有内置提供商同步模型（启动时调用） */
  syncAllBuiltinModels(): void {
    const builtins = providerDao.findAll().filter((p) => p.isBuiltin)
    for (const p of builtins) {
      const slug = p.name // name 就是 pi-ai slug
      const result = this.syncBuiltinModels(p.id, slug)
      if (result.total > 0) {
        log.info(`同步 ${p.displayName || p.name}: ${result.total} 个模型（新增 ${result.added}）`)
      }
    }
  }

  /**
   * 从提供商 API 拉取并同步模型列表
   * 目前先支持 OpenAI
   */
  async syncModelsFromProvider(providerId: string): Promise<{ providerId: string; total: number; added: number }> {
    const provider = providerDao.findById(providerId)
    if (!provider) {
      throw new Error(`未找到提供商：${providerId}`)
    }

    const apiKey = provider.apiKey?.trim()
    if (!apiKey) {
      throw new Error('请先配置 API Key')
    }

    // 根据协议类型选择不同的远程拉取方式
    const protocol = provider.apiProtocol || 'openai-completions'
    let fetchedModelIds: string[]
    if (protocol === 'openai-completions') {
      const baseUrl = provider.baseUrl?.trim() || 'https://api.openai.com/v1'
      fetchedModelIds = await this.fetchOpenAIModels(apiKey, baseUrl)
    } else if (protocol === 'google-generative-ai') {
      const baseUrl = provider.baseUrl?.trim() || 'https://generativelanguage.googleapis.com'
      fetchedModelIds = await this.fetchGoogleModels(apiKey, baseUrl)
    } else {
      throw new Error('该协议类型暂不支持自动同步模型')
    }

    const existingModelIds = new Set(providerDao.findModelsByProvider(providerId).map((m) => m.modelId))

    providerDao.upsertModels(providerId, fetchedModelIds)

    // 自动补充新模型的能力信息
    this.fillMissingCapabilities(providerId, provider.name, provider.baseUrl)

    let added = 0
    for (const modelId of fetchedModelIds) {
      if (!existingModelIds.has(modelId)) {
        added += 1
      }
    }

    return {
      providerId,
      total: fetchedModelIds.length,
      added
    }
  }

  /** 从 Google Generative AI 拉取模型列表 */
  private async fetchGoogleModels(apiKey: string, baseUrl?: string): Promise<string[]> {
    // 兼容带或不带版本路径的 baseUrl（如 .../v1beta 或裸域名）
    let normalizedBaseUrl = (baseUrl?.trim() || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
    if (!normalizedBaseUrl.match(/\/v\d/)) {
      normalizedBaseUrl += '/v1beta'
    }
    const url = `${normalizedBaseUrl}/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`

    const response = await fetch(url, { method: 'GET' })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Google 模型拉取失败（${response.status}）：${errText}`)
    }

    const payload = await response.json() as { models?: Array<{ name?: string }> }
    const modelIds = (payload.models || [])
      .map((item) => item.name?.replace(/^models\//, '').trim())
      .filter((id): id is string => Boolean(id))

    if (modelIds.length === 0) {
      throw new Error('Google 返回的模型列表为空')
    }

    return [...new Set(modelIds)].sort((a, b) => a.localeCompare(b))
  }

  /** 从 OpenAI 拉取模型列表 */
  private async fetchOpenAIModels(apiKey: string, baseUrl?: string): Promise<string[]> {
    const normalizedBaseUrl = (baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')
    const url = `${normalizedBaseUrl}/models`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI 模型拉取失败（${response.status}）：${errText}`)
    }

    const payload = await response.json() as { data?: Array<{ id?: string }> }
    const modelIds = (payload.data || [])
      .map((item) => item.id?.trim())
      .filter((id): id is string => Boolean(id))

    if (modelIds.length === 0) {
      throw new Error('OpenAI 返回的模型列表为空')
    }

    // 去重并按字典序稳定排序，保证 UI 顺序可预测
    return [...new Set(modelIds)].sort((a, b) => a.localeCompare(b))
  }
}

export const providerService = new ProviderService()
