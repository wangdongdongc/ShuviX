/**
 * ShuviX provider rows → pi-ai `Provider`s (one per row, A9).
 *
 * Two shapes, both registered under the id the session's model ref will carry:
 *
 *  - **Builtin rows** wrap pi's own builtin provider (`builtinProviders()`), id = the pi slug.
 *    Catalog models are pi's, untouched — URL, protocol, headers, limits and pricing all come
 *    from the catalog and a `provider_models` row can never override them. Model rows pi does
 *    not know (a model newer than the catalog) become **overlay** models built from a template
 *    (see `overlayTemplate`) and are served by the builtin provider's own implementation, auth
 *    (env keys, OAuth) included.
 *  - **Custom rows** go through `createProvider` with the lazy API implementation of the row's
 *    protocol, id = the row id. Their auth reads only the stored credential (M5): a keyless
 *    custom endpoint never picks up some unrelated `OPENAI_API_KEY` from the environment.
 *
 * Disabled rows (provider or model) are built exactly like enabled ones (Q9 / A2): a session
 * locked to them must keep working; pickers and agent creation do their own filtering.
 */
import {
  createProvider,
  lazyStream,
  type Api,
  type ApiKeyAuth,
  type Model,
  type Provider,
  type ProviderStreams
} from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { BUILTIN_PROVIDERS } from '@shuvix/chat-protocol/providerCatalog'
import type { ApiProtocol, ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import {
  customProviderLabel,
  piProviderIdOf,
  type ProviderModelRow,
  type ProviderRow
} from './port'

export { piProviderIdOf } from './port'

export interface BuildProvidersInput {
  providers: readonly ProviderRow[]
  models: readonly ProviderModelRow[]
}

/** One built provider plus what the registry needs to keep it in sync. */
export interface BuiltProvider {
  /** pi provider id (builtin slug or custom row id). */
  id: string
  /** The row it was built from. */
  rowId: string
  isBuiltin: boolean
  provider: Provider
  /**
   * Everything the build depended on, serialised. Equal fingerprints = an identical provider,
   * so a refresh can skip `setProvider` (credentials are not part of it — they are read live).
   */
  fingerprint: string
  /** Custom rows only: the label substituted for the row id in error text (M4). */
  label?: string
}

// ─────────────────────────── token limits ───────────────────────────

const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 16384

/**
 * contextWindow / maxTokens from capability data (custom models and overlay models; catalog
 * models keep the catalog's numbers).
 *
 * An output cap is trusted only when it is positive and strictly below the window. litellm's
 * catalog has a whole class of entries that copy the window into max_output_tokens (751 of the
 * 1976 bundled chat models, every xai/* entry among them — xAI never published such a cap), and
 * a few with output > input. A cap at or above the window can never be honoured by any request,
 * so it is treated like a missing one; 0 and negatives likewise (the capability dialog stores a
 * typed 0, and pi would send it as max_tokens: 0). A missing window compares against the default.
 *
 * Normalised here rather than at the litellm intake: capability rows are already in the
 * database (fillMissingCapabilities never overwrites) and the user can type values by hand.
 */
function resolveTokenLimits(caps: ModelCapabilities): { contextWindow: number; maxTokens: number } {
  const window = caps.maxInputTokens
  const contextWindow =
    typeof window === 'number' && Number.isFinite(window) && window > 0
      ? window
      : DEFAULT_CONTEXT_WINDOW
  const maxOutput = caps.maxOutputTokens
  const maxTokens =
    typeof maxOutput === 'number' && maxOutput > 0 && maxOutput < contextWindow
      ? maxOutput
      : DEFAULT_MAX_TOKENS
  return { contextWindow, maxTokens }
}

// ─────────────────────────── row parsing ───────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseCapabilities(text: string): ModelCapabilities {
  return parseJsonObject(text) as ModelCapabilities
}

/** `metadata.customHeaders` — string values only; empty / malformed → undefined. */
function parseCustomHeaders(metadata: string): Record<string, string> | undefined {
  const raw = parseJsonObject(metadata).customHeaders
  if (!isRecord(raw)) return undefined
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && name.trim()) headers[name] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

