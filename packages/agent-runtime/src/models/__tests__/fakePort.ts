/**
 * In-memory ProviderCredentialPort + row builders shared by the models/ tests.
 *
 * Rows are plain mutable arrays so a test can change the "database" between calls and check
 * that the model layer reads live (keys) or after `refresh()` (provider shape).
 */
import type { AuthContext, OAuthCredential } from '@earendil-works/pi-ai'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { ProviderCredentialPort, ProviderModelRow, ProviderRow } from '../port'

export interface FakePort extends ProviderCredentialPort {
  rows: ProviderRow[]
  modelRows: ProviderModelRow[]
  /** row id → stored OAuth JSON text */
  oauth: Map<string, string>
  /** every saveOAuth call, in order: [rowId, parsed JSON] */
  oauthWrites: Array<[string, Record<string, unknown>]>
  clearCalls: string[]
  apiKeyWrites: Array<[string, string]>
}

export function builtinRow(name: string, over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: name,
    name,
    displayName: '',
    isBuiltin: true,
    isEnabled: true,
    apiKey: '',
    baseUrl: '',
    apiProtocol: '',
    metadata: '',
    ...over
  }
}

export function customRow(id: string, over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id,
    name: 'My Proxy',
    displayName: '',
    isBuiltin: false,
    isEnabled: true,
    apiKey: '',
    baseUrl: 'http://proxy.test/v1',
    apiProtocol: 'openai-completions',
    metadata: '',
    ...over
  }
}

export function modelRow(
  providerId: string,
  modelId: string,
  caps: ModelCapabilities | string = {},
  isEnabled = true
): ProviderModelRow {
  return {
    providerId,
    modelId,
    isEnabled,
    capabilities: typeof caps === 'string' ? caps : JSON.stringify(caps)
  }
}

export function oauthCredential(over: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: 'oauth',
    access: 'acc-1',
    refresh: 'ref-1',
    expires: Date.now() + 60 * 60 * 1000,
    ...over
  }
}

export function fakePort(
  rows: ProviderRow[] = [],
  modelRows: ProviderModelRow[] = [],
  options: { saveApiKey?: boolean } = {}
): FakePort {
  const port: FakePort = {
    rows,
    modelRows,
    oauth: new Map(),
    oauthWrites: [],
    clearCalls: [],
    apiKeyWrites: [],
    listProviders: () => port.rows,
    listModels: () => port.modelRows,
    readOAuth: (id) => port.oauth.get(id),
    saveOAuth: (id, json) => {
      port.oauthWrites.push([id, JSON.parse(json) as Record<string, unknown>])
      port.oauth.set(id, json)
    },
    clearOAuth: (id) => {
      port.clearCalls.push(id)
      port.oauth.delete(id)
    }
  }
  if (options.saveApiKey) {
    port.saveApiKey = (id, key) => {
      port.apiKeyWrites.push([id, key])
      const row = port.rows.find((candidate) => candidate.id === id)
      if (row) row.apiKey = key
    }
  }
  return port
}

/** Put an OAuth record on a row (JSON text, exactly as the port would hold it). */
export function storeOAuth(
  port: FakePort,
  rowId: string,
  credential: Record<string, unknown>
): void {
  port.oauth.set(rowId, JSON.stringify(credential))
}

/** An auth context with a fixed environment and no files (no process.env leaks into tests). */
export function fakeAuthContext(env: Record<string, string> = {}): AuthContext {
  return {
    env: async (name) => env[name],
    fileExists: async () => false
  }
}

export interface RecordedRequest {
  url: string
  headers: Headers
  body: string | undefined
}

/** A fetch stub answering 401 with an OpenAI-style error body; records every call. */
export function rejectingFetch(): {
  fetch: (input: unknown, init?: RequestInit) => Promise<Response>
  calls: RecordedRequest[]
} {
  const calls: RecordedRequest[] = []
  return {
    calls,
    fetch: async (input, init) => {
      if (input instanceof Request) {
        const headers = new Headers(input.headers)
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
        calls.push({ url: input.url, headers, body: await input.clone().text() })
      } else {
        const url = input instanceof URL ? input.href : String(input)
        const body = typeof init?.body === 'string' ? init.body : undefined
        calls.push({ url, headers: new Headers(init?.headers), body })
      }
      return new Response('{"error":{"message":"stub"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }
  }
}

/** Parsed JSON body of a recorded request. */
export function bodyOf(request: RecordedRequest): Record<string, unknown> {
  return JSON.parse(request.body ?? '{}') as Record<string, unknown>
}
