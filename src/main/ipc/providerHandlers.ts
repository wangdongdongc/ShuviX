import { ipcMain } from 'electron'
import { providerService } from '../services/providerService'
import type {
  ProviderAddModelParams,
  ProviderAddParams,
  ProviderDeleteParams,
  ProviderSyncModelsParams,
  ProviderToggleEnabledParams,
  ProviderToggleModelEnabledParams,
  ProviderUpdateConfigParams,
  ProviderUpdateModelCapabilitiesParams
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

  /** 从提供商 API 同步模型列表（支持 OpenAI 兼容协议） */
  ipcMain.handle('provider:syncModels', async (_event, params: ProviderSyncModelsParams) => {
    return providerService.syncModelsFromProvider(params.providerId)
  })

  /** 添加自定义提供商 */
  ipcMain.handle('provider:add', (_event, params: ProviderAddParams) => {
    return providerService.addCustomProvider(params)
  })

  /** 删除自定义提供商 */
  ipcMain.handle('provider:delete', (_event, params: ProviderDeleteParams) => {
    const ok = providerService.deleteProvider(params.id)
    return { success: ok }
  })

  /** 手动添加模型 */
  ipcMain.handle('provider:addModel', (_event, params: ProviderAddModelParams) => {
    providerService.addModel(params.providerId, params.modelId)
    return { success: true }
  })

  /** 删除模型 */
  ipcMain.handle('provider:deleteModel', (_event, id: string) => {
    providerService.deleteModel(id)
    return { success: true }
  })

  /** 更新模型能力信息 */
  ipcMain.handle('provider:updateModelCapabilities', (_event, params: ProviderUpdateModelCapabilitiesParams) => {
    providerService.updateModelCapabilities(params.id, params.capabilities)
    return { success: true }
  })
}
