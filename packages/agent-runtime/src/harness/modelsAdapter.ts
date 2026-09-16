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
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models
} from '@earendil-works/pi-ai'
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai'
import {
  createAssistantMessageEventStream,
  streamSimple,
  completeSimple
} from '@earendil-works/pi-ai/compat'
import type { RuntimeNetwork } from '../types'

export interface ModelsAdapterDeps {
  /** 按 provider slug 取 apiKey（每次请求现取：OAuth token 会过期） */
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>
  /**
   * 网络侧钩子（可选）：把每次请求圈进宿主的作用域，并在错误落定时把 fetch 层的
   * 成因链贴回错误文案。不注入 = 行为与从前完全一致。见 types.ts 的 RuntimeNetwork。
   */
  network?: RuntimeNetwork
}

/**
 * 把 fetch 层记下的成因链贴到错误文案后面。
 *
 * 只在**确有**一次 fetch 失败时才动手：provider 用状态码答复的错误（400/429/5xx）
 * 走的是另一条路，文案本身已经有内容，不该被网络细节污染。已经包含就不重复贴
 * —— 同一条消息可能经过多层（如派生 agent 的转述）。
 */
function withFailureDetail(message: string, detail: string | undefined): string {
  if (!detail) return message
  const base = message.trim()
  if (base.includes(detail)) return message
  return base ? `${base} (${detail})` : detail
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
  /** 网络钩子没注入时退化成直跑，读不到任何详情 —— 与从前逐字节一致 */
  const scope = <T>(fn: () => T): T => (deps.network ? deps.network.runInRequestScope(fn) : fn())
  const lastFailure = (): string | undefined => deps.network?.describeLastFailure()

  /**
   * 给 pi-ai 抛出来的 error 事件补上成因。
   *
   * pi-ai 在 `stream` 的 catch 里就把异常压成了 `errorMessage`（见 types.ts 的
   * RuntimeNetwork 注释），流本身是正常结束的 —— 所以只能在事件流过这里时改，
   * 下面那个 catch 是看不到它的。不就地改 pi 的对象，浅拷一层再推。
   */
  const annotate = (event: AssistantMessageEvent): AssistantMessageEvent => {
    if (event.type !== 'error') return event
    const detail = lastFailure()
    if (!detail) return event
    const errorMessage = withFailureDetail(event.error.errorMessage ?? '', detail)
    if (errorMessage === event.error.errorMessage) return event
    return { ...event, error: { ...event.error, errorMessage } }
  }

  const streamWithKey = (
    model: Model<Api>,
    context: Context,
    options?: Record<string, unknown>
  ): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream()
    void scope(async () => {
      try {
        const apiKey = (await deps.getApiKey(model.provider)) || undefined
        for await (const event of streamSimple(model, context, { ...options, apiKey })) {
          out.push(annotate(event))
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
            errorMessage: withFailureDetail(
              err instanceof Error ? err.message : String(err),
              lastFailure()
            ),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            timestamp: Date.now()
          } as unknown as AssistantMessage
        })
      }
    })
    return out
  }

  /** 压缩 / 分支摘要走的非流式路径：异常原样抛出，只把成因接在 message 后面 */
  const completeWithKey = async (
    model: Model<Api>,
    context: Context,
    options?: Record<string, unknown>
  ): Promise<AssistantMessage> =>
    scope(async () => {
      try {
        const apiKey = (await deps.getApiKey(model.provider)) || undefined
        return await completeSimple(model, context, { ...options, apiKey })
      } catch (err) {
        const detail = lastFailure()
        if (!detail || !(err instanceof Error)) throw err
        err.message = withFailureDetail(err.message, detail)
        throw err
      }
    })

  return {
    streamSimple: streamWithKey,
    stream: streamWithKey,
    completeSimple: completeWithKey,
    complete: completeWithKey,
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
