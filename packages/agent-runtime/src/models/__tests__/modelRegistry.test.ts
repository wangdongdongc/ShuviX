/**
 * createModelRegistry — the rows-to-Models mirror sessions use.
 *
 * Pinned: providers exist the moment the registry does (A8), exactly one per row (A9),
 * refresh() re-syncs (and leaves unchanged providers alone), model refs follow the
 * builtin-slug / custom-row-id rule, credentials are read live, builtin providers keep the
 * ambient env fallback while custom ones never touch it (Q15 / M5), and custom row ids never
 * leak into error text (M4).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fauxProvider, isRetryableAssistantError, type Context } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { RuntimeNetwork } from '../../types'
import { createModelRegistry } from '../modelRegistry'
import { builtinRow, customRow, fakeAuthContext, fakePort, modelRow } from './fakePort'

const XAI_UUID = '0193a7c2-0000-7000-8000-00000000a001'
const CUSTOM_ID = '0193a7c2-0000-7000-8000-00000000c001'
const UNKNOWN_XAI = 'grok-shuvix-test-unknown'
const CTX: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }

const catalogIds = (slug: string): string[] =>
  builtinProviders()
    .find((p) => p.id === slug)!
    .getModels()
    .map((m) => m.id)

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('construction and refresh', () => {
  it('REG-01 builtin (uuid row) and custom providers resolve right after construction (A8)', () => {
    const port = fakePort(
      [builtinRow('XAI', { id: XAI_UUID }), customRow(CUSTOM_ID)],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    const { models } = createModelRegistry({ port })

    expect(models.getModel('xai', 'grok-4.5')?.provider).toBe('xai')
    expect(models.getModel(CUSTOM_ID, 'alpha')?.provider).toBe(CUSTOM_ID)
  })

  it('REG-02 disabled builtin and custom rows are registered, resolvable, and authenticate (Q9)', async () => {
    const port = fakePort(
      [
        builtinRow('xai', { isEnabled: false, apiKey: 'sk-x' }),
        customRow(CUSTOM_ID, { isEnabled: false, apiKey: 'sk-c' })
      ],
      [modelRow(CUSTOM_ID, 'alpha', {}, false)]
    )
    const { models } = createModelRegistry({ port, authContext: fakeAuthContext() })

    expect(models.getModel('xai', 'grok-4.5')).toBeDefined()
    expect(models.getModel(CUSTOM_ID, 'alpha')).toBeDefined()
    expect((await models.getAuth('xai'))?.auth.apiKey).toBe('sk-x')
    expect((await models.getAuth(CUSTOM_ID))?.auth.apiKey).toBe('sk-c')
  })

  it('REG-03 exactly the row-derived providers are registered — no other pi builtins (A9)', () => {
    const port = fakePort([
      builtinRow('XAI', { id: XAI_UUID }),
      builtinRow('openai'),
      customRow(CUSTOM_ID)
    ])
    const { models } = createModelRegistry({ port })
    expect(models.getProviders().map((p) => p.id)).toEqual(['xai', 'openai', CUSTOM_ID])
    expect(models.getProvider('anthropic')).toBeUndefined()
  })

  it('REG-04 a row added later appears after refresh()', async () => {
    const port = fakePort([builtinRow('xai')])
    const registry = createModelRegistry({ port })
    const setProvider = vi.spyOn(registry.mutable, 'setProvider')

    port.rows.push(customRow(CUSTOM_ID))
    port.modelRows.push(modelRow(CUSTOM_ID, 'alpha'))
    await registry.refresh()

    expect(setProvider).toHaveBeenCalledTimes(1)
    expect(setProvider.mock.calls[0][0].id).toBe(CUSTOM_ID)
    expect(registry.models.getModel(CUSTOM_ID, 'alpha')).toBeDefined()
  })

  it('REG-05 a removed row disappears; a stale model errors with the provider’s name, no throw', async () => {
    const port = fakePort(
      [customRow(CUSTOM_ID, { name: 'Gone Proxy', apiKey: 'sk' })],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    const registry = createModelRegistry({ port })
    const stale = registry.models.getModel(CUSTOM_ID, 'alpha')!

    port.rows.length = 0
    port.modelRows.length = 0
    await registry.refresh()

    expect(registry.models.getProvider(CUSTOM_ID)).toBeUndefined()
    const result = await registry.models.streamSimple(stale, CTX).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBe('Unknown provider: "Gone Proxy"')
  })

  it('REG-06 row and model-row updates are reflected after refresh()', async () => {
    const port = fakePort(
      [builtinRow('xai'), customRow(CUSTOM_ID, { name: 'Old', baseUrl: 'http://old.test' })],
      [
        modelRow('xai', UNKNOWN_XAI),
        modelRow('xai', 'grok-4.5'),
        modelRow(CUSTOM_ID, 'alpha', { maxInputTokens: 100000 })
      ]
    )
    const registry = createModelRegistry({ port })

    port.rows[1] = customRow(CUSTOM_ID, {
      name: 'New',
      baseUrl: 'http://new.test',
      apiProtocol: 'anthropic-messages'
    })
    port.modelRows = [
      modelRow(CUSTOM_ID, 'alpha', { maxInputTokens: 200000 }),
      modelRow(CUSTOM_ID, 'beta')
    ]
    await registry.refresh()

    const custom = registry.models.getProvider(CUSTOM_ID)!
    expect(custom.name).toBe('New')
    expect(custom.getModels().map((m) => [m.id, m.api, m.baseUrl, m.contextWindow])).toEqual([
      ['alpha', 'anthropic-messages', 'http://new.test', 200000],
      ['beta', 'anthropic-messages', 'http://new.test', 128000]
    ])
    // the overlay model is gone; the catalog model whose row was removed stays (it is pi's)
    expect(registry.models.getModel('xai', UNKNOWN_XAI)).toBeUndefined()
    expect(registry.models.getModels('xai').map((m) => m.id)).toEqual(catalogIds('xai'))
  })

  it('REG-07 a refresh without changes neither sets nor deletes providers', async () => {
    const port = fakePort(
      [builtinRow('xai'), customRow(CUSTOM_ID)],
      [modelRow('xai', UNKNOWN_XAI), modelRow(CUSTOM_ID, 'alpha')]
    )
    const registry = createModelRegistry({ port })
    const setProvider = vi.spyOn(registry.mutable, 'setProvider')
    const deleteProvider = vi.spyOn(registry.mutable, 'deleteProvider')

    // a key change is not a provider change either: credentials are read live
    port.rows[1].apiKey = 'sk-changed'
    await registry.refresh()

    expect(setProvider).not.toHaveBeenCalled()
    expect(deleteProvider).not.toHaveBeenCalled()
  })

  it('REG-16 a port that throws during refresh rejects and leaves the registrations intact', async () => {
    const port = fakePort([customRow(CUSTOM_ID)], [modelRow(CUSTOM_ID, 'alpha')])
    const registry = createModelRegistry({ port })
    port.listProviders = () => {
      throw new Error('database is locked')
    }

    await expect(registry.refresh()).rejects.toThrow('database is locked')
    expect(registry.models.getModel(CUSTOM_ID, 'alpha')).toBeDefined()
  })
})

describe('modelRefOf', () => {
  it('REG-08 builtin uuid row → slug; builtin slug row → slug; custom → row id', () => {
    const port = fakePort([
      builtinRow('XAI', { id: XAI_UUID }),
      builtinRow('openai'),
      customRow(CUSTOM_ID)
    ])
    const registry = createModelRegistry({ port })
    expect(registry.modelRefOf(XAI_UUID, 'grok-4.5')).toEqual({ provider: 'xai', id: 'grok-4.5' })
    expect(registry.modelRefOf('openai', 'gpt-5')).toEqual({ provider: 'openai', id: 'gpt-5' })
    expect(registry.modelRefOf(CUSTOM_ID, 'alpha')).toEqual({ provider: CUSTOM_ID, id: 'alpha' })
  })

  it('REG-09 an unknown row → undefined; an unknown model id still yields a ref (A3)', () => {
    const registry = createModelRegistry({ port: fakePort([builtinRow('xai')]) })
    expect(registry.modelRefOf('no-such-row', 'grok-4.5')).toBeUndefined()
    expect(registry.modelRefOf('xai', 'no-such-model')).toEqual({
      provider: 'xai',
      id: 'no-such-model'
    })
  })

  it('REG-10 refs for catalog, overlay, custom and disabled models all resolve to that provider', () => {
    const disabledId = '0193a7c2-0000-7000-8000-00000000c0d1'
    const port = fakePort(
      [
        builtinRow('XAI', { id: XAI_UUID }),
        customRow(CUSTOM_ID),
        customRow(disabledId, { isEnabled: false })
      ],
      [
        modelRow(XAI_UUID, UNKNOWN_XAI),
        modelRow(CUSTOM_ID, 'alpha'),
        modelRow(disabledId, 'off', {}, false)
      ]
    )
    const registry = createModelRegistry({ port })
    const cases: Array<[string, string]> = [
      [XAI_UUID, 'grok-4.5'],
      [XAI_UUID, UNKNOWN_XAI],
      [CUSTOM_ID, 'alpha'],
      [disabledId, 'off']
    ]
    for (const [rowId, modelId] of cases) {
      const ref = registry.modelRefOf(rowId, modelId)!
      const model = registry.models.getModel(ref.provider, ref.id)
      expect(model, `${rowId}/${modelId}`).toBeDefined()
      expect(model!.provider).toBe(ref.provider)
    }
  })
})

describe('credentials', () => {
  it('REG-11 builtin: env fallback, DB key wins; custom: never the environment (Q15 / M5)', async () => {
    const port = fakePort([builtinRow('xai'), customRow(CUSTOM_ID)])
    const env = fakeAuthContext({ XAI_API_KEY: 'env-x', OPENAI_API_KEY: 'env-o' })
    const { models } = createModelRegistry({ port, authContext: env })

    const fromEnv = await models.getAuth('xai')
    expect(fromEnv?.auth.apiKey).toBe('env-x')
    expect(fromEnv?.source).toBe('XAI_API_KEY')

    port.rows[0].apiKey = 'sk-db'
    const fromDb = await models.getAuth('xai')
    expect(fromDb?.auth.apiKey).toBe('sk-db')
    expect(fromDb?.source).toBe('stored credential')

    expect(await models.getAuth(CUSTOM_ID)).toBeUndefined()
  })

  it('REG-12 without an authContext pi’s default reads process.env', async () => {
    vi.stubEnv('XAI_API_KEY', 'pe')
    const { models } = createModelRegistry({ port: fakePort([builtinRow('xai')]) })
    expect((await models.getAuth('xai'))?.auth.apiKey).toBe('pe')
  })

  it('REG-13 a key change is visible without refresh()', async () => {
    const port = fakePort([customRow(CUSTOM_ID, { apiKey: 'sk-1' })])
    const { models } = createModelRegistry({ port })
    expect((await models.getAuth(CUSTOM_ID))?.auth.apiKey).toBe('sk-1')
    port.rows[0].apiKey = 'sk-2'
    expect((await models.getAuth(CUSTOM_ID))?.auth.apiKey).toBe('sk-2')
  })
})

describe('network and error text', () => {
  it('REG-14 `models` is scoped, `mutable` is not, and `models` sees `mutable` live', async () => {
    const als = new AsyncLocalStorage<object>()
    let runs = 0
    const network: RuntimeNetwork = {
      runInRequestScope: (fn) => {
        runs++
        return als.run({}, fn)
      },
      describeLastFailure: () => undefined
    }
    const port = fakePort([customRow(CUSTOM_ID)], [modelRow(CUSTOM_ID, 'alpha')])
    const registry = createModelRegistry({ port, network })
    const model = registry.models.getModel(CUSTOM_ID, 'alpha')!

    await registry.models.streamSimple(model, CTX).result()
    expect(runs).toBe(1)
    await registry.mutable.streamSimple(model, CTX).result()
    expect(runs).toBe(1)

    registry.mutable.setProvider(fauxProvider({ provider: 'faux-live' }).provider)
    expect(registry.models.getProvider('faux-live')).toBeDefined()
  })

  it('REG-15 risk probe: a deleted custom provider whose uuid contains 502 is not retryable (M4)', async () => {
    const id = '0193a502-0000-7000-8000-000000000502'
    const raw = { stopReason: 'error', errorMessage: `Unknown provider: ${id}` }
    expect(isRetryableAssistantError(raw as Parameters<typeof isRetryableAssistantError>[0])).toBe(
      true
    )

    const port = fakePort(
      [customRow(id, { name: 'Old Proxy', apiKey: 'sk' })],
      [modelRow(id, 'alpha')]
    )
    const registry = createModelRegistry({ port })
    const stale = registry.models.getModel(id, 'alpha')!
    port.rows.length = 0
    await registry.refresh()

    const result = await registry.models.completeSimple(stale, CTX)
    expect(result.errorMessage).toBe('Unknown provider: "Old Proxy"')
    expect(isRetryableAssistantError(result)).toBe(false)
  })

  it('REG-15b (pinned) a uuid provider this process never saw becomes a neutral placeholder', async () => {
    const id = '0193a429-0000-7000-8000-000000000429'
    const { models } = createModelRegistry({ port: fakePort([]) })
    const ghost = {
      id: 'alpha',
      name: 'alpha',
      api: 'openai-completions',
      provider: id,
      baseUrl: '',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100
    } as Parameters<typeof models.completeSimple>[0]

    const result = await models.completeSimple(ghost, CTX)

    expect(result.errorMessage).toBe('Unknown provider: (removed provider)')
    expect(isRetryableAssistantError(result)).toBe(false)
  })

  it('REG-15c builtin slugs are left as they are in error text', async () => {
    const { models } = createModelRegistry({
      port: fakePort([builtinRow('xai')]),
      authContext: fakeAuthContext()
    })
    const result = await models.completeSimple(models.getModel('xai', 'grok-4.5')!, CTX)
    expect(result.errorMessage).toBe('Provider is not configured: xai')
  })
})
