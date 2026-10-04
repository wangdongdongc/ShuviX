/**
 * The model registry: one pi-ai `Models` collection mirroring the host's provider rows.
 *
 * - `mutable` — the plain `createModels()` collection over the DB credential store, holding
 *   exactly one provider per row (A9; pi builtins without a row are not registered).
 * - `models` — `mutable` behind `withNetwork`: request scope, failure detail, timeout default,
 *   and the M4 rewrite of custom provider ids in error text. This is what sessions use.
 * - `refresh()` re-reads the rows and re-syncs `mutable` (the desktop calls it on
 *   `providers.changed`); unchanged providers are left alone. API keys and OAuth records are
 *   not part of a provider — the credential store reads them live per request — so a key
 *   change needs no refresh at all.
 * - `modelRefOf(rowId, modelId)` translates a `provider_models` row into the ref sessions
 *   store: `{provider: slug}` for builtin rows, `{provider: rowId}` for custom rows.
 *
 * Construction builds synchronously (A8): port reads are synchronous DAO calls, and a registry
 * that is usable the moment it exists keeps the desktop's startup ordering trivial.
 */
import {
  createModels,
  type AuthContext,
  type Models,
  type MutableModels
} from '@earendil-works/pi-ai'
import type { RuntimeNetwork } from '../types'
import { buildProviderEntries } from './catalog'
import { createDbCredentialStore } from './credentialStore'
import { withNetwork } from './networkModels'
import { piProviderIdOf, type ProviderCredentialPort } from './port'

/** What a session stores to name its model: pi provider id + model id. */
export interface ModelRef {
  provider: string
  id: string
}

export interface ModelRegistryOptions {
  port: ProviderCredentialPort
  /** Host network seam (desktop: llmNetwork). Omitted = no scope, no failure detail. */
  network?: RuntimeNetwork
  /**
   * Ambient auth for builtin providers (env keys etc., Q15). Omitted = pi's default context
   * (`process.env` where there is one). Custom providers never consult it (M5).
   */
  authContext?: AuthContext
  /** Request timeout default for the stream/complete family (see withNetwork). */
  timeoutMs?: number
}

export interface ModelRegistry {
  /** The collection sessions use (decorated). */
  readonly models: Models
  /** The undecorated collection the registry maintains; `models` sees its changes live. */
  readonly mutable: MutableModels
  /** Re-read the rows and re-sync the providers. Rejects (changing nothing) if the port throws. */
  refresh(): Promise<void>
  /** The ref of a model row; undefined when the row id is unknown (model ids are not checked). */
  modelRefOf(providerRowId: string, modelId: string): ModelRef | undefined
}

/** Shape of a uuid — the row ids of custom providers. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMOVED_PROVIDER_LABEL = '(removed provider)'

export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const { port } = options
  const mutable = createModels({
    credentials: createDbCredentialStore(port),
    ...(options.authContext ? { authContext: options.authContext } : {})
  })

  /** Registered provider id → fingerprint of what was registered. */
  const registered = new Map<string, string>()
  /**
   * Custom provider id → the label to show instead of it. Kept after the row is deleted: a
   * session still holding that model gets "Unknown provider: "<name>"" rather than a uuid.
   */
  const labels = new Map<string, string>()

  const sync = (): void => {
    // Build everything before touching the collection: a throwing port leaves it intact.
    const entries = buildProviderEntries({
      providers: port.listProviders(),
      models: port.listModels()
    })
    const next = new Set(entries.map((entry) => entry.id))
    for (const id of [...registered.keys()]) {
      if (next.has(id)) continue
      mutable.deleteProvider(id)
      registered.delete(id)
    }
    for (const entry of entries) {
      if (entry.label) labels.set(entry.id, entry.label)
      if (registered.get(entry.id) === entry.fingerprint) continue
      mutable.setProvider(entry.provider)
      registered.set(entry.id, entry.fingerprint)
    }
  }

  /**
   * M4: the text that replaces a provider id inside an error message. Builtin slugs stay as
   * they are; custom ids (uuids) become the provider's display name, or — for an id this
   * process never saw (deleted before a restart) — a neutral placeholder. A uuid left in the
   * text could contain `429` / `500` / `502` … and turn a configuration error into ten retries.
   */
  const labelOf = (providerId: string): string | undefined => {
    const label = labels.get(providerId)
    if (label !== undefined) return `"${label}"`
    return UUID_RE.test(providerId) ? REMOVED_PROVIDER_LABEL : undefined
  }

  sync()

  const models = withNetwork(mutable, options.network, {
    timeoutMs: options.timeoutMs,
    rewriteErrorMessage: (message, model) => {
      const label = labelOf(model.provider)
      if (!label || !model.provider || !message.includes(model.provider)) return message
      return message.split(model.provider).join(label)
    }
  })

  return {
    models,
    mutable,
    refresh: async () => sync(),
    modelRefOf: (providerRowId, modelId) => {
      const row = port.listProviders().find((candidate) => candidate.id === providerRowId)
      const provider = row ? piProviderIdOf(row) : undefined
      return provider ? { provider, id: modelId } : undefined
    }
  }
}
