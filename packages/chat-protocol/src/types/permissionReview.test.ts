/**
 * 自动审查的判决词汇（permissionReview.ts）—— 判定型 hook `permission.request` 的结论形状。
 *
 * 三方共读这一份：hook runner（结果契约的 schema → `next` 工具的参数）、安全模块（按 decision 执行）、
 * 询问卡片（展示 summary / risk）。这里钉的是词汇本身、严格程度的相对次序、形状守卫的宽严，以及
 * schema 的几条刻意取舍（不设长度上限、描述只用英文）。
 */
import { describe, expect, it } from 'vitest'
import {
  PERMISSION_DECISIONS,
  PERMISSION_RISKS,
  PERMISSION_VERDICT_SCHEMA,
  isPermissionVerdict,
  permissionDecisionSeverity,
  type PermissionVerdict
} from './permissionReview'

/** 一份合格判决（各用例在它之上改一个字段） */
const V: PermissionVerdict = {
  decision: 'allow',
  risk: 'low',
  summary: 'Runs the project test suite.',
  reason: 'The user asked for the tests to be run.'
}

/** schema 的一个属性（只读形状，不关心其余键） */
type PropertySchema = { type?: unknown; enum?: unknown; [key: string]: unknown }
const property = (name: string): PropertySchema =>
  (PERMISSION_VERDICT_SCHEMA.properties as Record<string, PropertySchema>)[name]

describe('判决词汇', () => {
  it('PR-1 decision 恰为 allow / ask / deny，risk 恰为 low / medium / high / critical（顺序即此）', () => {
    expect([...PERMISSION_DECISIONS]).toEqual(['allow', 'ask', 'deny'])
    expect([...PERMISSION_RISKS]).toEqual(['low', 'medium', 'high', 'critical'])
  })

  it('PR-2 严格程度 allow < ask < deny（只钉相对次序，不钉具体数值）', () => {
    expect(permissionDecisionSeverity('allow')).toBeLessThan(permissionDecisionSeverity('ask'))
    expect(permissionDecisionSeverity('ask')).toBeLessThan(permissionDecisionSeverity('deny'))
  })
})

describe('isPermissionVerdict —— 交给执行方之前的最后一道形状守卫', () => {
  const combos = PERMISSION_DECISIONS.flatMap((decision) =>
    PERMISSION_RISKS.map((risk) => ({ decision, risk }))
  )

  it.each(combos)(
    'PR-3 decision $decision × risk $risk → 真（summary / reason 为空串也算）',
    (combo) => {
      expect(isPermissionVerdict({ ...V, ...combo })).toBe(true)
      expect(isPermissionVerdict({ ...combo, summary: '', reason: '' })).toBe(true)
    }
  )

  it('PR-3 组合恰 12 种', () => {
    expect(combos).toHaveLength(12)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ["字符串 'allow'", 'allow'],
    ['数字 0', 0],
    ['空数组', []],
    ['true', true]
  ])('PR-4 非对象 %s → 假', (_label, value) => {
    expect(isPermissionVerdict(value)).toBe(false)
  })

  it.each(['decision', 'risk', 'summary', 'reason'] as const)('PR-4 缺 %s → 假', (key) => {
    const { [key]: _dropped, ...rest } = V
    expect(isPermissionVerdict(rest)).toBe(false)
  })

  it.each([
    ['summary: 42', { summary: 42 }],
    ['reason: null', { reason: null }]
  ])('PR-4 类型不对（%s）→ 假', (_label, over) => {
    expect(isPermissionVerdict({ ...V, ...over })).toBe(false)
  })

  it.each([
    ["decision: 'Allow'", { decision: 'Allow' }],
    ["decision: 'DENY'", { decision: 'DENY' }],
    ["decision: 'block'", { decision: 'block' }],
    ["risk: 'LOW'", { risk: 'LOW' }],
    ["risk: 'severe'", { risk: 'severe' }]
  ])('PR-4 词汇外或大小写不同（%s）→ 假（守卫不替调用方归一）', (_label, over) => {
    expect(isPermissionVerdict({ ...V, ...over })).toBe(false)
  })

  it('PR-7 多出的键不影响判定（宽松：多余键在 next 那一关已被 schema 拒掉）', () => {
    expect(isPermissionVerdict({ ...V, extra: 1 })).toBe(true)
  })
})

describe('PERMISSION_VERDICT_SCHEMA —— 审查 agent 的 next 工具参数', () => {
  it('PR-5 顶层 object、required 恰四个、不收多余键；decision / risk 的 enum 与常量逐项相等', () => {
    expect(PERMISSION_VERDICT_SCHEMA.type).toBe('object')
    expect([...(PERMISSION_VERDICT_SCHEMA.required as string[])].sort()).toEqual(
      ['decision', 'reason', 'risk', 'summary'].sort()
    )
    expect(PERMISSION_VERDICT_SCHEMA.required).toHaveLength(4)
    expect(PERMISSION_VERDICT_SCHEMA.additionalProperties).toBe(false)
    expect(Object.keys(PERMISSION_VERDICT_SCHEMA.properties as object).sort()).toEqual(
      ['decision', 'reason', 'risk', 'summary'].sort()
    )

    expect(property('decision').type).toBe('string')
    expect(property('decision').enum).toEqual([...PERMISSION_DECISIONS])
    expect(property('risk').type).toBe('string')
    expect(property('risk').enum).toEqual([...PERMISSION_RISKS])
  })

  it.each(['summary', 'reason'])(
    'PR-5 %s 是 string，且刻意没有 maxLength / minLength（超长不该逼模型多调一次 next）',
    (name) => {
      const prop = property(name)
      expect(prop.type).toBe('string')
      expect('maxLength' in prop).toBe(false)
      expect('minLength' in prop).toBe(false)
    }
  )

  it('PR-6 描述写给模型看，只用英文：整份 schema 不含 CJK 字符', () => {
    expect(JSON.stringify(PERMISSION_VERDICT_SCHEMA)).not.toMatch(/[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/)
  })
})
