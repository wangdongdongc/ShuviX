/**
 * Prompt Cache 后台保活装饰器（`pi-ai` `cache-warming`）—— 一个每会话一份的 `Models` 装饰器：
 *
 * 在长对话等待慢工具 / 人工审批卡片（`stopReason === 'toolUse'` → `streaming` 阶段）或等待用户回复
 * （`stopReason === 'stop'` → `idle` 阶段）期间，在厂商 Prompt Cache TTL 到期前（90% TTL）静默发送
 * 1-token 输出上限的重放请求以续期缓存，避免下一轮按高价重新 prefill。
 *
 * 成本核算与安全约束：
 *  - 全部数值与判定复用 `@earendil-works/pi-ai` 的 `evaluateCacheWarming` / `getPromptCacheTtlMs` /
 *    `getCacheWarmingDelayMs` / `isCacheWarmingReplayable` / `getCacheWarmingRequestOptions`；
 *  - 对未填写 `cost` 或缺少 `promptCache` TTL 的自定义模型，按 `model.id`（及 `/` 后的短名）从内置目录
 *    借用同名模型的参考 `cost` 与 `promptCache`（仅用于评估，不修改真实请求对象）；
 *  - 任何新到达的真实请求立即取消同对话的在途保活与定时器；会话关闭时 `dispose()` 清掉全部定时器与请求；
 *  - 保活失败只记 debug/warn 日志，永不影响对话与记录。
 */
