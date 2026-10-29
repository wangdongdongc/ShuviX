/**
 * 自动脱敏的出口装饰器（docs/auto-redaction-design.md §2.4 / §2.5）—— 一个完整的 pi-ai `Models` 装饰器，
 * 每条会话一份：SessionHost 打开会话时把它包在全局 Models 外面交给 Harness，于是这条会话里的每个模型调用
 * （根 agent、派生 agent、hook agent、审查员、压缩摘要）都经过它，而且都知道是哪条会话。
 *
 *  - 请求：问宿主的策略（第一层 / 第二层，按这次请求来自的对话认 agent），按判定改写（redactionEgress）；
 *    记录里的模型回复是别的模型产出的，那几个模型也各问一次（§15 第一个读者）。兜底新认出的记进对照表；这次的
 *    判定留给写入时用（工具结果里默认照发的几类，§15.2）。第一层或第二层拒发 → 不发请求，交回一条出错的回复（不重试）。
 *  - 回复：这次以真值发出去过东西时，流式事件里累积的回复与最终结果都把那些真值换回占位符。
 *  - 改写本身出错（只可能是 bug）：记 error，按对话记录里存的样子原样发出 —— 存的本来就是占位符，原样发
 *    只是少了请求时现拼的那部分的兜底，与「检测器出错当作漏检」同一个处置。
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
import {
  EgressBlockedError,
  prepareEgress,
  type EgressDecision,
  type ReaderDecisions,
  type Remasker
} from './redactionEgress'
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

function remaskEvent(event: AssistantMessageEvent, remasker: Remasker): AssistantMessageEvent {
  if (event.type === 'done') return { ...event, message: remasker.message(event.message) }
  if (event.type === 'error') return { ...event, error: remasker.message(event.error) }
  if ('partial' in event) return { ...event, partial: remasker.partial(event.partial) }
  return event
}

function hasResult(
  source: AsyncIterable<AssistantMessageEvent>
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
  return typeof (source as { result?: unknown }).result === 'function'
}

/**
 * 记录里的模型回复是哪些模型产出的（§15.2 的第一个读者），每个问一次策略（同一个对话）；这次的目的地用这次的判定。
 * 问不到（策略抛错，比如服务商已经删了）= undefined，出口按不照发。
 */
async function readerDecisions(
  context: Context,
  model: Model<Api>,
  decision: EgressDecision,
  decide: (provider: string, modelId: string) => EgressDecision | Promise<EgressDecision>,
  deps: RedactionEgressDeps
): Promise<ReaderDecisions> {
  const key = (provider: string, modelId: string): string => `${provider}\u0000${modelId}`
  const current = key(model.provider, model.id)
  const decisions = new Map<string, EgressDecision | undefined>([[current, decision]])
  for (const message of context.messages) {
    if (message.role !== 'assistant') continue
    const k = key(message.provider, message.model)
    if (decisions.has(k)) continue
    try {
      decisions.set(k, await decide(message.provider, message.model))
    } catch (error) {
      decisions.set(k, undefined)
      deps.logger.warn(
        `session ${deps.sessionId}: no redaction decision for ${message.provider}/${message.model}; its earlier content keeps placeholders: ${errorText(error)}`
      )
    }
  }
  return (provider, modelId) => decisions.get(key(provider, modelId))
}

export function withRedactionEgress(inner: Models, deps: RedactionEgressDeps): Models {
  /** 改写这次请求；拒发抛 EgressBlockedError，其余出错原样发 */
  const prepare = async (
    model: Model<Api>,
    context: Context,
    providerSessionId: string | undefined
  ): Promise<{ context: Context; remasker: Remasker | undefined }> => {
    const redaction = deps.redaction()
    if (!redaction) return { context, remasker: undefined }
    try {
      const conversationId = await redaction.conversationOf(providerSessionId)
      const decide = (
        provider: string,
        modelId: string
      ): EgressDecision | Promise<EgressDecision> =>
        deps.policy({
          sessionId: deps.sessionId,
          ...(conversationId === undefined ? {} : { conversationId }),
          provider,
          model: modelId
        })
      const decision = await decide(model.provider, model.id)
      if (conversationId !== undefined) redaction.noteDecision(conversationId, decision)
      const readerOf = await readerDecisions(context, model, decision, decide, deps)
      const prepared = prepareEgress(
        context,
        await redaction.table(),
        redaction.signer,
        decision,
        readerOf
      )
      await redaction.record(prepared.entries)
      return { context: prepared.context, remasker: prepared.remasker }
    } catch (error) {
      if (error instanceof EgressBlockedError) throw error
      deps.logger.error(
        `session ${deps.sessionId}: preparing a model request for redaction failed; it is sent as stored: ${errorText(error)}`
      )
      return { context, remasker: undefined }
    }
  }

  const wrapStream = (
    model: Model<Api>,
    context: Context,
    providerSessionId: string | undefined,
    start: (context: Context) => AsyncIterable<AssistantMessageEvent>
  ): AssistantMessageEventStream => {
    const outer = createAssistantMessageEventStream()
    void (async () => {
      let prepared: { context: Context; remasker: Remasker | undefined }
      try {
        prepared = await prepare(model, context, providerSessionId)
      } catch (error) {
        const message = errorReply(model, errorText(error))
        outer.push({ type: 'error', reason: 'error', error: message })
        outer.end(message)
        return
      }
      const { remasker } = prepared
      let terminated = false
      try {
        const source = start(prepared.context)
        for await (const event of source) {
          if (event.type === 'done' || event.type === 'error') terminated = true
          outer.push(remasker ? remaskEvent(event, remasker) : event)
        }
        if (terminated) return
        if (!hasResult(source)) throw new Error('the model stream ended without a result')
        const result = await source.result()
        outer.end(remasker ? remasker.message(result) : result)
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
      wrapStream(model, context, streamOptions?.sessionId, (prepared) =>
        inner.stream(model, prepared, streamOptions)
      ),
    streamSimple: (
      model: Model<Api>,
      context: Context,
      streamOptions?: ModelsSimpleStreamOptions
    ) =>
      wrapStream(model, context, streamOptions?.sessionId, (prepared) =>
        inner.streamSimple(model, prepared, streamOptions)
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
