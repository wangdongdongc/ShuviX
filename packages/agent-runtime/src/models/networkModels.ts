/**
 * `withNetwork` — a full pi-ai `Models` decorator for ShuviX's request-level concerns.
 *
 * 1. **Request scope.** Every stream/complete call (and the deferred / image / classifier
 *    calls, A7) runs inside the host's `RuntimeNetwork.runInRequestScope`, so the host can swap
 *    the transport for LLM requests only (the desktop's 15-minute undici dispatcher) and record
 *    fetch-level failures. pi's `lazyStream` starts its setup (auth resolution, lazy module
 *    load, provider call) synchronously, so a scope opened around the inner call covers the
 *    fetch and every continuation after it.
 * 2. **Failure detail.** The SDKs replace a fetch failure with a fixed text ("Connection
 *    error." / "Request timed out."), and pi keeps only `error.message` — the cause chain
 *    (`TypeError: fetch failed <- SocketError: other side closed (UND_ERR_SOCKET)`) survives only
 *    at the fetch layer. The decorator appends what the host recorded to the error text, on the
 *    forwarded error event **and** on the stream's final `result()`: pi-durable classifies
 *    retries from `result()`, and the appended chain is what makes a connection drop look
 *    retryable to `isRetryableAssistantError`. Provider-answered errors (status codes) carry no
 *    recorded failure and pass untouched.
 * 3. **Error text rewrite** (optional hook). The model registry substitutes a custom
 *    provider's display name for its row id (M4): ids are uuids, pi's setup errors embed the id,
 *    and a uuid containing `500` / `502` … would make a configuration error look retryable.
 * 4. **Timeout default.** `timeoutMs` is filled in on the stream/complete family when the
 *    caller left it out (A1) — also without a network seam.
 *
 * Every other `Models` method is delegated untouched. The object literal below is typed as
 * `Models`, so a method added by a pi upgrade fails the typecheck instead of silently missing.
 */
import {
  createAssistantMessageEventStream,
  type AnyModel,
  type AssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { RuntimeNetwork } from '../types'

/** Same as the OpenAI / Anthropic SDK clients' own default: 10 minutes. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000

export interface WithNetworkOptions {
  /** Request timeout filled in when the caller passes none (default 10 minutes). */
  timeoutMs?: number
  /**
   * Rewrites the error text of a failed request before the failure detail is appended.
   * Return the input unchanged to leave it alone (the event then passes by reference).
   */
  rewriteErrorMessage?: (message: string, model: Model<Api>) => string
}

/**
 * Append the fetch-level cause to an error text. Only when a failure was actually recorded,
 * never twice (a message can travel through several layers), and trimmed.
 */
function withFailureDetail(message: string, detail: string | undefined): string {
  if (!detail) return message
  const base = message.trim()
  if (base.includes(detail)) return message
  return base ? `${base} (${detail})` : detail
}

