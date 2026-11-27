/**
 * 工具参数流式原文恢复装饰器（Pi 1.6.1 兼容）：
 *
 * Pi 1.6.1 的 `pi-ai` 适配器不再把 `partialJson` / `partialArgs` 挂在 `partial.content[i]` 的
 * `toolCall` 块上，而是只通过 `toolcall_delta` 事件增量发出 `delta`。ShuviX 的投影层（`project.ts`）
 * 与文档协作编辑虚影（`ghostSources.ts`）依赖 `block.partialJson` 填充 `SessionView.live.argsText`。
 *
 * 本装饰器在 `streamSimple` / `stream` 的事件流上按 `contentIndex` 累积 `toolcall_delta.delta`：
 *  - 流式期间写到 `event.partial.content[contentIndex].partialJson`，供 `pi-durable` 写入 `pi.live`；
 *  - `toolcall_end` / `done` 时清掉该临时属性，保证落盘的最终助手条目不携带任何多余字段。
 */
import {
  createAssistantMessageEventStream,
  type AnyModel,
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions
} from '@earendil-works/pi-ai'

type MutableToolCallBlock = {
  type: string
  partialJson?: string
  partialArgs?: string
}

function wrapEventStream(source: AssistantMessageEventStream): AssistantMessageEventStream {
  const buffers = new Map<number, string>()

  const cleanup = (content: readonly unknown[] | undefined): void => {
    if (!Array.isArray(content)) return
    for (const item of content) {
      if (typeof item === 'object' && item !== null && 'partialJson' in item) {
        delete (item as MutableToolCallBlock).partialJson
      }
    }
  }

  const tap = (event: AssistantMessageEvent): AssistantMessageEvent => {
    if (event.type === 'toolcall_start') {
      buffers.set(event.contentIndex, '')
    } else if (event.type === 'toolcall_delta') {
      const next = (buffers.get(event.contentIndex) ?? '') + event.delta
      buffers.set(event.contentIndex, next)
      const block = event.partial.content[event.contentIndex] as MutableToolCallBlock | undefined
      if (block?.type === 'toolCall') {
        block.partialJson = next
      }
    } else if (event.type === 'toolcall_end') {
      buffers.delete(event.contentIndex)
      const block = event.partial.content[event.contentIndex] as MutableToolCallBlock | undefined
      if (block && 'partialJson' in block) delete block.partialJson
      const tc = event.toolCall as unknown as MutableToolCallBlock | undefined
      if (tc && 'partialJson' in tc) delete tc.partialJson
    } else if (event.type === 'done') {
      buffers.clear()
      cleanup(event.message.content)
    } else if (event.type === 'error') {
      buffers.clear()
      cleanup(event.error.content)
    }
    return event
  }

  const out = createAssistantMessageEventStream()
  void (async () => {
    try {
      for await (const event of source) {
        out.push(tap(event))
      }
      const msg = await source.result()
      cleanup(msg.content)
      out.end(msg)
    } catch {
      out.end()
    }
  })()
  return out
}

export function withToolCallPartialJson(inner: Models): Models {
  const decorated: Models = {
    stream: <TApi extends Api>(
      model: Model<TApi>,
      context: Context,
      streamOptions?: ModelsApiStreamOptions<TApi>
    ) => wrapEventStream(inner.stream(model, context, streamOptions)),
    streamSimple: (
      model: Model<Api>,
      context: Context,
      streamOptions?: ModelsSimpleStreamOptions
    ) => wrapEventStream(inner.streamSimple(model, context, streamOptions)),
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
