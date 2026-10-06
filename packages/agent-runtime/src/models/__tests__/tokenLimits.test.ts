/**
 * contextWindow / maxTokens normalisation for the models ShuviX builds itself — custom rows and
 * overlay models (unknown model ids on builtin providers). Ported from modelResolver.test.ts.
 *
 * Why it matters: capability data comes from litellm's catalog or the capability dialog, and a
 * whole class of maxOutputTokens values is untrustworthy — 751 of the 1976 bundled litellm chat
 * models carry max_output == max_input (every xai/* entry; xAI never published such a cap), a
 * few max_output > max_input. A cap at or above the window can never be honoured: pi would send
 * it as max_tokens, some providers reject it, and compaction's output reserve eats the window.
 * Rule: contextWindow = maxInputTokens ?? 128000; maxTokens = maxOutputTokens only when it is
 * > 0 and strictly below the window, else 16384.
 *
 * The threshold cases run on both construction paths (custom and overlay). Catalog models take
 * the catalog's numbers and never this rule (D group). pi-ai is not mocked.
 */
import { describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { buildProviders } from '../catalog'
import { builtinRow, customRow, modelRow } from './fakePort'

/** Written out on purpose: changing a default should make these tests speak up. */
const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 16384

const CUSTOM_ID = '0193a7c2-0000-7000-8000-00000000c001'
const UNKNOWN_XAI = 'grok-shuvix-test-unknown'
/** Catalog entry with maxTokens == contextWindow (500000 / 500000) — the shape the rule cuts. */
const KNOWN_XAI = 'grok-4.5'

type Limits = { contextWindow: number; maxTokens: number }
type Shape = 'custom' | 'overlay'
const DUAL_PATHS: Shape[] = ['custom', 'overlay']

function catalogEntry(provider: string, model: string): Model<Api> | undefined {
  return getBuiltinModel(
    provider as Parameters<typeof getBuiltinModel>[0],
    model as Parameters<typeof getBuiltinModel>[1]
  ) as Model<Api> | undefined
}

function limitsFrom(model: Model<Api> | undefined): Limits {
  if (!model) throw new Error('model not built')
  return { contextWindow: model.contextWindow, maxTokens: model.maxTokens }
}

function builtModel(
  row: ReturnType<typeof builtinRow>,
  modelId: string,
  caps: ModelCapabilities
): Model<Api> | undefined {
  const [provider] = buildProviders({ providers: [row], models: [modelRow(row.id, modelId, caps)] })
  return provider?.getModels().find((m) => m.id === modelId)
}

function limitsOf(shape: Shape, caps: ModelCapabilities): Limits {
  if (shape === 'custom') return limitsFrom(builtModel(customRow(CUSTOM_ID), 'local-model', caps))
  // pin the premise, or a pi upgrade that catalogs this id silently turns this into a catalog case
  expect(catalogEntry('xai', UNKNOWN_XAI)).toBeUndefined()
  return limitsFrom(builtModel(builtinRow('xai'), UNKNOWN_XAI, caps))
}

/** The capability dialog's Number(value) → NaN → null in JSON: not expressible in the type. */
const nullCaps = (caps: Record<string, number | null>): ModelCapabilities =>
  caps as unknown as ModelCapabilities

describe('token limits — precondition', () => {
  it('TL-00 the overlay model id is not in pi’s xai catalog', () => {
    expect(catalogEntry('xai', UNKNOWN_XAI)).toBeUndefined()
  })
})

describe('token limits — A thresholds (custom and overlay)', () => {
  it.each(DUAL_PATHS)('TL-A1 [%s] output cap below the window → used', (shape) => {
    expect(limitsOf(shape, { maxInputTokens: 200000, maxOutputTokens: 32000 })).toEqual({
      contextWindow: 200000,
      maxTokens: 32000
    })
  })

  it.each(DUAL_PATHS)(
    'TL-A2 [%s] output cap equal to the window (litellm grok shape) → unknown',
    (shape) => {
      expect(limitsOf(shape, { maxInputTokens: 500000, maxOutputTokens: 500000 })).toEqual({
        contextWindow: 500000,
        maxTokens: DEFAULT_MAX_TOKENS
      })
    }
  )

  it.each(DUAL_PATHS)('TL-A3 [%s] output cap above the window → unknown', (shape) => {
    expect(limitsOf(shape, { maxInputTokens: 131072, maxOutputTokens: 262144 })).toEqual({
      contextWindow: 131072,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })

  it.each(DUAL_PATHS)('TL-A4 [%s] window − 1 exactly → used', (shape) => {
    expect(limitsOf(shape, { maxInputTokens: 500000, maxOutputTokens: 499999 })).toEqual({
      contextWindow: 500000,
      maxTokens: 499999
    })
  })
})

describe('token limits — B missing values (custom)', () => {
  it('TL-B1 both missing → both defaults', () => {
    expect(limitsOf('custom', {})).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })

  it('TL-B2 window only → default output', () => {
    expect(limitsOf('custom', { maxInputTokens: 1000000 })).toEqual({
      contextWindow: 1000000,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })

  it('TL-B3 output only, below the default window → used', () => {
    expect(limitsOf('custom', { maxOutputTokens: 65536 })).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: 65536
    })
  })

  it.each([128000, 200000])(
    'TL-B4 output only, %i ≥ the default window → unknown',
    (maxOutputTokens) => {
      expect(limitsOf('custom', { maxOutputTokens })).toEqual({
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS
      })
    }
  )
})

describe('token limits — C null values', () => {
  it.each<[Record<string, number | null>, Limits]>([
    [
      { maxInputTokens: 200000, maxOutputTokens: null },
      { contextWindow: 200000, maxTokens: DEFAULT_MAX_TOKENS }
    ],
    [
      { maxInputTokens: null, maxOutputTokens: null },
      { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }
    ]
  ])('TL-C1 null counts as missing: %o', (caps, expected) => {
    expect(limitsOf('custom', nullCaps(caps))).toEqual(expected)
  })
})

describe('token limits — E non-positive output caps', () => {
  it.each([0, -5])('TL-E1 output cap %i → unknown (0 would be sent as max_tokens: 0)', (n) => {
    expect(limitsOf('custom', { maxInputTokens: 200000, maxOutputTokens: n })).toEqual({
      contextWindow: 200000,
      maxTokens: DEFAULT_MAX_TOKENS
    })
  })
})

describe('token limits — D catalog models ignore capability data', () => {
  it('TL-D2 xai/grok-4.5 keeps the catalog’s numbers, even its maxTokens ≥ window shape', () => {
    const registry = catalogEntry('xai', KNOWN_XAI)
    expect(registry).toBeDefined()
    expect(registry!.maxTokens).toBeGreaterThanOrEqual(registry!.contextWindow)

    expect(
      limitsFrom(
        builtModel(builtinRow('xai'), KNOWN_XAI, { maxInputTokens: 1000, maxOutputTokens: 1 })
      )
    ).toEqual({ contextWindow: registry!.contextWindow, maxTokens: registry!.maxTokens })
  })

  it('TL-D3 openai/gpt-5 keeps the catalog’s {400000, 128000}', () => {
    const registry = catalogEntry('openai', 'gpt-5')
    expect(registry).toBeDefined()
    expect({ contextWindow: registry!.contextWindow, maxTokens: registry!.maxTokens }).toEqual({
      contextWindow: 400000,
      maxTokens: 128000
    })

    expect(
      limitsFrom(
        builtModel(builtinRow('openai'), 'gpt-5', { maxInputTokens: 500, maxOutputTokens: 100 })
      )
    ).toEqual({ contextWindow: 400000, maxTokens: 128000 })
  })
})
