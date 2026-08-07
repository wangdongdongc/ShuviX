/**
 * Models 适配器 —— 把 ShuviX 现有的「resolveModel + getApiKey」模型解析方式
 * 接到 `AgentHarness` 要求的 `Models` 集合接口上。
 *
 * 背景：`Agent` 收的是「已解析好的 Model 对象 + getApiKey 回调」，而 `AgentHarness`
 * 收的是一个 `Models` provider 集合（认证由集合内部解析）。完整迁移到 `createModels()`
 * 意味着把 providers / provider_models 两张表也改造成 pi 的 Provider 注册表 —— 那是另一件事。
 *
 * 好在 harness 只用到 `Models` 的两个方法（`streamSimple` / `completeSimple`，
 * 后者供压缩与分支摘要使用），所以这里实现一个最小适配：
 * 转发给 pi-ai compat 的同名函数，并在每次调用时现取 apiKey（token 会过期，不能缓存）。
 * 其余方法保留 throw —— 一旦 harness 将来用到，会立刻炸在明确的位置，而不是静默降级。
 */
import type { Api, AssistantMessage, Context, Model, Models } from '@earendil-works/pi-ai'
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai'
import {
  createAssistantMessageEventStream,
  streamSimple,
  completeSimple
} from '@earendil-works/pi-ai/compat'

export interface ModelsAdapterDeps {
  /** 按 provider slug 取 apiKey（每次请求现取：OAuth token 会过期） */
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>
}

function unsupported(method: string): never {
  throw new Error(
    `Models.${method} 未实现 —— ShuviX 的模型解析仍走 resolveModel + providerDao，` +
      `harness 目前只需要 streamSimple / completeSimple。`
  )
}

/**
 * 构造一个仅支持流式/补全的最小 `Models`。
 *
 * `streamSimple` 必须**同步**返回 stream（接口签名如此），而 apiKey 解析是异步的 ——
 * 所以先造一个空 stream 立刻返回，再在后台把「取 key → 转发内层事件」泵进去。
 */
export function createModelsAdapter(deps: ModelsAdapterDeps): Models {
  const streamWithKey = (
    model: Model<Api>,
    context: Context,
    options?: Record<string, unknown>
  ): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream()
    void (async () => {
      try {
        const apiKey = (await deps.getApiKey(model.provider)) || undefined
        for await (const event of streamSimple(model, context, { ...options, apiKey })) {
          out.push(event)
        }
      } catch (err) {
        // 取 key / 建连阶段的失败：包成 error 事件，与 provider 侧错误路径同构，
        // 这样 harness 依旧只需处理 stopReason==='error' 一条分支。
        out.push({
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: err instanceof Error ? err.message : String(err),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            timestamp: Date.now()
          } as unknown as AssistantMessage
        })
      }
    })()
    return out
  }

  return {
    streamSimple: streamWithKey,
    stream: streamWithKey,
    async completeSimple(
      model: Model<Api>,
      context: Context,
      options?: Record<string, unknown>
    ): Promise<AssistantMessage> {
      const apiKey = (await deps.getApiKey(model.provider)) || undefined
      return completeSimple(model, context, { ...options, apiKey })
    },
    async complete(
      model: Model<Api>,
      context: Context,
      options?: Record<string, unknown>
    ): Promise<AssistantMessage> {
      const apiKey = (await deps.getApiKey(model.provider)) || undefined
      return completeSimple(model, context, { ...options, apiKey })
    },
    getProviders: () => unsupported('getProviders'),
    getProvider: () => unsupported('getProvider'),
    getModels: () => unsupported('getModels'),
    getModel: () => unsupported('getModel'),
    refresh: () => unsupported('refresh'),
    checkAuth: () => unsupported('checkAuth'),
    getAvailable: () => unsupported('getAvailable'),
    getAuth: () => unsupported('getAuth'),
    login: () => unsupported('login'),
    logout: () => unsupported('logout')
  } as unknown as Models
}
