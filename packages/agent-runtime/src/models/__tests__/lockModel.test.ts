/**
 * resolveLockModel（P1-09，裁决 K5）—— 会话的模型选择（provider 行 id + 模型 id）→ 锁里存的 durable
 * ModelRef；拒绝的四种原因；文案只说 provider 的名字、从不露 uuid；provider 行的启用位现读；
 * provider_models 行的启用位（选择器可见性）不是拒绝理由。纯函数：fakePort + 真 createModelRegistry。
 */
import { describe, expect, it } from 'vitest'
import { createModelRegistry, type ModelRegistry } from '../modelRegistry'
import { resolveLockModel, type LockModelResolution } from '../lockModel'
import { builtinRow, customRow, fakePort, modelRow, type FakePort } from './fakePort'

const XAI_UUID = '0193a7c2-0000-7000-8000-00000000a001'
const CUSTOM_ID = '0193a7c2-0000-7000-8000-00000000c001'

function setup(rows = [builtinRow('xai', { id: XAI_UUID }), customRow(CUSTOM_ID)]): {
  port: FakePort
  registry: ModelRegistry
  resolve: (selection: Parameters<typeof resolveLockModel>[2]) => LockModelResolution
} {
  const port = fakePort(rows, [modelRow(CUSTOM_ID, 'alpha')])
  const registry = createModelRegistry({ port })
  return {
    port,
    registry,
    resolve: (selection: Parameters<typeof resolveLockModel>[2]) =>
      resolveLockModel(registry, port, selection)
  }
}

function refusal(result: LockModelResolution): { kind: string; message: string } {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.model)}`)
  return { kind: result.kind, message: result.message }
}

describe('resolveLockModel', () => {
  it('LM-01 a builtin row with a uuid id resolves to its slug', () => {
    const { resolve } = setup()
    expect(resolve({ provider: XAI_UUID, modelId: 'grok-4.5' })).toEqual({
      ok: true,
      model: { provider: 'xai', modelId: 'grok-4.5' }
    })
  })

  it('LM-02 a builtin row whose id is the slug resolves the same way', () => {
    const { resolve } = setup([builtinRow('xai')])
    expect(resolve({ provider: 'xai', modelId: 'grok-4.5' })).toEqual({
      ok: true,
      model: { provider: 'xai', modelId: 'grok-4.5' }
    })
  })

  it('LM-03 a custom row resolves to its row id', () => {
    const { resolve } = setup()
    expect(resolve({ provider: CUSTOM_ID, modelId: 'alpha' })).toEqual({
      ok: true,
      model: { provider: CUSTOM_ID, modelId: 'alpha' }
    })
  })

  it('LM-04 a disabled builtin provider is refused, naming the provider and the model', () => {
    const { resolve } = setup([builtinRow('xai', { id: XAI_UUID, isEnabled: false })])
    const { kind, message } = refusal(resolve({ provider: XAI_UUID, modelId: 'grok-4.5' }))
    expect(kind).toBe('provider_disabled')
    expect(message).toContain('xai')
    expect(message).toContain('grok-4.5')
    expect(message).not.toContain(XAI_UUID)
  })

  it('LM-05 a disabled custom provider is refused by its label, never its uuid', () => {
    const { resolve } = setup([customRow(CUSTOM_ID, { isEnabled: false })])
    const { kind, message } = refusal(resolve({ provider: CUSTOM_ID, modelId: 'alpha' }))
    expect(kind).toBe('provider_disabled')
    expect(message).toContain('My Proxy')
    expect(message).toContain('alpha')
    expect(message).not.toContain(CUSTOM_ID)
  })

  it('LM-06 an unknown provider row is provider_unknown, without the id in the text', () => {
    const { resolve } = setup()
    const gone = '0193a7c2-0000-7000-8000-0000000dead0'
    const { kind, message } = refusal(resolve({ provider: gone, modelId: 'alpha' }))
    expect(kind).toBe('provider_unknown')
    expect(message).not.toContain(gone)
    expect(message).toContain('alpha')
  })

  it('LM-07 a known provider without that model is model_unknown, naming the model and the provider label', () => {
    const { resolve } = setup()
    const custom = refusal(resolve({ provider: CUSTOM_ID, modelId: 'beta' }))
    expect(custom.kind).toBe('model_unknown')
    expect(custom.message).toContain('beta')
    expect(custom.message).toContain('My Proxy')
    expect(custom.message).not.toContain(CUSTOM_ID)
    const builtin = refusal(resolve({ provider: XAI_UUID, modelId: 'grok-shuvix-test-unknown' }))
    expect(builtin.kind).toBe('model_unknown')
    expect(builtin.message).toContain('grok-shuvix-test-unknown')
    expect(builtin.message).toContain('xai')
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty provider', { provider: '', modelId: 'alpha' }],
    ['an empty model', { provider: CUSTOM_ID, modelId: '  ' }]
  ])('LM-08 no selection (%s) is no_model', (_name, selection) => {
    const { resolve } = setup()
    expect(refusal(resolve(selection)).kind).toBe('no_model')
  })

  it('LM-09 every accepted ref resolves through the registry', () => {
    const { resolve, registry } = setup()
    for (const selection of [
      { provider: XAI_UUID, modelId: 'grok-4.5' },
      { provider: CUSTOM_ID, modelId: 'alpha' }
    ]) {
      const result = resolve(selection)
      if (!result.ok) throw new Error(result.message)
      expect(registry.models.getModel(result.model.provider, result.model.modelId)).toBeDefined()
    }
  })

  it('LM-10 a disabled model row is not a refusal; the provider enabled bit is read live (no refresh needed)', () => {
    const port = fakePort([customRow(CUSTOM_ID)], [modelRow(CUSTOM_ID, 'alpha', {}, false)])
    const registry = createModelRegistry({ port })
    expect(resolveLockModel(registry, port, { provider: CUSTOM_ID, modelId: 'alpha' }).ok).toBe(
      true
    )
    port.rows[0]!.isEnabled = false
    expect(
      refusal(resolveLockModel(registry, port, { provider: CUSTOM_ID, modelId: 'alpha' })).kind
    ).toBe('provider_disabled')
    port.rows[0]!.isEnabled = true
    expect(resolveLockModel(registry, port, { provider: CUSTOM_ID, modelId: 'alpha' })).toEqual({
      ok: true,
      model: { provider: CUSTOM_ID, modelId: 'alpha' }
    })
  })
})
