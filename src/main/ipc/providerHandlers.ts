import { ipcMain } from 'electron'
import { providerService } from '../services/providerService'
import type {
  ProviderSyncModelsParams,
  ProviderToggleEnabledParams,
  ProviderToggleModelEnabledParams,
  ProviderUpdateConfigParams
} from '../types'

/**
 * 提供商管理 IPC 处理器
 * 负责提供商和模型的配置管理
 */
export function registerProviderHandlers(): void {
  /** 获取所有提供商（含禁用的，用于设置面板） */
  ipcMain.handle('provider:listAll', () => {
    return providerService.listAll()
  })

  /** 获取所有已启用的提供商 */
  ipcMain.handle('provider:listEnabled', () => {
    return providerService.listEnabled()
  })

  /** 获取单个提供商 */
  ipcMain.handle('provider:getById', (_event, id: string) => {
    return providerService.getById(id)
  })

  /** 更新提供商配置（apiKey、baseUrl） */
  ipcMain.handle('provider:updateConfig', (_event, params: ProviderUpdateConfigParams) => {
    providerService.updateConfig(params.id, {
      apiKey: params.apiKey,
      baseUrl: params.baseUrl
    })
    return { success: true }
  })

  /** 切换提供商启用状态 */
  ipcMain.handle('provider:toggleEnabled', (_event, params: ProviderToggleEnabledParams) => {
    providerService.toggleEnabled(params.id, params.isEnabled)
    return { success: true }
  })

  /** 获取某个提供商的所有模型（含禁用的，用于设置面板） */
  ipcMain.handle('provider:listModels', (_event, providerId: string) => {
    return providerService.listModels(providerId)
  })

  /** 获取所有可用模型（已启用提供商 + 已启用模型，用于对话选择器） */
  ipcMain.handle('provider:listAvailableModels', () => {
    return providerService.listAvailableModels()
  })

  /** 切换模型启用状态 */
  ipcMain.handle('provider:toggleModelEnabled', (_event, params: ProviderToggleModelEnabledParams) => {
    providerService.toggleModelEnabled(params.id, params.isEnabled)
    return { success: true }
  })

  /** 从提供商 API 同步模型列表（当前先支持 OpenAI） */
  ipcMain.handle('provider:syncModels', async (_event, params: ProviderSyncModelsParams) => {
    return providerService.syncModelsFromProvider(params.providerId)
  })
}
