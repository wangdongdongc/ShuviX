/**
 * `shuvix-model` 取值契约 —— 字符串 ↔ (provider, model) ↔ 模型目录条目。
 * 三端（渲染进程编辑器 / 主进程 / 扩展）共用这一份规则，故用例直接钉纯函数返回值。
 */
import { describe, it, expect } from 'vitest'
import { parseModelRef, resolveModelRef, formatModelRef } from './agentModelRef'

/** 模型目录条目：泛型只约束这两个字段，不必造完整 AvailableModel */
interface CatalogRow {
  providerId: string
  modelId: string
}
const row = (providerId: string, modelId: string): CatalogRow => ({ providerId, modelId })

const UUID = '0192f0a1-7c4e-7c3a-9f10-2b6a5d0c1e77'

describe('parseModelRef', () => {
  it('`<provider>/<model>` 拆成两段', () => {
    expect(parseModelRef('openai/gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  it('只按首个斜杠拆：模型 id 自带斜杠时余部整体归 model', () => {
    expect(parseModelRef('openrouter/anthropic/claude-3.5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5'
    })
  })

  it('裸模型 id：provider 为 undefined（是否成立交给 resolveModelRef 判定）', () => {
    expect(parseModelRef('gpt-4o')).toEqual({ model: 'gpt-4o' })
    expect(parseModelRef('gpt-4o')!.provider).toBeUndefined()
  })

  it('uuid 提供商前缀整段保留（uuid 含 - 不含 /，不该被拆坏）', () => {
    expect(parseModelRef(`${UUID}/gpt-4o`)).toEqual({ provider: UUID, model: 'gpt-4o' })
  })

  it('首尾斜杠不构成前缀：整串当模型 id（斜杠保留，不产生空 provider）', () => {
    expect(parseModelRef('/gpt')).toEqual({ model: '/gpt' })
    expect(parseModelRef('gpt/')).toEqual({ model: 'gpt/' })
  })

  it('空值族 → null', () => {
    expect(parseModelRef('')).toBeNull()
    expect(parseModelRef('   ')).toBeNull()
    expect(parseModelRef(null)).toBeNull()
    expect(parseModelRef(undefined)).toBeNull()
  })

  it('首尾空白被 trim', () => {
    expect(parseModelRef('  p/m  ')).toEqual({ provider: 'p', model: 'm' })
  })
})

describe('resolveModelRef', () => {
  it('前缀命中：providerId+modelId 双匹配，返回目录里那条对象本身', () => {
    const hit = row('openai', 'gpt-4o')
    const models = [row('anthropic', 'claude-3.5'), hit]
    expect(resolveModelRef('openai/gpt-4o', models)).toBe(hit)
  })

  it('裸 id 命中：按 modelId 匹配', () => {
    const hit = row('openai', 'gpt-4o')
    expect(resolveModelRef('gpt-4o', [row('anthropic', 'claude-3.5'), hit])).toBe(hit)
  })

  it('模型 id 自带斜杠且裸写：整串匹配命中', () => {
    const hit = row('openrouter', 'anthropic/claude-3.5')
    expect(resolveModelRef('anthropic/claude-3.5', [hit])).toBe(hit)
  })

  it('跨提供商回落：前缀没中就把整串当模型 id 再匹配一次（OpenRouter 形态）', () => {
    // 目录里没有 openai 提供商，但另一提供商有字面 modelId 'openai/gpt-4o'
    const hit = row('openrouter', 'openai/gpt-4o')
    expect(resolveModelRef('openai/gpt-4o', [hit])).toBe(hit)
  })

  it('前缀命中优先于整串命中（写了前缀就是强意图）', () => {
    const whole = row('openrouter', 'openai/gpt-4o')
    const prefixed = row('openai', 'gpt-4o')
    expect(resolveModelRef('openai/gpt-4o', [whole, prefixed])).toBe(prefixed)
  })

  it('都不中 → undefined（目录非空、同 provider 有其它模型时也不静默换一条）', () => {
    const models = [row('openai', 'gpt-4o'), row('openai', 'gpt-4o-mini')]
    expect(resolveModelRef('openai/gpt-5', models)).toBeUndefined()
    expect(resolveModelRef('gpt-5', models)).toBeUndefined()
  })

  it('空目录 / 空 spec → undefined', () => {
    expect(resolveModelRef('openai/gpt-4o', [])).toBeUndefined()
    expect(resolveModelRef('', [row('openai', 'gpt-4o')])).toBeUndefined()
    expect(resolveModelRef(null, [row('openai', 'gpt-4o')])).toBeUndefined()
  })

  it('同名模型挂在两个提供商下、裸写 → 取目录顺序第一条（要指准就写前缀）', () => {
    const first = row('openai', 'gpt-4o')
    const second = row('azure', 'gpt-4o')
    expect(resolveModelRef('gpt-4o', [first, second])).toBe(first)
    expect(resolveModelRef('azure/gpt-4o', [first, second])).toBe(second)
  })
})

describe('formatModelRef', () => {
  it('恒带 providerId 前缀', () => {
    expect(formatModelRef('openai', 'gpt-4o')).toBe('openai/gpt-4o')
  })

  it('model 为空 → 空串（= 清除声明）', () => {
    expect(formatModelRef('openai', '')).toBe('')
  })

  it('provider 为空 → 只写模型 id', () => {
    expect(formatModelRef('', 'gpt-4o')).toBe('gpt-4o')
  })
})

describe('往返：format → parse → resolve 命中同一条', () => {
  it.each([
    ['普通', 'openai', 'gpt-4o'],
    ['模型 id 自带斜杠', 'openrouter', 'anthropic/claude-3.5'],
    ['uuid 提供商', UUID, 'vendor/custom-model']
  ])('%s', (_label, provider, model) => {
    const hit = row(provider, model)
    const catalog = [row('other', 'noise'), hit]
    const spec = formatModelRef(provider, model)
    expect(parseModelRef(spec)).toEqual({ provider, model })
    expect(resolveModelRef(spec, catalog)).toBe(hit)
  })
})
