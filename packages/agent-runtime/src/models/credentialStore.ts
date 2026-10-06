/**
 * pi-ai `CredentialStore` over the host's provider rows.
 *
 * Keyed by pi provider id (builtin slug / custom row id — `rowForProviderId`; a builtin row's
 * legacy uuid id is not an address, A6). One credential per provider, derived from two columns:
 *
 *  - **OAuth wins over the API key.** Both configured means the user signed in to use the
 *    subscription; a refresh failure surfaces as an error (pi's ModelsError "oauth") instead of
 *    silently billing the API key — "subscription today, API credits tomorrow" is much harder to
 *    notice than a re-login prompt.
 *  - `delete` (logout) clears the OAuth record only; the API key stays and takes over again.
 *
 * Writes are serialized per provider id (`modify` / `delete` share one chain): xAI rotates the
 * refresh token, so two concurrent refreshes would invalidate each other — pi's `Models` runs
 * refreshes inside `modify` precisely so this chain can order them. The chain is per process;
 * the desktop has exactly one.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential
} from '@earendil-works/pi-ai'
import {
  piProviderIdOf,
  rowForProviderId,
  type ProviderCredentialPort,
  type ProviderRow
} from './port'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Stored OAuth JSON → credential. Requires non-empty `access` and `refresh`; a missing
 * `expires` reads as 0 (already expired → refreshed on first use). Records written before the
 * pi 1.0 migration carry no `type` and read as OAuth; every other field is preserved.
 * Anything unreadable (corrupt JSON, changed encryption key) is "not logged in".
 */
function parseOAuth(json: string | undefined): OAuthCredential | undefined {
  if (!json) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (parsed.type !== undefined && parsed.type !== 'oauth') return undefined
  const { access, refresh, expires } = parsed
  if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh) {
    return undefined
  }
  return {
    ...parsed,
    type: 'oauth',
    access,
    refresh,
    expires: typeof expires === 'number' && Number.isFinite(expires) ? expires : 0
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

/** Stop waiting when the signal aborts; the abandoned operation is still observed. */
function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) {
    void operation.catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function createDbCredentialStore(port: ProviderCredentialPort): CredentialStore {
  const chains = new Map<string, Promise<unknown>>()

  /** Serialize per provider id; the chain is never released before the active task settles. */
  const enqueue = <T>(
    providerId: string,
    task: () => Promise<T>,
    options?: AuthOperationOptions
  ): Promise<T> => {
    const signal = options?.signal
    const previous = chains.get(providerId) ?? Promise.resolve()
    const queued = (async () => {
      await previous.catch(() => {})
      signal?.throwIfAborted()
      return task()
    })()
    const tail = queued.catch(() => {})
    chains.set(providerId, tail)
    void tail.then(() => {
      if (chains.get(providerId) === tail) chains.delete(providerId)
    })
    return raceWithAbort(queued, signal)
  }

  const rowOf = (providerId: string): ProviderRow | undefined =>
    rowForProviderId(port.listProviders(), providerId)

  const requireRow = (providerId: string): ProviderRow => {
    const row = rowOf(providerId)
    if (!row) throw new Error(`No provider row for credential id ${providerId}`)
    return row
  }

  /** The credential a row currently holds (live: no caching anywhere). */
  const credentialOf = (row: ProviderRow): Credential | undefined => {
    const oauth = parseOAuth(port.readOAuth(row.id))
    if (oauth) return oauth
    const key = row.apiKey?.trim()
    return key ? { type: 'api_key', key } : undefined
  }

  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted()
      const row = rowOf(providerId)
      return row ? credentialOf(row) : undefined
    },

    async list(options): Promise<readonly CredentialInfo[]> {
      options?.signal?.throwIfAborted()
      const rows = port.listProviders()
      const out: CredentialInfo[] = []
      for (const row of rows) {
        const providerId = piProviderIdOf(row)
        // A row shadowed by another answering to the same id is not addressable.
        if (!providerId || rowForProviderId(rows, providerId) !== row) continue
        const credential = credentialOf(row)
        if (credential) out.push({ providerId, type: credential.type })
      }
      return out
    },

    modify(providerId, fn, options) {
      return enqueue(
        providerId,
        async () => {
          const row = requireRow(providerId)
          const next = await fn(credentialOf(row))
          // Deliberately no abort check here: a credential `fn` produced (a rotated refresh
          // token above all) is persisted even when the caller gave up meanwhile — dropping it
          // would leave only an invalidated token behind and force a re-login.
          if (next === undefined) return credentialOf(requireRow(providerId))
          if (next.type === 'oauth') {
            port.saveOAuth(row.id, JSON.stringify(next))
          } else {
            if (!port.saveApiKey) {
              throw new Error('This credential store cannot write API keys')
            }
            port.saveApiKey(row.id, next.key ?? '')
          }
          // What a subsequent read() returns (OAuth still wins over a freshly written key, A4).
          return credentialOf(requireRow(providerId))
        },
        options
      )
    },

    delete(providerId, options) {
      return enqueue(
        providerId,
        async () => {
          port.clearOAuth(requireRow(providerId).id)
        },
        options
      )
    }
  }
}
