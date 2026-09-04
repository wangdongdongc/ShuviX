import { ipcMain, shell } from 'electron'
import { providerService } from '../services/providerService'
import { providerOAuthService } from '../services/providerOAuthService'
import type {
  ProviderOAuthUiEvent,
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
 *
 * providers.changed 事件由 providerService 各 mutator 在数据层发布（覆盖所有调用方），
 * 此处不再负责广播。
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

  /** 更新提供商配置（name、apiKey、baseUrl、apiProtocol、metadata） */
  ipcMain.handle('provider:updateConfig', (_event, params: ProviderUpdateConfigParams) => {
    providerService.updateConfig(params.id, {
      name: params.name,
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      apiProtocol: params.apiProtocol,
      metadata: params.metadata
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
  ipcMain.handle(
    'provider:toggleModelEnabled',
    (_event, params: ProviderToggleModelEnabledParams) => {
      providerService.toggleModelEnabled(params.id, params.isEnabled)
      return { success: true }
    }
  )

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
  ipcMain.handle(
    'provider:updateModelCapabilities',
    (_event, params: ProviderUpdateModelCapabilitiesParams) => {
      providerService.patchCapabilities(params.id, params.capabilities)
      return { success: true }
    }
  )

  // ============ 订阅登录（OAuth） ============

  /** 查询某提供商的订阅登录状态 */
  ipcMain.handle('provider:oauthStatus', (_event, id: string) => {
    return providerOAuthService.status(id)
  })

  /**
   * 发起设备码登录。这个调用会一直挂到用户在浏览器里批准（或超时/取消）为止 ——
   * 期间的设备码经 `provider:oauth-event` 推给发起方窗口（设置面板是独立窗口，
   * 所以发给 event.sender 而不是主窗口）。
   */
  ipcMain.handle('provider:oauthLogin', async (event, id: string) => {
    const send = (payload: ProviderOAuthUiEvent): void => {
      if (event.sender.isDestroyed()) return
      event.sender.send('provider:oauth-event', payload)
    }
    return providerOAuthService.login(id, (e) => {
      if (e.type === 'device_code') {
        send({
          providerId: id,
          kind: 'device_code',
          userCode: e.userCode,
          verificationUri: e.verificationUri,
          expiresInSeconds: e.expiresInSeconds
        })
        // 顺手把验证页打开；打不开也不算失败，界面上有链接和用户码可以手动走
        void shell.openExternal(e.verificationUri).catch(() => undefined)
        return
      }
      if (e.type === 'auth_url') {
        send({ providerId: id, kind: 'message', message: e.instructions || e.url })
        return
      }
      if (e.type === 'info' || e.type === 'progress') {
        send({ providerId: id, kind: 'message', message: e.message })
      }
    })
  })

  /** 取消进行中的登录 */
  ipcMain.handle('provider:oauthCancel', (_event, id: string) => {
    providerOAuthService.cancelLogin(id)
    return { success: true }
  })

  /** 退出订阅登录（清凭据；API Key 不动） */
  ipcMain.handle('provider:oauthLogout', async (_event, id: string) => {
    await providerOAuthService.logout(id)
    return { success: true }
  })
}
