/**
 * 自动脱敏的出口装饰器（docs/auto-redaction-design.md §16）—— 一个完整的 pi-ai `Models` 装饰器，每条会话一份：
 * SessionHost 打开会话时把它包在全局 Models 外面交给 Harness，于是这条会话里的每个模型调用（根 agent、派生 agent、
 * hook agent、审查员、压缩摘要）都经过它，而且都知道是哪条会话。
 *
 * 它不改请求：记录里存什么就发什么。每次请求只做两件事：问宿主的策略（按这次请求来自的对话认 agent），第一层拒发 →
 * 不发请求，交回一条出错的回复（不重试）；判定记下来，给之后写进这个对话的工具结果用。问策略本身出错：记 error，照发。
 *
 * 其余 `Models` 方法原样转交；对象字面量按 `Models` 标注，pi 升级多出的方法会在类型检查里报出来。
 */
import {
  createAssistantMessageEventStream,
  type AnyModel,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { RuntimeLogger } from '../types'
import { errorText } from './context'
import { EgressBlockedError, type EgressDecision } from './redactionEgress'
import type { SessionRedaction } from './sessionRedaction'

/** 宿主据此判一次请求（第一层 + 第二层） */
export interface RedactionPolicyRequest {
  sessionId: string
  /** 请求来自的对话（认不出 = undefined，按根 agent 判） */
  conversationId?: number
  /** pi 的 provider id（内置是 slug，自定义是行 id）—— 宿主换成设置里显示的名字 */
  provider: string
  model: string
}

export type RedactionPolicy = (
  request: RedactionPolicyRequest
) => EgressDecision | Promise<EgressDecision>

export interface RedactionEgressDeps {
  sessionId: string
  /** 这条会话的脱敏（会话对象建好之后才有；没有 = 原样转交） */
  redaction: () => SessionRedaction | undefined
  policy: RedactionPolicy
  logger: RuntimeLogger
}

/** 没发出去（拒发）或流断了时交回的那条出错回复 */
function errorReply(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now()
  }
}

function hasResult(
  source: AsyncIterable<AssistantMessageEvent>
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
  return typeof (source as { result?: unknown }).result === 'function'
}

export function withRedactionEgress(inner: Models, deps: RedactionEgressDeps): Models {
  /** 问这次请求的策略并记下判定；拒发抛 EgressBlockedError，其余出错照发 */
  const judge = async (model: Model<Api>, providerSessionId: string | undefined): Promise<void> => {
    const redaction = deps.redaction()
    if (!redaction) return
    let conversationId: number | undefined
    try {
      conversationId = await redaction.conversationOf(providerSessionId)
      const decision = await deps.policy({
        sessionId: deps.sessionId,
        ...(conversationId === undefined ? {} : { conversationId }),
        provider: model.provider,
        model: model.id
      })
      if (conversationId !== undefined) redaction.noteDecision(conversationId, decision)
      if (decision.blocked) throw new EgressBlockedError()
    } catch (error) {
      if (error instanceof EgressBlockedError) throw error
      // 问不到：之后的工具结果不能沿用上一次的判定（那可能是另一个模型的），按判不出处理
      if (conversationId !== undefined) redaction.forgetDecision(conversationId)
      deps.logger.error(
        `session ${deps.sessionId}: no redaction decision for this model request; it is sent as stored: ${errorText(error)}`
      )
    }
  }

  const wrapStream = (
    model: Model<Api>,
    providerSessionId: string | undefined,
    start: () => AsyncIterable<AssistantMessageEvent>
  ): AssistantMessageEventStream => {
    const outer = createAssistantMessageEventStream()
    void (async () => {
      try {
        await judge(model, providerSessionId)
      } catch (error) {
        const message = errorReply(model, errorText(error))
        outer.push({ type: 'error', reason: 'error', error: message })
        outer.end(message)
        return
      }
      let terminated = false
      try {
        const source = start()
        for await (const event of source) {
          if (event.type === 'done' || event.type === 'error') terminated = true
          outer.push(event)
        }
        if (terminated) return
        if (!hasResult(source)) throw new Error('the model stream ended without a result')
        outer.end(await source.result())
      } catch (error) {
        if (terminated) return
        const message = errorReply(model, errorText(error))
        outer.push({ type: 'error', reason: 'error', error: message })
        outer.end(message)
      }
    })()
    return outer
  }

  const decorated: Models = {
    stream: <TApi extends Api>(
      model: Model<TApi>,
      context: Context,
      streamOptions?: ModelsApiStreamOptions<TApi>
    ) =>
      wrapStream(model, streamOptions?.sessionId, () =>
        inner.stream(model, context, streamOptions)
      ),
    streamSimple: (
      model: Model<Api>,
      context: Context,
      streamOptions?: ModelsSimpleStreamOptions
    ) =>
      wrapStream(model, streamOptions?.sessionId, () =>
        inner.streamSimple(model, context, streamOptions)
      ),
    complete: <TApi extends Api>(
      model: Model<TApi>,
      context: Context,
      streamOptions?: ModelsApiStreamOptions<TApi>
    ) => decorated.stream(model, context, streamOptions).result(),
    completeSimple: (
      model: Model<Api>,
      context: Context,
      streamOptions?: ModelsSimpleStreamOptions
    ) => decorated.streamSimple(model, context, streamOptions).result(),

    // ── 原样转交 ──
    streamDeferred: (model, handle, deferredOptions) =>
      inner.streamDeferred(model, handle, deferredOptions),
    fetchDeferred: (model, handle, deferredOptions) =>
      inner.fetchDeferred(model, handle, deferredOptions),
    cancelDeferred: (model, handle, deferredOptions) =>
      inner.cancelDeferred(model, handle, deferredOptions),
    generateImages: (model, context, imageOptions) =>
      inner.generateImages(model, context, imageOptions),
    classify: (model, context, classifierOptions) =>
      inner.classify(model, context, classifierOptions),
    getProviders: () => inner.getProviders(),
    getProvider: (id) => inner.getProvider(id),
    getModels: (provider) => inner.getModels(provider),
    getModel: (provider, id) => inner.getModel(provider, id),
    getModelsOfType: (type, provider) => inner.getModelsOfType(type, provider),
    getModelOfType: (type, provider, id) => inner.getModelOfType(type, provider, id),
    getAllModels: (provider) => inner.getAllModels(provider),
    refresh: (refreshOptions) => inner.refresh(refreshOptions),
    checkAuth: (providerId, authOptions) => inner.checkAuth(providerId, authOptions),
    getAvailable: (providerId, authOptions) => inner.getAvailable(providerId, authOptions),
    getAvailableOfType: (type, providerId, authOptions) =>
      inner.getAvailableOfType(type, providerId, authOptions),
    getAllAvailable: (providerId, authOptions) => inner.getAllAvailable(providerId, authOptions),
    getAuth: ((providerOrModel: string | AnyModel, overrides?: Parameters<Models['getAuth']>[1]) =>
      typeof providerOrModel === 'string'
        ? inner.getAuth(providerOrModel, overrides)
        : inner.getAuth(providerOrModel, overrides)) as Models['getAuth'],
    login: (providerId, type, interaction, loginOptions) =>
      inner.login(providerId, type, interaction, loginOptions),
    logout: (providerId, authOptions) => inner.logout(providerId, authOptions)
  }
  return decorated
}
