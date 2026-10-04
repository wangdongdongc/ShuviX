/**
 * catalog.ts — ShuviX provider rows → pi-ai Providers.
 *
 * Builtin rows wrap pi's builtin provider (catalog models untouched, unknown model rows become
 * overlay models from the M3 template); custom rows go through createProvider with the lazy
 * implementation of their protocol. pi-ai is not mocked: the real catalog is read, and the
 * "this model id is not in the catalog" premise is pinned by a precondition (M1) so a pi
 * upgrade that adds it fails loudly instead of quietly turning the overlay cases into catalog
 * cases.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampThinkingLevel,
  createModels,
  getSupportedThinkingLevels,
  normalizeContext,
  type Api,
  type Context,
  type Model,
  type Provider
} from '@earendil-works/pi-ai'
import { builtinProviders, getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { BUILTIN_PROVIDERS } from '@shuvix/chat-protocol/providerCatalog'
import { API_PROTOCOL_OPTIONS } from '@shuvix/chat-protocol/types/provider'
import { buildProviders, piProviderIdOf } from '../catalog'
import { createDbCredentialStore } from '../credentialStore'
import {
  builtinRow,
  customRow,
  fakeAuthContext,
  fakePort,
  modelRow,
  rejectingFetch
} from './fakePort'

/** Not in pi's xai catalog (precondition below). grok-4.6 used to be this id; pi 1.0 added it. */
const UNKNOWN_XAI = 'grok-shuvix-test-unknown'
const XAI_UUID = '0193a7c2-0000-7000-8000-00000000a001'
const CUSTOM_ID = '0193a7c2-0000-7000-8000-00000000c001'
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const CTX: Context = {
  systemPrompt: 'SYS',
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }]
}

function catalogOf(slug: string): readonly Model<Api>[] {
  const provider = builtinProviders().find((p) => p.id === slug)
  if (!provider) throw new Error(`pi has no builtin provider ${slug}`)
  return provider.getModels()
}

function catalogEntry(slug: string, modelId: string): Model<Api> | undefined {
  return getBuiltinModel(
    slug as Parameters<typeof getBuiltinModel>[0],
    modelId as Parameters<typeof getBuiltinModel>[1]
  ) as Model<Api> | undefined
}

function only(providers: Provider[]): Provider {
  expect(providers).toHaveLength(1)
  return providers[0]
}

function modelOf(provider: Provider, id: string): Model<Api> {
  const model = provider.getModels().find((m) => m.id === id)
  if (!model) throw new Error(`model ${id} not found on ${provider.id}`)
  return model
}

/** The M3 template's compat as the overlay should carry it (model-specific keys dropped). */
function endpointCompatOf(model: Model<Api>): Record<string, unknown> | undefined {
  if (!model.compat) return undefined
  const { allowedFallbackModels: _dropped, ...rest } = model.compat as Record<string, unknown>
  return Object.keys(rest).length > 0 ? rest : undefined
}

