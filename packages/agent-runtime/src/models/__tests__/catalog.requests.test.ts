/**
 * What actually goes over the wire — the real pi API implementations behind the registry, with
 * `fetch` stubbed (pi builds its SDK clients per request, so a global stub is seen). Every stub
 * answers 401; the tests only look at the request that was (or was not) sent and at the error
 * the caller gets back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isRetryableAssistantError,
  type AssistantMessage,
  type Context
} from '@earendil-works/pi-ai'
import { API_PROTOCOL_OPTIONS } from '@shuvix/chat-protocol/types/provider'
import { createModelRegistry } from '../modelRegistry'
import {
  bodyOf,
  builtinRow,
  customRow,
  fakePort,
  modelRow,
  rejectingFetch,
  type FakePort
} from './fakePort'

const CUSTOM_ID = '0193a7c2-0000-7000-8000-00000000c001'
const UNKNOWN_XAI = 'grok-shuvix-test-unknown'
const CTX: Context = {
  systemPrompt: 'SYS',
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }]
}

function stubFetch(): ReturnType<typeof rejectingFetch> {
  const stub = rejectingFetch()
  vi.stubGlobal('fetch', stub.fetch)
  return stub
}

function registryFor(port: FakePort): ReturnType<typeof createModelRegistry> {
  return createModelRegistry({ port })
}

async function send(port: FakePort, provider: string, modelId: string): Promise<AssistantMessage> {
  const registry = registryFor(port)
  const model = registry.models.getModel(provider, modelId)
  if (!model) throw new Error(`no model ${provider}/${modelId}`)
  return registry.models.streamSimple(model, CTX).result()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('builtin providers', () => {
  it('REQ-01 xai with a DB key → one POST to /responses, Bearer key, body.model', async () => {
    const stub = stubFetch()
    const result = await send(fakePort([builtinRow('xai', { apiKey: 'sk-db' })]), 'xai', 'grok-4.5')

    expect(result.stopReason).toBe('error')
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].url).toBe('https://api.x.ai/v1/responses')
    expect(stub.calls[0].headers.get('authorization')).toBe('Bearer sk-db')
    expect(bodyOf(stub.calls[0]).model).toBe('grok-4.5')
  })

  it('REQ-02 an overlay xai model goes to the same /responses endpoint under its own id', async () => {
    const stub = stubFetch()
    const port = fakePort([builtinRow('xai', { apiKey: 'sk-db' })], [modelRow('xai', UNKNOWN_XAI)])
    await send(port, 'xai', UNKNOWN_XAI)

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].url).toBe('https://api.x.ai/v1/responses')
    expect(bodyOf(stub.calls[0]).model).toBe(UNKNOWN_XAI)
  })
})

describe('custom providers', () => {
  const base = 'http://proxy.test/v1'

  it('REQ-03 openai-completions → baseUrl + /chat/completions with the stored key', async () => {
    const stub = stubFetch()
    const port = fakePort(
      [customRow(CUSTOM_ID, { apiKey: 'sk-1', baseUrl: base })],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    await send(port, CUSTOM_ID, 'alpha')

    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].url).toBe(`${base}/chat/completions`)
    expect(stub.calls[0].headers.get('authorization')).toBe('Bearer sk-1')
  })

  it('REQ-04 the trimmed compat holds on the wire: no `store`, system prompt as role "system"', async () => {
    const stub = stubFetch()
    const port = fakePort(
      [customRow(CUSTOM_ID, { apiKey: 'sk-1', baseUrl: base })],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    await send(port, CUSTOM_ID, 'alpha')

    const body = bodyOf(stub.calls[0])
    expect(body).not.toHaveProperty('store')
    const messages = body.messages as Array<{ role: string; content: unknown }>
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(messages.some((m) => m.role === 'developer')).toBe(false)
  })

  const wire: Record<string, (request: { url: string; headers: Headers }) => void> = {
    'openai-completions': (request) => {
      expect(request.url).toBe(`${base}/chat/completions`)
      expect(request.headers.get('authorization')).toBe('Bearer sk-1')
    },
    'openai-responses': (request) => {
      expect(request.url).toBe(`${base}/responses`)
      expect(request.headers.get('authorization')).toBe('Bearer sk-1')
    },
    'anthropic-messages': (request) => {
      expect(new URL(request.url).pathname.endsWith('/v1/messages')).toBe(true)
      expect(request.headers.get('x-api-key')).toBe('sk-1')
    },
    'google-generative-ai': (request) => {
      expect(new URL(request.url).pathname.endsWith('/models/alpha:streamGenerateContent')).toBe(
        true
      )
      expect(request.headers.get('x-goog-api-key')).toBe('sk-1')
    }
  }

  it.each(API_PROTOCOL_OPTIONS.map((option) => option.value))(
    'REQ-05 protocol %s reaches its endpoint with its auth header',
    async (protocol) => {
      const stub = stubFetch()
      const port = fakePort(
        [customRow(CUSTOM_ID, { apiKey: 'sk-1', baseUrl: base, apiProtocol: protocol })],
        [modelRow(CUSTOM_ID, 'alpha')]
      )
      const result = await send(port, CUSTOM_ID, 'alpha')

      expect(result.stopReason).toBe('error')
      expect(stub.calls).toHaveLength(1)
      wire[protocol](stub.calls[0])
    }
  )

  it('REQ-06 customHeaders are on the outgoing request (M2)', async () => {
    const stub = stubFetch()
    const port = fakePort(
      [
        customRow(CUSTOM_ID, {
          apiKey: 'sk-1',
          baseUrl: base,
          metadata: '{"customHeaders":{"X-Custom":"v"}}'
        })
      ],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    await send(port, CUSTOM_ID, 'alpha')

    expect(stub.calls[0].headers.get('x-custom')).toBe('v')
  })

  it('REQ-07 keyless custom row → error result naming the provider, no request, no placeholder key', async () => {
    const stub = stubFetch()
    const port = fakePort(
      [customRow(CUSTOM_ID, { name: 'My Proxy' })],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    const result = await send(port, CUSTOM_ID, 'alpha')

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toMatch(/No API key for provider|Provider is not configured/)
    expect(result.errorMessage).toContain('"My Proxy"')
    expect(result.errorMessage).not.toContain(CUSTOM_ID)
    expect(stub.calls).toHaveLength(0)
  })

  it('REQ-08 the same through completeSimple: resolves (never rejects) with the error result', async () => {
    const stub = stubFetch()
    const port = fakePort(
      [customRow(CUSTOM_ID, { name: 'My Proxy' })],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    const registry = registryFor(port)
    const result = await registry.models.completeSimple(
      registry.models.getModel(CUSTOM_ID, 'alpha')!,
      CTX
    )

    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBe('Provider is not configured: "My Proxy"')
    expect(stub.calls).toHaveLength(0)
  })

  it('REQ-09 (pinned) keyless with an Authorization custom header is still "not configured" (M5)', async () => {
    const stub = stubFetch()
    const port = fakePort(
      [
        customRow(CUSTOM_ID, {
          metadata: '{"customHeaders":{"Authorization":"Bearer from-header"}}'
        })
      ],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    const result = await send(port, CUSTOM_ID, 'alpha')

    expect(result.errorMessage).toBe('Provider is not configured: "My Proxy"')
    expect(stub.calls).toHaveLength(0)
  })

  it('REQ-10 risk probe: a keyless custom row whose uuid contains 500 is not retryable (M4)', async () => {
    const id = '0193a500-0000-7000-8000-000000000500'
    // premise: the raw pi text with the uuid in it WOULD be classified as retryable
    const raw = { stopReason: 'error', errorMessage: `Provider is not configured: ${id}` }
    expect(isRetryableAssistantError(raw as Parameters<typeof isRetryableAssistantError>[0])).toBe(
      true
    )

    stubFetch()
    const port = fakePort([customRow(id, { name: 'My Proxy' })], [modelRow(id, 'alpha')])
    const result = await send(port, id, 'alpha')

    expect(result.errorMessage).not.toContain(id)
    expect(isRetryableAssistantError(result)).toBe(false)
  })

  it('REQ-11 a key changed in the port reaches the next request without a rebuild', async () => {
    const stub = stubFetch()
    const port = fakePort(
      [customRow(CUSTOM_ID, { apiKey: 'sk-old', baseUrl: base })],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    const registry = registryFor(port)
    const model = registry.models.getModel(CUSTOM_ID, 'alpha')!

    await registry.models.completeSimple(model, CTX)
    port.rows[0].apiKey = 'sk-new'
    await registry.models.completeSimple(model, CTX)

    expect(stub.calls.map((c) => c.headers.get('authorization'))).toEqual([
      'Bearer sk-old',
      'Bearer sk-new'
    ])
  })
})