/** Mirrors pi's createSetupErrorMessage (api/lazy.ts): the shape of a failed request's result. */
function setupErrorMessage(model: Model<Api>, errorMessage: string): AssistantMessage {
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

function withTimeoutDefault<T extends { timeoutMs?: number }>(
  options: T | undefined,
  timeoutMs: number
): T {
  return options?.timeoutMs !== undefined ? { ...options } : ({ ...options, timeoutMs } as T)
}

export function withNetwork(
  inner: Models,
  network?: RuntimeNetwork,
  options: WithNetworkOptions = {}
): Models {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const rewrite = options.rewriteErrorMessage
  const scope = <T>(fn: () => T): T => (network ? network.runInRequestScope(fn) : fn())

  /** Final error text: rewrite hook first, then the recorded fetch failure (read in scope). */
  const errorTextOf = (message: string, model: Model<Api>): string => {
    const rewritten = rewrite ? rewrite(message, model) : message
    return withFailureDetail(rewritten, network?.describeLastFailure())
  }

  /** Annotated copy of a message's error text, or the same object when nothing changes. */
  const annotateError = (message: AssistantMessage, model: Model<Api>): AssistantMessage => {
    const original = message.errorMessage
    const errorMessage = errorTextOf(original ?? '', model)
    if (errorMessage === (original ?? '')) return message
    return { ...message, errorMessage }
  }

  /** A final result: only failed ones are touched (a clean result never reads the detail). */
  const annotateResult = (message: AssistantMessage, model: Model<Api>): AssistantMessage =>
    message.stopReason === 'error' || message.stopReason === 'aborted'
      ? annotateError(message, model)
      : message

  const annotateEvent = (
    event: AssistantMessageEvent,
    model: Model<Api>
  ): AssistantMessageEvent => {
    if (event.type !== 'error') return event
    const error = annotateError(event.error, model)
    return error === event.error ? event : { ...event, error }
  }

  /**
   * Run `start` (the inner stream call) in a request scope and pump its events into a stream
   * returned synchronously. Without a network seam and a rewrite hook there is nothing to do:
   * the inner stream itself is returned, events and result by reference.
   */
  const wrapStream = (
    model: Model<Api>,
    start: () => AsyncIterable<AssistantMessageEvent>
  ): AssistantMessageEventStream => {
    if (!network && !rewrite) {
      try {
        return start() as AssistantMessageEventStream
      } catch (error) {
        return failedStream(model, error instanceof Error ? error.message : String(error))
      }
    }
    const outer = createAssistantMessageEventStream()
    scope(() => {
      void (async () => {
        let terminated = false
        try {
          const source = start()
          for await (const event of source) {
            if (event.type === 'done' || event.type === 'error') terminated = true
            outer.push(annotateEvent(event, model))
          }
          if (terminated) return
          if (hasResult(source)) {
            outer.end(annotateResult(await source.result(), model))
          } else {
            const message = setupErrorMessage(
              model,
              errorTextOf('Stream ended without a result', model)
            )
            outer.push({ type: 'error', reason: 'error', error: message })
            outer.end(message)
          }
        } catch (error) {
          // After a terminal event the outcome is settled; a late throw changes nothing.
          if (terminated) return
          // A setup failure (or a source that throws mid-stream): same shape as pi's own
          // setup errors, so callers handle one branch.
          const raw = error instanceof Error ? error.message : String(error)
          const message = setupErrorMessage(model, errorTextOf(raw, model))
          outer.push({ type: 'error', reason: 'error', error: message })
          outer.end(message)
        }
      })()
    })
    return outer
  }

  const failedStream = (model: Model<Api>, errorMessage: string): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream()
    const message = setupErrorMessage(model, errorMessage)
    stream.push({ type: 'error', reason: 'error', error: message })
    stream.end(message)
    return stream
  }

  const decorated: Models = {
    // ── request scope + annotation + timeout default ──
    stream: <TApi extends Api>(
      model: Model<TApi>,
      context: Context,
      streamOptions?: ModelsApiStreamOptions<TApi>
    ) =>
      wrapStream(model, () =>
        inner.stream(model, context, withTimeoutDefault(streamOptions, timeoutMs))
      ),
    streamSimple: (
      model: Model<Api>,
      context: Context,
      streamOptions?: ModelsSimpleStreamOptions
    ) =>
      wrapStream(model, () =>
        inner.streamSimple(model, context, withTimeoutDefault(streamOptions, timeoutMs))
      ),
    // complete* resolve the decorated stream's result: one code path, never rejects for
    // provider failures (same contract as pi's own complete*).
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

    // ── request scope only (A7): delegated as-is, no timeout default ──
    streamDeferred: (model, handle, deferredOptions) =>
      scope(() => inner.streamDeferred(model, handle, deferredOptions)),
    fetchDeferred: (model, handle, deferredOptions) =>
      scope(() => inner.fetchDeferred(model, handle, deferredOptions)),
    cancelDeferred: (model, handle, deferredOptions) =>
      scope(() => inner.cancelDeferred(model, handle, deferredOptions)),
    generateImages: (model, context, imageOptions) =>
      scope(() => inner.generateImages(model, context, imageOptions)),
    classify: (model, context, classifierOptions) =>
      scope(() => inner.classify(model, context, classifierOptions)),

    // ── plain delegation ──
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
