import { BrowserWindow, ipcMain } from 'electron'
import { routeExternalUrl } from '../services/externalOpen'
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
   * 发起订阅登录。这个调用会一直挂到用户在浏览器里批准（或超时/取消/失败）为止 ——
   * 期间的事件经 `provider:oauth-event` 推给发起方窗口（设置面板是独立窗口，所以发给
   * event.sender 而不是主窗口）：设备码、授权页地址、要用户粘贴地址的提问（答案走
   * `provider:oauthAnswer`）。结束时推一条 `finished`：同一窗口里重新挂载的设置页（发起它的那个
   * 组件已经卸载、Promise 没人等）靠它知道该重查状态。
   *
   * 登录跟着发起它的窗口走：窗口关了就取消。浏览器流程（OpenAI）本身没有期限，不取消的话它会一直
   * 占着本机回调端口和这家的登录名额，直到重启。
   */
  ipcMain.handle('provider:oauthLogin', async (event, id: string) => {
    const sender = event.sender
    const send = (payload: ProviderOAuthUiEvent): void => {
      if (sender.isDestroyed()) return
      sender.send('provider:oauth-event', payload)
    }
    // 顺手把验证页 / 授权页打开；打不开也不算失败，界面上有链接可以手动走。
    // 这个地址来自提供商服务器的响应（或 pi 拼的授权地址），不是写死的，所以同样过 externalOpen 那道闸
    const openInBrowser = (url: string): void => {
      if (sender.isDestroyed()) return
      void routeExternalUrl(url, { parent: BrowserWindow.fromWebContents(sender) })
    }
    const cancelOnClose = (): void => providerOAuthService.cancelLogin(id)
    sender.once('destroyed', cancelOnClose)
    const result = await providerOAuthService.login(id, (e) => {
      switch (e.type) {
        case 'device_code':
          send({
            providerId: id,
            kind: 'device_code',
            userCode: e.userCode,
            verificationUri: e.verificationUri,
            expiresInSeconds: e.expiresInSeconds
          })
          openInBrowser(e.verificationUri)
          return
        case 'auth_url':
          send({ providerId: id, kind: 'auth_url', url: e.url })
          openInBrowser(e.url)
          return
        case 'prompt':
          send({
            providerId: id,
            kind: 'prompt',
            promptId: e.promptId,
            input: e.input,
            message: e.message,
            placeholder: e.placeholder
          })
          return
        case 'prompt_closed':
          send({ providerId: id, kind: 'prompt_closed', promptId: e.promptId })
          return
        case 'info':
        case 'progress':
          send({ providerId: id, kind: 'message', message: e.message })
      }
    })
    if (!sender.isDestroyed()) sender.removeListener('destroyed', cancelOnClose)
    send({ providerId: id, kind: 'finished' })
    return result
  })

  /** 回答登录中的提问（浏览器回不到本机时粘贴的地址）；提问已经不在 → success: false */
  ipcMain.handle(
    'provider:oauthAnswer',
    (_event, params: { id: string; promptId: string; value: string }) => {
      return {
        success: providerOAuthService.answerPrompt(params.id, params.promptId, params.value)
      }
    }
  )

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
