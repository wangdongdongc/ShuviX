import { providerDao } from '../dao/providerDao'
import type { Provider, ProviderModel } from '../types'

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
}

export const providerService = new ProviderService()
