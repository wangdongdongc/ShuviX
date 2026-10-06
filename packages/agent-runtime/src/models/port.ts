/**
 * The model layer's only view of the host's provider storage.
 *
 * ShuviX keeps providers in two tables (desktop: `providers` / `provider_models`). The model
 * layer never touches them directly: the host hands in a port with synchronous reads (the
 * desktop's DAO calls are synchronous, and `createModelRegistry` builds its providers at
 * construction) plus the three OAuth writes the credential store needs. Everything with
 * semantics — which row a pi provider id names, OAuth-over-key precedence, legacy record
 * normalisation, serialisation of writes — lives on this side of the port so it is tested once.
 */

/** One `providers` row, booleans instead of the DB's 0/1. */
export interface ProviderRow {
  /** Row primary key. Custom rows use it as their pi provider id; builtin rows do not (see piProviderIdOf). */
  id: string
  /** Builtin rows: the pi-ai provider slug (any case). Custom rows: the user's name. */
  name: string
  /** User-facing label (builtin rows ship one; custom rows usually leave it empty). */
  displayName?: string
  isBuiltin: boolean
  /** Disabled rows are still registered (Q9): sessions locked to them keep working. */
  isEnabled: boolean
  /** Decrypted API key; '' when none. */
  apiKey: string
  /** Custom rows only (builtin endpoints come from pi's catalog). */
  baseUrl: string
  /** Custom rows only: one of chat-protocol's ApiProtocol values ('' = openai-completions). */
  apiProtocol: string
  /** JSON text, e.g. `{"customHeaders":{"X-Key":"v"}}`; anything unparseable reads as `{}`. */
  metadata: string
}

/** One `provider_models` row. */
export interface ProviderModelRow {
  /** The owning row's `id` (not its pi provider id). */
  providerId: string
  modelId: string
  isEnabled: boolean
  /** JSON text of chat-protocol's ModelCapabilities; anything unparseable reads as `{}`. */
  capabilities: string
}

/**
 * Host storage behind the model layer. Reads are synchronous and live (no caching on either
 * side: a key typed into settings must reach the very next request).
 */
export interface ProviderCredentialPort {
  listProviders(): readonly ProviderRow[]
  listModels(): readonly ProviderModelRow[]
  /**
   * The stored OAuth record of a row as JSON text (decrypted), or undefined when there is none.
   * The store parses and validates it — a corrupt record reads as "not logged in".
   */
  readOAuth(providerRowId: string): string | undefined
  /** Persist the full OAuth credential JSON (every field, including provider-specific extras). */
  saveOAuth(providerRowId: string, json: string): void
  /** Remove the OAuth record (logout). The API key is untouched. */
  clearOAuth(providerRowId: string): void
  /** Optional: persist an API key written through `CredentialStore.modify` (pi's api-key login). */
  saveApiKey?(providerRowId: string, apiKey: string): void
}

/**
 * pi provider id of a row.
 *
 * Builtin rows are addressed by their slug, never by their row id: databases created after the
 * UUIDv7 migration (7eb9d83) carry uuid ids on builtin rows while only `name` is the slug, and
 * there is no migration back — the same release sees `id='xai'` on one install and `id='0193…'`
 * on another. Custom rows are addressed by their row id (names are user text and may collide
 * with a slug). A builtin row without a name has no pi id.
 */
export function piProviderIdOf(
  row: Pick<ProviderRow, 'id' | 'name' | 'isBuiltin'>
): string | undefined {
  if (!row.isBuiltin) return row.id
  const slug = (row.name ?? '').trim().toLowerCase()
  return slug || undefined
}

/**
 * The row a pi provider id names. A builtin row answering to the slug wins over a custom row
 * whose id happens to equal it (the catalog makes the same choice), so a custom provider can
 * never be handed a builtin provider's credential or vice versa.
 */
export function rowForProviderId(
  rows: readonly ProviderRow[],
  providerId: string
): ProviderRow | undefined {
  return (
    rows.find((row) => row.isBuiltin && piProviderIdOf(row) === providerId) ??
    rows.find((row) => !row.isBuiltin && row.id === providerId)
  )
}

/** User-facing label of a custom row (display name, else name). */
export function customProviderLabel(row: Pick<ProviderRow, 'name' | 'displayName'>): string {
  return row.displayName?.trim() || row.name?.trim() || 'custom provider'
}
