import { defineHandler, isClientAlive, onClientGone, pushTo } from './registry'
import { windowOf } from './ipcAdapter'
import { routeExternalUrl } from '../services/externalOpen'
import { providerService } from '../services/providerService'
import { providerOAuthService } from '../services/providerOAuthService'
import { commandClassifier } from '../services/commandClassifier'
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
  defineHandler('provider:listAll', () => {
    return providerService.listAll()
  })

  /** 获取所有已启用的提供商 */
  defineHandler('provider:listEnabled', () => {
    return providerService.listEnabled()
  })

  /** 获取单个提供商 */
  defineHandler('provider:getById', (_ctx, id: string) => {
    return providerService.getById(id)
  })

  /** 更新提供商配置（name、apiKey、baseUrl、apiProtocol、metadata） */
  defineHandler('provider:updateConfig', (_ctx, params: ProviderUpdateConfigParams) => {
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
  defineHandler('provider:toggleEnabled', (_ctx, params: ProviderToggleEnabledParams) => {
    providerService.toggleEnabled(params.id, params.isEnabled)
    return { success: true }
  })

  /** 获取某个提供商的所有模型（含禁用的，用于设置面板） */
  defineHandler('provider:listModels', (_ctx, providerId: string) => {
    return providerService.listModels(providerId)
  })

  /** 获取所有可用模型（已启用提供商 + 已启用模型，用于对话选择器） */
  defineHandler('provider:listAvailableModels', () => {
    return providerService.listAvailableModels()
  })

  /** 可选的命令分类模型（已启用提供商目录里的「分类」类模型，见 commandClassifier） */
  defineHandler('provider:listClassifierModels', () => {
    return commandClassifier.listModels()
  })

  /** 切换模型启用状态 */
  defineHandler('provider:toggleModelEnabled', (_ctx, params: ProviderToggleModelEnabledParams) => {
    providerService.toggleModelEnabled(params.id, params.isEnabled)
    return { success: true }
  })

  /** 从提供商 API 同步模型列表（支持 OpenAI 兼容协议） */
  defineHandler('provider:syncModels', async (_ctx, params: ProviderSyncModelsParams) => {
    return providerService.syncModelsFromProvider(params.providerId)
  })

  /** 添加自定义提供商 */
  defineHandler('provider:add', (_ctx, params: ProviderAddParams) => {
    return providerService.addCustomProvider(params)
  })

  /** 删除自定义提供商 */
  defineHandler('provider:delete', (_ctx, params: ProviderDeleteParams) => {
    const ok = providerService.deleteProvider(params.id)
    return { success: ok }
  })

  /** 手动添加模型 */
  defineHandler('provider:addModel', (_ctx, params: ProviderAddModelParams) => {
    providerService.addModel(params.providerId, params.modelId)
    return { success: true }
  })

  /** 删除模型 */
  defineHandler('provider:deleteModel', (_ctx, id: string) => {
    providerService.deleteModel(id)
    return { success: true }
  })

  /** 更新模型能力信息 */
  defineHandler(
    'provider:updateModelCapabilities',
    (_ctx, params: ProviderUpdateModelCapabilitiesParams) => {
      providerService.patchCapabilities(params.id, params.capabilities)
      return { success: true }
    }
  )

  // ============ 订阅登录（OAuth） ============

  /** 查询某提供商的订阅登录状态 */
  defineHandler('provider:oauthStatus', (_ctx, id: string) => {
    return providerOAuthService.status(id)
  })

  /**
   * 发起订阅登录。这个调用会一直挂到用户在浏览器里批准（或超时/取消/失败）为止 ——
   * 期间的事件经 `provider:oauth-event` 推给发起方窗口（设置面板是独立窗口，所以发给
   * 调用方 `ctx.client` 而不是主窗口）：设备码、授权页地址、要用户粘贴地址的提问（答案走
   * `provider:oauthAnswer`）。结束时推一条 `finished`：同一窗口里重新挂载的设置页（发起它的那个
   * 组件已经卸载、Promise 没人等）靠它知道该重查状态。
   *
   * 登录跟着发起它的窗口走：窗口关了就取消。浏览器流程（OpenAI）本身没有期限，不取消的话它会一直
   * 占着本机回调端口和这家的登录名额，直到重启。
   */
  defineHandler('provider:oauthLogin', async (ctx, id: string) => {
    // 发起方没了就不再推（pushTo 自己会跳过）
    const send = (payload: ProviderOAuthUiEvent): void => {
      pushTo(ctx.client, 'provider:oauth-event', payload)
    }
    // 顺手把验证页 / 授权页打开；打不开也不算失败，界面上有链接可以手动走。
    // 这个地址来自提供商服务器的响应（或 pi 拼的授权地址），不是写死的，所以同样过 externalOpen 那道闸
    // 网络客户端（浏览器）发起的：不在这台电脑上开浏览器（远处的人看不见），它的界面上有链接
    const openInBrowser = (url: string): void => {
      if (ctx.client.kind !== 'window' || !isClientAlive(ctx.client)) return
      void routeExternalUrl(url, { parent: windowOf(ctx) })
    }
    const stopWatching = onClientGone(ctx.client, () => providerOAuthService.cancelLogin(id))
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
    stopWatching()
    send({ providerId: id, kind: 'finished' })
    return result
  })

  /** 回答登录中的提问（浏览器回不到本机时粘贴的地址）；提问已经不在 → success: false */
  defineHandler(
    'provider:oauthAnswer',
    (_ctx, params: { id: string; promptId: string; value: string }) => {
      return {
        success: providerOAuthService.answerPrompt(params.id, params.promptId, params.value)
      }
    }
  )

  /** 取消进行中的登录 */
  defineHandler('provider:oauthCancel', (_ctx, id: string) => {
    providerOAuthService.cancelLogin(id)
    return { success: true }
  })

  /** 退出订阅登录（清凭据；API Key 不动） */
  defineHandler('provider:oauthLogout', async (_ctx, id: string) => {
    await providerOAuthService.logout(id)
    return { success: true }
  })
}
