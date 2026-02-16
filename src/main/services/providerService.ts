import { v7 as uuidv7 } from 'uuid'
import { providerDao } from '../dao/providerDao'
import type { ApiProtocol, Provider, ProviderModel } from '../types'

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
    const id = `custom-${uuidv7()}`
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
  }

  /** 删除模型 */
  deleteModel(id: string): void {
    providerDao.deleteModel(id)
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

    // 仅支持 OpenAI 兼容协议的提供商同步模型
    const protocol = (provider as any).apiProtocol || 'openai-completions'
    if (protocol !== 'openai-completions' && providerId !== 'openai') {
      throw new Error('自动同步仅支持 OpenAI 兼容协议的提供商')
    }

    const apiKey = provider.apiKey?.trim()
    if (!apiKey) {
      throw new Error('请先配置 API Key')
    }

    const existingModelIds = new Set(providerDao.findModelsByProvider(providerId).map((m) => m.modelId))
    const baseUrl = provider.baseUrl?.trim() || (providerId === 'openai' ? 'https://api.openai.com/v1' : '')
    const fetchedModelIds = await this.fetchOpenAIModels(apiKey, baseUrl)

    providerDao.upsertModels(providerId, fetchedModelIds)

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