/** Model rows of one provider row, first row per modelId wins (disabled rows included, A2). */
function modelRowsOf(models: readonly ProviderModelRow[], rowId: string): ProviderModelRow[] {
  const seen = new Set<string>()
  const out: ProviderModelRow[] = []
  for (const row of models) {
    if (row.providerId !== rowId || !row.modelId || seen.has(row.modelId)) continue
    seen.add(row.modelId)
    out.push(row)
  }
  return out
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Shared shape of every model ShuviX builds itself (custom and overlay).
 *
 * `reasoning: true` regardless of the capability flag: whether a turn thinks is the session's
 * thinking level, not the capability row — with `reasoning: false` pi would clamp every level
 * to off and a level the user picked would silently never be sent.
 */
function dynamicModel(
  base: { provider: string; api: Api; baseUrl: string },
  modelId: string,
  caps: ModelCapabilities
): Model<Api> {
  const limits = resolveTokenLimits(caps)
  return {
    id: modelId,
    name: modelId,
    api: base.api,
    provider: base.provider,
    baseUrl: base.baseUrl,
    reasoning: true,
    input: caps.vision ? ['text', 'image'] : ['text'],
    cost: { ...ZERO_COST },
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens
  }
}

// ─────────────────────────── builtin rows ───────────────────────────

/**
 * Compat keys that describe one exact catalog model rather than the endpoint; never copied
 * from an overlay template onto an unrelated model id.
 */
const MODEL_SPECIFIC_COMPAT_KEYS: readonly string[] = ['allowedFallbackModels']

interface OverlayTemplate {
  api: Api
  baseUrl: string
  headers?: Record<string, string>
  compat?: Record<string, unknown>
}

function templateFromModel(model: Model<Api>): OverlayTemplate {
  let compat: Record<string, unknown> | undefined
  if (isRecord(model.compat)) {
    compat = { ...model.compat }
    for (const key of MODEL_SPECIFIC_COMPAT_KEYS) delete compat[key]
    if (Object.keys(compat).length === 0) compat = undefined
  }
  return {
    api: model.api,
    baseUrl: model.baseUrl,
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(compat ? { compat } : {})
  }
}

/**
 * Template for overlay models of one builtin provider (M3):
 *  1. the first catalog model whose `api` is the provider's declared `defaultApi`
 *     (chat-protocol BUILTIN_PROVIDERS);
 *  2. else, with a declared `baseUrl`: that URL + `defaultApi`, no compat, no headers;
 *  3. else the first catalog model (cloudflare-* declare no URL — theirs carry placeholders).
 * Only endpoint-level fields are taken (api / baseUrl / headers / compat minus the
 * model-specific keys): never the name, pricing tiers, thinking map or input limits.
 */
function overlayTemplate(
  slug: string,
  catalog: readonly Model<Api>[]
): OverlayTemplate | undefined {
  const declared = BUILTIN_PROVIDERS.find((entry) => entry.name === slug)
  if (declared) {
    const match = catalog.find((model) => model.api === declared.defaultApi)
    if (match) return templateFromModel(match)
    if (declared.baseUrl) return { api: declared.defaultApi as Api, baseUrl: declared.baseUrl }
  }
  const first = catalog[0]
  return first ? templateFromModel(first) : undefined
}

function overlayModel(
  slug: string,
  template: OverlayTemplate,
  modelId: string,
  caps: ModelCapabilities
): Model<Api> {
  const model = dynamicModel(
    { provider: slug, api: template.api, baseUrl: template.baseUrl },
    modelId,
    caps
  )
  // Fresh copies: the template's objects came from a catalog model shared module-wide.
  if (template.headers) model.headers = { ...template.headers }
  if (template.compat) model.compat = { ...template.compat } as Model<Api>['compat']
  return model
}

/**
 * The builtin provider with overlay models appended. Every member delegates to the builtin
 * (no spread: a provider implemented with prototype methods would lose them), only the two
 * model listings add the overlay — `Models` routes requests by `model.provider`, so overlay
 * models reach the builtin's own implementation and auth.
 */
function withOverlay(base: Provider, overlay: readonly Model<Api>[]): Provider {
  const wrapped: Provider = {
    id: base.id,
    name: base.name,
    baseUrl: base.baseUrl,
    headers: base.headers,
    auth: base.auth,
    getModels: () => [...base.getModels(), ...overlay],
    getAllModels: () => [...(base.getAllModels?.() ?? base.getModels()), ...overlay],
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options)
  }
  if (base.refreshModels) wrapped.refreshModels = (context) => base.refreshModels!(context)
  if (base.filterModels) {
    wrapped.filterModels = (models, credential) => base.filterModels!(models, credential)
  }
  if (base.filterAllModels) {
    wrapped.filterAllModels = (models, credential) => base.filterAllModels!(models, credential)
  }
  if (base.fetchDeferred) {
    wrapped.fetchDeferred = (model, handle, options) => base.fetchDeferred!(model, handle, options)
  }
  if (base.cancelDeferred) {
    wrapped.cancelDeferred = (model, handle, options) =>
      base.cancelDeferred!(model, handle, options)
  }
  if (base.generateImages) {
    wrapped.generateImages = (model, context, options) =>
      base.generateImages!(model, context, options)
  }
  if (base.classify)
    wrapped.classify = (model, context, options) => base.classify!(model, context, options)
  return wrapped
}

function buildBuiltin(
  slug: string,
  row: ProviderRow,
  base: Provider,
  models: readonly ProviderModelRow[]
): BuiltProvider {
  const catalog = base.getModels()
  const known = new Set(catalog.map((model) => model.id))
  const unknownRows = modelRowsOf(models, row.id).filter((m) => !known.has(m.modelId))
  const template = unknownRows.length > 0 ? overlayTemplate(slug, catalog) : undefined
  const overlay = template
    ? unknownRows.map((m) =>
        overlayModel(slug, template, m.modelId, parseCapabilities(m.capabilities))
      )
    : []
  return {
    id: slug,
    rowId: row.id,
    isBuiltin: true,
    provider: withOverlay(base, overlay),
    fingerprint: JSON.stringify(['builtin', slug, overlay])
  }
}

