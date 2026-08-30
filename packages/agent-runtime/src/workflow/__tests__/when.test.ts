/**
 * 触发绑定的 CEL `when` —— compile（解析期语法门）与 evaluate（fire 期 strict 求值）的
 * 契约钉板。strict 语义是触发模型的安全阀：访问 payload 缺失属性、非布尔结果都必须
 * **向上抛**，由引擎兜成「不命中 + 告警」—— 宁漏一次触发，绝不误发一个 run。
 */
import { describe, expect, it } from 'vitest'
import { compileWhen, evaluateLaneKey, evaluateWhen } from '../when'

describe('compileWhen — 解析期语法门', () => {
  it('合法表达式 → null', () => {
    expect(compileWhen('event.isDefaultTitle')).toBeNull()
    expect(compileWhen("event.turnCount == 2 && env.host == 'desktop'")).toBeNull()
  })

  it('语法错 → 返回错误消息字符串（整份文件据此判非法）', () => {
    const err = compileWhen('event.')
    expect(typeof err).toBe('string')
    expect(err!.length).toBeGreaterThan(0)
  })
})

describe('evaluateWhen — strict 求值', () => {
  it('布尔结果原样返回（true / false 各一）', () => {
    expect(evaluateWhen('event.flag', { event: { flag: true } })).toBe(true)
    expect(evaluateWhen('event.flag', { event: { flag: false } })).toBe(false)
  })

  it.each([
    ['数值', '1 + 1'],
    ['字符串', "'x'"]
  ])('非布尔结果（%s）→ throw must evaluate to a boolean', (_label, expr) => {
    expect(() => evaluateWhen(expr, { event: {} })).toThrow('must evaluate to a boolean')
  })

  it('strict 语义：访问 payload 缺失属性（event.nope，event={}）→ throw', () => {
    expect(() => evaluateWhen('event.nope', { event: {} })).toThrow()
  })

  it('上下文三件套可达：vars 与 env 参与判定', () => {
    expect(
      evaluateWhen("vars.a == 1 && env.host == 'desktop'", {
        event: {},
        vars: { a: 1 },
        env: { host: 'desktop', platform: 'darwin' }
      })
    ).toBe(true)
  })

  it('CEL 吸收语义：false && event.nope → false 不抛（短路侧已定结果）', () => {
    expect(evaluateWhen('false && event.nope', { event: {} })).toBe(false)
  })

  it('同一表达式重复求值结果稳定（缓存不冻结上下文）', () => {
    const expr = 'vars.a == 1'
    expect(evaluateWhen(expr, { vars: { a: 1 } })).toBe(true)
    expect(evaluateWhen(expr, { vars: { a: 2 } })).toBe(false)
    expect(evaluateWhen(expr, { vars: { a: 1 } })).toBe(true)
  })
})

describe('evaluateLaneKey — 分道键求值', () => {
  it('string 结果原样返回', () => {
    expect(evaluateLaneKey("'a'", {})).toBe('a')
    expect(evaluateLaneKey('event.sessionId', { event: { sessionId: 's-42' } })).toBe('s-42')
  })

  it('number → 字符串（键是身份，类型在这里收敛）', () => {
    expect(evaluateLaneKey('event.n', { event: { n: 42 } })).toBe('42')
    expect(evaluateLaneKey('event.n', { event: { n: 1.5 } })).toBe('1.5')
  })

  it.each([
    ['布尔', 'event.v', { v: true }, 'got boolean'],
    ['对象', 'event.v', { v: { a: 1 } }, 'got object'],
    ['列表', 'event.v', { v: [1, 2] }, 'got object'],
    ['null', 'event.v', { v: null }, 'got object']
  ])(
    '%s 结果 → throw must evaluate to a string or number（布尔当键会把不相干的 run 挤成一条道）',
    (_label, expr, event, got) => {
      expect(() => evaluateLaneKey(expr, { event })).toThrow('must evaluate to a string or number')
      expect(() => evaluateLaneKey(expr, { event })).toThrow(got)
    }
  )

  it('strict 语义：访问缺失属性 → throw（引擎据此 fail-safe 到缺省键）', () => {
    expect(() => evaluateLaneKey('event.nope', { event: {} })).toThrow()
  })

  it('与 when 共用编译缓存互不干扰：各自的类型校验照常生效（两个方向各一）', () => {
    // 先 when 后 key
    expect(evaluateWhen('event.v', { event: { v: true } })).toBe(true)
    expect(() => evaluateLaneKey('event.v', { event: { v: true } })).toThrow('got boolean')
    // 先 key 后 when（换一个表达式，走另一条缓存条目）
    expect(evaluateLaneKey('event.k', { event: { k: 'lane-1' } })).toBe('lane-1')
    expect(() => evaluateWhen('event.k', { event: { k: 'lane-1' } })).toThrow(
      'must evaluate to a boolean'
    )
  })
})