import {
  CACHE_WARMING_MAX_AGE_MS,
  CACHE_WARMING_MAX_IDLE_AGE_MS,
  evaluateCacheWarming,
  getCacheWarmingDelayMs,
  getCacheWarmingRequestOptions,
  getPromptCacheTtlMs,
  isCacheWarmingReplayable,
  type AnyModel,
  type Api,
  type AssistantMessage,
  type CacheWarmingPhase,
  type Context,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { RuntimeLogger } from '../types'
import { errorText } from './context'

export interface CacheWarmingDeps {
  sessionId: string
  /** 现读开关：返回 true 时为本会话启用后台保活 */
  isEnabled: () => boolean
  logger: RuntimeLogger
  now?: () => number
  /** 测试可注入自定义定时器 */
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

interface ReferenceMeta {
  readonly cost: Model<Api>['cost']
  readonly promptCache: NonNullable<Model<Api>['promptCache']>
}

let referenceIndex:
  | { byApiAndId: Map<string, ReferenceMeta>; byId: Map<string, ReferenceMeta> }
  | undefined

function getReferenceIndex(): {
  byApiAndId: Map<string, ReferenceMeta>
  byId: Map<string, ReferenceMeta>
} {
  if (referenceIndex !== undefined) return referenceIndex
  const byApiAndId = new Map<string, ReferenceMeta>()
  const byId = new Map<string, ReferenceMeta>()
  for (const provider of builtinProviders()) {
    for (const model of provider.getModels()) {
      if (!model.promptCache) continue
      const meta: ReferenceMeta = { cost: model.cost, promptCache: model.promptCache }
      const idKey = model.id.toLowerCase()
      const apiKey = `${model.api}::${idKey}`
      if (!byApiAndId.has(apiKey)) byApiAndId.set(apiKey, meta)
      if (!byId.has(idKey)) byId.set(idKey, meta)
    }
  }
  referenceIndex = { byApiAndId, byId }
  return referenceIndex
}

function hasZeroCost(cost: Model<Api>['cost']): boolean {
  return cost.input === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0
}

/**
 * 为自定义模型补齐用于保活核算的 `promptCache` 与参考 `cost`（浅拷贝，绝不修改原 model）：
 *  - 原模型已同时具备 `promptCache` 与非零 `cost` 时原样返回；
 *  - 否则按 `model.id` 以及 `/` 后的末段名（如 `anthropic/claude-sonnet-4-6` → `claude-sonnet-4-6`）
 *    在内置目录中优先按 `(api, id)` 精确查找，再按 `id` 查找，仅补缺失字段。
 */
export function resolveCacheWarmingModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
  const needsCache = model.promptCache === undefined
  const needsCost = hasZeroCost(model.cost)
  if (!needsCache && !needsCost) return model

  const { byApiAndId, byId } = getReferenceIndex()
  const raw = model.id.trim().toLowerCase()
  const candidates = raw.includes('/') ? [raw, raw.slice(raw.lastIndexOf('/') + 1)] : [raw]
  let hit: ReferenceMeta | undefined
  for (const candidate of candidates) {
    hit = byApiAndId.get(`${model.api}::${candidate}`)
    if (hit) break
  }
  if (!hit) {
    for (const candidate of candidates) {
      hit = byId.get(candidate)
      if (hit) break
    }
  }
  if (!hit) return model
  return {
    ...model,
    ...(needsCache ? { promptCache: hit.promptCache } : {}),
    ...(needsCost ? { cost: hit.cost } : {})
  }
}

interface ActiveWarming {
  timer?: ReturnType<typeof setTimeout>
  controller?: AbortController
}

export function withCacheWarming(
  inner: Models,
  deps: CacheWarmingDeps
): { models: Models; dispose: () => void } {
  const now = deps.now ?? Date.now
  const scheduleTimer = deps.setTimer ?? setTimeout
  const cancelTimer = deps.clearTimer ?? clearTimeout
  const active = new Map<string, ActiveWarming>()
  let disposed = false

  const cancel = (key: string): void => {
    const entry = active.get(key)
    if (!entry) return
    active.delete(key)
    if (entry.timer !== undefined) cancelTimer(entry.timer)
    entry.controller?.abort()
  }

  const dispose = (): void => {
    disposed = true
    for (const key of [...active.keys()]) cancel(key)
  }

  const keyOf = (options: { sessionId?: string } | undefined): string =>
    options?.sessionId ?? '__root__'

  const scheduleAfterReply = (
    key: string,
    model: Model<Api>,
    context: Context,
    options: ModelsSimpleStreamOptions | undefined,
    reply: AssistantMessage
  ): void => {
    if (disposed || !deps.isEnabled()) return
    const phase: CacheWarmingPhase | undefined =
      reply.stopReason === 'toolUse'
        ? 'streaming'
        : reply.stopReason === 'stop'
          ? 'idle'
          : undefined
    if (phase === undefined) return

    const evalModel = resolveCacheWarmingModel(model)
    if (!isCacheWarmingReplayable(evalModel, options)) return
    const ttlMs = getPromptCacheTtlMs(evalModel, options)
    if (ttlMs === undefined) return
    const delayMs = getCacheWarmingDelayMs(ttlMs)
    if (delayMs === undefined) return

    const promptTokens =
      (reply.usage.input ?? 0) + (reply.usage.cacheRead ?? 0) + (reply.usage.cacheWrite ?? 0)
    const decision = evaluateCacheWarming(evalModel, promptTokens, phase)
    if (decision.action !== 'warm') return

    const startedAt = now()
    const maxAgeMs = phase === 'idle' ? CACHE_WARMING_MAX_IDLE_AGE_MS : CACHE_WARMING_MAX_AGE_MS
    if (delayMs >= maxAgeMs) return

    const entry: ActiveWarming = {}
    active.set(key, entry)

    const arm = (): void => {
      if (disposed || active.get(key) !== entry) return
      const elapsed = now() - startedAt
      if (elapsed + delayMs >= maxAgeMs) {
        cancel(key)
        return
      }
      entry.timer = scheduleTimer(() => {
        entry.timer = undefined
        if (disposed || active.get(key) !== entry || !deps.isEnabled()) {
          cancel(key)
          return
        }
        const controller = new AbortController()
        entry.controller = controller
        const warmOptions = getCacheWarmingRequestOptions(
          (options ?? {}) as ModelsSimpleStreamOptions,
          controller.signal
        )
        void (async () => {
          let warmReply: AssistantMessage
          try {
            const stream = inner.streamSimple(model, context, warmOptions)
            warmReply = await stream.result()
          } catch (error) {
            if (!controller.signal.aborted && !disposed) {
              deps.logger.warn(
                `session ${deps.sessionId}: cache warming refresh failed (${model.provider}/${model.id}): ${errorText(error)}`
              )
            }
            if (active.get(key) === entry) cancel(key)
            return
          }
          if (entry.controller === controller) entry.controller = undefined
          if (warmReply.stopReason === 'error' || warmReply.stopReason === 'aborted') {
            if (!controller.signal.aborted && !disposed) {
              deps.logger.warn(
                `session ${deps.sessionId}: cache warming refresh ended with ${warmReply.stopReason} (${model.provider}/${model.id})${warmReply.errorMessage ? `: ${warmReply.errorMessage}` : ''}`
              )
            }
            if (active.get(key) === entry) cancel(key)
            return
          }
          if (!controller.signal.aborted && !disposed && active.get(key) === entry) {
            arm()
          }
        })()
      }, delayMs)
    }

    arm()
  }

  const decorated: Models = {
    stream: <TApi extends Api>(
      model: Model<TApi>,
      context: Context,
      streamOptions?: ModelsApiStreamOptions<TApi>
    ) => {
      const key = keyOf(streamOptions)
      cancel(key)
      return inner.stream(model, context, streamOptions)
    },
    streamSimple: (
      model: Model<Api>,
      context: Context,
      streamOptions?: ModelsSimpleStreamOptions
    ) => {
      const key = keyOf(streamOptions)
      cancel(key)
      const stream = inner.streamSimple(model, context, streamOptions)
      void stream
        .result()
        .then((reply) => {
          scheduleAfterReply(key, model, context, streamOptions, reply)
        })
        .catch(() => {
          /* 主请求自身出错由调用方处理，不触发保活 */
        })
      return stream
    },
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

  return { models: decorated, dispose }
}