// ─────────────────────────── custom rows ───────────────────────────

/**
 * Lazy pi API implementation per protocol a custom provider may declare. Typed against the
 * protocol union, so a protocol added to the settings dropdown without an implementation
 * here fails the typecheck.
 */
const CUSTOM_API_IMPLEMENTATIONS = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi
} satisfies Record<ApiProtocol, () => ProviderStreams>

/**
 * Conservative compat for OpenAI-compatible third-party endpoints: most reject `store` and
 * the `developer` role. Everything else is left to pi's defaults / URL detection.
 */
const CUSTOM_COMPLETIONS_COMPAT = { supportsStore: false, supportsDeveloperRole: false }

function isApiProtocol(value: string): value is ApiProtocol {
  return Object.hasOwn(CUSTOM_API_IMPLEMENTATIONS, value)
}

/**
 * A protocol this build cannot serve (a hand-edited row, a protocol from a newer release):
 * the provider still builds — one bad row must not take the others down — and every request
 * on it ends in a stream error naming the protocol.
 */
function unsupportedProtocol(protocol: string): ProviderStreams {
  const fail = (model: Model<Api>): ReturnType<ProviderStreams['stream']> =>
    lazyStream(model, async () => {
      throw new Error(`Unsupported API protocol "${protocol}"`)
    })
  return { stream: fail, streamSimple: fail }
}

/**
 * Custom providers' api-key auth reads the stored credential only (M5) — never the ambient
 * environment, which belongs to the builtin providers that name their variables.
 */
function storedKeyOnlyAuth(label: string): ApiKeyAuth {
  return {
    name: `${label} API key`,
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted()
      if (!credential?.key) return undefined
      return { auth: { apiKey: credential.key }, env: credential.env, source: 'stored credential' }
    }
  }
}

function buildCustom(row: ProviderRow, models: readonly ProviderModelRow[]): BuiltProvider {
  const label = customProviderLabel(row)
  const protocol = row.apiProtocol?.trim() || 'openai-completions'
  const headers = parseCustomHeaders(row.metadata)
  const built = modelRowsOf(models, row.id).map((m) => {
    const model = dynamicModel(
      { provider: row.id, api: protocol, baseUrl: row.baseUrl ?? '' },
      m.modelId,
      parseCapabilities(m.capabilities)
    )
    if (protocol === 'openai-completions') {
      model.compat = { ...CUSTOM_COMPLETIONS_COMPAT } as Model<Api>['compat']
    }
    // M2: pi 1.0 applies model headers (Models.getAuth merges them) but never a provider's.
    if (headers) model.headers = { ...headers }
    return model
  })
  const implementation = isApiProtocol(protocol)
    ? CUSTOM_API_IMPLEMENTATIONS[protocol]()
    : unsupportedProtocol(protocol)
  const provider = createProvider({
    id: row.id,
    name: label,
    baseUrl: row.baseUrl || undefined,
    auth: { apiKey: storedKeyOnlyAuth(label) },
    models: built,
    // A map, not a single implementation: a model of another api handed to this provider
    // errors ("no API implementation") instead of being sent with the wrong wire protocol.
    api: { [protocol]: implementation }
  })
  return {
    id: row.id,
    rowId: row.id,
    isBuiltin: false,
    provider,
    fingerprint: JSON.stringify(['custom', label, row.baseUrl ?? '', protocol, built]),
    label
  }
}

// ─────────────────────────── entry points ───────────────────────────

/**
 * Build one provider per row, in row order, with their bookkeeping. Rows that cannot be built
 * are skipped, never thrown: a builtin row without a name or naming a slug pi does not ship,
 * a second builtin row with the same slug, and a custom row whose id equals a builtin slug
 * (the builtin wins — the credential store resolves the id the same way).
 */
export function buildProviderEntries(input: BuildProvidersInput): BuiltProvider[] {
  const factories = new Map<string, Provider>()
  for (const provider of builtinProviders()) factories.set(provider.id, provider)

  const builtinIds = new Set<string>()
  for (const row of input.providers) {
    const id = row.isBuiltin ? piProviderIdOf(row) : undefined
    if (id && factories.has(id)) builtinIds.add(id)
  }

  const out: BuiltProvider[] = []
  const taken = new Set<string>()
  for (const row of input.providers) {
    const id = piProviderIdOf(row)
    if (!id || taken.has(id)) continue
    if (row.isBuiltin) {
      const base = factories.get(id)
      if (!base) continue
      out.push(buildBuiltin(id, row, base, input.models))
    } else {
      if (builtinIds.has(id)) continue
      out.push(buildCustom(row, input.models))
    }
    taken.add(id)
  }
  return out
}

/** One pi `Provider` per buildable row (see `buildProviderEntries`). */
export function buildProviders(input: BuildProvidersInput): Provider[] {
  return buildProviderEntries(input).map((entry) => entry.provider)
}