function xaiWith(...modelIds: string[]): Provider {
  return only(
    buildProviders({
      providers: [builtinRow('xai')],
      models: modelIds.map((id) => modelRow('xai', id))
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('preconditions', () => {
  it('M1: the unknown xai model id is not in pi’s catalog', () => {
    expect(catalogEntry('xai', UNKNOWN_XAI)).toBeUndefined()
  })
})

describe('piProviderIdOf', () => {
  it('CAT-01 builtin row with slug id → the slug', () => {
    expect(piProviderIdOf(builtinRow('xai'))).toBe('xai')
  })

  it('CAT-02 builtin row with a legacy uuid id and name "XAI" → "xai"', () => {
    expect(piProviderIdOf(builtinRow('XAI', { id: XAI_UUID }))).toBe('xai')
  })

  it('CAT-03 custom row named "xai" → its row id, never the slug', () => {
    expect(piProviderIdOf(customRow(CUSTOM_ID, { name: 'xai' }))).toBe(CUSTOM_ID)
  })

  it('CAT-04 builtin row with an empty name → undefined; buildProviders skips it without throwing', () => {
    const nameless = builtinRow('', { id: XAI_UUID })
    expect(piProviderIdOf(nameless)).toBeUndefined()
    expect(buildProviders({ providers: [nameless], models: [] })).toEqual([])
  })
})

describe('builtin rows', () => {
  it('CAT-05 every BUILTIN_PROVIDERS name has a pi builtin provider', () => {
    const ids = new Set(builtinProviders().map((p) => p.id))
    for (const entry of BUILTIN_PROVIDERS) expect(ids.has(entry.name), entry.name).toBe(true)
  })

  it('CAT-05b every declared defaultApi is used by at least one catalog model (M3 rule 1 applies)', () => {
    for (const entry of BUILTIN_PROVIDERS) {
      const apis = new Set(catalogOf(entry.name).map((m) => m.api))
      expect(apis.has(entry.defaultApi), `${entry.name}: ${entry.defaultApi}`).toBe(true)
    }
  })

  it('CAT-06 builtin xai row without model rows → one provider "xai" serving exactly the catalog, in order', () => {
    const provider = only(buildProviders({ providers: [builtinRow('xai')], models: [] }))
    expect(provider.id).toBe('xai')
    expect(provider.getModels().map((m) => m.id)).toEqual(catalogOf('xai').map((m) => m.id))
  })

  it('CAT-07 a model row for a catalog model never overrides the catalog (caps ignored, listed once)', () => {
    const provider = only(
      buildProviders({
        providers: [builtinRow('xai')],
        models: [
          modelRow('xai', 'grok-4.5', { maxInputTokens: 1000, maxOutputTokens: 1, vision: false })
        ]
      })
    )
    const hits = provider.getModels().filter((m) => m.id === 'grok-4.5')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual(catalogEntry('xai', 'grok-4.5'))
  })

  it('CAT-08 an unknown model row becomes one overlay model built from the M3 template', () => {
    const provider = xaiWith(UNKNOWN_XAI)
    const catalog = catalogOf('xai')
    expect(provider.getModels()).toHaveLength(catalog.length + 1)

    const template = catalog.find((m) => m.api === 'openai-responses')!
    const overlay = modelOf(provider, UNKNOWN_XAI)
    const expected: Record<string, unknown> = {
      id: UNKNOWN_XAI,
      name: UNKNOWN_XAI,
      api: 'openai-responses',
      provider: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      reasoning: true,
      input: ['text'],
      cost: ZERO_COST,
      contextWindow: 128000,
      maxTokens: 16384
    }
    const compat = endpointCompatOf(template)
    if (compat) expected.compat = compat
    expect(overlay).toEqual(expected)
    expect(overlay).not.toHaveProperty('headers')
  })

  it('CAT-09 vision decides the overlay input; the template’s image input is not inherited', () => {
    const provider = only(
      buildProviders({
        providers: [builtinRow('xai')],
        models: [modelRow('xai', 'seeing', { vision: true }), modelRow('xai', 'blind', {})]
      })
    )
    expect(catalogOf('xai')[0].input).toContain('image')
    expect(modelOf(provider, 'seeing').input).toEqual(['text', 'image'])
    expect(modelOf(provider, 'blind').input).toEqual(['text'])
  })

  it('CAT-10 caps.reasoning false still yields reasoning: true (thinking is the session’s choice)', () => {
    const provider = only(
      buildProviders({
        providers: [builtinRow('xai')],
        models: [modelRow('xai', UNKNOWN_XAI, { reasoning: false })]
      })
    )
    const overlay = modelOf(provider, UNKNOWN_XAI)
    expect(overlay.reasoning).toBe(true)
    expect(getSupportedThinkingLevels(overlay)).toContain('medium')
  })

  it('CAT-11 the overlay takes no name, thinking map, pricing tiers or input limits from the template', () => {
    const template = catalogOf('xai').find((m) => m.api === 'openai-responses')!
    // premise: the template actually has all four
    expect(template.thinkingLevelMap).toBeDefined()
    expect(template.cost.tiers).toBeDefined()
    expect(template.inputLimits).toBeDefined()

    const overlay = modelOf(xaiWith(UNKNOWN_XAI), UNKNOWN_XAI)
    expect(overlay.name).toBe(UNKNOWN_XAI)
    expect(overlay.thinkingLevelMap).toBeUndefined()
    expect(overlay.cost.tiers).toBeUndefined()
    expect(overlay.inputLimits).toBeUndefined()
  })

  it('CAT-12 a disabled model row still yields its overlay model (A2)', () => {
    const provider = only(
      buildProviders({
        providers: [builtinRow('xai')],
        models: [modelRow('xai', UNKNOWN_XAI, {}, false)]
      })
    )
    expect(provider.getModels().some((m) => m.id === UNKNOWN_XAI)).toBe(true)
  })

  it('CAT-13 duplicate unknown model rows → one overlay model (first row wins)', () => {
    const provider = only(
      buildProviders({
        providers: [builtinRow('xai')],
        models: [
          modelRow('xai', UNKNOWN_XAI, { maxInputTokens: 200000 }),
          modelRow('xai', UNKNOWN_XAI, { maxInputTokens: 300000 })
        ]
      })
    )
    const hits = provider.getModels().filter((m) => m.id === UNKNOWN_XAI)
    expect(hits).toHaveLength(1)
    expect(hits[0].contextWindow).toBe(200000)
  })

  it('CAT-14 overlay models are visible through Models: getModel, getModelOfType, getAllModels', () => {
    const models = createModels()
    models.setProvider(xaiWith(UNKNOWN_XAI))
    expect(models.getModel('xai', UNKNOWN_XAI)?.id).toBe(UNKNOWN_XAI)
    expect(models.getModelOfType('chat', 'xai', UNKNOWN_XAI)?.id).toBe(UNKNOWN_XAI)
    expect(models.getAllModels('xai').some((m) => m.id === UNKNOWN_XAI)).toBe(true)
  })

  it('CAT-15 the wrapped builtin keeps builtin behaviour: env key, OAuth, its own implementation', async () => {
    const provider = xaiWith(UNKNOWN_XAI)
    expect(provider.auth.oauth).toBeDefined()

    const models = createModels({ authContext: fakeAuthContext({ XAI_API_KEY: 'env-x' }) })
    models.setProvider(provider)
    const auth = await models.getAuth('xai')
    expect(auth?.auth.apiKey).toBe('env-x')
    expect(auth?.source).toBe('XAI_API_KEY')

    const stub = rejectingFetch()
    vi.stubGlobal('fetch', stub.fetch)
    const result = await models.completeSimple(models.getModel('xai', UNKNOWN_XAI)!, CTX)
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).not.toMatch(/no API implementation/)
    expect(stub.calls.map((c) => c.url)).toEqual(['https://api.x.ai/v1/responses'])
  })

  it('CAT-16 two builds share no overlay objects and never mutate the catalog', () => {
    const before = structuredClone(catalogOf('xai'))
    const first = modelOf(xaiWith(UNKNOWN_XAI), UNKNOWN_XAI)
    const second = modelOf(xaiWith(UNKNOWN_XAI), UNKNOWN_XAI)
    expect(first).not.toBe(second)
    expect(first.compat === undefined || first.compat !== second.compat).toBe(true)

    first.name = 'mutated'
    first.input.push('image')
    expect(second.name).toBe(UNKNOWN_XAI)
    expect(second.input).toEqual(['text'])
    expect(catalogOf('xai')).toEqual(before)
  })

  it('CAT-17 openrouter overlay → openai-completions at the openai-completions catalog model’s URL (M3)', () => {
    const provider = only(
      buildProviders({
        providers: [builtinRow('openrouter')],
        models: [modelRow('openrouter', 'vendor/shuvix-test-unknown')]
      })
    )
    const template = catalogOf('openrouter').find((m) => m.api === 'openai-completions')!
    const overlay = modelOf(provider, 'vendor/shuvix-test-unknown')
    expect(overlay.api).toBe('openai-completions')
    expect(overlay.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(overlay.baseUrl).toBe(template.baseUrl)
    expect(overlay.compat).toEqual(endpointCompatOf(template))
  })

  it('CAT-18 nvidia: template headers are copied; mutating the overlay leaves the catalog alone', () => {
    const template = catalogOf('nvidia')[0]
    expect(template.headers).toBeDefined()
    const templateSnapshot = structuredClone({ headers: template.headers, compat: template.compat })

    const provider = only(
      buildProviders({
        providers: [builtinRow('nvidia')],
        models: [modelRow('nvidia', 'vendor/shuvix-test-unknown')]
      })
    )
    const overlay = modelOf(provider, 'vendor/shuvix-test-unknown')
    expect(overlay.headers).toEqual(template.headers)
    expect(overlay.headers).not.toBe(template.headers)

    overlay.headers!['X-Mutated'] = '1'
    ;(overlay.compat as Record<string, unknown>).mutated = true
    expect({ headers: template.headers, compat: template.compat }).toEqual(templateSnapshot)
  })

  it('CAT-19 kimi-coding: ShuviX adds no User-Agent anywhere (Q11)', async () => {
    const provider = only(
      buildProviders({
        providers: [builtinRow('kimi-coding')],
        models: [modelRow('kimi-coding', 'kimi-shuvix-test-unknown')]
      })
    )
    const hasUserAgent = (headers: Record<string, string | null> | undefined): boolean =>
      Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'user-agent')
    for (const model of provider.getModels())
      expect(hasUserAgent(model.headers), model.id).toBe(false)

    const models = createModels({ authContext: fakeAuthContext({ KIMI_API_KEY: 'k' }) })
    models.setProvider(provider)
    const auth = await models.getAuth(modelOf(provider, 'kimi-shuvix-test-unknown'))
    expect(hasUserAgent(auth?.auth.headers)).toBe(false)
  })
})

describe('custom rows', () => {
  it('CAT-20 an openai-completions row with two model rows → provider row.id, label, trimmed compat', () => {
    const row = customRow(CUSTOM_ID, { name: 'My Proxy', baseUrl: 'http://proxy.test/v1' })
    const provider = only(
      buildProviders({
        providers: [row],
        models: [modelRow(CUSTOM_ID, 'alpha'), modelRow(CUSTOM_ID, 'beta')]
      })
    )
    expect(provider.id).toBe(CUSTOM_ID)
    expect(provider.name).toBe('My Proxy')
    expect(provider.getModels().map((m) => m.id)).toEqual(['alpha', 'beta'])
    for (const model of provider.getModels()) {
      expect(model.provider).toBe(CUSTOM_ID)
      expect(model.api).toBe('openai-completions')
      expect(model.baseUrl).toBe('http://proxy.test/v1')
      expect(model.reasoning).toBe(true)
      expect(model.cost).toEqual(ZERO_COST)
      expect(model.compat).toEqual({ supportsStore: false, supportsDeveloperRole: false })
    }

    // a display name, when present, is the label
    const labelled = only(
      buildProviders({ providers: [{ ...row, displayName: 'Shown Name' }], models: [] })
    )
    expect(labelled.name).toBe('Shown Name')
  })

  it('CAT-21 an empty apiProtocol means openai-completions with the trimmed compat', () => {
    const provider = only(
      buildProviders({
        providers: [customRow(CUSTOM_ID, { apiProtocol: '' })],
        models: [modelRow(CUSTOM_ID, 'alpha')]
      })
    )
    const model = modelOf(provider, 'alpha')
    expect(model.api).toBe('openai-completions')
    expect(model.compat).toEqual({ supportsStore: false, supportsDeveloperRole: false })
  })

  it.each(API_PROTOCOL_OPTIONS.map((option) => option.value))(
    'CAT-22 protocol %s → model.api is the protocol; compat only for openai-completions',
    (protocol) => {
      const provider = only(
        buildProviders({
          providers: [customRow(CUSTOM_ID, { apiProtocol: protocol })],
          models: [modelRow(CUSTOM_ID, 'alpha')]
        })
      )
      const model = modelOf(provider, 'alpha')
      expect(model.api).toBe(protocol)
      if (protocol === 'openai-completions') {
        expect(model.compat).toEqual({ supportsStore: false, supportsDeveloperRole: false })
      } else {
        expect(model.compat).toBeUndefined()
      }
    }
  )

  it('CAT-23 a model of another api handed to the provider errors instead of using the wrong protocol', async () => {
    const provider = only(
      buildProviders({
        providers: [customRow(CUSTOM_ID)],
        models: [modelRow(CUSTOM_ID, 'alpha')]
      })
    )
    const foreign = { ...modelOf(provider, 'alpha'), api: 'anthropic-messages' } as Model<Api>
    const result = await provider.streamSimple(foreign, normalizeContext(CTX)).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toMatch(/has no API implementation/)
  })

  it('CAT-24 a garbage apiProtocol does not break the build; that provider errors on request', async () => {
    const stub = rejectingFetch()
    vi.stubGlobal('fetch', stub.fetch)
    const good = customRow(CUSTOM_ID, { apiKey: 'sk-good' })
    const bad = customRow('0193a7c2-0000-7000-8000-00000000c0ba', {
      apiProtocol: 'nope',
      apiKey: 'sk-bad'
    })
    const port = fakePort([bad, good], [modelRow(bad.id, 'm-bad'), modelRow(good.id, 'm-good')])

    const providers = buildProviders({ providers: port.rows, models: port.modelRows })
    expect(providers.map((p) => p.id)).toEqual([bad.id, good.id])
    expect(providers[1].getModels().map((m) => m.id)).toEqual(['m-good'])

    const models = createModels({ credentials: createDbCredentialStore(port) })
    for (const provider of providers) models.setProvider(provider)
    const result = await models.completeSimple(models.getModel(bad.id, 'm-bad')!, CTX)
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toMatch(/Unsupported API protocol "nope"/)
    expect(stub.calls).toHaveLength(0)
  })

  it('CAT-25 customHeaders reach the request auth (model headers, merged by Models.getAuth — M2)', async () => {
    const port = fakePort(
      [customRow(CUSTOM_ID, { apiKey: 'sk-1', metadata: '{"customHeaders":{"X-Key":"val"}}' })],
      [modelRow(CUSTOM_ID, 'alpha')]
    )
    const models = createModels({ credentials: createDbCredentialStore(port) })
    for (const provider of buildProviders({ providers: port.rows, models: port.modelRows })) {
      models.setProvider(provider)
    }
    const model = models.getModel(CUSTOM_ID, 'alpha')!
    expect(model.headers).toEqual({ 'X-Key': 'val' })
    const auth = await models.getAuth(model)
    expect(auth?.auth.headers).toEqual({ 'X-Key': 'val' })
  })

  it.each(['not json', '{}', '{"customHeaders":{}}', '{"customHeaders":"str"}', ''])(
    'CAT-26 metadata %j → no headers, no throw',
    (metadata) => {
      const provider = only(
        buildProviders({
          providers: [customRow(CUSTOM_ID, { metadata })],
          models: [modelRow(CUSTOM_ID, 'alpha')]
        })
      )
      expect(modelOf(provider, 'alpha')).not.toHaveProperty('headers')
    }
  )

  it('CAT-27 malformed capabilities JSON reads as {} (defaults, text-only), no throw', () => {
    const provider = only(
      buildProviders({
        providers: [customRow(CUSTOM_ID)],
        models: [modelRow(CUSTOM_ID, 'alpha', '{not json'), modelRow(CUSTOM_ID, 'beta', '[1,2]')]
      })
    )
    for (const id of ['alpha', 'beta']) {
      const model = modelOf(provider, id)
      expect(model.input).toEqual(['text'])
      expect(model.contextWindow).toBe(128000)
      expect(model.maxTokens).toBe(16384)
    }
  })

  it('CAT-28 two custom rows keep their own models', () => {
    const other = '0193a7c2-0000-7000-8000-00000000c002'
    const providers = buildProviders({
      providers: [
        customRow(CUSTOM_ID),
        customRow(other, { name: 'Other', baseUrl: 'http://other.test' })
      ],
      models: [modelRow(CUSTOM_ID, 'alpha'), modelRow(other, 'beta'), modelRow(CUSTOM_ID, 'gamma')]
    })
    expect(providers.map((p) => [p.id, p.getModels().map((m) => m.id)])).toEqual([
      [CUSTOM_ID, ['alpha', 'gamma']],
      [other, ['beta']]
    ])
    expect(providers[1].getModels()[0].baseUrl).toBe('http://other.test')
  })

  it('CAT-29 a custom row without model rows still builds, with no models', () => {
    const provider = only(buildProviders({ providers: [customRow(CUSTOM_ID)], models: [] }))
    expect(provider.id).toBe(CUSTOM_ID)
    expect(provider.getModels()).toEqual([])
  })
})

describe('shared rules', () => {
  it('CAT-30 disabled builtin and custom rows are built with their models (Q9)', () => {
    const providers = buildProviders({
      providers: [
        builtinRow('xai', { isEnabled: false }),
        customRow(CUSTOM_ID, { isEnabled: false })
      ],
      models: [modelRow('xai', UNKNOWN_XAI, {}, false), modelRow(CUSTOM_ID, 'alpha', {}, false)]
    })
    expect(providers.map((p) => p.id)).toEqual(['xai', CUSTOM_ID])
    expect(providers[0].getModels().some((m) => m.id === UNKNOWN_XAI)).toBe(true)
    expect(providers[0].getModels().length).toBe(catalogOf('xai').length + 1)
    expect(providers[1].getModels().map((m) => m.id)).toEqual(['alpha'])
  })

  it('CAT-31 xhigh / max clamp to high on custom and overlay models (Q17)', () => {
    const [xai, custom] = buildProviders({
      providers: [builtinRow('xai'), customRow(CUSTOM_ID)],
      models: [modelRow('xai', UNKNOWN_XAI), modelRow(CUSTOM_ID, 'alpha')]
    })
    for (const model of [modelOf(xai, UNKNOWN_XAI), modelOf(custom, 'alpha')]) {
      expect(clampThinkingLevel(model, 'xhigh')).toBe('high')
      expect(clampThinkingLevel(model, 'max')).toBe('high')
    }
  })

  it('CAT-32 a custom row whose id equals a builtin slug: the builtin wins, the custom row is skipped', () => {
    const providers = buildProviders({
      providers: [customRow('xai', { name: 'Impostor' }), builtinRow('XAI', { id: XAI_UUID })],
      models: [modelRow('xai', 'custom-only')]
    })
    const provider = only(providers)
    expect(provider.id).toBe('xai')
    expect(provider.auth.oauth).toBeDefined()
    expect(provider.getModels().map((m) => m.id)).toEqual(catalogOf('xai').map((m) => m.id))
  })
})
